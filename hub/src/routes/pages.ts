// Server-rendered pages: /, /story, /login, /join, /app, /docs, /privacy.

import { Hono, type Context } from "hono";
import type { AppEnv } from "../types";
import { pageSession } from "../lib/auth";
import { UUID_RE } from "../lib/crypto";
import { daySummaries, listDevices, querySamples, type DayOut, type DeviceOut } from "../lib/queries";
import { addDays, isDate, localDate, localHourOfDay, startOfLocalDay } from "../lib/time";
import { isHeartRate } from "../lib/validate";
import { MAX_WEBHOOKS } from "../lib/webhooks";
import { dial, heartBuckets, hourlyFromCumulative, pulseCurve } from "../views/dial";
import { clock, dayLabel, num, shortDay } from "../views/format";
import { html, raw, type Safe } from "../views/html";
import { page, type OpenGraph } from "../views/layout";
import { APP_JS, JOIN_JS, LOGIN_JS } from "../views/scripts";
import { docsBody } from "../views/docs";
import { PRIVACY_TITLE, privacyBody } from "../views/privacy";
import { GUIDE_DESCRIPTION, GUIDE_TITLE, guideBody } from "../views/guide";
import { HOME_DESCRIPTION, HOME_IMAGE_ALT, HOME_TITLE, homeBody } from "../views/home";
import { alternates, localPath, type Lang } from "../views/i18n";
import { STORY_DESCRIPTION, STORY_IMAGE_ALT, STORY_TITLE, storyBody } from "../views/story";

export const pages = new Hono<AppEnv>();

const MODEL_NAMES: Record<string, string> = { band10: "Band 10", band10pro: "Band 10 Pro" };
const NOW_WINDOW_MS = 10 * 60_000;
/** An hour with more steps than this counts as active (same rule as the iOS app). */
const ACTIVE_HOUR_STEPS = 250;

const CHEV_L = raw('<svg class="ico" viewBox="0 0 10 10" aria-hidden="true"><path d="M6.5 1.5 3 5l3.5 3.5"/></svg>');
const CHEV_R = raw('<svg class="ico" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 1.5 7 5 3.5 8.5"/></svg>');

function render(
  c: Context<AppEnv>,
  title: string,
  body: Safe,
  extra: {
    script?: string;
    signedIn?: boolean;
    actions?: Safe;
    description?: string;
    og?: OpenGraph;
    lang?: Lang;
    alternates?: Record<Lang, string>;
  } = {},
) {
  return c.html(page({ title, nonce: c.get("nonce"), body, path: c.req.path, ...extra }));
}

const legend = html`<ul class="legend" aria-hidden="true"><li><i class="sw sw-step"></i>saatlik adım</li><li><i class="sw sw-hr"></i>nabız</li><li><i class="sw sw-now"></i>şimdi</li><li><i class="sw sw-night"></i>gece, 22–06</li></ul>`;

// ---------------------------------------------------------------------------

/** Open Graph data for a public page; absolute URLs on the public hostname. */
function og(c: Context<AppEnv>, path: string, image: string, imageAlt: string): OpenGraph {
  const origin = `https://${c.env.PUBLIC_HOSTNAME}`;
  return { url: origin + path, image: `${origin}/img/${image}`, imageAlt };
}

// Public pages in English (root) and Turkish (/tr).
for (const lang of ["en", "tr"] as const) {
  const suffix = lang === "en" ? "" : `-${lang}`;

  pages.get(localPath(lang, "/"), async (c) => {
    const signedIn = (await pageSession(c)) !== null;
    const deleted = c.req.query("silindi") === "1" || c.req.query("deleted") === "1";
    return render(c, HOME_TITLE[lang], homeBody({ deleted, lang }), {
      signedIn,
      lang,
      alternates: alternates("/"),
      description: HOME_DESCRIPTION[lang],
      og: og(c, localPath(lang, "/"), `og-home${suffix}.png`, HOME_IMAGE_ALT[lang]),
    });
  });

  pages.get(localPath(lang, "/story"), async (c) => {
    const signedIn = (await pageSession(c)) !== null;
    return render(c, `${STORY_TITLE[lang]} · Freeband`, storyBody(lang), {
      signedIn,
      lang,
      alternates: alternates("/story"),
      description: STORY_DESCRIPTION[lang],
      og: og(c, localPath(lang, "/story"), `og-story${suffix}.png`, STORY_IMAGE_ALT[lang]),
    });
  });

  pages.get(localPath(lang, "/guide"), async (c) => {
    const signedIn = (await pageSession(c)) !== null;
    return render(c, `${GUIDE_TITLE[lang]} · Freeband`, guideBody(lang), {
      signedIn,
      lang,
      alternates: alternates("/guide"),
      description: GUIDE_DESCRIPTION[lang],
      og: og(c, localPath(lang, "/guide"), `og-home${suffix}.png`, HOME_IMAGE_ALT[lang]),
    });
  });

  pages.get(localPath(lang, "/privacy"), async (c) => {
    const signedIn = (await pageSession(c)) !== null;
    return render(c, PRIVACY_TITLE[lang], privacyBody(lang), {
      signedIn,
      lang,
      alternates: alternates("/privacy"),
      og: og(c, localPath(lang, "/privacy"), `og-home${suffix}.png`, HOME_IMAGE_ALT[lang]),
    });
  });
}

// ---------------------------------------------------------------------------

pages.get("/login", (c) => {
  const body = html`
<section class="narrow">
  <p class="label">web paneli</p>
  <h1>Panele giriş</h1>
  <p class="lede">Uygulamada Web paneli aç'a dokunduğunda buraya kendiliğinden girersin. Başka bir bilgisayardaysan anahtarı yapıştır.</p>
  <div class="box">
    <p id="login-status" role="status" aria-live="polite"></p>
    <noscript><p class="error">Giriş için tarayıcında JavaScript açık olmalı.</p></noscript>
    <form id="login-form" class="stack" hidden autocomplete="off">
      <div>
        <label for="token">Erişim anahtarı</label>
        <input id="token" name="token" type="password" placeholder="fb_..." spellcheck="false" autocapitalize="off" required>
      </div>
      <button type="submit">Giriş yap</button>
    </form>
  </div>
  <p class="small muted">Anahtarı uygulamada Ayarlar'daki Web erişimi bölümünde bulursun. Anahtar tarayıcıda saklanmaz; yalnız oturum açmak için bir kez sunucuya gider ve yerine 30 gün geçerli bir oturum çerezi alırsın.</p>
</section>`;
  return render(c, "Giriş", body, { script: LOGIN_JS });
});

pages.get("/join", (c) => {
  const testflight = c.env.TESTFLIGHT_URL;
  const install = testflight
    ? html`<a href="${testflight}">Freeband'i TestFlight'tan kur</a>. Önce App Store'dan TestFlight uygulamasını kurman istenebilir.`
    : html`Seni davet edenden Freeband'in TestFlight bağlantısını iste.`;
  const body = html`
<section>
  <p class="label">davet</p>
  <h1>Freeband'e katıl</h1>
  <p class="lede">Bileğindeki Xiaomi Smart Band 10 ya da 10 Pro'yu Xiaomi hesabı olmadan kullanırsın; verilerin telefonunda kalır. Web erişimini açınca bu sunucudan panelini görebilir, API ile verine ulaşabilirsin.</p>
  <ol class="grid g2 steps">
    <li><h3>Uygulamayı kur.</h3><p class="muted">${install}</p></li>
    <li><h3>Bandını Mi Fitness'la bir kez eşle.</h3><p class="muted">Freeband bandın anahtarını oradan okur. Mi Fitness'ı silme.</p></li>
    <li><h3>Freeband'i aç ve ilk kurulumu bitir.</h3><p class="muted">Uygulama seni adım adım götürür.</p></li>
    <li><h3>Web erişimine katıl.</h3><p class="muted">Bu sayfa telefonunda açıksa düğmeye dokun; Freeband davet kodu dolu açılır.</p>
      <p><a id="join-link" class="btn" href="#">Freeband'de aç ${CHEV_R}</a></p>
      <p class="small muted">Davet kodu: <code id="join-code">…</code></p>
    </li>
  </ol>
  <p class="note small muted">Davet kodu bağlantının # sonrasında durur ve bu sayfadan sunucuya gönderilmez.</p>
</section>`;
  return render(c, "Freeband'e katıl", body, { script: JOIN_JS });
});

// ---------------------------------------------------------------------------

interface DayView {
  steps: number | null;
  calories: number | null;
  /** Standing hours from the latest live sample. */
  standing: number | null;
  lastHr: { bpm: number; ts: number } | null;
  hrMin: number | null;
  hrMax: number | null;
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
  let calories: number | null = null;
  let standing: number | null = null;
  let lastHr: DayView["lastHr"] = null;
  let hrMin: number | null = null;
  let hrMax: number | null = null;
  let battery: number | null = null;
  for (const r of rows) {
    const h = localHourOfDay(r.ts, tz);
    if (r.type === "live") {
      if (r.steps !== null) {
        stepPts.push({ h, steps: r.steps });
        steps = Math.max(steps ?? 0, r.steps);
      }
      if (r.calories !== null) calories = Math.max(calories ?? 0, r.calories);
      if (r.standing_hours !== null) standing = r.standing_hours;
      if (isHeartRate(r.heart_rate)) {
        hrPts.push({ h, bpm: r.heart_rate });
        lastHr = { bpm: r.heart_rate, ts: r.ts };
        hrMin = Math.min(hrMin ?? r.heart_rate, r.heart_rate);
        hrMax = Math.max(hrMax ?? r.heart_rate, r.heart_rate);
      }
    } else if (r.level !== null) {
      battery = r.level;
    }
  }
  return {
    steps,
    calories,
    standing,
    lastHr,
    hrMin,
    hrMax,
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

/** One reading in the panel grid: a small label over a figure, "–" when missing. */
function reading(cls: string, label: string, value: string | null, unit = ""): Safe {
  return html`<div class="${cls}"><span class="label">${label}</span>${
    value === null ? html`<span class="fig none">–</span>` : html`<span class="fig">${value}${unit ? html`<span class="unit">${unit}</span>` : ""}</span>`
  }</div>`;
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

  // --- dial
  const liveNow = !!day?.lastHr && isToday && now - day.lastHr.ts <= NOW_WINDOW_MS;
  let caption: string | null = null;
  if (day?.lastHr) {
    caption = liveNow ? "bpm, şimdi" : `bpm, ${clock(day.lastHr.ts, a.tz)}`;
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
    live: liveNow,
  });

  const emptyText = !device
    ? "Henüz veri gelmedi. Telefonda Freeband'i açıp Senkronize et'e dokun."
    : !day?.hasData
      ? isToday
        ? "Bugün için veri yok. Telefonda Freeband'i açıp Senkronize et'e dokun."
        : "Bu gün için veri yok. Başka bir gün seç."
      : null;

  const lastSync = device ? Date.parse(device.last_seen) : null;
  const lastSyncText =
    lastSync === null
      ? null
      : localDate(lastSync, a.tz) === today
        ? clock(lastSync, a.tz)
        : `${shortDay(localDate(lastSync, a.tz))} ${clock(lastSync, a.tz)}`;
  const fresh = lastSync !== null && now - lastSync <= NOW_WINDOW_MS;

  const deviceSwitcher = multi
    ? html`<nav class="devices" aria-label="Bantlar">${devices.map(
        (d) =>
          html`<a href="${appHref(d.id, date)}" aria-current="${d.id === device?.id ? "true" : "false"}">${d.name}<span class="muted"> ${MODEL_NAMES[d.model] ? `(${MODEL_NAMES[d.model]})` : ""}</span></a>`,
      )}</nav>`
    : "";

  const status = device
    ? html`<p class="status"><span>${device.name}</span>${
        lastSyncText ? html`<span class="sync"><span class="dot${fresh ? " on" : ""}" aria-hidden="true"></span>son senkron ${lastSyncText}</span>` : ""
      }</p>`
    : html`<p class="status"><span class="sync"><span class="dot" aria-hidden="true"></span>Henüz bant yok</span></p>`;

  // --- readings
  const hrRange =
    day?.hrMin != null && day.hrMax != null ? (day.hrMin === day.hrMax ? `${day.hrMin}` : `${day.hrMin}–${day.hrMax}`) : null;
  const activeHours = day ? day.hourly.filter((n) => n > ACTIVE_HOUR_STEPS).length : 0;
  const curve = day ? pulseCurve(day.heart, `${dayLabel(date)} nabız eğrisi: en düşük ${day.hrMin ?? "–"}, en yüksek ${day.hrMax ?? "–"}`) : null;

  // --- 14-day list
  const byDate = new Map(list.map((r) => [r.date, r]));
  const rows14 = Array.from({ length: 14 }, (_, i) => addDays(today, -i)).map((d) => {
    const r = byDate.get(d);
    return html`<tr aria-current="${d === date ? "true" : "false"}">
  <td><a href="${appHref(devParam, d)}">${d === today ? "Bugün" : dayLabel(d)}</a></td>
  <td class="n">${r?.steps != null ? num(r.steps) : "–"}</td>
  <td class="n">${r?.heart_rate_avg != null ? num(r.heart_rate_avg) : "–"}</td>
  <td class="n hide-s">${r?.battery_last != null ? `%${r.battery_last}` : "–"}</td>
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
  <div class="row"><button type="button" class="ghost sm" data-action="test" data-id="${h.id}">Test et</button><button type="button" class="ghost danger sm" data-action="delete" data-id="${h.id}">Sil</button></div>
</li>`;
  });
  const canAddHook = hooks.results.length < MAX_WEBHOOKS;

  const prev = addDays(date, -1);
  const next = addDays(date, 1);

  const body = html`
<div class="dayhead">
  <div>
    <p class="label">${isToday ? "bugün" : "geçmiş bir gün"}</p>
    <h1>${dayLabel(date)}</h1>
    ${status}
  </div>
  <form class="picker" method="get" action="/app">
    ${devParam ? html`<input type="hidden" name="device" value="${devParam}">` : ""}
    <a class="btn ghost sq" href="${appHref(devParam, prev)}" aria-label="Önceki gün" title="Önceki gün">${CHEV_L}</a>
    <label class="sr" for="date">Gün</label>
    <input id="date" name="date" type="date" value="${date}" max="${today}">
    <button type="submit" class="ghost">Göster</button>
    ${next <= today ? html`<a class="btn ghost sq" href="${appHref(devParam, next)}" aria-label="Sonraki gün" title="Sonraki gün">${CHEV_R}</a>` : ""}
    ${isToday ? "" : html`<a class="btn" href="${appHref(devParam, null)}">Bugüne dön</a>`}
  </form>
</div>
${deviceSwitcher}

<div class="grid board">
  <div class="dialcell">
    ${dialSvg}
    ${emptyText ? html`<p class="empty">${emptyText}</p>` : legend}
  </div>
  ${reading("metric m-steps", "adım", day?.steps != null ? num(day.steps) : null)}
  ${reading("metric m-cal", "kalori", day?.calories != null ? num(day.calories) : null, "kcal")}
  ${reading("metric m-bat", "pil", day?.battery != null ? `%${day.battery}` : null)}
  ${reading("fact", "nabız aralığı", hrRange, "bpm")}
  ${reading("fact", "ayakta", day?.standing != null ? String(day.standing) : null, "saat")}
  ${reading("fact", "aktif saat", activeHours > 0 ? String(activeHours) : null, "saat")}
  ${reading("fact", "son ölçüm", day?.lastHr ? clock(day.lastHr.ts, a.tz) : null)}
  <div class="curvecell">
    <span class="label">${isToday ? "nabız, bugün" : `nabız, ${shortDay(date)}`}</span>
    ${curve ?? html`<p class="small muted">${isToday ? "Canlı nabzı açtıkça ya da senkronize ettikçe günün nabız eğrisi burada belirir." : "Bu gün için nabız eğrisi yok."}</p>`}
  </div>
</div>

<section>
  <h2>Son 14 gün. <span class="muted">Bir güne dokunursan yukarıda açılır.</span></h2>
  ${device
    ? html`<div class="tablewrap"><table class="days">
<thead><tr><th>Gün</th><th class="n">Adım</th><th class="n">Ortalama nabız</th><th class="n hide-s">Pil</th></tr></thead>
<tbody>${rows14}</tbody>
</table></div>`
    : html`<p class="muted">İlk senkronizasyondan sonra günlerin burada listelenir.</p>`}
</section>

<section>
  <h2>Verini taşı. <span class="muted">İndir ya da her senkronizasyondan sonra kendi sunucuna gönder.</span></h2>
  <div class="grid g3">
    <div>
      <h3>Dışa aktar</h3>
      <p class="muted">Buradaki tüm verini indir. Her satırda hangi banttan geldiği yazar. JSON her şeyi içerir; CSV canlı örnekler ve pil içindir, diğer türlerin kendi CSV'leri var.</p>
      <div class="row"><a class="btn ghost" href="/v1/export.csv" download>CSV indir</a><a class="btn ghost" href="/v1/export.json" download>JSON indir</a></div>
      <p class="small muted">Diğer CSV'ler: <a href="/v1/export.csv?type=minute" download>dakikalar</a>, <a href="/v1/export.csv?type=sleep" download>uyku</a>, <a href="/v1/export.csv?type=score" download>skorlar</a>.</p>
    </div>
    <div class="span2">
      <h3>Webhook'lar</h3>
      <p class="muted">Her senkronizasyondan sonra veri, imzalı bir istekle kendi sunucuna da gönderilir. Adres https:// ile başlamalı; en fazla ${MAX_WEBHOOKS} adres ekleyebilirsin. İmzayı doğrulamayı <a href="/docs#imza">API belgesi</a> anlatıyor.</p>
      ${hookItems.length ? html`<ul id="wh-list" class="hooks">${hookItems}</ul>` : html`<p class="small muted">Henüz webhook yok.</p>`}
      ${canAddHook
        ? html`<form id="wh-form" class="stack" autocomplete="off">
        <div><label for="wh-url">Adres</label><input id="wh-url" name="url" type="url" placeholder="https://ornek.com/freeband" required></div>
        <button type="submit">Webhook ekle</button>
        <p id="wh-out" class="small" role="status"></p>
      </form>`
        : html`<p class="muted small">En fazla ${MAX_WEBHOOKS} webhook ekleyebilirsin. Yenisi için önce birini sil.</p>`}
      <div id="wh-created" hidden>
        <p>Webhook eklendi. Bu gizli değeri şimdi kopyala; bir daha gösterilmeyecek. Sunucun gelen isteklerin imzasını bununla doğrular.</p>
        <code id="wh-secret" class="secret"></code>
        <div class="row"><button type="button" id="wh-copy">Kopyala</button><button type="button" class="ghost" id="wh-done">Tamam</button></div>
      </div>
    </div>
  </div>
</section>

<section>
  <h2>Hesap. <span class="muted">Anahtarını yenile ya da her şeyi sil.</span></h2>
  <div class="grid g2">
    <div>
      <h3>Erişim anahtarı</h3>
      <p class="muted">Uygulama veriyi bu anahtarla gönderir. Anahtarın başkasının eline geçtiğini düşünüyorsan yenisini oluştur.</p>
      <button type="button" class="ghost" id="rot-start">Yeni anahtar oluştur</button>
      <div id="rot-confirm" class="confirm" hidden>
        <p>Eski anahtar hemen çalışmaz olur ve diğer tarayıcılardaki oturumlar kapanır. Yeni anahtarı telefonda Freeband'de <strong>Ayarlar → Web erişimi → API anahtarını gir</strong> alanına yapıştırana kadar uygulama veri gönderemez.</p>
        <div class="row"><button type="button" id="rot-go">Yeni anahtarı oluştur</button><button type="button" class="ghost" id="rot-cancel">Vazgeç</button></div>
        <p id="rot-out" class="small" role="status"></p>
      </div>
      <div id="rot-result" hidden>
        <p>Yeni anahtarın bu. Şimdi kopyala; bir daha gösterilmeyecek. Telefonda Freeband'i aç ve <strong>Ayarlar → Web erişimi → API anahtarını gir</strong> alanına yapıştır (İngilizce arayüzde Settings → Web access → Enter API key).</p>
        <code id="rot-token" class="secret"></code>
        <button type="button" id="rot-copy">Kopyala</button>
      </div>
    </div>
    <div>
      <h3>Hesabı sil</h3>
      <p class="muted">Hesabın ve bu sunucudaki tüm örneklerin, dakika, uyku ve skor kayıtların, bant kayıtların, webhook'ların ve oturumların kalıcı olarak silinir. Telefondaki veriye dokunulmaz.</p>
      <button type="button" class="ghost danger" id="del-start">Hesabı sil</button>
      <div id="del-confirm" class="confirm" hidden>
        <label for="del-input">Onaylamak için <strong>sil</strong> yaz</label>
        <input id="del-input" class="wide" type="text" autocomplete="off" spellcheck="false">
        <div class="row"><button type="button" class="danger" id="del-go" disabled>Hesabı kalıcı olarak sil</button><button type="button" class="ghost" id="del-cancel">Vazgeç</button></div>
        <p id="del-out" class="small" role="status"></p>
      </div>
    </div>
  </div>
</section>
`;

  return render(c, "Panel", body, {
    script: APP_JS,
    signedIn: true,
    actions: html`<a class="navlink" href="/docs">API belgesi</a><button type="button" class="ghost sm" id="signout">Çıkış yap</button>`,
  });
});

// ---------------------------------------------------------------------------

pages.get("/docs", async (c) => {
  const signedIn = (await pageSession(c)) !== null;
  return render(c, "API belgesi", docsBody(new URL(c.req.url).origin), { signedIn });
});
