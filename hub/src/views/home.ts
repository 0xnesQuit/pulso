// The public home page, in Turkish: the product first (one line, the app
// screens, two actions), then four short sections.

import { html, type Safe } from "./html";
import { GITHUB_URL } from "./layout";

export const HOME_DESCRIPTION =
  "Freeband, Xiaomi Smart Band 10 ve 10 Pro'yu Mi Fitness ve Xiaomi hesabı olmadan okuyan bir iPhone uygulaması. Verin telefonunda kalır.";

const SHOTS: Array<{ file: string; name: string; alt: string }> = [
  {
    file: "today",
    name: "Bugün",
    alt: "Bugün ekranı: günün hükmü Dengeli; Uyku 74, Toparlanma 41 ve Yük 0,0 yayları; adım, dinlenik nabız ve uyku satırları.",
  },
  {
    file: "score-recovery",
    name: "Toparlanma",
    alt: "Toparlanma ayrıntısı: 41, orta; nabız değişkenliği 48 ms ve dinlenik nabız 52 bpm katkı satırları, normale göre konumlarıyla.",
  },
  {
    file: "sleep",
    name: "Uyku",
    alt: "Uyku ekranı: 4 sa. 55 dk., 22:23–3:27, %97 verimli; uyanık, REM, hafif ve derin evrelerin zaman çizelgesi ve süreleri.",
  },
  {
    file: "band",
    name: "Bant",
    alt: "Bant ekranı: Band 10 Pro çizimi, %46 pil ve 1 dk önce senkronlandı; senkronla, bul, bildir ve canlı nabız düğmeleri.",
  },
];

export function homeBody(o: { deleted: boolean }): Safe {
  return html`
${o.deleted ? html`<p class="banner small" role="status">Hesabın ve bu sunucudaki tüm verin silindi.</p>` : ""}
<section class="hero">
  <h1>Xiaomi Smart Band 10 için hesapsız bir iPhone uygulaması</h1>
  <p class="lede">Freeband bandını Mi Fitness ve Xiaomi hesabı olmadan okur, skorlarını telefonda hesaplar. Verin telefonunda kalır.</p>
  <div class="actions"><a class="btn" href="/story">Nasıl yaptık</a><a class="btn ghost" href="${GITHUB_URL}">GitHub</a></div>
  <figure class="stage">
    <ul class="shots">${SHOTS.map(
      (s, i) =>
        html`<li><img src="/img/${s.file}.webp" width="600" height="1300" alt="${s.alt}" ${i === 0 ? "" : html`loading="lazy" `}decoding="async"><span>${s.name}</span></li>`,
    )}</ul>
    <figcaption>Ekranlar demo veriyle.</figcaption>
  </figure>
</section>

<section class="sect">
  <header>
    <h2>Mi Fitness'sız, hesapsız</h2>
    <p>Freeband bandla Bluetooth üzerinden doğrudan konuşur. Hesap açmazsın; adım, nabız, uyku ve skorlar telefonda kalır.</p>
  </header>
  <ul class="cards c3">
    <li class="card"><h3>Anahtar telefonda</h3><p>Bandın anahtarını Mi Fitness'ın telefondaki klasöründen bir kez okur ve Keychain'e yazar. Anahtar hiçbir yere gönderilmez.</p></li>
    <li class="card"><h3>Veri bantta kalır</h3><p>Freeband dosyaları onaylamaz (ACK göndermez), bu yüzden bant geçmiş veriyi silmez.</p></li>
    <li class="card"><h3>Kurulumda bir kez Mi Fitness</h3><p>Sıfır bir bandı eşlemek için Mi Fitness şart, çünkü anahtar Xiaomi sunucusunda üretiliyor.</p></li>
  </ul>
</section>

<section class="sect">
  <header>
    <h2>Kendi skorların, açık hesapla</h2>
    <p>Skorlar telefonda, bandın ham verisinden hesaplanır. Her skor neden o değerde olduğunu katkı satırlarıyla, ne kadar güvenilir olduğunu güven düzeyiyle gösterir.</p>
  </header>
  <ul class="cards c3">
    <li class="card"><div class="score-head"><h3>Uyku</h3><span class="range">0–100</span></div><p>Süre, verimlilik, derin uyku, REM, huzur, düzen ve gece nabız düşüşü.</p></li>
    <li class="card"><div class="score-head"><h3>Toparlanma</h3><span class="range">0–100</span></div><p>Nabız değişkenliği, dinlenik nabız, uyku ve dünkü yük; son 14 günlük normaline göre.</p></li>
    <li class="card"><div class="score-head"><h3>Yük</h3><span class="range">0–21</span></div><p>Nabız rezervine göre bölgelerde geçen dakikalar. İyi ya da kötü değil, yalnız ne kadar.</p></li>
    <li class="card wide"><h3>Güven</h3><p>Yüksek, orta, düşük ya da yok; her zaman gerekçesiyle, örneğin “RR yok” ya da “bazalde 5/14 gece”.</p></li>
  </ul>
</section>

<section class="sect">
  <header>
    <h2>İsteğe bağlı web erişimi</h2>
    <p>Bu sayfa Freeband hub'ı. Uygulamada Web erişimini açarsan telefon verini buraya da gönderir. Açmazsan buraya hiçbir şey gelmez.</p>
  </header>
  <div>
    <ul class="cards c2">
      <li class="card"><h3>Web paneli</h3><p>Günü tarayıcıdan gör. Uygulamada Web paneli aç'a dokun; tarayıcı seni doğrudan panele alır.</p></li>
      <li class="card"><h3>REST API</h3><p>Verine kişisel anahtarınla ulaş. Uç noktalar ve örnekler API belgesinde.</p></li>
      <li class="card"><h3>Webhook'lar</h3><p>Her senkronizasyondan sonra veri imzalı bir istekle kendi sunucuna da gider.</p></li>
      <li class="card"><h3>Dışa aktarma</h3><p>Buradaki tüm verini CSV ya da JSON olarak indir.</p></li>
    </ul>
    <p class="small muted note">Başka bir bilgisayardan girmek için anahtarı uygulamadan kopyala ve <a href="/login">giriş sayfasına</a> yapıştır. Neyin saklandığını <a href="/privacy">gizlilik sayfası</a> anlatıyor.</p>
    <div class="actions"><a class="btn ghost" href="/docs">API belgesi</a><a class="btn ghost" href="/privacy">Gizlilik</a></div>
  </div>
</section>

<section class="sect">
  <header>
    <h2>Durum</h2>
  </header>
  <div class="card">
    <p class="status-line"><span class="dot" aria-hidden="true"></span>TestFlight'ta iç test</p>
    <p>Freeband şimdilik yalnız iç testte; App Store'da yok. Kaynak kodu <a href="${GITHUB_URL}">GitHub'da</a>, bandın nasıl çözüldüğü <a href="/story">Nasıl yaptık</a> sayfasında.</p>
  </div>
</section>`;
}
