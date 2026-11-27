# 🛡️ Kalkan — Discord Güvenlik, Moderasyon ve Kurtarma Botu

Bir klan sunucusunun zararlı bir mod yüzünden ele geçirilip silinmesi olayından ilham alınarak yazıldı.
Amaç üç katmanlı: **önle** (zararlı dosya/link/hesap), **sınırla** (biri hesabı kaptırsa zarar küçük kalsın), **kurtar** (sunucu gidiyorsa üyeler ve yapı kaybolmasın).

> Tüm bot mesajları Türkçedir. Telefonda (Termux) ücretsiz ve 7/24 çalışacak şekilde tasarlandı — VDS gerekmez.

---

## İçindekiler
1. [Neler yapar?](#1-neler-yapar)
2. [Kurulum — Discord tarafı](#2-kurulum--discord-tarafı)
3. [Kurulum — Telefon (Termux)](#3-kurulum--telefon-termux)
4. [İlk ayarlar (sunucuda 10 dakika)](#4-ilk-ayarlar-sunucuda-10-dakika)
5. [Komutlar](#5-komutlar)
6. [Hesap bağlama ve kurtarma (isteğe bağlı ama önemli)](#6-hesap-bağlama-ve-kurtarma)
7. [Gizlilik ve veri](#7-gizlilik-ve-veri)
8. [Dürüst sınırlar — bunları bil](#8-dürüst-sınırlar--bunları-bil)
9. [Sorun giderme](#9-sorun-giderme)
10. [Proje yapısı, test, yedek](#10-proje-yapısı-test-yedek)

---

## 1. Neler yapar?

**Önleme**
- **Link koruması (akıllı):** Her kanalda, istisnasız. **GIF'ler (Tenor/Giphy) link sayılmaz.** Discord CDN medyası serbest. Davet linkleri, bilinmeyen siteler, IP adresleri, taklit (punycode / bozuk biçimli) alan adları, kısaltılmış linkler (bit.ly gibi → hedefine bakılır), çalıştırılabilir dosya linkleri engellenir. Gizlenmiş yazımlar (`discord . gg / x`, `hxxp`, `[.]`) yakalanır.
- **Dosya koruması:** `.exe .jar .bat .ps1 …` gibi çalıştırılabilirler engellenir; yeni üyeler arşiv atamaz; engellenen dosya **çalıştırılmadan** indirilip hash'lenir, VirusTotal'e sorulur (dosya yüklenmez), karantina kanalına yazılır. VirusTotal'de ≥3 motor zararlı derse hash kara listeye girer.
- **Küfür / hakaret, reklam, spam, flood, tekrar, çok kanala aynı mesaj, toplu etiket, BÜYÜK HARF, emoji/satır seli** — Türkçeye özel (`sıktı`, `şikayet`, `amca`, `sikke` gibi masum kelimeler yanlış alarm vermez; `s1kt1r`, `a m k` gibi gizlemeler yakalanır). Kademeli ceza: uyarı → susturma.
- **Token / gizli anahtar sızıntısı:** mesaj silinir, mağdur cezalandırılmaz, özelden uyarılır.
- **Mod/plugin kontrolü:** `/modkontrol` bir `.jar` dosyasını çalıştırmadan tarar (webhook adresi, PowerShell/cmd çağrısı, gömülü `.exe`, Modrinth'te bilinen proje mi…). `tools/plugin-watch.js` ile Minecraft sunucundaki `plugins/` klasörünü de izleyebilirsin.
- **Doğrulama kapısı, yeni hesap kapısı, baskın (raid) tespiti, davet çiftliği tespiti, yetkili ismi taklidi** (Kiril/Yunan benzer harfler dahil).
- **Bal küpü (honeypot):** sahte kanal; oraya yazan kişi otomatik yakalanır (ele geçirilmiş hesaplar/botlar toplu mesaj atarken).
- **Güvenlik sınavı (`/sinav`):** 6 rastgele soru, geçen role kavuşur. Çoğu saldırı insan hatasıyla başlar.

**Sınırlama (biri hesabını kaptırırsa)**
- **Anti-nuke:** kısa sürede toplu kanal/rol silme, ban/kick, webhook, budama, emoji silme → kritik roller alınır, 1 saat susturulur, silinenler geri yüklenir, kritik uyarı gelir. Gece modunda eşikler yarıya iner. Sunucu sahibi/güvenilir hesap için eşik iki katıdır ve hesaba dokunulmaz (ama panik modu açılabilir).
- **Rol koruması + zaman kilidi:** güvenilmeyen biri yönetici rolü verirse geri alınır; güvenilir kişi verse bile istersen 24 saat beklemeye alınır (`/yetki iptal` ile durdurulur).
- **Yetkisiz bot ekleme** anında atılır.
- **Risk skoru:** şüpheli sinyaller birikir (yarı ömür 6 saat); eşik aşılırsa **geri alınabilir** otomatik önlem (susturma + kritik rolleri alma + izleme). `/uye geri-al` ile tek komutla iade.
- **Süreli yetki (JIT, `/yetki`):** kimse kalıcı yönetici olmaz; yetki ikinci kişinin onayıyla, süreli verilir.
- **Panik modu (`/panic ac`):** tüm kanalları kilitler, davetleri kapatır, doğrulama seviyesini yükseltir; kapatınca eski hale döner.

**Kurtarma**
- **Üye kaydı:** sunucudaki herkes (eskiler ve yeniler) güvenlik amacıyla kaydedilir (yalnızca kimlik/rol/sayaç; mesaj içeriği değil).
- **Sunucu silinirse:** bot, doğrulanmış üyelerin sunucu listesine bakarak silindiğini **doğrular** (bot sadece atıldıysa duyuru göndermez), sonra **yalnızca gönüllü olarak kayıt olan (`/izin-ver` ya da hesap bağlayan) üyelere** açıklama + yedek sunucu linkini yavaş ve güvenli bir kuyrukla DM'ler. Kayıt olmayan kimseye toplu DM gitmez; izni `/izni-iptal` ile her zaman geri çekilir. Belirsizse sahiplere "göndereyim mi?" diye sorar.
- **İki anahtarlı koruma:** yedek sunucu/duyuru ayarı iki ayrı kişide durur; değişiklik 12 saat beklemeli ve diğer kişi iptal edebilir → birinin hesabı çalınsa bile kurtarma düzeni bozulmaz.
- **Şifreli yedek:** roller, kanallar, izinler, üye-rol eşleşmesi. Geri yükleme **yalnızca ekler**, hiçbir şeyi silmez. Silinen kanal/rol anti-nuke tarafından otomatik geri getirilir.

**Analiz ve izleme**
- **Olay analizi (`/olay rapor`):** denetim günlüğünden zaman çizelgesi + "kim yapmış olabilir" sıralaması (olasılık diliyle, kesin hüküm değil) + kanıt dosyası. Saldırı olunca uyarı kanalına otomatik ön özet düşer. İstersen Anthropic API ile doğal dilde özet.
- **Kullanıcı izleme (`/izle`):** özellikle RAT/zararlı dosya dağıtmaya çalışan kişiler için. İzlenen kişinin mesajları, silinen mesajları, gönderdiği dosyalar (hash, gerçek tür tespiti, `.png` görünümlü `.exe`, jar taraması, VirusTotal), davetleri, ses kanalı hareketleri, isim değişiklikleri kaydedilir; riskli dosyada otomatik silme + uyarı. `/ihbar` ve sağ tık "Şüpheli Bildir" ile üyeler ihbar edebilir (kötüye kullanıma karşı limitli); yeterli farklı ihbarla otomatik izlemeye alınır.
- **Kara liste:** yerel + dış listeler (kullanıcı ID, dosya hash, sahte alan adları).
- **`/durum`, `/guvenlik` (0–100 puan + somut öneriler), haftalık rapor.**
- **Ek uyarı kanalları:** ntfy.sh, Telegram, ayrı sunucuda webhook — Discord'a erişemesen bile telefonuna ulaşır.

---

## 2. Kurulum — Discord tarafı

1. <https://discord.com/developers/applications> → **New Application** (adı: Kalkan).
2. Sol menü **Bot**:
   - **Reset Token** → token'ı kopyala (bunu sadece `.env` dosyasına yaz, kimseye gösterme).
   - **Public Bot: KAPALI** (kimse botu başka sunucuya ekleyemesin).
   - **Privileged Gateway Intents**: **Server Members Intent** ve **Message Content Intent** → **AÇIK**. (Kapalıysa bot "disallowed intents" hatası verir.)
3. (Hesap bağlama kullanacaksan) **OAuth2** → **Client Secret** → kopyala (`CLIENT_SECRET`). Redirect adresini 6. bölümde ekleyeceksin.
4. Botu sunucuna eklemek için şu adresi tarayıcıda aç (`APP_ID` yerine **General Information → Application ID** yaz):

   ```
   https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot%20applications.commands&permissions=1099780189367
   ```

   Bu adres, botun tam ihtiyacı olan yetkileri verir (Yönetici DEĞİL): denetim günlüğü, rol/kanal yönetimi, atma/yasaklama, susturma, mesaj yönetimi, sunucu yönetimi (davetler), kanal görme, mesaj/embed/dosya, davet oluşturma.
5. **Çok önemli — rol sırası:** Sunucu Ayarları → Roller → **Kalkan rolünü, yönetmesi gereken tüm rollerin üstüne sürükle** (sahibin/sen dışındaki en yüksek yetkili rolün hemen altı ya da üstü olsun). Bot, kendi rolünden yüksek bir role müdahale edemez. `/guvenlik` bunu kontrol eder.
6. Discord'da **Ayarlar → Gelişmiş → Geliştirici Modu**'nu aç; kendi profiline sağ tıkla → **Kullanıcı ID'sini Kopyala** (→ `OWNER_IDS`). İkinci anahtar için güvendiğin **başka bir kişinin** ID'sini de al (→ `BACKUP_OWNER_IDS`).

> 💡 Yönetici yetkisi vermedim; böylece bot ele geçirilse zarar sınırlı kalır. Dezavantajı: silinen bir "Yönetici" rolü yeniden oluşturulurken, botun kendisinde olmayan yetkiler role verilemez (güvenlik gereği). İstersen botu Yönetici yaparsın ama bunu önermem.

---

## 3. Kurulum — Telefon (Termux)

### 3.1 Termux'u kur
- Play Store'daki Termux eski ve bozuk. **F-Droid**'den kur: <https://f-droid.org/packages/com.termux/>
- İsteğe bağlı: **Termux:Boot** (telefon yeniden başlayınca bot kendi açılsın) — yine F-Droid'den.

### 3.2 Gerekli paketler
Termux'ta sırayla:

```bash
pkg update -y && pkg upgrade -y
pkg install -y nodejs git unzip nano tmux
termux-setup-storage          # izin isteyecek, "İzin ver" de
node -v                       # v18 ve üstü olmalı (v20/v22 en iyisi)
```

### 3.3 Botu yükle
Zip dosyasını telefonuna indir (örn. **İndirilenler** klasörüne), sonra:

```bash
cd ~
unzip ~/storage/downloads/kalkan-bot.zip      # dosya adın farklıysa düzelt
cd kalkan-bot
npm install                                    # 1-3 dakika sürebilir
cp .env.example .env
nano .env                                      # DISCORD_TOKEN ve OWNER_IDS'i doldur (CTRL+X, Y, Enter ile kaydet)
npm run check                                  # kendi kendini test eder: "Her şey yolunda" yazmalı
```

### 3.4 Çalıştır (7/24)
```bash
tmux new -s kalkan
bash start.sh
# tmux'tan ayrıl: CTRL+B, sonra D.   Geri dönmek için:  tmux attach -t kalkan
```
`start.sh` botu çökerse / bağlantı koparsa kendisi yeniden başlatır ve günlüğü `data/logs/kalkan.log` dosyasına yazar (`tail -f data/logs/kalkan.log`).

İlk açılışta bot sana DM atar: "Kalkan çevrimiçi". Gelmezse `.env` içindeki `OWNER_IDS`'i ve botla ortak sunucun olduğunu kontrol et.

### 3.5 Telefonun botu öldürmesini engelle (en kritik kısım)
Android arka plan uygulamalarını agresifçe kapatır. Şunları yap:
- **Ayarlar → Uygulamalar → Termux → Pil → "Kısıtlama yok / Optimize etme"** (telefona göre adı değişir).
- Termux bildiriminde **"Acquire wakelock"** yazıyorsa ona dokun (start.sh de `termux-wake-lock` çağırır).
- Termux'u **son uygulamalar ekranında kilitle** (kartı basılı tut → kilit).
- Android 12+ için: **Geliştirici seçenekleri → "Alt süreç kısıtlamalarını devre dışı bırak"** (Android 14+) ya da bilgisayardan `adb shell settings put global settings_enable_monitor_phantom_procs false`.
- Telefonu **şarjda** ve **sabit Wi-Fi'da** tut. Mobil veride kullanacaksan kotaya dikkat (bot az veri kullanır ama 7/24 açık kalır).
- **Termux:Boot** kurduysan: 
  ```bash
  mkdir -p ~/.termux/boot
  printf '#!/data/data/com.termux/files/usr/bin/bash\ntermux-wake-lock\ncd ~/kalkan-bot && bash start.sh\n' > ~/.termux/boot/kalkan.sh
  chmod +x ~/.termux/boot/kalkan.sh
  ```
  Ve Termux:Boot uygulamasını bir kez aç.

### 3.6 Güncelleme / durdurma
- Durdur: tmux içinde `CTRL+C` (bot düzgün kapanır, veriyi yazar).
- Güncelleme: yeni zip'i **başka klasöre** aç, eski `data/` ve `.env` dosyalarını yeni klasöre kopyala.

---

## 4. İlk ayarlar (sunucuda 10 dakika)

Hepsi Discord'da, yetkili bir hesaptan:

1. `/ayar kanal` → **uyarı** kanalı (yalnızca yetkililerin gördüğü bir kanal) ve **log** kanalı. Uyarılar ayrıca sana DM olarak da gelir.
2. `/guvenlik` → puanını ve eksiklerini gör. Önerileri sırayla yap.
3. `/yedek al` → ilk yedek. (Sonrası her 6 saatte otomatik.)
4. `/honeypot kur` → tuzak kanalı.
5. `/dogrulama kur` → yeni üyeler önce doğrulama kanalını görür (isteğe bağlı ama baskınlara karşı çok etkili).
6. `/ayar guvenilir` → gerçekten güvendiğin 1–3 kişi. (Listeyi küçük tut: bunlar anti-nuke'tan muaf.)
7. Kurtarma: bölüm 6.
8. `/ayar goster` ile her şeyi kontrol et.

Her ayar değişikliği uyarı kanalına yazılır, yani biri hesabını çalıp ayarları kurcalarsa görürsün.

---

## 5. Komutlar

| Komut | Ne yapar |
|---|---|
| `/ayar goster · kanal · guvenilir · muaf-rol · modul · link-izin · kufur-seviye · kufur-kelime · gece-modu · dogrulama-rol · jit · sinav-rol · ceza · deger` | Tüm ayarlar. `deger` içinde 50'den fazla eşik/süre/aç-kapa var (otomatik tamamlamalı). |
| `/guvenlik` · `/durum` | Güvenlik puanı + öneriler · botun sağlığı |
| `/panic ac · kapat` | Acil kilit |
| `/raid durum · ac · kapat · birak · at` | Baskın modu |
| `/dogrulama kur · durum · kaldir` | Doğrulama kapısı |
| `/yedek al · liste · geri-yukle` | Sunucu yedeği (geri yükleme yalnızca ekler) |
| `/kurtarma durum · hedef · hedef-iptal · metin-ayarla · tatbikat · duyur · durdur · otomatik` | Sunucu kaybı planı |
| `/hesap baglan · kod · durum · sil` · `/verilerimi-sil` | Üyenin kendi hesap bağlantısı / verisini silmesi |
| `/yetki al · birak · iptal · liste` | Süreli yönetici yetkisi |
| `/izle ekle · kaldir · liste · rapor · not` | Kullanıcı izleme |
| `/ihbar` · sağ tık → **Şüpheli Bildir** | Üyeler şüpheli kişiyi bildirir |
| `/karaliste ekle · kaldir · kontrol · liste · durum` | Kara liste |
| `/olay rapor · kisi` | Olay analizi + kanıt dosyası |
| `/audit son` · `/uye bilgi · geri-al` | Kayıtlar · üye kaydı / önlemleri geri alma |
| `/modkontrol` · `/linkkontrol` | Dosyayı/linki açmadan kontrol |
| `/honeypot kur · kaldir` · `/sinav basla · durum · liste` | Tuzak kanal · güvenlik sınavı |

Hassas komutlar (ayarlar, yedek, kurtarma, zaman kilidi…) yalnızca `OWNER_IDS` içindekilere (ya da `OWNER_IDS` boşsa sunucu sahibine) açıktır.

### Plugin izleyici (isteğe bağlı)
Minecraft sunucunun dosyalarına erişebildiğin bir makinede:
```bash
node tools/plugin-watch.js --dir /sunucu/plugins --webhook "https://discord.com/api/webhooks/..." --interval 30
```
İlk çalıştırmada mevcut dosyalar referans alınır; sonra yeni/değişen her `.jar` taranır ve webhook'a yazılır. (Pterodactyl panelde terminal yoksa bu araç yerine `/modkontrol` ile dosyayı elle gönder.)

---

## 6. Hesap bağlama ve kurtarma

**Önemli — gönüllülük esastır.** Sunucu silinirse DM yalnızca **kurtarma bildirimine gönüllü olarak kayıt olmuş** üyelere gider. Üye iki yoldan kayıt olur: `/izin-ver` (tek komut) ya da `/hesap baglan` (hesap bağlama; bağlamak da izin sayılır). `/izni-iptal` ile istediği an çıkar, çıkınca bir daha DM almaz. Kayıt olmayan üyeye **toplu DM gönderilmez** (Discord kurallarına aykırı ve spam sayılabilir; hesabın/botun kapanma riski vardır). Bu yüzden sunucu kurallarına "silinirsek haber almak için `/izin-ver` yaz" cümlesini koymanı öneririm.

Hesap bağlamak ise ayrıca iki şeye yarar (isteğe bağlı): silinmeyi **doğrulamak** (bot sadece atıldıysa yanlış alarm vermesin) ve üyeyi **tek tıkla yedek sunucuya eklemek** (`identify guilds guilds.join` izinleri; şifre ve mesajlar okunmaz, kullanıcı token'ı istenmez).

### 6.1 Telefonda önerilen: "elle kod" modu (alan adı/sunucu gerekmez)
1. GitHub'da ücretsiz bir depo aç (örn. `kalkan-dogrulama`), `web/callback.html` ve `web/gizlilik.html` dosyalarını depoya yükle (kök dizine).
2. Depo → **Settings → Pages** → Branch: `main`, klasör `/ (root)` → Save. Adres şuna benzer: `https://KULLANICI.github.io/kalkan-dogrulama/callback.html`
3. Developer Portal → **OAuth2 → Redirects → Add** → bu adresi **birebir** yaz → Save. (İstersen Privacy Policy URL olarak `…/gizlilik.html` yaz.)
4. `.env`: 
   ```
   CLIENT_SECRET=...
   OAUTH_REDIRECT_URI=https://KULLANICI.github.io/kalkan-dogrulama/callback.html
   ```
5. Üye `/hesap baglan` yazar → bağlantıyı açar → sayfada çıkan kodu kopyalar → `/hesap kod` ile yapıştırır. Sayfa statiktir; kodu hiçbir yere göndermez.

*(Alternatif "sunucu" modu için `PUBLIC_URL` gerekir ve botun dışarıdan erişilebilir bir adresi olmalı; telefonda genelde gerekmez.)*

### 6.2 Yedek sunucu ve iki anahtar
1. İkinci bir (boş) sunucu aç; **botu oraya da ekle** (aynı davet adresi; `GUILD_IDS` kullanıyorsan oranın ID'sini ekle). Yedek sunucuda sunucu sahibi sen olma, ya da en az farklı kişi olsun.
2. `.env` içinde `BACKUP_OWNER_IDS` = güvendiğin **başka** kişi. (Aynı kişiyi iki yere yazma; bot uyarır.)
3. Ana sunucuda `/kurtarma hedef` → yedek sunucunun **süresiz** davet linki (`discord.gg/kod`; bot linki gerçekten doğrular). **İlk kurulum anında geçerli olur**; sonraki her değişiklik 12 saat bekler ve diğer anahtardaki kişiye DM'den onay/iptal butonuyla gider.
4. `/kurtarma metin-ayarla` ile üyelere gidecek açıklamayı yaz (içinde link olamaz; link bot tarafından, doğrulanmış yedek sunucudan eklenir). `{sunucu}` yazarsan sunucu adı gelir.
5. **`/kurtarma tatbikat`** → duyuruyu yalnızca sana gönderir. Mutlaka dene.
6. `/kurtarma otomatik` → silinme doğrulanınca duyuru kendiliğinden başlasın mı?

---

## 7. Gizlilik ve veri

Saklananlar (`data/` klasörü): üye kimliği, kullanıcı adı, roller, katılım zamanı, **sayaçlar** (mesaj/link/dosya sayısı, saat dağılımı), risk skoru; hesabını bağlayanlar için **şifreli** erişim anahtarı; sunucu yedekleri (**şifreli**); olay günlüğü (olay türü + kimlikler; mesaj içeriği değil). **İzleme listesindekilerin** mesajları yetkililer için kaydedilir.
Saklanmayanlar: şifreler, e-posta, özel mesajlar, izlenmeyen kişilerin mesaj içeriği.

**Üyenin komutları:** `/privacy` (neleri, neden, ne kadar süre sakladığımız), `/verilerim` (kendi verisinin özeti), `/veri-indir` (JSON dökümü; yalnızca sana görünen özel yanıtla ek dosya olarak gelir, erişim anahtarların dökümde yer almaz), `/verilerimi-sil` (silme + olay günlüğündeki kimliğin takma adla değişmesi), `/izin-ver` ve `/izni-iptal` (kurtarma bildirimi izni).
**Yetkili erişim kaydı:** bir yetkili üyenin kişisel/güvenlik verisine baktığında kayıt düşer (kim, ne zaman, hangi kişi); güvenilir kişiler (sunucu sahibi, bot sahibi ve `/ayar` ile eklenenler) `/erisim-kaydi` ile görür. Günlüklerde token/webhook/anahtar yazılmadan önce maskelenir.
**Saklama süreleri (varsayılan):** olay günlüğü 90 gün, erişim kaydı 180 gün, moderasyon vakaları 365 gün, ayrılan üye 30 gün. Günlük otomatik temizlenir. Güvenlik soruşturması kayıtları (izleme listesi, risk puanı) ve moderasyon vakaları `/veri-indir` dökümüne dahil değildir; bunların var olduğu `/privacy` içinde açıkça yazılıdır.
- Ayrılan üyenin kaydı **30 gün sonra** silinir. Herkes `/hesap sil` ya da `/verilerimi-sil` ile kendi verisini siler.
- Şifreleme anahtarı: `.env` içindeki `DATA_KEY` (öneri; en az 12 karakter ya da 64 hex) ya da `data/.key`. **Anahtarı kaybedersen şifreli veriler açılamaz.** Anahtarı değiştirirken eskisini `DATA_KEY_OLD` içine yaz; eski veriler açılmaya devam eder.
- Üyelerine sunucu kurallarında botun bu verileri güvenlik amacıyla tuttuğunu yazmanı öneririm (KVKK/GDPR şeffaflığı). Ben avukat değilim; hukuki konularda uzmana danış.

---

## 8. Dürüst sınırlar — bunları bil

- **Telefon = en zayıf halka.** Telefon kapanır/uyur/internet kesilirse bot çevrimdışıdır ve o sürede **hiçbir koruma çalışmaz** (Discord tarafında doğrulama kapısı gibi kurulu şeyler yerinde kalır ama yeni olaylar işlenmez). Bot çevrimdışı olunca uyarı alırsan (ntfy/Telegram'ı ayarlaman bu yüzden önerilir) tedbir alırsın. İleride ücretsiz bir bulut/VPS seçeneği bulursan `data/` ve `.env` dosyalarını taşıman yeter.
- **Botun kendisi de hedeftir.** Token'ı sızdırma. Telefon ele geçirilirse bot da gider. Bu yüzden Yönetici yetkisi vermedim ve iki anahtar var.
- **Kusursuz koruma yok.** Bu bot riski ciddi şekilde düşürür ama her saldırıyı durdurmaz. En büyük koruma insanlar: şüpheli dosya açmamak, 2FA, en az yetki. (`/sinav` bunun için.)
- **Zararlı dosyayı "çalıştırarak" tespit etmez.** Statik tarama + hash + VirusTotal yapar; yeni/özel bir zararlıyı kaçırabilir. Şüpheli olanı hiç açma.
- **Mesajlar yedeklenmez.** Sunucu silinirse yapı (rol/kanal/izin) geri gelir, sohbet geçmişi gelmez.
- **DM'leri göremez.** RAT'i DM'den atanlar için `/ihbar` ve izleme listesi yardımcıdır; bot DM'leri okuyamaz.
- **Kim yaptı tahmini sezgiseldir.** `/olay rapor` olasılık verir, kesin hüküm vermez; son karar insanın.
- **Gönüllü kayıt olmayan üyeye kurtarma DM'i gitmez.** Sunucu silinirse haber alabilenler yalnızca `/izin-ver` diyenler ya da hesabını bağlayanlardır; bu bilinçli bir güvenlik/uyum kararıdır. Kayıt sayısı düşükse bunu sunucu kurallarında duyur.
- **Gerçek Discord ile otomatik test yapılmaz.** `npm test` sahte (mock) Discord nesneleriyle çalışır: mantığı, yetkileri ve veri akışını doğrular ama Discord'un gerçek hız sınırlarını, izin hatalarını ve ağ davranışını kanıtlamaz. Canlı davranış için küçük bir deneme sunucusunda elle denemek gerekir.
- **Discord sınırları:** çok sayıda DM hız sınırına takılabilir (bu yüzden ~1 sn aralıkla gider; 2.400 kişi ≈ 45 dk). DM'i kapalı olanlara ulaşılamaz.
- **Yeni hesap/baskın eşikleri varsayılandır;** sunucuna göre `/ayar deger` ile ayarla, ilk günlerde yanlış alarmları `/ayar muaf-rol` ve `/ayar link-izin` ile gider.

---

## 9. Sorun giderme

| Belirti | Çözüm |
|---|---|
| `Used disallowed intents` | Developer Portal → Bot → **Server Members Intent** ve **Message Content Intent** aç. |
| `DISCORD_TOKEN geçersiz` | Portal'dan **Reset Token** ile yenisini al, `.env`'e yaz. Eski token'ı bir yere yapıştırdıysan mutlaka yenile. |
| Komutlar görünmüyor | Botu `applications.commands` kapsamıyla yeniden ekle (bölüm 2.4). Kayıt birkaç saniye sürer; Discord'u yeniden başlat. |
| "Botun rolü yeterince yüksekte değil" | Bot rolünü sürükleyip yönetmesi gereken rollerin üstüne koy. |
| DM gelmiyor | Botla ortak sunucun olmalı; Discord → Gizlilik → "Sunucu üyelerinden gelen DM'lere izin ver" açık olmalı. |
| `Bot zaten çalışıyor (PID …)` | Başka bir tmux/Termux oturumunda çalışıyor. Yoksa `data/.lock` dosyasını sil. |
| Bot sürekli yeniden başlıyor | `tail -n 50 data/logs/kalkan.log` ve `data/logs/supervisor.log`. Genelde token/intents/internet. `node tools/healthcheck.js` botun sağlığını (bellek, bağlantı, kalp atışı) söyler. |
| `npm install` hatası | `pkg upgrade -y`, `pkg install nodejs` ve tekrar dene; yer açmak için `npm cache clean --force`. |
| Hata ayıklamak | `npm run check` (kendi kendine test), `npm test` (otomatik testler). |

---

## 10. Proje yapısı, test, yedek

```
src/index.js          giriş noktası (bağlantı, modüller, yeniden bağlanma, kapanış)
src/modules/*.js      her özellik ayrı modül (antinuke, raid, backup, recovery, watchlist, …)
src/data/*.js         küfür kalıpları, tehdit göstergeleri
tools/check.js        kendi kendine kontrol (söz dizimi + başlatma + komut şeması)
tools/plugin-watch.js Minecraft plugin klasörü izleyici
web/callback.html     hesap bağlama için statik sayfa (GitHub Pages)
test/                 otomatik testler (npm test)
data/                 (çalışınca oluşur) veri, yedekler, günlükler, .lock
```

**Kendi yedeğin:** `data/` klasörünü ve `.env` dosyasını arada başka yere kopyala (örn. `cp -r data ~/storage/downloads/kalkan-data-yedek`). Telefon bozulursa botu başka yerde kaldığın yerden açabilirsin.

Lisans: kişisel kullanım için serbest. Sorumluluk kullanıcıya aittir.
