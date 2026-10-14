# Freeband: Xiaomi Smart Band 10'u nasıl çözdük

Hedef: Xiaomi Smart Band 10 / 10 Pro'yu Mi Fitness ve Xiaomi hesabı olmadan, verisi telefonda kalan kendi iPhone uygulamamızla kullanmak. Ayrıntılı bulgular ve kaynak atıfları: [`findings.md`](../findings.md), komut haritası: [`CAPABILITIES.md`](CAPABILITIES.md), dosya formatları: [`ACTIVITY.md`](ACTIVITY.md).

1. **Masa başı keşif.**
   - Gadgetbridge'in (açık kaynak Android uygulaması) Xiaomi kodunu okuduk: bağlantı, kimlik doğrulama, şifreleme, komutlar, dosya formatları.
   - AstroBox'ın (Band 10'u destekleyen bir iOS uygulaması) protobuf şemalarıyla karşılaştırdık.
   - Sonuç: Band 10 Xiaomi'nin yeni protokolünü konuşuyor ve iPhone'da BLE üzerinden büyük olasılıkla mümkün.
2. **Mac'ten ilk temas.**
   - BLE taramasında bant Xiaomi'nin `FE95` yayınıyla göründü.
   - Mac'ten bağlanma iki kez zaman aşımına düştü: bant yalnızca eşleştiği iPhone'u kabul ediyor.
   - nRF Connect: bant iPhone'a bağlıyken hiç yayın yapmıyor.
3. **iPhone'da bir test uygulaması.** iOS'un zaten bağlı tuttuğu bandı yeniden eşlemeden aldık. GATT tablosunda `FE95` servisi, `005E` (okuma) ve `005F` (yazma) karakteristikleri çıktı: BLE V2 kanalı açık. Projenin geçer/kalır anı buydu.
4. **Anahtar.**
   - Bant, ilk eşlemede Xiaomi sunucusunun ürettiği 16 baytlık bir anahtar (auth key) istiyor.
   - iPhone'da bu anahtar Dosyalar → Mi Fitness klasöründe, bir önbellek veritabanının içinde duruyor.
   - Uygulama klasörü kullanıcıya seçtiriyor, anahtarı telefonda okuyor ve Keychain'e yazıyor. Anahtar hiçbir yere gönderilmiyor.
5. **El sıkışma.**
   - Telefon ve bant rastgele sayılar (nonce) değiş tokuş ediyor.
   - Anahtar ve bu sayılardan HKDF-SHA256 (`"miwear-auth"`) ile oturum anahtarları türetiliyor. Bandın HMAC'i tutunca anahtarın doğru olduğu anlaşılıyor.
   - Son adımda kendimizi `device_type = iOS` olarak tanıtıyoruz; bu bilgi AES-CCM ile şifreli gidiyor.
6. **Şifreli kanal ve ilk komut.**
   - Mesajlar `a5 a5` başlıklı, CRC16'lı çerçevelerde, AES-128-CTR ile şifrelenmiş protobuf olarak gidiyor.
   - İlk komut pil oldu: **%46**. Aynı değeri standart BLE pil servisinden de okuyup şifre çözmenin doğru olduğunu doğruladık.
7. **Bağımsız doğrulama.** Protokol kodunu Mac'te ayrı bir Python uygulamasıyla 13 test vektörüne karşı doğruladık.
8. **Canlı veri.** Bir komutla bant canlı istatistik göndermeye başlıyor: adım, kalori, nabız. Pili korumak için 2 dakika sonra kapatıyoruz.
9. **Mi Fitness ile çakışma.**
   - Aynı kanalda iki oturum olamıyor. Uygulamamız kanalı bırakmayınca Mi Fitness'ın senkronu takıldı; kanalı bırakmayı ekledik.
   - Mi Fitness dosyaları onaylayınca (ACK) bant onları siliyor.
10. **Diğer komutlar.** Bildirim gönderme, bandı titreterek bulma, saat eşitleme.
11. **Geçmiş veri (aktivite dosyaları).**
    - Bant bugünün ve geçmiş günlerin dosya listesini veriyor.
    - Her dosyanın 7 baytlık bir kimliği var: zaman, saat dilimi, sürüm ve tür (dakikalık veri, günlük özet, uyku, uyku evreleri, elle ölçüm).
    - Dosyalar parça parça geliyor, sonunda CRC32 var.
    - Biz ACK göndermiyoruz, bandaki veri silinmiyor.
12. **Dosya formatları.**
    - Önce belgeye döktük. Sonra kodu sıfırdan yazdık: bir Python referans çözücü ve onunla birebir aynı sonucu veren bir Swift çözücü.
    - 147 test geçiyor; 37 bin bozuk dosyada bile çökmüyor.
13. **Ürün.**
    - Freeband bu verilerden kendi Uyku, Toparlanma ve Yük skorlarını hesaplıyor; her skorun katkıları ve güveni görünüyor.
    - Yanında Cloudflare üzerinde isteğe bağlı bir API ve web paneli var.
14. **Açık kalanlar.**
    - Gerçek bir uyku dosyası henüz doğrulanmadı.
    - Bandın kendiliğinden gönderdiği `2/110` mesajının anlamı bilinmiyor.
    - Sıfır bir bandı Mi Fitness olmadan eşlemek şimdilik mümkün değil, çünkü anahtar Xiaomi sunucusunda üretiliyor.

## Teşekkürler

- [Gadgetbridge](https://codeberg.org/Freeyourgadget/Gadgetbridge): protokolün en ayrıntılı açık kaynak anlatımı.
- [AstroBox](https://github.com/AstralSightStudios): iOS'ta BLE ve `device_type = iOS` ipucu, protobuf şemaları.
- [xiaomi-band-ios-export](https://github.com/artyomxx/xiaomi-band-ios-export): anahtarın iPhone'daki yeri.
- Band 10'da BLE'yi deneyen açık kaynak denemeler: [blueband-map](https://github.com/LordierClaw/blueband-map), [band9-rust-ios](https://github.com/ireescc277-dotcom/band9-rust-ios).

Freeband bağımsız bir projedir, Xiaomi ile bağlantısı yoktur. Xiaomi, Mi Band ve Mi Fitness, Xiaomi Inc.'in ticari markalarıdır.
