// /story ("Nasıl yaptık"): docs/STORY.md as a designed page, in Turkish.
// The content is inline; keep it in step with docs/STORY.md and keep its facts
// exact. Diagrams are inline SVG coloured by classes in layout.ts.

import { html, raw, type Safe } from "./html";
import { GITHUB_URL } from "./layout";

export const STORY_TITLE = "Xiaomi Smart Band 10'u nasıl çözdük";
export const STORY_DESCRIPTION =
  "Xiaomi Smart Band 10'u Mi Fitness ve Xiaomi hesabı olmadan okumak için yaptıklarımız, adım adım: BLE kanalı, anahtar, el sıkışma, şifreli çerçeveler ve aktivite dosyaları.";

const blob = (path: string): string => `${GITHUB_URL}/blob/main/${path}`;
const FINDINGS = blob("findings.md");
const CAPABILITIES = blob("docs/CAPABILITIES.md");
const ACTIVITY = blob("docs/ACTIVITY.md");

// Phone ↔ band handshake, drawn top to bottom so it stays readable at 390 px.
const HANDSHAKE = raw(`<svg viewBox="0 0 320 304" role="img" aria-label="El sıkışma: telefon nonce gönderir, bant nonce ve HMAC ile yanıtlar; iki taraf auth key ve nonce'lardan HKDF-SHA256 ile oturum anahtarlarını türetir; telefon AES-CCM ile şifreli device_type = iOS gönderir; sonra mesajlar AES-128-CTR ile şifreli protobuf olarak gider.">
<text class="lane" x="44" y="14" text-anchor="middle">Telefon</text>
<text class="lane" x="276" y="14" text-anchor="middle">Bant</text>
<line class="life" x1="44" y1="24" x2="44" y2="304"/>
<line class="life" x1="276" y1="24" x2="276" y2="304"/>
<text class="mono" x="160" y="48" text-anchor="middle">nonce</text>
<line class="msg" x1="44" y1="56" x2="268" y2="56"/><path class="head" d="M276 56l-9-4.5v9z"/>
<text class="mono" x="160" y="92" text-anchor="middle">nonce + HMAC</text>
<line class="msg" x1="276" y1="100" x2="52" y2="100"/><path class="head" d="M44 100l9-4.5v9z"/>
<rect class="box" x="12" y="118" width="296" height="88" rx="4"/>
<text x="160" y="137" text-anchor="middle">auth key + nonce'lar</text>
<path class="msg" d="M160 143v9"/><path class="head" d="M160 157l-3.5-6h7z"/>
<text class="mono" x="160" y="173" text-anchor="middle">HKDF-SHA256 "miwear-auth"</text>
<path class="msg" d="M160 178v7"/><path class="head" d="M160 190l-3.5-6h7z"/>
<text x="160" y="201" text-anchor="middle">oturum anahtarları</text>
<text class="cap" x="52" y="226">bandın HMAC'i tuttu: anahtar doğru</text>
<text class="mono" x="160" y="250" text-anchor="middle">device_type = iOS · AES-CCM</text>
<line class="msg" x1="44" y1="258" x2="268" y2="258"/><path class="head" d="M276 258l-9-4.5v9z"/>
<text class="mono" x="160" y="286" text-anchor="middle">protobuf · AES-128-CTR</text>
<line class="chan" x1="54" y1="294" x2="266" y2="294"/><path class="chan-head" d="M44 294l11-5.5v11z"/><path class="chan-head" d="M276 294l-11-5.5v11z"/>
</svg>`);

// One frame on the encrypted channel.
const FRAME_CELLS: Array<[x: number, w: number, label: string, cap: string]> = [
  [0, 64, "a5 a5", "başlık"],
  [66, 40, "type", "tür"],
  [108, 40, "seq", "sıra"],
  [150, 46, "len", "uzunluk"],
  [198, 50, "crc16", "sağlama"],
];
const FRAME = raw(`<svg viewBox="0 0 320 70" role="img" aria-label="Çerçeve düzeni: a5 a5 başlığı, tür, sıra, uzunluk, crc16 ve payload.">
${FRAME_CELLS.map(
  ([x, w, label, cap]) =>
    `<rect class="cell" x="${x}" y="4" width="${w}" height="36" rx="2"/><text class="mono" x="${x + w / 2}" y="26" text-anchor="middle">${label}</text><text class="cap" x="${x + w / 2}" y="60" text-anchor="middle">${cap}</text>`,
).join("")}
<rect class="pay" x="250" y="4" width="70" height="36" rx="2"/><text class="mono pay-t" x="285" y="26" text-anchor="middle">payload</text><text class="cap" x="285" y="60" text-anchor="middle">şifreli</text>
</svg>`);

interface Step {
  title: string;
  body: Safe;
  milestone?: boolean;
  extra?: Safe;
}

const c = (s: string): Safe => html`<code>${s}</code>`;

const STEPS: Step[] = [
  {
    title: "Masa başı keşif",
    body: html`<ul>
  <li>Gadgetbridge'in (açık kaynak Android uygulaması) Xiaomi kodunu okuduk: bağlantı, kimlik doğrulama, şifreleme, komutlar, dosya formatları.</li>
  <li>AstroBox'ın (Band 10'u destekleyen bir iOS uygulaması) protobuf şemalarıyla karşılaştırdık.</li>
  <li>Sonuç: Band 10 Xiaomi'nin yeni protokolünü konuşuyor ve iPhone'da BLE üzerinden büyük olasılıkla mümkün.</li>
</ul>`,
  },
  {
    title: "Mac'ten ilk temas",
    body: html`<ul>
  <li>BLE taramasında bant Xiaomi'nin ${c("FE95")} yayınıyla göründü.</li>
  <li>Mac'ten bağlanma iki kez zaman aşımına düştü: bant yalnızca eşleştiği iPhone'u kabul ediyor.</li>
  <li>nRF Connect: bant iPhone'a bağlıyken hiç yayın yapmıyor.</li>
</ul>`,
  },
  {
    title: "iPhone'da bir test uygulaması",
    milestone: true,
    body: html`<p>iOS'un zaten bağlı tuttuğu bandı yeniden eşlemeden aldık. GATT tablosunda ${c("FE95")} servisi, ${c("005E")} (okuma) ve ${c("005F")} (yazma) karakteristikleri çıktı: BLE V2 kanalı açık. <strong>Projenin geçer/kalır anı buydu.</strong></p>`,
  },
  {
    title: "Anahtar",
    body: html`<ul>
  <li>Bant, ilk eşlemede Xiaomi sunucusunun ürettiği 16 baytlık bir anahtar (auth key) istiyor.</li>
  <li>iPhone'da bu anahtar Dosyalar → Mi Fitness klasöründe, bir önbellek veritabanının içinde duruyor.</li>
  <li>Uygulama klasörü kullanıcıya seçtiriyor, anahtarı telefonda okuyor ve Keychain'e yazıyor. Anahtar hiçbir yere gönderilmiyor.</li>
</ul>`,
  },
  {
    title: "El sıkışma",
    body: html`<ul>
  <li>Telefon ve bant rastgele sayılar (nonce) değiş tokuş ediyor.</li>
  <li>Anahtar ve bu sayılardan HKDF-SHA256 (${c('"miwear-auth"')}) ile oturum anahtarları türetiliyor. Bandın HMAC'i tutunca anahtarın doğru olduğu anlaşılıyor.</li>
  <li>Son adımda kendimizi ${c("device_type = iOS")} olarak tanıtıyoruz; bu bilgi AES-CCM ile şifreli gidiyor.</li>
</ul>`,
    extra: html`<figure class="diagram">${HANDSHAKE}<figcaption>El sıkışmadan sonra her mesaj AES-128-CTR ile şifreli protobuf.</figcaption></figure>`,
  },
  {
    title: "Şifreli kanal ve ilk komut",
    milestone: true,
    body: html`<ul>
  <li>Mesajlar ${c("a5 a5")} başlıklı, CRC16'lı çerçevelerde, AES-128-CTR ile şifrelenmiş protobuf olarak gidiyor.</li>
  <li>İlk komut pil oldu: <strong>%46</strong>. Aynı değeri standart BLE pil servisinden de okuyup şifre çözmenin doğru olduğunu doğruladık.</li>
</ul>
<div class="figs"><div><b>%46</b><span>ilk komutun cevabı: pil</span></div></div>`,
    extra: html`<figure class="diagram">${FRAME}<figcaption>Şifreli kanalda bir mesajın çerçevesi.</figcaption></figure>`,
  },
  {
    title: "Bağımsız doğrulama",
    body: html`<p>Protokol kodunu Mac'te ayrı bir Python uygulamasıyla 13 test vektörüne karşı doğruladık.</p>`,
  },
  {
    title: "Canlı veri",
    body: html`<p>Bir komutla bant canlı istatistik göndermeye başlıyor: adım, kalori, nabız. Pili korumak için 2 dakika sonra kapatıyoruz.</p>`,
  },
  {
    title: "Mi Fitness ile çakışma",
    body: html`<ul>
  <li>Aynı kanalda iki oturum olamıyor. Uygulamamız kanalı bırakmayınca Mi Fitness'ın senkronu takıldı; kanalı bırakmayı ekledik.</li>
  <li>Mi Fitness dosyaları onaylayınca (ACK) bant onları siliyor.</li>
</ul>`,
  },
  {
    title: "Diğer komutlar",
    body: html`<p>Bildirim gönderme, bandı titreterek bulma, saat eşitleme.</p>`,
  },
  {
    title: "Geçmiş veri (aktivite dosyaları)",
    body: html`<ul>
  <li>Bant bugünün ve geçmiş günlerin dosya listesini veriyor.</li>
  <li>Her dosyanın 7 baytlık bir kimliği var: zaman, saat dilimi, sürüm ve tür (dakikalık veri, günlük özet, uyku, uyku evreleri, elle ölçüm).</li>
  <li>Dosyalar parça parça geliyor, sonunda CRC32 var.</li>
  <li>Biz ACK göndermiyoruz, bandaki veri silinmiyor.</li>
</ul>`,
  },
  {
    title: "Dosya formatları",
    body: html`<ul>
  <li>Önce belgeye döktük. Sonra kodu sıfırdan yazdık: bir Python referans çözücü ve onunla birebir aynı sonucu veren bir Swift çözücü.</li>
  <li>147 test geçiyor; 37 bin bozuk dosyada bile çökmüyor.</li>
</ul>
<div class="figs"><div><b>147</b><span>test geçiyor</span></div><div><b>37 bin</b><span>bozuk dosyada çökme yok</span></div></div>`,
  },
  {
    title: "Ürün",
    body: html`<ul>
  <li>Freeband bu verilerden kendi Uyku, Toparlanma ve Yük skorlarını hesaplıyor; her skorun katkıları ve güveni görünüyor.</li>
  <li>Yanında Cloudflare üzerinde isteğe bağlı bir API ve web paneli var.</li>
</ul>`,
  },
  {
    title: "Açık kalanlar",
    body: html`<ul>
  <li>Gerçek bir uyku dosyası henüz doğrulanmadı.</li>
  <li>Bandın kendiliğinden gönderdiği ${c("2/110")} mesajının anlamı bilinmiyor.</li>
  <li>Sıfır bir bandı Mi Fitness olmadan eşlemek şimdilik mümkün değil, çünkü anahtar Xiaomi sunucusunda üretiliyor.</li>
</ul>`,
  },
];

const ext = (name: string, url: string): Safe => html`<a href="${url}">${name}</a>`;
const THANKS: Safe[] = [
  html`${ext("Gadgetbridge", "https://codeberg.org/Freeyourgadget/Gadgetbridge")}<span>Protokolün en ayrıntılı açık kaynak anlatımı.</span>`,
  html`${ext("AstroBox", "https://github.com/AstralSightStudios")}<span>iOS'ta BLE ve ${c("device_type = iOS")} ipucu, protobuf şemaları.</span>`,
  html`${ext("xiaomi-band-ios-export", "https://github.com/artyomxx/xiaomi-band-ios-export")}<span>Anahtarın iPhone'daki yeri.</span>`,
  html`${ext("blueband-map", "https://github.com/LordierClaw/blueband-map")}<span>Band 10'da BLE'yi deneyen açık kaynak denemelerden biri.</span>`,
  html`${ext("band9-rust-ios", "https://github.com/ireescc277-dotcom/band9-rust-ios")}<span>Band 10'da BLE'yi deneyen açık kaynak denemelerden biri.</span>`,
];

const pad = (n: number): string => String(n).padStart(2, "0");

export function storyBody(): Safe {
  return html`
<article class="story">
  <header class="story-head">
    <p class="label">Nasıl yaptık</p>
    <h1>${STORY_TITLE}</h1>
    <p class="lede">Hedef: Xiaomi Smart Band 10 / 10 Pro'yu Mi Fitness ve Xiaomi hesabı olmadan, verisi telefonda kalan kendi iPhone uygulamamızla kullanmak.</p>
    <ul class="refs" aria-label="Ayrıntılı belgeler">
      <li><a href="${FINDINGS}"><code>findings.md</code>bulgular ve kaynak atıfları</a></li>
      <li><a href="${CAPABILITIES}"><code>CAPABILITIES.md</code>komut haritası</a></li>
      <li><a href="${ACTIVITY}"><code>ACTIVITY.md</code>dosya formatları</a></li>
    </ul>
  </header>

  <ol class="timeline">${STEPS.map(
    (s, i) => html`
    <li class="${s.milestone ? "milestone" : ""}">
      <span class="step-n" aria-hidden="true">${pad(i + 1)}</span>
      <div class="step"><h2><span class="sr">${i + 1}. </span>${s.title}</h2>${s.body}</div>
      ${s.extra ?? ""}
    </li>`,
  )}
  </ol>

  <section class="story-more">
    <h2>Teşekkürler</h2>
    <ul class="rows">${THANKS.map((t) => html`<li>${t}</li>`)}</ul>
  </section>

  <section class="story-more">
    <h2>Ayrıntılar GitHub'da</h2>
    <ul class="cards c3">
      <li><a class="card" href="${FINDINGS}"><code>findings.md</code><p>Ayrıntılı bulgular ve kaynak atıfları</p></a></li>
      <li><a class="card" href="${CAPABILITIES}"><code>docs/CAPABILITIES.md</code><p>Komut haritası</p></a></li>
      <li><a class="card" href="${ACTIVITY}"><code>docs/ACTIVITY.md</code><p>Dosya formatları</p></a></li>
    </ul>
    <div class="actions note"><a class="btn ghost" href="${GITHUB_URL}">Kaynak kod GitHub'da</a></div>
  </section>
</article>`;
}
