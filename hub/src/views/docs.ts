// /docs: API reference with curl examples and signature verification snippets.

import { html, type Safe } from "./html";

const NODE_VERIFY = `import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";

const SECRET = process.env.OPENBAND_WEBHOOK_SECRET; // obwh_...

http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks); // imzayı ham gövde üzerinden doğrula
    const expected = Buffer.from(
      "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex"),
    );
    const got = Buffer.from(req.headers["x-openband-signature"] ?? "");
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      res.writeHead(401).end();
      return;
    }
    const body = JSON.parse(raw.toString("utf8"));
    if (body.event === "sync.completed") {
      console.log(body.device.id, body.samples.length);
    }
    res.writeHead(204).end();
  });
}).listen(8080);`;

const PY_VERIFY = `import hashlib, hmac, json, os
from http.server import BaseHTTPRequestHandler, HTTPServer

SECRET = os.environ["OPENBAND_WEBHOOK_SECRET"].encode()  # obwh_...

class Hook(BaseHTTPRequestHandler):
    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        expected = "sha256=" + hmac.new(SECRET, raw, hashlib.sha256).hexdigest()
        got = self.headers.get("X-OpenBand-Signature", "")
        if not hmac.compare_digest(got, expected):
            self.send_response(401)
            self.end_headers()
            return
        body = json.loads(raw)
        if body["event"] == "sync.completed":
            print(body["device"]["id"], len(body["samples"]))
        self.send_response(204)
        self.end_headers()

HTTPServer(("", 8080), Hook).serve_forever()`;

const INGEST_BODY = `{
  "schema": "openband.v1",
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

export function docsBody(origin: string): Safe {
  const H = `-H "Authorization: Bearer $OPENBAND_TOKEN"`;
  return html`
<h1>API belgesi</h1>
<p>OpenBand hub'ı verine bir REST API ve imzalı webhook'larla açar. Bu sayfa sözleşmenin (openband.v1) hub tarafını anlatır. Tüm zamanlar ISO 8601 UTC'dir, örneğin <code>2026-10-13T20:59:41Z</code>.</p>
<p>Taban adres: <code>${origin}</code></p>

<h2 id="kimlik">Kimlik doğrulama</h2>
<p>Her istek kişisel anahtarınla gelir: <code>Authorization: Bearer ob_...</code>. Anahtarı uygulama, Web erişimini açtığında oluşturur. Sunucuda anahtarın kendisi değil, yalnız SHA-256 özeti tutulur; anahtarı kaybedersen yenisini oluşturman gerekir.</p>
<pre>export OPENBAND_TOKEN=ob_...
curl ${origin}/v1/me ${H}</pre>
<p>Hata cevapları hep aynı biçimdedir: <code>{"error": "kod", "message": "açıklama"}</code>. Sık görülen kodlar: 400 <code>invalid_body</code> ya da <code>invalid_query</code>, 401 <code>unauthorized</code>, 403 <code>cross_origin</code>, 404 <code>not_found</code>, 409, 413, 415, 429 <code>rate_limited</code> (<code>Retry-After</code> başlığıyla).</p>
<p>API tarayıcıdan başka sitelerin çağırması için açık değildir (CORS başlığı yok). Kendi sunucundan, betiklerinden ya da komut satırından çağır.</p>

<h2 id="hesap">Hesap</h2>
<h3>Hesap oluştur</h3>
<p>Uygulama bunu Web erişimini açtığında kendisi yapar. Anahtar yalnız bu cevapta bir kez döner. IP başına saatte 10 istekle sınırlıdır.</p>
<pre>curl -X POST ${origin}/v1/accounts \\
  -H "Content-Type: application/json" \\
  -d '{"device_name": "Xiaomi Smart Band 10 Pro D9B9", "tz": "Europe/Istanbul"}'

{"account_id": "…", "token": "ob_…", "web_url": "${origin}/login"}</pre>
<p>Web paneline doğrudan girmek için <code>web_url</code> adresinin sonuna <code>#token=</code> ve anahtarı ekle. Anahtar URL parçasında (#) kaldığı için sunucuya gitmez; sayfa onu oturum çerezine çevirir ve adres çubuğundan siler.</p>

<h3>Hesap bilgisi</h3>
<pre>curl ${origin}/v1/me ${H}

{"account_id": "…", "name": "…", "tz": "Europe/Istanbul", "created_at": "…",
 "samples": {"live": 1520, "battery": 44, "total": 1564},
 "devices": [{"id": "5B0E2C9A-…", "name": "Xiaomi Smart Band 10 Pro D9B9", "model": "band10pro", "last_seen": "…"}],
 "webhooks": 1}</pre>

<h3>Anahtarı yenile</h3>
<p>Yeni anahtar döner, eskisi hemen geçersiz olur. Diğer web oturumları kapanır.</p>
<pre>curl -X POST ${origin}/v1/token/rotate ${H}</pre>

<h3>Hesabı sil</h3>
<p>Hesabı, tüm örnekleri, bant kayıtlarını, webhook'ları ve oturumları kalıcı olarak siler.</p>
<pre>curl -X DELETE ${origin}/v1/account ${H}</pre>

<h2 id="gonderim">Veri gönderme</h2>
<p><code>POST /v1/ingest</code> uygulamanın kullandığı uç noktadır. Gövde en fazla 512 KB ve 5000 örnek olabilir. Her gövde tek bir banda aittir. Her örnek <code>(device.id, type, ts)</code> ile tekildir; aynısı tekrar gelirse sayılır ama saklanmaz. Hesap başına saatte 120 istek ve günde 200 000 örnek kabul edilir.</p>
<pre>curl -X POST ${origin}/v1/ingest ${H} \\
  -H "Content-Type: application/json" \\
  --data-binary @sync.json

{"accepted": 2, "duplicates": 0}</pre>
<pre>${INGEST_BODY}</pre>
<p>Doğrulanan alanlar: <code>schema</code> <code>openband.v1</code>, <code>event</code> <code>sync.completed</code>, <code>device.id</code> UUID, <code>device.model</code> <code>band10</code> ya da <code>band10pro</code>, <code>heart_rate</code> 0–250, <code>level</code> 0–100, <code>steps</code> 0–200 000, <code>calories</code> 0–50 000, <code>standing_hours</code> 0–24, <code>ts</code> en fazla 2 gün ileride. Bir hesapta en fazla 10 bant olabilir. <code>device.tz</code> gelirse hesabın saat dilimi ona göre güncellenir.</p>

<h2 id="okuma">Veriyi okuma</h2>
<h3>Ham örnekler</h3>
<p><code>GET /v1/samples</code> örnekleri zamana göre artan sırada döner. Parametreler: <code>device</code> (bant kimliği; verilmezse tüm bantlar), <code>type</code> (<code>live</code> ya da <code>battery</code>), <code>from</code>, <code>to</code>, <code>limit</code> (varsayılan 1000, en fazla 5000). <code>from</code> ve <code>to</code> ya ISO 8601 zaman (<code>from</code> dahil, <code>to</code> hariç) ya da hesabın saat dilimine göre <code>YYYY-MM-DD</code> gün (iki uç da dahil) olabilir. <code>has_more</code> doğruysa son örneğin zamanını yeni <code>from</code> olarak kullan.</p>
<pre>curl "${origin}/v1/samples?type=live&from=2026-10-13&to=2026-10-13" ${H}

{"samples": [{"device_id": "5B0E2C9A-…", "type": "live", "ts": "2026-10-13T20:59:41Z",
  "steps": 8421, "calories": 312, "heart_rate": 74, "standing_hours": 9}],
 "has_more": false}</pre>

<h3>Günlük özet</h3>
<p><code>GET /v1/days</code> her gün ve her bant için bir satır döner; günler hesabın saat dilimine göredir. <code>steps</code> ve <code>calories</code> gün içinde birikimli geldiği için günün en büyük değeridir. Nabız özetleri 0 değerlerini (ölçülmedi) saymaz. Veri olmayan günler listede yer almaz. Varsayılan aralık bugün dahil son 14 gün, en fazla 366 gün.</p>
<pre>curl "${origin}/v1/days?from=2026-10-01&to=2026-10-13" ${H}

{"tz": "Europe/Istanbul", "from": "2026-10-01", "to": "2026-10-13", "days": [
  {"date": "2026-10-13", "device_id": "5B0E2C9A-…", "steps": 8421, "calories": 312,
   "heart_rate_min": 52, "heart_rate_max": 131, "heart_rate_avg": 74, "battery_last": 46}]}</pre>

<h3>Dışa aktarma</h3>
<p><code>GET /v1/export.csv</code> ve <code>GET /v1/export.json</code>, <code>/v1/samples</code> ile aynı <code>from</code>, <code>to</code>, <code>device</code>, <code>type</code> parametrelerini alır. Parametresiz çağrı tüm veriyi verir. Her satır <code>device_id</code> taşır. Tek seferde en fazla 200 000 örnek; daha fazlası için aralığı böl.</p>
<pre>curl -o openband.csv "${origin}/v1/export.csv?from=2026-10-01" ${H}

device_id,type,ts,steps,calories,heart_rate,standing_hours,level
5B0E2C9A-…,battery,2026-10-13T20:59:40Z,,,,,46
5B0E2C9A-…,live,2026-10-13T20:59:41Z,8421,312,74,9,</pre>

<h2 id="webhook">Webhook'lar</h2>
<p>Hub, her başarılı gönderimden sonra (en az bir yeni örnek varsa) aynı gövdeyi hesabın webhook'larına POST eder. Adres yalnız <code>https://</code> olabilir, hub'ın kendi alan adı, IP adresleri ve yerel adlar kabul edilmez. Hesap başına en fazla 5 webhook. Yönlendirmeler izlenmez, zaman aşımı 5 saniyedir, şimdilik yeniden deneme yoktur. Aynı örnek iki kez gelebilir; alıcı <code>(device.id, type, ts)</code> ile tekilleştirmeli.</p>
<pre>curl -X POST ${origin}/v1/webhooks ${H} \\
  -H "Content-Type: application/json" \\
  -d '{"url": "https://ornek.com/openband"}'

{"id": "…", "url": "https://ornek.com/openband", "secret": "obwh_…", "created_at": "…"}</pre>
<p>Gizli değer yalnız bu cevapta bir kez döner; sunucuda şifreli tutulur ve bir daha gösterilmez.</p>
<pre>curl ${origin}/v1/webhooks ${H}
curl ${origin}/v1/webhooks/ID ${H}
curl -X POST ${origin}/v1/webhooks/ID/test ${H}
curl -X DELETE ${origin}/v1/webhooks/ID ${H}</pre>
<p>Test isteği <code>X-OpenBand-Event: ping</code> ile şu gövdeyi gönderir: <code>{"schema": "openband.v1", "event": "ping", "sent_at": "…", "webhook_id": "…"}</code>. Cevap <code>{"delivered", "status", "error"}</code> olur.</p>

<h3 id="imza">İmzayı doğrulama</h3>
<p>Her istek şu başlıklarla gelir:</p>
<ul>
  <li><code>Content-Type: application/json</code></li>
  <li><code>X-OpenBand-Event</code>: <code>sync.completed</code> ya da <code>ping</code></li>
  <li><code>X-OpenBand-Delivery</code>: her gönderim için rastgele bir UUID</li>
  <li><code>X-OpenBand-Signature</code>: <code>sha256=</code> ve gövdenin HMAC-SHA256 özeti (küçük harf hex). Anahtar, gizli değerin UTF-8 baytlarıdır.</li>
</ul>
<p>İmzayı gövdeyi ayrıştırmadan önce, ham baytlar üzerinden ve sabit zamanlı karşılaştırmayla doğrula.</p>
<p>Node.js:</p>
<pre>${NODE_VERIFY}</pre>
<p>Python:</p>
<pre>${PY_VERIFY}</pre>

<h2 id="oturum">Web paneli oturumu</h2>
<p><code>POST /v1/session</code> gövdesi <code>{"token": "ob_…"}</code> olan bir istekle 30 gün geçerli bir oturum çerezi verir (<code>HttpOnly; Secure; SameSite=Strict</code>). <code>DELETE /v1/session</code> çıkış yapar. Bu iki uç nokta yalnız panel sayfalarından çağrılabilir; çerezle yapılan veri değiştiren istekler de aynı kaynaktan gelmek zorundadır.</p>
`;
}
