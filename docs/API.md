# OpenBand veri sözleşmesi (v1)

Uygulama, webhook'lar ve Cloudflare hub aynı JSON biçimini kullanır. Zamanlar ISO 8601 UTC (`2026-10-13T20:59:41Z`).

## Örnek (sample) türleri

| `type` | Alanlar | Anlamı |
|---|---|---|
| `live` | `steps`, `calories`, `heart_rate`, `standing_hours` | Bandın canlı istatistik olayı (Health 8/47). `steps` ve `calories` o güne ait **kümülatif** toplam; `heart_rate` anlık, 0 ise ölçülmedi. |
| `battery` | `level` | Pil yüzdesi (System 2/1). |

Sonraki görevde eklenecek: `minute` (dakikalık adım/nabız/stres/SpO2) ve `sleep` (uyku oturumu).

Bir kullanıcının birden fazla bandı olabilir (ör. Band 10 ve Band 10 Pro). Her gövde tek bir banda aittir ve `device.id` ile tanımlanır. Her örnek `(device.id, type, ts)` ile tekildir; aynı üçlü tekrar gelirse yok sayılır.

## Gönderim gövdesi (uygulama → hub, uygulama → webhook)

```json
{
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
  "summary": {
    "date": "2026-10-13",
    "steps": 8421,
    "calories": 312,
    "heart_rate_last": 74,
    "battery": 46
  },
  "samples": [
    { "type": "live", "ts": "2026-10-13T20:59:41Z", "steps": 8421, "calories": 312, "heart_rate": 74, "standing_hours": 9 },
    { "type": "battery", "ts": "2026-10-13T20:59:40Z", "level": 46 }
  ]
}
```

- `event`: şimdilik yalnız `sync.completed`; webhook testi için `ping`.
- `device.id`: uygulamanın her bant için bir kez ürettiği rastgele UUID (bandın MAC'i ya da seri numarası değil). `device.model`: `band10` ya da `band10pro`.
- `summary.date` cihazın saat dilimindeki gün.
- Bir gövdede en fazla 5000 örnek, en fazla 512 KB.

## Webhook imzası

Her istek şu başlıklarla gelir:

| Başlık | Değer |
|---|---|
| `Content-Type` | `application/json` |
| `X-OpenBand-Event` | `sync.completed` ya da `ping` |
| `X-OpenBand-Delivery` | rastgele UUID |
| `X-OpenBand-Signature` | `sha256=<hex>`: gövdenin HMAC-SHA256'sı, anahtar webhook'un gizli değeri |

Alıcı imzayı ham gövde üzerinden doğrulamalı. Uygulama webhook'ları yalnız `https://` adreslere gönderir.

## Hub API

Taban adres: `https://openband.cobanov.dev` (geliştirmede `http://localhost:8787`). Kimlik doğrulama `Authorization: Bearer ob_<token>`.

| Yöntem | Yol | Açıklama |
|---|---|---|
| `POST` | `/v1/accounts` | Yeni hesap. Gövde `{ "device_name": "...", "tz": "Europe/Istanbul" }`. Cevap `{ "account_id", "token", "web_url" }`; token yalnız bir kez döner. IP başına sınırlı. |
| `GET` | `/v1/me` | Hesap bilgisi, örnek sayıları ve bilinen cihazlar (`devices: [{ id, name, model, last_seen }]`). |
| `POST` | `/v1/ingest` | Gönderim gövdesi (yukarıda). Cevap `{ "accepted", "duplicates" }`. Ardından hesabın sunucu webhook'larına iletilir. |
| `GET` | `/v1/samples?device=&type=live&from=&to=&limit=` | Ham örnekler, zamana göre artan, en fazla 5000. `device` verilmezse tüm cihazlar; her örnek `device_id` taşır. |
| `GET` | `/v1/days?device=&from=YYYY-MM-DD&to=YYYY-MM-DD` | Cihaz başına günlük özet (`device_id` alanıyla): `steps`, `calories`, `heart_rate_min/max/avg`, `battery_last`; hesabın saat dilimine göre. |
| `GET` | `/v1/export.csv` · `/v1/export.json` | `from`/`to` ile dışa aktarma. |
| `GET` `POST` `DELETE` | `/v1/webhooks`, `/v1/webhooks/:id` | Sunucu webhook'ları (en fazla 5; yalnız https). Oluştururken gizli değer bir kez döner. `POST /v1/webhooks/:id/test` ping gönderir. |
| `POST` | `/v1/token/rotate` | Yeni token, eskisi hemen geçersiz. |
| `DELETE` | `/v1/account` | Hesabı ve tüm veriyi kalıcı siler. |
| `POST` | `/v1/session` | Web paneli girişi: gövde `{ "token" }`, cevap HttpOnly oturum çerezi. `DELETE` çıkış. |

Web sayfaları: `/` (tanıtım ve giriş), `/login#token=...` (uygulamadaki "Web paneli aç" bağlantısı; token URL parçasında kalır, sunucuya gitmez, sayfa onu `POST /v1/session` ile çereze çevirir), `/app` (panel), `/docs` (API belgesi), `/privacy` (gizlilik).

## Güvenlik kuralları

- Token: `ob_` + 32 rastgele baytın base64url'i. D1'de yalnız SHA-256 özeti tutulur.
- Hesaplar birbirinin verisini göremez; her sorgu `account_id` ile sınırlı.
- Oturum çerezi `HttpOnly; Secure; SameSite=Strict`, 30 gün.
- Gövde boyutu, örnek sayısı, alan aralıkları doğrulanır (ör. `heart_rate` 0–250, `level` 0–100, `ts` ±2 gün geleceğe kadar).
- Webhook hedefi yalnız `https://`, hub'ın kendi alan adına izin yok, 5 sn zaman aşımı.
- Sağlık verisi: kullanıcı "Web erişimi"ni açmadıkça hiçbir şey hub'a gitmez; `DELETE /v1/account` her şeyi siler.
