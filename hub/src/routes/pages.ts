// Server-rendered pages: /, /login, /app, /docs, /privacy.

import { Hono, type Context } from "hono";
import type { AppEnv } from "../types";
import { pageSession } from "../lib/auth";
import { UUID_RE } from "../lib/crypto";
import { daySummaries, listDevices, querySamples, type DayOut, type DeviceOut } from "../lib/queries";
import { addDays, isDate, localDate, localHourOfDay, startOfLocalDay } from "../lib/time";
import { MAX_WEBHOOKS } from "../lib/webhooks";
import { dial, heartBuckets, hourlyFromCumulative } from "../views/dial";
import { clock, dayLabel, num, shortDay } from "../views/format";
import { html, type Safe } from "../views/html";
import { page } from "../views/layout";
import { APP_JS, LOGIN_JS } from "../views/scripts";
import { docsBody } from "../views/docs";
import { privacyBody } from "../views/privacy";

export const pages = new Hono<AppEnv>();

const MODEL_NAMES: Record<string, string> = { band10: "Band 10", band10pro: "Band 10 Pro" };
const NOW_WINDOW_MS = 10 * 60_000;

function render(c: Context<AppEnv>, title: string, body: Safe, extra: { script?: string; signedIn?: boolean; actions?: Safe } = {}) {
  return c.html(page({ title, nonce: c.get("nonce"), body, ...extra }));
}

// ---------------------------------------------------------------------------

pages.get("/", async (c) => {
  const signedIn = (await pageSession(c)) !== null;
  const deleted = c.req.query("silindi") === "1";
  const body = html`
${deleted ? html`<p class="small" role="status">Hesabın ve bu sunucudaki tüm verin silindi.</p>` : ""}
<h1>Bandının verisi, istediğin yerde</h1>
<p>OpenBand, Xiaomi Smart Band 10 ve 10 Pro'yu Mi Fitness ya da Xiaomi hesabı olmadan okuyan bir iPhone uygulaması. Veri telefonunda kalır.</p>
<p>Bu sayfa OpenBand hub'ı. Uygulamada Web erişimini açarsan telefon verini buraya da gönderir. Günü tarayıcıdan görebilir, verini dışa aktarabilir ya da webhook ile kendi sunucuna aktarabilirsin. Açmazsan buraya hiçbir şey gelmez.</p>
<p>${signedIn ? html`<a class="button" href="/app">Panele git</a>` : html`<a class="button" href="/login">Anahtarla giriş yap</a>`}</p>

<h2>Nasıl giriş yapılır</h2>
<ol>
  <li>Telefonda OpenBand'i aç ve Ayarlar'a git.</li>
  <li>Web erişimini aç. Uygulama senin için bir hesap ve kişisel bir anahtar oluşturur.</li>
  <li>Web paneli aç'a dokun. Tarayıcı açılır ve seni doğrudan panele alır.</li>
</ol>
<p>Başka bir bilgisayardan girmek için anahtarı uygulamadan kopyala ve <a href="/login">giriş sayfasına</a> yapıştır. Anahtar bir parola gibidir; kimseyle paylaşma.</p>

<h2>Geliştiriciler için</h2>
<p>Verine REST API ve imzalı webhook'larla da ulaşabilirsin. Ayrıntılar <a href="/docs">API belgesinde</a>.</p>
<p>Neyin saklandığını ve nasıl silineceğini <a href="/privacy">gizlilik sayfası</a> anlatıyor.</p>`;
  return render(c, "OpenBand", body, { signedIn });
});

// ---------------------------------------------------------------------------

pages.get("/login", (c) => {
  const body = html`
<h1>Panele giriş</h1>
<p id="login-status" role="status" aria-live="polite"></p>
<noscript><p class="error">Giriş için tarayıcında JavaScript açık olmalı.</p></noscript>
<form id="login-form" class="stack" hidden autocomplete="off">
  <div>
    <label for="token">Erişim anahtarı</label>
    <input id="token" name="token" type="password" placeholder="ob_..." spellcheck="false" autocapitalize="off" required>
  </div>
  <button type="submit">Giriş yap</button>
</form>
<p class="small muted">Anahtarı uygulamada Ayarlar'daki Web erişimi bölümünde bulursun. Anahtar tarayıcıda saklanmaz; yalnız oturum açmak için bir kez sunucuya gider ve yerine 30 gün geçerli bir oturum çerezi alırsın.</p>`;
  return render(c, "Giriş", body, { script: LOGIN_JS });
});

// ---------------------------------------------------------------------------

interface DayView {
  steps: number | null;
  lastHr: { bpm: number; ts: number } | null;
  battery: number | null;
  hourly: number[];
  heart: Array<{ h: number; bpm: number }>;
  hasData: boolean;
}

async function loadDay(db: D1Database, accountId: string, tz: string, device: DeviceOut, date: string): Promise<DayView> {
  const from = startOfLocalDay(date, tz);
  const to = startOfLocalDay(addDays(date, 1), tz);
  const rows = await querySamples(db, accountId, { from, to, device: device.id, limit: 20_000 });
  const stepPts: Array<{ h: number; steps: number }> = [];
  const hrPts: Array<{ h: number; bpm: number }> = [];
  let steps: number | null = null;
  let lastHr: DayView["lastHr"] = null;
  let battery: number | null = null;
  for (const r of rows) {
    const h = localHourOfDay(r.ts, tz);
    if (r.type === "live") {
      if (r.steps !== null) {
        stepPts.push({ h, steps: r.steps });
        steps = Math.max(steps ?? 0, r.steps);
      }
      if (r.heart_rate !== null && r.heart_rate > 0) {
        hrPts.push({ h, bpm: r.heart_rate });
        lastHr = { bpm: r.heart_rate, ts: r.ts };
      }
    } else if (r.level !== null) {
      battery = r.level;
    }
  }
  return {
    steps,
    lastHr,
    battery,
    hourly: hourlyFromCumulative(stepPts),
    heart: heartBuckets(hrPts),
    hasData: rows.length > 0,
  };
}

function appHref(device: string | null, date: string | null): string {
  const p = new URLSearchParams();
  if (device) p.set("device", device);
  if (date) p.set("date", date);
  const s = p.toString();
  return s ? `/app?${s}` : "/app";
}

pages.get("/app", async (c) => {
  const s = await pageSession(c);
  if (!s) return c.redirect("/", 303);
  const a = s.account;
  const db = c.env.DB;
  const now = Date.now();
  const today = localDate(now, a.tz);

  const devices = await listDevices(db, a.id);
  const qDevice = (c.req.query("device") ?? "").toUpperCase();
  const device = (UUID_RE.test(qDevice) && devices.find((d) => d.id === qDevice)) || devices[0] || null;
  const qDate = c.req.query("date");
  const date = qDate && isDate(qDate) && qDate <= today ? qDate : today;
  const isToday = date === today;
  const multi = devices.length > 1;
  const devParam = multi && device ? device.id : null;

  const [day, list, hooks] = await Promise.all([
    device ? loadDay(db, a.id, a.tz, device, date) : Promise.resolve(null),
    device ? daySummaries(db, a.id, a.tz, addDays(today, -13), today, device.id) : Promise.resolve([] as DayOut[]),
    db
      .prepare(
        "SELECT id, url, last_delivery_at, last_status, last_error FROM webhooks WHERE account_id = ?1 ORDER BY created_at",
      )
      .bind(a.id)
      .all<{ id: string; url: string; last_delivery_at: number | null; last_status: number | null; last_error: string | null }>(),
  ]);

  // --- dial and metrics
  let caption: string | null = null;
  if (day?.lastHr) {
    caption = isToday && now - day.lastHr.ts <= NOW_WINDOW_MS ? "bpm, şimdi" : `son ölçüm ${clock(day.lastHr.ts, a.tz)}`;
  } else if (day?.hasData) {
    caption = "nabız ölçülmedi";
  }
  const dialSvg = dial({
    hourlySteps: day?.hourly ?? new Array(24).fill(0),
    heart: day?.heart ?? [],
    nowHour: isToday ? localHourOfDay(now, a.tz) : null,
    centerValue: day?.lastHr ? String(day.lastHr.bpm) : day?.hasData ? "–" : null,
    centerCaption: caption,
    label: `${dayLabel(date)}: ${day?.steps !== null && day?.steps !== undefined ? `${day.steps} adım` : "adım yok"}, ${day?.lastHr ? `son nabız ${day.lastHr.bpm}` : "nabız yok"}`,
  });

  const emptyText = !device
    ? "Henüz veri gelmedi. Telefonda OpenBand'i açıp Senkronize et'e dokun."
    : !day?.hasData
      ? isToday
        ? "Bugün için veri yok. Telefonda OpenBand'i açıp Senkronize et'e dokun."
        : "Bu gün için veri yok. Başka bir gün seç."
      : null;

  const lastSync = device ? Date.parse(device.last_seen) : null;
  const lastSyncText =
    lastSync === null
      ? null
      : localDate(lastSync, a.tz) === today
        ? clock(lastSync, a.tz)
        : `${shortDay(localDate(lastSync, a.tz))} ${clock(lastSync, a.tz)}`;

  const deviceSwitcher = multi
    ? html`<nav class="devices" aria-label="Bantlar">${devices.map(
        (d) =>
          html`<a href="${appHref(d.id, date)}" aria-current="${d.id === device?.id ? "true" : "false"}">${d.name}<span class="muted"> ${MODEL_NAMES[d.model] ? `(${MODEL_NAMES[d.model]})` : ""}</span></a>`,
      )}</nav>`
    : device
      ? html`<p class="muted small">${device.name}</p>`
      : "";

  // --- 14-day list
  const byDate = new Map(list.map((r) => [r.date, r]));
  const rows14 = Array.from({ length: 14 }, (_, i) => addDays(today, -i)).map((d) => {
    const r = byDate.get(d);
    return html`<tr aria-current="${d === date ? "true" : "false"}">
  <td><a href="${appHref(devParam, d)}">${d === today ? "Bugün" : dayLabel(d)}</a></td>
  <td class="n num">${r?.steps != null ? num(r.steps) : "–"}</td>
  <td class="n num">${r?.heart_rate_avg != null ? num(r.heart_rate_avg) : "–"}</td>
  <td class="n num hide-s">${r?.battery_last != null ? `%${r.battery_last}` : "–"}</td>
</tr>`;
  });

  // --- webhooks
  const hookItems = hooks.results.map((h) => {
    const status =
      h.last_delivery_at === null
        ? "Henüz gönderim yapılmadı."
        : `Son gönderim ${shortDay(localDate(h.last_delivery_at, a.tz))} ${clock(h.last_delivery_at, a.tz)}: ${
            h.last_error === null ? `ulaştı (HTTP ${h.last_status})` : `ulaşmadı (${h.last_error})`
          }.`;
    return html`<li>
  <div class="url">${h.url}</div>
  <div id="wh-status-${h.id}" class="small ${h.last_error ? "error" : "muted"}" role="status">${status}</div>
  <div class="row"><button type="button" class="text" data-action="test" data-id="${h.id}">Test et</button><button type="button" class="text danger" data-action="delete" data-id="${h.id}">Sil</button></div>
</li>`;
  });
  const canAddHook = hooks.results.length < MAX_WEBHOOKS;

  const prev = addDays(date, -1);
  const next = addDays(date, 1);

  const body = html`
<div class="title-row"><h1>${dayLabel(date)}</h1>${isToday ? "" : html`<a class="small" href="${appHref(devParam, null)}">Bugüne dön</a>`}</div>
${deviceSwitcher}

${dialSvg}
${emptyText ? html`<p class="empty muted">${emptyText}</p>` : ""}

${day?.hasData
  ? html`<div class="metrics">
  <div class="metric"><div class="value num">${day.steps !== null ? num(day.steps) : "–"}</div><div class="label">adım</div></div>
  <div class="metric"><div class="value num">${day.lastHr ? num(day.lastHr.bpm) : "–"}</div><div class="label">nabız</div></div>
</div>
<div class="meta"><span>${day.battery !== null ? `Pil %${day.battery}` : "Pil bilgisi yok"}</span><span>${lastSyncText ? `Son senkron ${lastSyncText}` : ""}</span></div>`
  : ""}

<h2>Başka bir gün</h2>
<form class="picker" method="get" action="/app">
  ${devParam ? html`<input type="hidden" name="device" value="${devParam}">` : ""}
  <div><label for="date">Gün</label><input id="date" name="date" type="date" value="${date}" max="${today}"></div>
  <button type="submit">Göster</button>
</form>
<div class="nav-days small"><a href="${appHref(devParam, prev)}">Önceki gün</a>${next <= today ? html`<a href="${appHref(devParam, next)}">Sonraki gün</a>` : ""}</div>

<h2>Son 14 gün</h2>
${device
  ? html`<table class="days">
<thead><tr><th>Gün</th><th class="n">Adım</th><th class="n">Ortalama nabız</th><th class="n hide-s">Pil</th></tr></thead>
<tbody>${rows14}</tbody>
</table>`
  : html`<p class="muted">İlk senkronizasyondan sonra günlerin burada listelenir.</p>`}

<h2>Dışa aktar</h2>
<p>Buradaki tüm verini indir. Her satırda hangi banttan geldiği yazar.</p>
<div class="row"><a class="button" href="/v1/export.csv" download>CSV indir</a><a class="button" href="/v1/export.json" download>JSON indir</a></div>

<h2>Webhook'lar</h2>
<p>Her senkronizasyondan sonra veri, imzalı bir istekle kendi sunucuna da gönderilir. Adres https:// ile başlamalı; en fazla ${MAX_WEBHOOKS} adres ekleyebilirsin. İmzayı doğrulamayı <a href="/docs#imza">API belgesi</a> anlatıyor.</p>
${hookItems.length ? html`<ul id="wh-list" class="hooks">${hookItems}</ul>` : html`<p class="muted">Henüz webhook yok.</p>`}
${canAddHook
  ? html`<form id="wh-form" class="stack" autocomplete="off">
  <div><label for="wh-url">Adres</label><input id="wh-url" name="url" type="url" placeholder="https://ornek.com/openband" required></div>
  <button type="submit">Webhook ekle</button>
  <p id="wh-out" class="small" role="status"></p>
</form>`
  : html`<p class="muted small">En fazla ${MAX_WEBHOOKS} webhook ekleyebilirsin. Yenisi için önce birini sil.</p>`}
<div id="wh-created" hidden>
  <p>Webhook eklendi. Bu gizli değeri şimdi kopyala; bir daha gösterilmeyecek. Sunucun gelen isteklerin imzasını bununla doğrular.</p>
  <code id="wh-secret" class="secret"></code>
  <div class="row"><button type="button" id="wh-copy">Kopyala</button><button type="button" class="text" id="wh-done">Tamam</button></div>
</div>

<h2>Erişim anahtarı</h2>
<p>Uygulama veriyi bu anahtarla gönderir. Anahtarın başkasının eline geçtiğini düşünüyorsan yenisini oluştur.</p>
<button type="button" class="text" id="rot-start">Yeni anahtar oluştur</button>
<div id="rot-confirm" class="confirm" hidden>
  <p>Eski anahtar hemen çalışmaz olur ve diğer tarayıcılardaki oturumlar kapanır. Telefondaki uygulama, yeni anahtarı girene kadar veri gönderemez.</p>
  <div class="row"><button type="button" id="rot-go">Yeni anahtarı oluştur</button><button type="button" class="text" id="rot-cancel">Vazgeç</button></div>
  <p id="rot-out" class="small" role="status"></p>
</div>
<div id="rot-result" hidden>
  <p>Yeni anahtarın bu. Şimdi kopyala ve uygulamaya gir; bir daha gösterilmeyecek.</p>
  <code id="rot-token" class="secret"></code>
  <button type="button" id="rot-copy">Kopyala</button>
</div>

<h2>Hesabı sil</h2>
<p>Hesabın ve bu sunucudaki tüm örneklerin, bant kayıtların, webhook'ların ve oturumların kalıcı olarak silinir. Telefondaki veriye dokunulmaz.</p>
<button type="button" class="text danger" id="del-start">Hesabı sil</button>
<div id="del-confirm" class="confirm" hidden>
  <label for="del-input">Onaylamak için <strong>sil</strong> yaz</label>
  <input id="del-input" class="wide" type="text" autocomplete="off" spellcheck="false">
  <div class="row"><button type="button" class="danger" id="del-go" disabled>Hesabı kalıcı olarak sil</button><button type="button" class="text" id="del-cancel">Vazgeç</button></div>
  <p id="del-out" class="small" role="status"></p>
</div>
`;

  return render(c, "Panel", body, {
    script: APP_JS,
    signedIn: true,
    actions: html`<a href="/docs">API belgesi</a><button type="button" class="text" id="signout">Çıkış yap</button>`,
  });
});

// ---------------------------------------------------------------------------

pages.get("/docs", async (c) => {
  const signedIn = (await pageSession(c)) !== null;
  return render(c, "API belgesi", docsBody(new URL(c.req.url).origin), { signedIn });
});

pages.get("/privacy", async (c) => {
  const signedIn = (await pageSession(c)) !== null;
  return render(c, "Gizlilik", privacyBody(), { signedIn });
});
