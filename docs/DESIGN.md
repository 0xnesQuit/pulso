# Freeband tasarım sistemi (v2: dither)

Konu: bilekteki banttan veriyi Xiaomi'siz okuyan yerel sağlık uygulaması.
Kitle: kullanıcı ve davet ettiği arkadaşları; teknik merakı olan, karanlık arayüz seven insanlar.
Ana iş: bantla eşleşmek, günü bir bakışta görmek, veriyi istenen yere taşımak.
Referans (kullanıcının seçtiği): ade.chele.bi ve Ditther. Modern, koyu, siyah, piksel/dither dokulu.

## Tek cesur öğe: dither'lanmış 24 saat kadranı

Gün yine 24 saatlik bir kadran (00 tepede, saat yönünde), ama piksel ızgarasında çizilir:
- Kadran, kenarı ~72 hücrelik kare bir piksel ızgarasında hesaplanır; her hücre kare bir piksel olarak ya yanar ya söner (ara ton yok).
- Ara tonlar 4×4 Bayer sıralı dither ile verilir. Halka izi %25 yoğunlukta, gece kesimi (22–06) %12.
- Dış yay: saatlik adım çubukları, uzunluk adımla orantılı, fosfor yeşili, dolu piksel.
- İç iz: nabız örnekleri tek pikseller ve aralarında 1 piksellik çizgi, kırmızı.
- Şimdi çentiği: 2×3 piksel beyaz blok.
- Merkez: son nabız piksel fontla, altında küçük mono etiket.
- Ekran dışı her şey düz ve sessiz: dither yalnız kadranda, ikonda ve logoda.

## Renk (her zaman koyu)

| Ad | Hex | Rolü |
|---|---|---|
| Zemin | `#0A0A0A` | Sayfa |
| Yüzey | `#111111` | Kutu içi, girdi alanları |
| Çizgi | `#1F1F1F` | Kutu kenarları, ayırıcılar (1 px) |
| Metin | `#EDEDED` | Birincil metin, birincil düğme zemini |
| Soluk | `#8A8A8A` | İkincil metin |
| Silik | `#4A4A4A` | Pasif, kadran izi |
| Fosfor | `#8BE36B` | Adım (veri rengi) |
| Nabız | `#FF5C5C` | Nabız (veri rengi); hata ve durdur |

Vurgular veriye aittir. Düğmeler monokrom: birincil düğme Metin zemin + Zemin yazı, ikincil düğme Yüzey zemin + Çizgi kenar.

## Yazı

- **Open Sauce Sans** (SIL OFL), tek aile, dört ağırlık: başlıklar Light (300), metin Regular (400), etiketler ve düğmeler Medium (500), büyük rakamlar SemiBold (600) ve tabular rakamlar. Büyük metrikler 40–48 pt, başlıklar 24–34 pt. (İlk v2 taslağındaki Departure Mono kullanıcı isteğiyle kaldırıldı.)
- Kod blokları (web belgeleri) sistem monospace'inde kalır.
- Etiketler küçük harf ya da cümle düzeni, Soluk renkte (ör. `adım`, `nabız aralığı`).

## Yerleşim

- Kenar boşluğu 16 pt; içerik sola hizalı.
- Metrikler 1 px Çizgi kenarlı bir ızgarada (ade'deki harness ızgarası gibi): kutular arası boşluk yok, kenarlar paylaşılır, köşe yuvarlaması 0–2 pt.
- Bugün: üstte tarih + bant seçici, altında tek satır mono durum. Ortada solda kadran, sağda adım/kalori/pil. Altında 2×2 kutu ızgarası (nabız aralığı, ayakta, aktif saat, son ölçüm), sonra günün nabız eğrisi (1 px çizgi). Düğmeler sekme çubuğunun üstünde sabit.
- Web panelinde aynı ızgara; masaüstünde kadran solda, metrikler sağda.

## Hareket

Tek koreografi: kadran açılırken pikseller 00'dan şimdiye doğru sırayla yanar (~500 ms, "Reduce Motion" açıksa yok). Canlı modda son nabız pikseli yanıp söner.

## Yazı dili

Değişmedi: kullanıcının bakışından, sade Türkçe, etken çatı, eylem adları akış boyunca aynı. Mono etiketler kısa.

## Not

Genel kalıplar listesinde "koyu zemin + tek parlak vurgu" ve "küçük etiketlerde monospace" var; burada bunlar kullanıcının açıkça istediği yön olduğu için seçildi. Farkı dither kadran ve piksel wordmark taşıyor.
