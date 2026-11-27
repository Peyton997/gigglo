# Kalkan — Kısa Teknik Denetim Raporu (v1.1 çalışması, 1. kontrol noktası)

Yöntem: README'ye güvenilmedi; kod okundu, kritik yollar (şifreleme, ağ, depo, günlük, DM, yetki) hedefli incelendi, bulgular **testle** doğrulandı.
Sınır: Gerçek Discord'a bağlanan entegrasyon testi **yoktur**; tüm testler sahte (mock) nesnelerle çalışır (bkz. en alt).

## Bulunan ve düzeltilen sorunlar

| # | Önem | Bulgu | Düzeltme | Test |
|---|------|-------|----------|------|
| 1 | Yüksek | Toplu kurtarma DM'i, onay vermemiş tüm kayıtlı üyelere gidiyordu (spam/ToS riski, gizlilik) | Yalnızca **gönüllü kayıt (opt-in)** olanlara; izin geri çekilebilir; bot/ayrılmış üye hariç | recovery.test (7 senaryo) |
| 2 | Yüksek | Günlük maskeleyici, yakalama grubu olmayan desenlerde token'ı maskelemek yerine **konum + tüm satırı** yazıyordu (sır sızıntısı) | `typeof` kontrolüyle düzeltildi | security.test › logger (regresyon) |
| 3 | Yüksek | Dış istekler (indirme/yönlendirme) SSRF'ye karşı yetersizdi | `src/net.js`: yalnız HTTPS, özel/yerel IP (IPv4/IPv6/mapped/NAT64) engeli, bağlantı anında DNS doğrulaması (rebinding), elle yönlendirme izleme + sınır, akışta boyut sınırı | security.test › net (5 test) |
| 4 | Yüksek | Anahtar: parolanın SHA-256'sı, kısa parola kabul, rotasyon yok, sürüm bilgisi yok | scrypt, ≥12 karakter, sürümlü KLK2 zarfı (başlık AAD ile doğrulanır), `DATA_KEY_OLD` ile rotasyon, v1 verisi hâlâ çözülür | security.test › crypto (4 test) |
| 5 | Orta | Depo yazımında fsync yoktu; bozulmada sessiz sıfırlanabiliyordu | fsync + `.bak/.bak2`, bozuk dosya silinmeden saklanır, `loadStatus` sahibe DM ile bildirilir | security.test › store |
| 6 | Orta | Olay günlüğü dosya adı kullanıcı/sunucu girdisinden türüyordu (yol geçişi riski); saklama süresi yoktu; silme isteğinde kimlik kalıyordu | Ad temizleme, `purgeOlderThan`, `anonymizeUser` | security.test › privacy |
| 7 | Orta | Link tespiti `start.sh`, `Main.java` gibi dosya adlarını link sayıp yanlış alarm veriyordu; CDN üzerindeki `.exe` serbestti | Kademeli TLD denetimi, CDN'de medya dışı engel | security.test › links |
| 8 | Orta | Periyodik görevler üst üste binebiliyordu; hata yönetimi dağınıktı | Çakışmasız zamanlayıcı + metrikler; merkezî yönlendirici (hata kimliği, uygulama tarafı yetki, iç ayrıntı sızmaz) | security.test › router |
| 9 | Orta | Çift `/verilerimi-sil` kaydı; kimlik verisi silme eksikti | Tek komut, sağlayıcı tabanlı silme/döküm (`/verilerim`, `/veri-indir`), yetkili erişim kaydı | security.test › privacy |
| 10 | Düşük | `start.sh` günlüğü `tee` ile şişiriyor, kırpma yalnızca yeniden başlatmada | Günlüğü bot döndürür (2 MB × 3); betik yalnız `supervisor.log` yazar; çıkış kodu 3 = bellek sınırı | tools/check.js |
| 11 | Düşük | Sağlık izleme yoktu | `data/health.json` kalp atışı + `tools/healthcheck.js` + bellek bekçisi (`MAX_RSS_MB`) | core testleri |

## Hâlâ açık / henüz yapılmadı (dürüst liste)

- Anti-nuke: güvenilir hesap ele geçirilme alarmı, webhook/sticker/entegrasyon sayaçları, panik için ikinci kişi onayı, sunucuya göre uyarlanan eşikler **henüz yok** (eşikler elle ayarlanabilir).
- Yedek: sürümleme/bütünlük doğrulama/önizleme/tatbikat ve kimlik eşleme iyileştirmeleri sürüyor; **mesaj geçmişi ve sunucu sahipliği geri yüklenemez** (Discord izin vermez).
- Dosya taraması yalnızca **statik**tir (imza/hash/VirusTotal); "güvenli" iddiası yoktur. Sihirli bayt (magic byte) denetimi `files.js` içinde ekleniyor.
- Yeni özellik modülleri (moderasyon vakaları, ticket, kurulum sihirbazı, anket, etkinlik, topluluk araçları) sırada.
- i18n altyapısı hazır (tr/en/az) ama mevcut modül metinlerinin çoğu hâlâ Türkçe sabit metindir.
- Veri deposu JSON'dur (küçük/orta sunucular için); çok büyük sunucularda SQLite gerekebilir — şimdilik eklenmedi.
- Telefonda barındırma 7/24 **garanti edilemez**: Android pil yönetimi Termux'u kapatabilir.

## Test kapsamı ve sınırları

- `npm test`: 122 otomatik test, hepsi **yerel/sahte** (Discord ve internet gerekmez). `node tools/check.js`: söz dizimi + sahte başlatma + komut şeması (28 komut, sınır 100).
- Gerçek Discord'da **doğrulanmayanlar:** hız sınırı davranışı, izin/rol sırası hataları (50013), gerçek DM kapalı durumları, OAuth uçtan uca, gerçek sunucu silinmesi. Bunlar küçük bir deneme sunucusunda elle denenmeli.
