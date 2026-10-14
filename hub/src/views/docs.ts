// /docs (English) and /tr/docs (Turkish): API reference with curl examples and
// signature verification snippets. Section anchors are the same in both languages.

import { html, type Safe } from "./html";
import type { Lang } from "./i18n";

const NODE_VERIFY = `import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";

const SECRET = process.env.FREEBAND_WEBHOOK_SECRET; // fbwh_...

http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks); // imzayı ham gövde üzerinden doğrula
    const expected = Buffer.from(
      "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex"),
    );
    const got = Buffer.from(req.headers["x-freeband-signature"] ?? "");
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      res.writeHead(401).end();
      return;
    }
    const body = JSON.parse(raw.toString("utf8"));
    if (body.event === "sync.completed" || body.event === "sync.partial") {
      // Tanımadığın türleri atla; minute/sleep/score için son geleni sakla.
      const known = body.samples.filter((s) => ["live", "battery", "minute", "sleep", "score"].includes(s.type));
      console.log(body.device.id, body.event, known.length);
    }
    res.writeHead(204).end();
  });
}).listen(8080);`;

const PY_VERIFY = `import hashlib, hmac, json, os
from http.server import BaseHTTPRequestHandler, HTTPServer

SECRET = os.environ["FREEBAND_WEBHOOK_SECRET"].encode()  # fbwh_...

class Hook(BaseHTTPRequestHandler):
    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        expected = "sha256=" + hmac.new(SECRET, raw, hashlib.sha256).hexdigest()
        got = self.headers.get("X-Freeband-Signature", "")
        if not hmac.compare_digest(got, expected):
            self.send_response(401)
            self.end_headers()
            return
        body = json.loads(raw)
        if body["event"] in ("sync.completed", "sync.partial"):
            # Tanımadığın türleri atla; minute/sleep/score için son geleni sakla.
            known = [s for s in body["samples"] if s["type"] in ("live", "battery", "minute", "sleep", "score")]
            print(body["device"]["id"], body["event"], len(known))
        self.send_response(204)
        self.end_headers()

HTTPServer(("", 8080), Hook).serve_forever()`;

const HEALTH_SAMPLES = `[
  { "type": "minute", "ts": "2026-10-13T07:42:00Z", "steps": 112, "heart_rate": 96,
    "spo2": 97, "stress": 34, "active_calories": 6, "distance_m": 84 },
  { "type": "sleep", "ts": "2026-10-12T20:41:00Z", "end": "2026-10-13T04:12:00Z", "is_nap": false,
    "minutes": { "deep": 82, "light": 241, "rem": 96, "awake": 32 },
    "wake_count": 3, "efficiency": 93,
    "stages": [[0, "light", 14], [14, "deep", 38], [52, "light", 61], [113, "rem", 22]],
    "hr_min": 48, "spo2_avg": 96.4, "spo2_min": 91, "hrv_rmssd": 42 },
  { "type": "score", "ts": "2026-10-12T21:00:00Z", "date": "2026-10-13",
    "sleep": 82, "recovery": 64, "strain": 11.4, "rhr": 54, "hrv_rmssd": 41.5,
    "confidence": { "sleep": "high", "recovery": "medium", "strain": "low" },
    "contributors": [
      { "score": "sleep", "key": "duration", "weight": 35, "value": 431, "unit": "min", "subscore": 88, "baseline": 418 },
      { "score": "recovery", "key": "hrv", "weight": 40, "value": null, "subscore": null, "note": "RR yok" }
    ],
    "algo": "freeband-score/1" }
]`;

const INGEST_BODY = `{
  "schema": "freeband.v1",
  "event": "sync.completed",
  "device": {
    "id": "5B0E2C9A-4C7D-4F57-9A39-2D2B1D9E8A10",
    "name": "Xiaomi Smart Band 10 Pro D9B9",
    "model": "band10pro",
    "app_version": "0.4 (8)",
    "tz": "Europe/Istanbul"
  },
  "sent_at": "2026-10-13T21:00:02Z",
  "summary": { "date": "2026-10-13", "steps": 8421, "calories": 312, "heart_rate_last": 74, "battery": 46 },
  "samples": [
    { "type": "live", "ts": "2026-10-13T20:59:41Z", "steps": 8421, "calories": 312, "heart_rate": 74, "standing_hours": 9 },
    { "type": "battery", "ts": "2026-10-13T20:59:40Z", "level": 46 }
  ]
}`;

function docsTR(origin: string): Safe {
  const H = `-H "Authorization: Bearer $FREEBAND_TOKEN"`;
  return html`
<div class="doc">
<nav class="toc" aria-label="Bölümler">
  <span class="label">bölümler</span>
  <a href="#kimlik">Kimlik doğrulama</a><a href="#hesap">Hesap</a><a href="#gonderim">Veri gönderme</a><a href="#saglik">Sağlık verisi</a><a href="#okuma">Veriyi okuma</a><a href="#webhook">Webhook'lar</a><a href="#imza">İmza doğrulama</a><a href="#oturum">Panel oturumu</a>
</nav>
<article class="prose">
<p class="label">freeband.v1</p>
<h1>API belgesi</h1>
<p class="lede">Freeband hub'ı verine bir REST API ve imzalı webhook'larla açar. Bu sayfa sözleşmenin (freeband.v1) hub tarafını anlatır.</p>
<p>Tüm zamanlar ISO 8601 UTC'dir, örneğin <code>2026-10-13T20:59:41Z</code>. Taban adres: <code>${origin}</code></p>

<h2 id="kimlik">Kimlik doğrulama</h2>
<p>Her istek kişisel anahtarınla gelir: <code>Authorization: Bearer fb_...</code>. Anahtarı uygulama, Web erişimini açtığında oluşturur. Sunucuda anahtarın kendisi değil, yalnız SHA-256 özeti tutulur; anahtarı kaybedersen yenisini oluşturman gerekir.</p>
<pre>export FREEBAND_TOKEN=fb_...
curl ${origin}/v1/me ${H}</pre>
<p>Hata cevapları hep aynı biçimdedir: <code>{"error": "kod", "message": "açıklama"}</code>. Sık görülen kodlar: 400 <code>invalid_body</code> ya da <code>invalid_query</code>, 401 <code>unauthorized</code>, 403 <code>cross_origin</code>, 404 <code>not_found</code>, 409, 413, 415, 429 <code>rate_limited</code> (<code>Retry-After</code> başlığıyla).</p>
<p>API tarayıcıdan başka sitelerin çağırması için açık değildir (CORS başlığı yok). Kendi sunucundan, betiklerinden ya da komut satırından çağır.</p>

<h2 id="hesap">Hesap</h2>
<h3>Hesap oluştur</h3>
<p>Uygulama bunu Web erişimini açtığında kendisi yapar. Anahtar yalnız bu cevapta bir kez döner. IP başına saatte 10 istekle sınırlıdır.</p>
<pre>curl -X POST ${origin}/v1/accounts \\
  -H "Content-Type: application/json" \\
  -d '{"device_name": "Xiaomi Smart Band 10 Pro D9B9", "tz": "Europe/Istanbul"}'

{"account_id": "…", "token": "fb_…", "web_url": "${origin}/login"}</pre>
<p>Web paneline doğrudan girmek için <code>web_url</code> adresinin sonuna <code>#token=</code> ve anahtarı ekle. Anahtar URL parçasında (#) kaldığı için sunucuya gitmez; sayfa onu oturum çerezine çevirir ve adres çubuğundan siler.</p>

<h3>Hesap bilgisi</h3>
<pre>curl ${origin}/v1/me ${H}

{"account_id": "…", "name": "…", "tz": "Europe/Istanbul", "created_at": "…",
 "samples": {"live": 1520, "battery": 44, "minute": 8640, "sleep": 6, "score": 6, "total": 10216},
 "devices": [{"id": "5B0E2C9A-…", "name": "Xiaomi Smart Band 10 Pro D9B9", "model": "band10pro", "last_seen": "…"}],
 "webhooks": 1}</pre>

<h3>Anahtarı yenile</h3>
<p>Yeni anahtar döner, eskisi hemen geçersiz olur. Diğer web oturumları kapanır. Yeni anahtarı telefonda Freeband'de <strong>Ayarlar → Web erişimi → API anahtarını gir</strong> alanına yapıştır; o zamana kadar uygulama veri gönderemez.</p>
<pre>curl -X POST ${origin}/v1/token/rotate ${H}</pre>

<h3>Hesabı sil</h3>
<p>Hesabı, tüm örnekleri, dakika, uyku ve skor kayıtlarını, bant kayıtlarını, webhook'ları ve oturumları kalıcı olarak siler.</p>
<pre>curl -X DELETE ${origin}/v1/account ${H}</pre>

<h2 id="gonderim">Veri gönderme</h2>
<p><code>POST /v1/ingest</code> uygulamanın kullandığı uç noktadır. Gövde en fazla 512 KB ve 5000 örnek olabilir. Her gövde tek bir banda aittir. Her örnek <code>(device.id, type, ts)</code> ile tekildir. <code>live</code> ve <code>battery</code> tekrar gelirse sayılır ama saklanmaz; <code>minute</code>, <code>sleep</code> ve <code>score</code> tekrar gelirse son gelen eskisinin yerine geçer (aşağıda). Hesap başına saatte 120 istek ve günde 200 000 örnek kabul edilir.</p>
<pre>curl -X POST ${origin}/v1/ingest ${H} \\
  -H "Content-Type: application/json" \\
  --data-binary @sync.json

{"accepted": 2, "duplicates": 0}</pre>
<pre>${INGEST_BODY}</pre>
<p>Doğrulanan alanlar: <code>schema</code> <code>freeband.v1</code>, <code>event</code> <code>sync.completed</code> ya da <code>sync.partial</code>, <code>device.id</code> UUID, <code>device.model</code> <code>band10</code> ya da <code>band10pro</code>, <code>heart_rate</code> 0–250, <code>level</code> 0–100, <code>steps</code> 0–200 000, <code>calories</code> 0–50 000, <code>standing_hours</code> 0–24, <code>ts</code> en fazla 2 gün ileride. Bir hesapta en fazla 10 bant olabilir. <code>device.tz</code> gelirse hesabın saat dilimi ona göre güncellenir.</p>
<p><code>sync.partial</code>, senkron yarıda kaldığında (ör. 20 dosyadan 12'si okunduğunda) gönderilir. Gövdedeki örnekler geçerlidir ve saklanır; kalanı sonraki senkronda gelir. Webhook'lara aynı olay adıyla iletilir.</p>
<p>Sözleşme yalnız ekleyerek büyür. Hub tanımadığı bir türdeki örneği reddetmez, atlar ve cevapta sayar: <code>{"accepted": 1, "duplicates": 0, "ignored": 2}</code> (<code>ignored</code> yalnız 0'dan büyükse gelir). Tanınan bir türde tek bir geçersiz alan bütün gövdeyi <code>400 invalid_body</code> ile reddeder; hata mesajı alanın yolunu verir (ör. <code>samples[3].heart_rate</code>).</p>

<h2 id="saglik">Sağlık verisi: dakika, uyku, skor</h2>
<p>Uygulama bandın aktivite dosyalarını çözünce üç tür daha gönderir. Üçü de üzerine yazılır: aynı <code>(device.id, type, ts)</code> yeniden gelirse son gelen kazanır ve satırın tamamı yenisiyle değişir. Değişmeden gelen satır <code>duplicates</code>'e sayılır ve webhook'ları yeniden tetiklemez. Nabız 30–220, SpO2 70–100, stres 1–100 aralığındadır; ölçülmeyen isteğe bağlı alan gönderilmez ya da <code>null</code> olur.</p>
<pre>${HEALTH_SAMPLES}</pre>
<ul>
  <li><code>minute</code>: <code>ts</code> dakikanın başı (saniye 0). <code>steps</code> 0–1000; isteğe bağlı <code>heart_rate</code>, <code>spo2</code>, <code>stress</code>, <code>active_calories</code> (0–100 kcal), <code>distance_m</code> (0–1000). Yalnız boş olmayan dakikalar gönderilir; bir gövdede en fazla bir gün önerilir.</li>
  <li><code>sleep</code>: <code>ts</code> yatış, <code>end</code> kalkış (en fazla 24 saat). <code>minutes</code> evre dakikaları, <code>efficiency</code> yüzde, <code>stages</code> <code>[yatıştan dakika, evre, süre]</code> üçlüleri (<code>deep</code>, <code>light</code>, <code>rem</code>, <code>awake</code>). <code>hr_min</code>, <code>spo2_avg</code>, <code>spo2_min</code> ölçülmediyse <code>null</code>; <code>hrv_rmssd</code> yalnız RR varsa. Gece, uyandığın güne aittir.</li>
  <li><code>score</code>: <code>ts</code>, <code>date</code> gününün yerel gece yarısı. <code>sleep</code> ve <code>recovery</code> 0–100, <code>strain</code> 0–21, hepsi <code>null</code> olabilir. <code>confidence</code> her skor için <code>high</code>, <code>medium</code>, <code>low</code> ya da <code>none</code>. <code>contributors</code> katkı satırları (<code>key</code> gerekli; <code>score</code>, <code>weight</code>, <code>value</code>, <code>unit</code>, <code>subscore</code>, <code>baseline</code>, <code>note</code> isteğe bağlı). <code>algo</code> algoritmanın sürümü.</li>
</ul>

<h2 id="okuma">Veriyi okuma</h2>
<h3>Ham örnekler</h3>
<p><code>GET /v1/samples</code> canlı ve pil örneklerini zamana göre artan sırada döner. Parametreler: <code>device</code> (bant kimliği; verilmezse tüm bantlar), <code>type</code> (<code>live</code> ya da <code>battery</code>), <code>from</code>, <code>to</code>, <code>limit</code> (varsayılan 1000, en fazla 5000). <code>from</code> ve <code>to</code> ya ISO 8601 zaman (<code>from</code> dahil, <code>to</code> hariç) ya da hesabın saat dilimine göre <code>YYYY-MM-DD</code> gün (iki uç da dahil) olabilir. <code>has_more</code> doğruysa son örneğin zamanını yeni <code>from</code> olarak kullan.</p>
<pre>curl "${origin}/v1/samples?type=live&from=2026-10-13&to=2026-10-13" ${H}

{"samples": [{"device_id": "5B0E2C9A-…", "type": "live", "ts": "2026-10-13T20:59:41Z",
  "steps": 8421, "calories": 312, "heart_rate": 74, "standing_hours": 9}],
 "has_more": false}</pre>

<h3>Dakikalar</h3>
<p><code>GET /v1/minutes</code> dakikaları zamana göre artan sırada döner. Parametreler: <code>device</code>, <code>from</code>, <code>to</code> (ham örneklerdeki gibi), <code>limit</code> (varsayılan 1440, en fazla 5000) ve <code>after</code>. <code>has_more</code> doğruysa aynı isteği <code>after=</code> ve cevaptaki <code>next</code> değeriyle tekrarla; birden çok bant aynı dakikayı paylaşsa da hiçbir satır atlanmaz.</p>
<pre>curl "${origin}/v1/minutes?from=2026-10-13&to=2026-10-13" ${H}

{"minutes": [{"device_id": "5B0E2C9A-…", "type": "minute", "ts": "2026-10-13T07:42:00Z",
  "steps": 112, "heart_rate": 96, "spo2": 97, "stress": 34, "active_calories": 6, "distance_m": 84}],
 "has_more": true, "next": "…"}

curl "${origin}/v1/minutes?from=2026-10-13&to=2026-10-13&after=…" ${H}</pre>

<h3>Uyku</h3>
<p><code>GET /v1/sleep</code> uyku oturumlarını döner. <code>from</code> ve <code>to</code> kalkış zamanına (<code>end</code>) uygulanır: <code>from=2026-10-13&amp;to=2026-10-13</code> 12'sini 13'üne bağlayan geceyi ve 13'ündeki şekerlemeleri verir. <code>limit</code> varsayılan 100, en fazla 1000; sayfalama dakikalardaki gibi.</p>
<pre>curl "${origin}/v1/sleep?from=2026-10-13&to=2026-10-13" ${H}

{"sleep": [{"device_id": "5B0E2C9A-…", "type": "sleep", "ts": "2026-10-12T20:41:00Z", "end": "2026-10-13T04:12:00Z",
  "is_nap": false, "minutes": {"deep": 82, "light": 241, "rem": 96, "awake": 32}, "wake_count": 3, "efficiency": 93,
  "stages": [[0, "light", 14], [14, "deep", 38]], "hr_min": 48, "spo2_avg": 96.4, "spo2_min": 91, "hrv_rmssd": 42}],
 "has_more": false, "next": null}</pre>

<h3>Skorlar</h3>
<p><code>GET /v1/scores</code> günlük skorları kendi <code>date</code> alanına göre döner. <code>from</code> ve <code>to</code> yalnız <code>YYYY-MM-DD</code> olabilir (iki uç dahil); verilmezse sınır yok. <code>limit</code> varsayılan 366, en fazla 1000; sayfalama dakikalardaki gibi.</p>
<pre>curl "${origin}/v1/scores?from=2026-10-01&to=2026-10-13" ${H}

{"scores": [{"device_id": "5B0E2C9A-…", "type": "score", "ts": "2026-10-12T21:00:00Z", "date": "2026-10-13",
  "sleep": 82, "recovery": 64, "strain": 11.4, "rhr": 54, "hrv_rmssd": 41.5,
  "confidence": {"sleep": "high", "recovery": "medium", "strain": "low"},
  "contributors": [{"score": "sleep", "key": "duration", "weight": 35, "value": 431, "unit": "min", "subscore": 88}],
  "algo": "freeband-score/1"}],
 "has_more": false, "next": null}</pre>

<h3>Günlük özet</h3>
<p><code>GET /v1/days</code> her gün ve her bant için bir satır döner; günler hesabın saat dilimine göredir. <code>steps</code>, canlı örneklerin birikimli en büyük değeri ile dakika adımlarının toplamından büyük olanıdır. <code>calories</code> canlı örneklerden gelir. Nabız özetleri canlı örnekleri ve dakikaları birlikte kullanır ve yalnız 30–220 bpm arasını sayar. Varsa <code>sleep_minutes</code> (o gün biten gece uykusunun derin + hafif + REM dakikaları), <code>nap_minutes</code> (o gün biten şekerlemeler) ve <code>score</code> (o günün skorları) da gelir. Hiç verisi olmayan günler listede yer almaz. Varsayılan aralık bugün dahil son 14 gün, en fazla 366 gün.</p>
<pre>curl "${origin}/v1/days?from=2026-10-01&to=2026-10-13" ${H}

{"tz": "Europe/Istanbul", "from": "2026-10-01", "to": "2026-10-13", "days": [
  {"date": "2026-10-13", "device_id": "5B0E2C9A-…", "steps": 8421, "calories": 312,
   "heart_rate_min": 52, "heart_rate_max": 131, "heart_rate_avg": 74, "battery_last": 46,
   "sleep_minutes": 419, "nap_minutes": 35,
   "score": {"sleep": 82, "recovery": 64, "strain": 11.4, "rhr": 54, "hrv_rmssd": 41.5,
             "confidence": {"sleep": "high", "recovery": "medium", "strain": "low"}, "algo": "freeband-score/1"}}]}</pre>

<h3>Dışa aktarma</h3>
<p><code>GET /v1/export.csv</code> ve <code>GET /v1/export.json</code>, <code>/v1/samples</code> ile aynı <code>from</code>, <code>to</code> ve <code>device</code> parametrelerini alır; <code>type</code> <code>live</code>, <code>battery</code>, <code>minute</code>, <code>sleep</code> ya da <code>score</code> olabilir. Parametresiz çağrı tüm veriyi verir. Her satır <code>device_id</code> taşır. Tek seferde toplam en fazla 200 000 satır; daha fazlası için aralığı böl.</p>
<p>JSON her türü içerir: <code>samples</code> (canlı ve pil), <code>minutes</code>, <code>sleep</code> ve <code>scores</code> dizileri, okuma uç noktalarındaki biçimde. CSV düz bir tablo olduğu için her tür kendi dosyasındadır: varsayılan CSV canlı ve pil örnekleridir; <code>type=minute</code>, <code>type=sleep</code> ve <code>type=score</code> kendi sütunlarıyla gelir. Uyku evreleri ve skor katkıları CSV'de tırnaklı JSON hücresidir.</p>
<pre>curl -o freeband.csv "${origin}/v1/export.csv?from=2026-10-01" ${H}

device_id,type,ts,steps,calories,heart_rate,standing_hours,level
5B0E2C9A-…,battery,2026-10-13T20:59:40Z,,,,,46
5B0E2C9A-…,live,2026-10-13T20:59:41Z,8421,312,74,9,

curl -o dakikalar.csv "${origin}/v1/export.csv?type=minute&from=2026-10-01" ${H}

device_id,type,ts,steps,heart_rate,spo2,stress,active_calories,distance_m
5B0E2C9A-…,minute,2026-10-13T07:42:00Z,112,96,97,34,6,84

curl -o uyku.csv "${origin}/v1/export.csv?type=sleep" ${H}
curl -o skorlar.csv "${origin}/v1/export.csv?type=score" ${H}
curl -o freeband.json "${origin}/v1/export.json" ${H}</pre>

<h2 id="webhook">Webhook'lar</h2>
<p>Hub, her başarılı gönderimden sonra (en az bir yeni ya da değişen satır varsa) doğruladığı gövdeyi, gövdenin olayıyla (<code>sync.completed</code> ya da <code>sync.partial</code>) hesabın webhook'larına POST eder. Hub'ın tanımadığı türler iletilmez. Adres yalnız <code>https://</code> olabilir, hub'ın kendi alan adı, IP adresleri ve yerel adlar kabul edilmez. Hesap başına en fazla 5 webhook. Yönlendirmeler izlenmez, zaman aşımı 5 saniyedir, şimdilik yeniden deneme yoktur. Aynı örnek iki kez gelebilir; alıcı <code>(device.id, type, ts)</code> ile tekilleştirmeli, <code>minute</code>, <code>sleep</code> ve <code>score</code> için son geleni saklamalı, tanımadığı türleri atlamalı.</p>
<pre>curl -X POST ${origin}/v1/webhooks ${H} \\
  -H "Content-Type: application/json" \\
  -d '{"url": "https://ornek.com/freeband"}'

{"id": "…", "url": "https://ornek.com/freeband", "secret": "fbwh_…", "created_at": "…"}</pre>
<p>Gizli değer yalnız bu cevapta bir kez döner; sunucuda şifreli tutulur ve bir daha gösterilmez.</p>
<pre>curl ${origin}/v1/webhooks ${H}
curl ${origin}/v1/webhooks/ID ${H}
curl -X POST ${origin}/v1/webhooks/ID/test ${H}
curl -X DELETE ${origin}/v1/webhooks/ID ${H}</pre>
<p>Test isteği <code>X-Freeband-Event: ping</code> ile şu gövdeyi gönderir: <code>{"schema": "freeband.v1", "event": "ping", "sent_at": "…", "webhook_id": "…"}</code>. Cevap <code>{"delivered", "status", "error"}</code> olur.</p>

<h3 id="imza">İmzayı doğrulama</h3>
<p>Her istek şu başlıklarla gelir:</p>
<ul>
  <li><code>Content-Type: application/json</code></li>
  <li><code>X-Freeband-Event</code>: <code>sync.completed</code>, <code>sync.partial</code> ya da <code>ping</code></li>
  <li><code>X-Freeband-Delivery</code>: her gönderim için rastgele bir UUID</li>
  <li><code>X-Freeband-Signature</code>: <code>sha256=</code> ve gövdenin HMAC-SHA256 özeti (küçük harf hex). Anahtar, gizli değerin UTF-8 baytlarıdır.</li>
</ul>
<p>İmzayı gövdeyi ayrıştırmadan önce, ham baytlar üzerinden ve sabit zamanlı karşılaştırmayla doğrula.</p>
<p>Node.js:</p>
<pre>${NODE_VERIFY}</pre>
<p>Python:</p>
<pre>${PY_VERIFY}</pre>

<h2 id="oturum">Web paneli oturumu</h2>
<p><code>POST /v1/session</code> gövdesi <code>{"token": "fb_…"}</code> olan bir istekle 30 gün geçerli bir oturum çerezi verir (<code>HttpOnly; Secure; SameSite=Strict</code>). <code>DELETE /v1/session</code> çıkış yapar. Bu iki uç nokta yalnız panel sayfalarından çağrılabilir; çerezle yapılan veri değiştiren istekler de aynı kaynaktan gelmek zorundadır.</p>
</article>
</div>
`;
}

const NODE_VERIFY_EN = NODE_VERIFY.replace("// imzayı ham gövde üzerinden doğrula", "// verify the signature over the raw body").replace(
  "// Tanımadığın türleri atla; minute/sleep/score için son geleni sakla.",
  "// Skip types you don't know; keep the latest minute/sleep/score.",
);
const PY_VERIFY_EN = PY_VERIFY.replace(
  "# Tanımadığın türleri atla; minute/sleep/score için son geleni sakla.",
  "# Skip types you don't know; keep the latest minute/sleep/score.",
);
const HEALTH_SAMPLES_EN = HEALTH_SAMPLES.replace('"note": "RR yok"', '"note": "no RR"');

function docsEN(origin: string): Safe {
  const H = `-H "Authorization: Bearer $FREEBAND_TOKEN"`;
  return html`
<div class="doc">
<nav class="toc" aria-label="Sections">
  <span class="label">sections</span>
  <a href="#kimlik">Authentication</a><a href="#hesap">Account</a><a href="#gonderim">Sending data</a><a href="#saglik">Health data</a><a href="#okuma">Reading data</a><a href="#webhook">Webhooks</a><a href="#imza">Verifying signatures</a><a href="#oturum">Panel session</a>
</nav>
<article class="prose">
<p class="label">freeband.v1</p>
<h1>API docs</h1>
<p class="lede">The Freeband hub opens your data through a REST API and signed webhooks. This page covers the hub's side of the contract (freeband.v1).</p>
<p>All times are ISO 8601 UTC, for example <code>2026-10-13T20:59:41Z</code>. Base address: <code>${origin}</code></p>

<h2 id="kimlik">Authentication</h2>
<p>Every request carries your personal key: <code>Authorization: Bearer fb_...</code>. The app creates the key when you turn on Web access. The server keeps only its SHA-256 hash, not the key itself; if you lose the key, make a new one.</p>
<pre>export FREEBAND_TOKEN=fb_...
curl ${origin}/v1/me ${H}</pre>
<p>Error responses always look the same: <code>{"error": "code", "message": "explanation"}</code>. Common codes: 400 <code>invalid_body</code> or <code>invalid_query</code>, 401 <code>unauthorized</code>, 403 <code>cross_origin</code>, 404 <code>not_found</code>, 409, 413, 415, 429 <code>rate_limited</code> (with a <code>Retry-After</code> header). Messages are in Turkish for now.</p>
<p>The API isn't open to other websites calling it from a browser (no CORS headers). Call it from your own server, scripts or the command line.</p>

<h2 id="hesap">Account</h2>
<h3>Create an account</h3>
<p>The app does this itself when you turn on Web access. The key comes back once, only in this response. Limited to 10 requests per IP per hour.</p>
<pre>curl -X POST ${origin}/v1/accounts \\
  -H "Content-Type: application/json" \\
  -d '{"device_name": "Xiaomi Smart Band 10 Pro D9B9", "tz": "Europe/Istanbul"}'

{"account_id": "…", "token": "fb_…", "web_url": "${origin}/login"}</pre>
<p>To go straight to the web panel, add <code>#token=</code> and the key to the end of <code>web_url</code>. The key stays in the URL fragment (#), so it never reaches the server; the page turns it into a session cookie and removes it from the address bar.</p>

<h3>Account details</h3>
<pre>curl ${origin}/v1/me ${H}

{"account_id": "…", "name": "…", "tz": "Europe/Istanbul", "created_at": "…",
 "samples": {"live": 1520, "battery": 44, "minute": 8640, "sleep": 6, "score": 6, "total": 10216},
 "devices": [{"id": "5B0E2C9A-…", "name": "Xiaomi Smart Band 10 Pro D9B9", "model": "band10pro", "last_seen": "…"}],
 "webhooks": 1}</pre>

<h3>Renew the key</h3>
<p>Returns a new key; the old one stops working right away. Other web sessions end. Paste the new key into <strong>Settings → Web access → Enter API key</strong> in Freeband on your phone; until then the app can't send data.</p>
<pre>curl -X POST ${origin}/v1/token/rotate ${H}</pre>

<h3>Delete the account</h3>
<p>Deletes the account, all samples, minute, sleep and score records, band records, webhooks and sessions for good.</p>
<pre>curl -X DELETE ${origin}/v1/account ${H}</pre>

<h2 id="gonderim">Sending data</h2>
<p><code>POST /v1/ingest</code> is the endpoint the app uses. A body can be at most 512 KB and 5000 samples, and belongs to one band. Each sample is unique by <code>(device.id, type, ts)</code>. Repeated <code>live</code> and <code>battery</code> samples are counted but not stored; a repeated <code>minute</code>, <code>sleep</code> or <code>score</code> replaces the old one (below). Each account can send 120 requests per hour and 200,000 samples per day.</p>
<pre>curl -X POST ${origin}/v1/ingest ${H} \\
  -H "Content-Type: application/json" \\
  --data-binary @sync.json

{"accepted": 2, "duplicates": 0}</pre>
<pre>${INGEST_BODY}</pre>
<p>Validated fields: <code>schema</code> <code>freeband.v1</code>, <code>event</code> <code>sync.completed</code> or <code>sync.partial</code>, <code>device.id</code> a UUID, <code>device.model</code> <code>band10</code> or <code>band10pro</code>, <code>heart_rate</code> 0–250, <code>level</code> 0–100, <code>steps</code> 0–200,000, <code>calories</code> 0–50,000, <code>standing_hours</code> 0–24, <code>ts</code> at most 2 days in the future. An account can have at most 10 bands. If <code>device.tz</code> is present, the account's time zone follows it.</p>
<p><code>sync.partial</code> is sent when a sync stops halfway (say, 12 of 20 files read). The samples in the body are valid and stored; the rest come with the next sync. Webhooks get it under the same event name.</p>
<p>The contract only grows by adding. The hub doesn't reject samples of a type it doesn't know: it skips them and counts them in the response, <code>{"accepted": 1, "duplicates": 0, "ignored": 2}</code> (<code>ignored</code> appears only when above 0). One invalid field in a known type rejects the whole body with <code>400 invalid_body</code>; the message names the field's path (e.g. <code>samples[3].heart_rate</code>).</p>

<h2 id="saglik">Health data: minutes, sleep, scores</h2>
<p>Once the app has parsed the band's activity files, it sends three more types. All three are overwritten: if the same <code>(device.id, type, ts)</code> comes again, the latest wins and the whole row is replaced. A row that arrives unchanged counts as a duplicate and doesn't trigger webhooks again. Heart rate is 30–220, SpO2 70–100 and stress 1–100; an optional field that wasn't measured is left out or <code>null</code>.</p>
<pre>${HEALTH_SAMPLES_EN}</pre>
<ul>
  <li><code>minute</code>: <code>ts</code> is the start of the minute (seconds 0). <code>steps</code> 0–1000; optional <code>heart_rate</code>, <code>spo2</code>, <code>stress</code>, <code>active_calories</code> (0–100 kcal), <code>distance_m</code> (0–1000). Only non-empty minutes are sent; at most one day per body is recommended.</li>
  <li><code>sleep</code>: <code>ts</code> is bedtime, <code>end</code> wake time (at most 24 hours later). <code>minutes</code> holds minutes per stage, <code>efficiency</code> a percentage, <code>stages</code> triples of <code>[minutes since bedtime, stage, duration]</code> (<code>deep</code>, <code>light</code>, <code>rem</code>, <code>awake</code>). <code>hr_min</code>, <code>spo2_avg</code> and <code>spo2_min</code> are <code>null</code> when not measured; <code>hrv_rmssd</code> only when there is RR data. A night belongs to the day you wake up.</li>
  <li><code>score</code>: <code>ts</code> is local midnight of <code>date</code>. <code>sleep</code> and <code>recovery</code> 0–100, <code>strain</code> 0–21, each may be <code>null</code>. <code>confidence</code> is <code>high</code>, <code>medium</code>, <code>low</code> or <code>none</code> per score. <code>contributors</code> are the contributor rows (<code>key</code> required; <code>score</code>, <code>weight</code>, <code>value</code>, <code>unit</code>, <code>subscore</code>, <code>baseline</code>, <code>note</code> optional). <code>algo</code> is the algorithm version.</li>
</ul>

<h2 id="okuma">Reading data</h2>
<h3>Raw samples</h3>
<p><code>GET /v1/samples</code> returns live and battery samples in ascending time. Parameters: <code>device</code> (band ID; all bands if left out), <code>type</code> (<code>live</code> or <code>battery</code>), <code>from</code>, <code>to</code>, <code>limit</code> (default 1000, at most 5000). <code>from</code> and <code>to</code> are either ISO 8601 times (<code>from</code> included, <code>to</code> excluded) or <code>YYYY-MM-DD</code> days in the account's time zone (both ends included). If <code>has_more</code> is true, use the last sample's time as the new <code>from</code>.</p>
<pre>curl "${origin}/v1/samples?type=live&from=2026-10-13&to=2026-10-13" ${H}

{"samples": [{"device_id": "5B0E2C9A-…", "type": "live", "ts": "2026-10-13T20:59:41Z",
  "steps": 8421, "calories": 312, "heart_rate": 74, "standing_hours": 9}],
 "has_more": false}</pre>

<h3>Minutes</h3>
<p><code>GET /v1/minutes</code> returns minutes in ascending time. Parameters: <code>device</code>, <code>from</code>, <code>to</code> (as for raw samples), <code>limit</code> (default 1440, at most 5000) and <code>after</code>. If <code>has_more</code> is true, repeat the request with <code>after=</code> set to the <code>next</code> value from the response; no row is skipped even when several bands share a minute.</p>
<pre>curl "${origin}/v1/minutes?from=2026-10-13&to=2026-10-13" ${H}

{"minutes": [{"device_id": "5B0E2C9A-…", "type": "minute", "ts": "2026-10-13T07:42:00Z",
  "steps": 112, "heart_rate": 96, "spo2": 97, "stress": 34, "active_calories": 6, "distance_m": 84}],
 "has_more": true, "next": "…"}

curl "${origin}/v1/minutes?from=2026-10-13&to=2026-10-13&after=…" ${H}</pre>

<h3>Sleep</h3>
<p><code>GET /v1/sleep</code> returns sleep sessions. <code>from</code> and <code>to</code> apply to the wake time (<code>end</code>): <code>from=2026-10-13&amp;to=2026-10-13</code> gives the night from the 12th to the 13th and the naps on the 13th. <code>limit</code> defaults to 100, at most 1000; paging works as for minutes.</p>
<pre>curl "${origin}/v1/sleep?from=2026-10-13&to=2026-10-13" ${H}

{"sleep": [{"device_id": "5B0E2C9A-…", "type": "sleep", "ts": "2026-10-12T20:41:00Z", "end": "2026-10-13T04:12:00Z",
  "is_nap": false, "minutes": {"deep": 82, "light": 241, "rem": 96, "awake": 32}, "wake_count": 3, "efficiency": 93,
  "stages": [[0, "light", 14], [14, "deep", 38]], "hr_min": 48, "spo2_avg": 96.4, "spo2_min": 91, "hrv_rmssd": 42}],
 "has_more": false, "next": null}</pre>

<h3>Scores</h3>
<p><code>GET /v1/scores</code> returns daily scores by their own <code>date</code>. <code>from</code> and <code>to</code> can only be <code>YYYY-MM-DD</code> (both ends included); without them there's no limit. <code>limit</code> defaults to 366, at most 1000; paging works as for minutes.</p>
<pre>curl "${origin}/v1/scores?from=2026-10-01&to=2026-10-13" ${H}

{"scores": [{"device_id": "5B0E2C9A-…", "type": "score", "ts": "2026-10-12T21:00:00Z", "date": "2026-10-13",
  "sleep": 82, "recovery": 64, "strain": 11.4, "rhr": 54, "hrv_rmssd": 41.5,
  "confidence": {"sleep": "high", "recovery": "medium", "strain": "low"},
  "contributors": [{"score": "sleep", "key": "duration", "weight": 35, "value": 431, "unit": "min", "subscore": 88}],
  "algo": "freeband-score/1"}],
 "has_more": false, "next": null}</pre>

<h3>Daily summary</h3>
<p><code>GET /v1/days</code> returns one row per day and band; days follow the account's time zone. <code>steps</code> is the larger of the live samples' cumulative maximum and the sum of minute steps. <code>calories</code> comes from live samples. Heart rate summaries use live samples and minutes together and count only 30–220 bpm. When present, <code>sleep_minutes</code> (deep + light + REM minutes of the night ending that day), <code>nap_minutes</code> (naps ending that day) and <code>score</code> (that day's scores) are included. Days without any data aren't listed. The default range is the last 14 days including today, at most 366 days.</p>
<pre>curl "${origin}/v1/days?from=2026-10-01&to=2026-10-13" ${H}

{"tz": "Europe/Istanbul", "from": "2026-10-01", "to": "2026-10-13", "days": [
  {"date": "2026-10-13", "device_id": "5B0E2C9A-…", "steps": 8421, "calories": 312,
   "heart_rate_min": 52, "heart_rate_max": 131, "heart_rate_avg": 74, "battery_last": 46,
   "sleep_minutes": 419, "nap_minutes": 35,
   "score": {"sleep": 82, "recovery": 64, "strain": 11.4, "rhr": 54, "hrv_rmssd": 41.5,
             "confidence": {"sleep": "high", "recovery": "medium", "strain": "low"}, "algo": "freeband-score/1"}}]}</pre>

<h3>Export</h3>
<p><code>GET /v1/export.csv</code> and <code>GET /v1/export.json</code> take the same <code>from</code>, <code>to</code> and <code>device</code> parameters as <code>/v1/samples</code>; <code>type</code> can be <code>live</code>, <code>battery</code>, <code>minute</code>, <code>sleep</code> or <code>score</code>. Without parameters you get everything. Every row carries <code>device_id</code>. At most 200,000 rows in total per call; split the range for more.</p>
<p>JSON has every type: <code>samples</code> (live and battery), <code>minutes</code>, <code>sleep</code> and <code>scores</code> arrays, in the same shape as the read endpoints. CSV is a flat table, so each type has its own file: the default CSV is live and battery samples; <code>type=minute</code>, <code>type=sleep</code> and <code>type=score</code> come with their own columns. Sleep stages and score contributors are quoted JSON cells in the CSV.</p>
<pre>curl -o freeband.csv "${origin}/v1/export.csv?from=2026-10-01" ${H}

device_id,type,ts,steps,calories,heart_rate,standing_hours,level
5B0E2C9A-…,battery,2026-10-13T20:59:40Z,,,,,46
5B0E2C9A-…,live,2026-10-13T20:59:41Z,8421,312,74,9,

curl -o minutes.csv "${origin}/v1/export.csv?type=minute&from=2026-10-01" ${H}

device_id,type,ts,steps,heart_rate,spo2,stress,active_calories,distance_m
5B0E2C9A-…,minute,2026-10-13T07:42:00Z,112,96,97,34,6,84

curl -o sleep.csv "${origin}/v1/export.csv?type=sleep" ${H}
curl -o scores.csv "${origin}/v1/export.csv?type=score" ${H}
curl -o freeband.json "${origin}/v1/export.json" ${H}</pre>

<h2 id="webhook">Webhooks</h2>
<p>After every successful upload (with at least one new or changed row), the hub POSTs the validated body to the account's webhooks with the body's event (<code>sync.completed</code> or <code>sync.partial</code>). Types the hub doesn't know aren't forwarded. The address must be <code>https://</code>; the hub's own domain, IP addresses and local names aren't accepted. At most 5 webhooks per account. Redirects aren't followed, the timeout is 5 seconds, and there are no retries for now. The same sample can arrive twice; the receiver should dedupe by <code>(device.id, type, ts)</code>, keep the latest <code>minute</code>, <code>sleep</code> and <code>score</code>, and skip types it doesn't know.</p>
<pre>curl -X POST ${origin}/v1/webhooks ${H} \\
  -H "Content-Type: application/json" \\
  -d '{"url": "https://example.com/freeband"}'

{"id": "…", "url": "https://example.com/freeband", "secret": "fbwh_…", "created_at": "…"}</pre>
<p>The secret comes back once, only in this response; the server keeps it encrypted and never shows it again.</p>
<pre>curl ${origin}/v1/webhooks ${H}
curl ${origin}/v1/webhooks/ID ${H}
curl -X POST ${origin}/v1/webhooks/ID/test ${H}
curl -X DELETE ${origin}/v1/webhooks/ID ${H}</pre>
<p>The test request sends this body with <code>X-Freeband-Event: ping</code>: <code>{"schema": "freeband.v1", "event": "ping", "sent_at": "…", "webhook_id": "…"}</code>. The response is <code>{"delivered", "status", "error"}</code>.</p>

<h3 id="imza">Verifying the signature</h3>
<p>Every request comes with these headers:</p>
<ul>
  <li><code>Content-Type: application/json</code></li>
  <li><code>X-Freeband-Event</code>: <code>sync.completed</code>, <code>sync.partial</code> or <code>ping</code></li>
  <li><code>X-Freeband-Delivery</code>: a random UUID per delivery</li>
  <li><code>X-Freeband-Signature</code>: <code>sha256=</code> and the HMAC-SHA256 of the body (lowercase hex). The key is the UTF-8 bytes of the secret.</li>
</ul>
<p>Verify the signature before parsing the body, over the raw bytes, with a constant-time comparison.</p>
<p>Node.js:</p>
<pre>${NODE_VERIFY_EN}</pre>
<p>Python:</p>
<pre>${PY_VERIFY_EN}</pre>

<h2 id="oturum">Web panel session</h2>
<p><code>POST /v1/session</code> with the body <code>{"token": "fb_…"}</code> gives a session cookie valid for 30 days (<code>HttpOnly; Secure; SameSite=Strict</code>). <code>DELETE /v1/session</code> signs out. Only the panel pages can call these two endpoints; requests that change data with the cookie must also come from the same origin.</p>
</article>
</div>
`;
}

export const DOCS_TITLE: Record<Lang, string> = { en: "API docs", tr: "API belgesi" };

export function docsBody(origin: string, lang: Lang): Safe {
  return lang === "en" ? docsEN(origin) : docsTR(origin);
}
