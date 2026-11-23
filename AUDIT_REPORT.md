# Şehir & Toprak Fethi — Kod Denetimi ve Düzeltme Raporu

**Denetim tarihi:** 23 Kasım 2026  
**İncelenen kaynak:** Kullanıcının bu sohbette yüklediği `sehirfethetmeoyunu.zip` arşivindeki proje  
**Kapsam:** React/Vite istemcisi, oyun kuralları, çevrimiçi oda/diplomasi akışı, ortak dünya senkronizasyonu, cihaz kimliği saklama, Android/web sürüm kontrolü.

> Bu rapor, kod incelemesi ve çalıştırılabilen otomatik testlerin sonuçlarını özetler. Gerçek iki cihazlı çevrimiçi oyun testi ve Android APK derlemesi bu ortamda tamamlanamadı. Bu nedenle “bilinen tüm hatalar kesin olarak bitti” garantisi vermez.

## Düzeltilen sorunlar

### 1. Çevrimiçi tur hamlelerinin host tarafından doğrulanmaması

Önceden host, istemciden gelen tur tamamlama paketinde esas olarak harcanan puana bakıyordu. Kare koordinatları, sahiplik iddiaları, duvar eylemleri ve hamle sırası güvenilir biçimde doğrulanmıyordu.

**Düzeltme:** `validateTurnPlacementPlan` eklendi. Host artık her hamleyi kendi haritasına ve tur başındaki duvar durumuna göre yeniden doğruluyor. Sınır dışı/ondalıklı koordinatlar, başka oyuncu adına hamle, tekrar eden kareler, güncel olmayan sahiplik, geçersiz maliyet, bitişik olmayan fetih, olmayan duvarı yıkma ve tur puanını aşma reddediliyor. İstemcinin gönderdiği ceza/ittifak sonuçları doğrudan kabul edilmiyor; host kendi ittifak durumundan hesaplıyor.

### 2. Duvar aşma ve ikinci vuruş akışı

Bir duvarı ilk puanla aşma ve sonraki puanla fethetme akışı, doğrulama eklendiğinde ikinci adımda yanlış sınıflandırılabiliyordu. Ayrıca yalnızca duvarı aşan hamlede tur sonunda hostun temel duvar haritasında sur kalabiliyordu.

**Düzeltme:** İkinci aşama `isWallDemolished` olarak işaretleniyor. `isWallBreachOnly` hamlesi toprağı ele geçirmeden suru kaldırıyor; iki puanlı yıkım ise hem suru kaldırıp hem kareyi fethediyor. Her iki durum da hostun doğrulanmış planına göre uygulanıyor.

### 3. Çevrimiçi diplomasi ve istemci kaynaklı durum değişiklikleri

İstemci tarafında aynı cihazdaki oyuncuların ittifak/iptal/toprak devri işlemleri hosta güvenilir ve kısıtlanmış istekler olarak iletilmiyordu. Diplomasi yanıtları da bekleyen tekliften bağımsız gelen payload alanlarına dayanabiliyordu.

**Düzeltme:** İstemci içi toprak devri, aynı-cihaz ittifak oluşturma ve karşılıklı iptal ayrı istek türlerine taşındı. Host oyuncu kimliklerini, cihaz taraflarını, toprak miktarını ve mevcut ittifakı doğrulayıp işlemi kendi haritasında yapıyor. Çapraz-cihaz teklif/iptal yanıtları artık hostun bekleyen teklif/istek kimliğiyle eşleştiriliyor; kabul edilen ittifak verisi istemcinin yolladığı nesneden değil hostta saklanan tekliften oluşturuluyor. İptal edilen bekleyen diplomasi pencereleri karşı cihaza da kapatılıyor.

### 4. Çevrimiçi rulet seçimi

Host, istemciden gelen rulet sayısında tamsayı/evre kontrolünü yeterince yapmıyordu; bozuk sayı `NaN` olarak oyun durumuna girebilirdi.

**Düzeltme:** Sayı seçimi yalnızca aktif istemci oyuncusunun `PICK_NUMBER` aşamasında ve 1–9 arası tamsayı olarak kabul ediliyor. Rulet isteği de aynı kontrollerden geçiyor; güvenli üst sınır hostta uygulanıyor.

### 5. React StrictMode ve ortak dünya bağlantısının yaşam döngüsü

`WorldSimulationEngine` oluşturulurken constructor içinde EventSource, BroadcastChannel ve zamanlayıcılar başlatılıyordu. React StrictMode geliştirme döngüsünde render edilen örneklerden biri atılabildiğinden yinelenen bağlantı/zamanlayıcı veya cleanup sonrasında tekrar kurulmamış bağlantı riski vardı.

**Düzeltme:** Ağ senkronizasyonu constructor dışına alındı. `ensureSync()` bağlantıyı mount sonrasında başlatıyor; `SharedWorldSync.destroy()` artık idempotent ve yok edilmiş bir bağlantı yeniden kullanılmıyor. Bekleyen bulut sorguları da destroy sonrası sonuçlarını uygulamıyor.

### 6. Cihaz kimliği ve ülke kimliğinin saklanması

`localStorage` erişimi engellendiğinde tek bir `try/catch` nedeniyle sessionStorage/çerez yedekleri de kullanılamayabiliyordu.

**Düzeltme:** localStorage, sessionStorage ve çerez erişimleri birbirinden bağımsız ele alınıyor. Yerel depolama engellense de kullanılabilir yedek depolarda cihaz/ülke kimliği korunuyor. Cihaz kimliği için `crypto.randomUUID()` destekleniyorsa kullanılıyor.

### 7. Nükleer saldırı ve uzak dünya verisi sınır kontrolleri

Uzak saldırı geçmişi ve senkronizasyon paketleri koordinat, yarıçap, zaman, ülke kimliği, RLE/koordinat dizileri ve ülke istatistikleri açısından sıkı sınırlandırılmamıştı. Hatalı/tekrarlı geri alma paketleri sahiplik sayaçlarını bozabilirdi. Eski yerel dünya görüntüsünün üstüne nükleer geçmiş yüklenirken sahiplik sayıları eski kalabiliyordu.

**Düzeltme:** Nükleer saldırılar için koordinat, başlangıç noktası, azami yarıçap ve zaman penceresi doğrulaması eklendi. Uzak fetih/geri alma işlemleri tamsayı koordinat, harita sınırı, ülke kimliği, kara/çorak arazi ve mevcut sahiplik kontrolünden geçiyor. Ülke kimlikleri, renk/isim, yükseltmeler, nüfus/altın/asker/envanter ve RLE/koordinat dizileri sınırlandırıldı. Çorak arazi başkent üzerinden tekrar sahiplenilemiyor. Kayıtlı nükleer saldırı geçmişi yerel görüntüden sonra uygulandığında ülke alanları gerçek sahiplik haritasından yeniden hesaplanıyor.

### 8. Android ve web sürüm metadata uyumsuzluğu

Android Gradle dosyasında sabit `versionCode`/`versionName` değerleri, `public/version.json` içindeki sürümle farklıydı. Web sürüm kontrolünde ayrıca yanlış GitHub Pages kullanıcı adı kullanılmıştı; kök `/version.json` yolu proje alt dizininde güvenilir değildi.

**Düzeltme:** Android Gradle, `public/version.json` dosyasını okuyarak APK sürümünü aynı kaynaktan alıyor. Vite web sürüm değerlerini aynı dosyadan derleme zamanında enjekte ediyor. Web sürüm kontrolü önce göreli `./version.json`, ardından doğru GitHub Pages adresini deniyor. Zorunlu minimum sürüm ile isteğe bağlı güncelleme ayrıldı; Android istemcide isteğe bağlı APK güncellemesi bildirimi de eklendi.

## Eklenen otomatik testler

`tests/` dizinine Node.js testleri eklendi ve `package.json` içine `npm test` komutu tanımlandı.

- Tur hamlelerinin geçerli/sınır dışı/ondalıklı/tekrarlı/sahte sahiplikli olma durumları
- Tur puanı ve kare maliyeti doğrulaması
- Duvar aşma, ikinci aşama yıkım ve normal iki puanlı duvar saldırısı
- Ardışık bitişik hamle doğrulaması
- Duvar kurma ve bozuk tahta şekli kontrolleri
- localStorage erişimi engellendiğinde cihaz/ülke kimliği yedeği

## Test sonuçları

| Kontrol | Sonuç |
|---|---:|
| `node --test` | **12/12 başarılı** |
| JavaScript/JSX sözdizimi taraması | **25 dosya, 0 sözdizimi hatası** |
| Değiştirilen saf JavaScript modüllerinde `node --check` | Başarılı |
| `git diff --check` | Hata yok |
| `npm run lint` | Çalıştırılamadı — bağımlılık kurulumu zaman aşımına uğradı |
| `npm run build` | Çalıştırılamadı — Vite ikilisi kurulamadı |
| Android APK/Gradle derlemesi | Bu ortamda çalıştırılmadı |
| İki gerçek cihazla çevrimiçi oyun testi | Bu ortamda çalıştırılmadı |

`npm ci --ignore-scripts --prefer-offline --no-audit --no-fund` denemesi ortamda zaman aşımına uğradı. Bu yüzden derleme/lint sonucu başarılı olarak raporlanmıyor. Projeyi yerel makinede açınca `npm ci`, `npm test`, `npm run lint` ve `npm run build` çalıştırılmalı; Android için `cd android` ardından `./gradlew assembleDebug` ile APK doğrulanmalı.

## Açık kalan kritik mimari güvenlik riski

Ortak dünya senkronizasyonu `https://ntfy.sh/sf_mmo_earth_v17_fresh` adlı herkese açık konu üzerinden yapılıyor. `src/world/sharedWorldSync.js` bu kanaldan gelen mesajların gerçek göndericisini kriptografik olarak doğrulamadan uyguluyor. Aynı akışta `ADMIN_DELETE_COUNTRY`, `ADMIN_CLEAR_CHAT`, `ADMIN_CLEAR_RADIATION`, `ADMIN_RESET_TREATIES` ve `ADMIN_RESET_WORLD` gibi yönetim mesajları da işleniyor. İstemci tarafındaki IP/hash kontrolü, herkese açık JavaScript içinde güvenilir bir yönetici kimlik doğrulama sınırı oluşturmaz.

Bu açığı yalnızca statik istemci koduna gizli anahtar koyarak güvenli biçimde kapatmak mümkün değil; tarayıcıya gönderilen anahtar kullanıcı tarafından çıkarılabilir. Kalıcı çözüm için sunucu tarafında kimlik doğrulama/yetkilendirme, yönetici işlemlerinin sunucu tarafından imzalanması veya yalnızca sunucunun yazabildiği özel bir mesaj kanalı gerekiyor. Bu mimari risk bu ZIP içinde **çözülmüş değildir**; raporda özellikle açık bırakılmıştır.

## GitHub durumu

Düzeltmeler bu arşivdeki çalışma kopyasına uygulandı. GitHub `main` dalına commit/push yapılmadı; bu çalışma sırasında bağlı GitHub yazma API'si 403 erişim hatası döndürdü.
