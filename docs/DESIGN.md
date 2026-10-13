# OpenBand tasarım sistemi

Konu: bilekteki banttan veriyi Xiaomi'siz okuyan yerel sağlık uygulaması.
Kitle: kullanıcı ve davet ettiği, çoğu teknik olmayan arkadaşları.
Ana iş: bantla birkaç adımda eşleşmek, günü bir bakışta görmek, veriyi istenen yere taşımak.

## Tek cesur öğe: 24 saat kadranı

Gün, 24 saatlik bir saat kadranı olarak gösterilir. 00 tepede, saat yönünde ilerler. Bant bilekte duran bir saat; uygulama da onun dilini konuşur.

- Kadran izi (track) ince bir halka. 22:00–06:00 arası gece tonuyla hafifçe koyulaşır, uyku saatlerini işaret eder.
- Dış yay: her saat için radyal bir çubuk. Uzunluğu o saatteki adımla orantılı, renk Safran.
- İç iz: nabız örnekleri, merkeze uzaklığı nabız değeriyle orantılı noktalar. Renk Nar.
- Şu anki zaman: izin üstünde küçük bir çentik.
- Merkez: son nabız (büyük, sıkıştırılmış rakam) ve altında "bpm, şimdi" ya da "son ölçüm 14:31".
- Veri yoksa kadran boş iz olarak durur ve altında ne yapılacağını söyleyen tek cümle yer alır.

Kadran dışındaki her şey sakin: kart yığını yok, gölge yok, gradyan yok. Ayrım boşlukla ve gerektiğinde tek bir ince çizgiyle yapılır.

## Renk

| Ad | Açık | Koyu | Rolü |
|---|---|---|---|
| Porselen / Gece | `#F1F3F5` | `#121A2B` | Zemin |
| Mürekkep / Kırağı | `#16202B` | `#E8ECF1` | Metin |
| Kadran | `#D9DFE6` | `#2A3348` | Halka izi, ayırıcılar, ikincil yüzey |
| Safran | `#E2A013` | `#F0B43A` | Adım |
| Nar | `#D2344A` | `#F0566A` | Nabız; ayrıca hata ve "durdur" |
| Gece izi | `#121A2B` %10 | `#000000` %25 | Kadranda gece saatleri |

İkincil metin: Mürekkep %60 / Kırağı %60. Birincil düğme zemini Mürekkep (açık) / Kırağı (koyu), yazısı zemin rengi. Vurgu rengi sadece veriye aittir: Safran adım, Nar nabız; düğmeler renkli değildir.

## Yazı

Tek aile: SF Pro (iOS), iki genişlik.

- Rakamlar: SF Pro **Compressed**, semibold, tabular. Büyük metrikler 56/48 pt, ikincil rakamlar 28 pt. Saat kadranının rakamları gibi uzun ve dar.
- Metin: SF Pro Text, normal genişlik. Gövde 17 pt, açıklama 15 pt, dipnot 13 pt.
- Başlıklar cümle düzeninde (sadece ilk harf büyük), büyük harfli etiket yok, monospace etiket yok.

Web panelinde aynı rol ayrımı **Archivo** değişken fontuyla (Google Fonts) yapılır: rakamlarda `wdth 62`, metinde `wdth 100`.

## Yerleşim

Sola hizalı metin; kadran yatayda ortalı ve ekran genişliğinin yaklaşık %80'i.

```
Salı, 13 Ekim                         (ayarlar)

            .-''''''''-.
          .'   ♥ 74     '.            kadran, ortada
         :    bpm, şimdi   :
          '.            .'
            '-........-'

8 421                 74
adım                  nabız

Pil %46               Son senkron 14:31

[ Senkronize et ]                     birincil
Canlı nabzı başlat                    ikincil (metin düğmesi)
```

Sekmeler: Bugün · Ayarlar (Geçmiş, bir sonraki görevde gelecek).

## İlk kurulum (sıralı akış, numara kullanılabilir)

1. **Bandın, sadece senin.** OpenBand ne yapar: veri telefonda kalır, Mi Fitness silinmez, eşleşme bozulmaz. Uyarı: bandı Mi Fitness'tan kaldırma, fabrika ayarına döndürme, anahtar değişir.
2. **Bandın anahtarını al.** Dosyalar'dan Mi Fitness klasörünü seçme adımları. Başarıda bant adı ve maskeli anahtar görünür.
3. **Bağlan.** "Mi Fitness'ı kapat" hatırlatması, "Bandı bağla" düğmesi. Başarıda pil ve bugünkü adım görünür, "Başla" ile Bugün ekranına geçilir.

## Hareket

Tek koreografi: kadran ilk dolduğunda saat çubukları 00'dan şu ana doğru sırayla büyür (toplam ~600 ms). Başka giriş animasyonu yok. "Reduce Motion" açıksa doğrudan çizilir. Kullanıcı eylemine cevap veren geçişler (sayfa geçişi, düğme durumu) serbest.

## Yazı dili

Kullanıcının bakışından, sade Türkçe, etken çatı. Düğme ne yaptığını söyler ("Senkronize et", "Bandı bağla", "Dışa aktar"); aynı eylem akış boyunca aynı adı taşır. Hatalar özür dilemez, ne olduğunu ve ne yapılacağını söyler ("Bant cevap vermedi. Mi Fitness'ı kapatıp tekrar dene."). Boş ekran bir davettir.

## Plan incelemesi (genel kalıplara karşı)

- Krem zemin + terrakota vurgu değil: zemin soğuk porselen/gece laciverti, vurgular veriye ait (gündüz adımı Safran, kalp Nar).
- Koyu zemin + tek asit vurgu değil: koyu tema gece mavisi ve iki veri rengi taşıyor.
- SaaS kart kiti değil: metrikler kartsız, boşlukla ayrılıyor; tek yuvarlak öğe kadranın kendisi.
- İlk taslakta metrikler 2×2 kart ızgarasıydı (BandProbe v0.3). Bu kalıp olduğu için kaldırıldı; yerine kadran + iki büyük rakam geldi.
