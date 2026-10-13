// /privacy, in Turkish. Keep it short and accurate; update it whenever what
// the hub stores or who processes it changes.

import { html, type Safe } from "./html";

export function privacyBody(): Safe {
  return html`
<h1>Gizlilik</h1>
<p>Bu hub'ı Mert Çobanov kendisi ve davet ettiği arkadaşları için işletiyor. Burası bir şirket hizmeti değil; sağlık verini taşıdığı için olabildiğince az şey tutacak şekilde yapıldı.</p>

<h2>İsteğe bağlı</h2>
<p>Freeband uygulaması verini telefonda tutar. Uygulamada Web erişimini açmadıkça buraya hiçbir şey gelmez. Açtığında uygulama bir hesap oluşturur ve her senkronizasyonda bandının verisini buraya gönderir. Web erişimini kapatmak yeni gönderimi durdurur; buradaki veriyi silmek için hesabı silmen gerekir.</p>

<h2>Ne saklanır</h2>
<ul>
  <li>Hesap: rastgele bir hesap kimliği, erişim anahtarının SHA-256 özeti (anahtarın kendisi değil), saat dilimi, hesap açılırken verilen cihaz adı ve oluşturulma zamanı.</li>
  <li>Bantlar: uygulamanın her bant için ürettiği rastgele kimlik (MAC adresi ya da seri numarası değil), bant adı, modeli, uygulama sürümü, ilk ve son görülme zamanı.</li>
  <li>Örnekler: zaman, adım, kalori, nabız, ayakta geçen saat ve pil yüzdesi.</li>
  <li>Webhook'lar: eklediğin adresler, şifrelenmiş gizli değerleri ve son gönderimin sonucu.</li>
  <li>Web oturumları: tarayıcındaki çerezin özeti ve bitiş zamanı (en fazla 30 gün).</li>
  <li>Kötüye kullanımı sınırlamak için kısa süreli sayaçlar: IP adresinin anahtarlı özeti, ham IP değil. En geç iki gün içinde silinir.</li>
</ul>
<p>Adın, e-posta adresin, konumun, Xiaomi hesabın ya da bandının şifreleme anahtarı burada tutulmaz.</p>

<h2>Kim görebilir</h2>
<p>Verini yalnız anahtarınla ya da oturumunla sen görürsün; hesaplar birbirinin verisini göremez. Hub'ı işleten kişi teknik olarak veritabanına erişebilir. Verin satılmaz, kimseyle paylaşılmaz; reklam, analiz ya da izleme aracı yoktur. Sayfalar dış kaynak yüklemez, yazı tipi de buradan gelir. Tek çerez giriş için kullanılan oturum çerezidir.</p>

<h2>Cloudflare</h2>
<p>Hub, Cloudflare Workers ve Cloudflare D1 üzerinde çalışır. Cloudflare burada veri işleyen olarak altyapıyı sağlar: istekleri karşılar ve veritabanını barındırır. İstekleri işlerken IP adresi ve istenen adres gibi teknik kayıtlar tutar ve bunları birkaç gün içinde siler. Hub bu kayıtlara anahtar, çerez ya da sağlık verisi yazmaz.</p>

<h2>Webhook'lar</h2>
<p>Bir webhook eklersen verin her senkronizasyondan sonra seçtiğin adrese de gönderilir. O adrese ulaştıktan sonra veriden adresin sahibi sorumludur.</p>

<h2>Silme</h2>
<p>Panelde Hesabı sil'e dokun ya da <code>DELETE /v1/account</code> çağır. Hesabın, örneklerin, bant kayıtların, webhook'ların ve oturumların hemen ve kalıcı olarak silinir; geri alınamaz. Silinen veri, Cloudflare D1'in geri yükleme kaydında en fazla 30 gün daha kalabilir; bu sürede panelden ya da API'den ulaşılamaz ve süre dolunca kendiliğinden kaybolur.</p>
<p>Telefondaki veri bundan etkilenmez; onu uygulamadan ya da uygulamayı silerek kaldırırsın.</p>

<h2>Soru</h2>
<p>Sorun ya da merak ettiğin bir şey olursa seni davet eden kişiye ya da hub'ı işleten Mert Çobanov'a yaz.</p>
`;
}
