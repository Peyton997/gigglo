'use strict';
// Gizli anahtar, sosyal mühendislik, reklam ve jar-gösterge kalıpları.

/* ------------------------------------------------ gizli anahtar sızıntısı */
const SECRET_PATTERNS = [
  { name: 'Discord bot/kullanıcı token\'ı', re: /\b[MNO][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}\b/ },
  { name: 'Discord MFA token\'ı', re: /\bmfa\.[A-Za-z\d_-]{84}\b/ },
  { name: 'GitHub token\'ı', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Telegram bot token\'ı', re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { name: 'API anahtarı (sk-...)', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'AWS erişim anahtarı', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Özel anahtar (PRIVATE KEY)', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

// Eşleşen gizli değeri SAKLAMAZ; yalnızca türünü döndürür.
function findSecret(text) {
  const s = String(text || '');
  for (const p of SECRET_PATTERNS) if (p.re.test(s)) return p.name;
  return null;
}

/* ------------------------------------------------ sosyal mühendislik (RAT/dosya yem kalıpları) */
const SOC_PATTERNS = [
  { w: 2, re: /\b(mod|plugin|client|hile|cheat|macro|launcher|program|uygulama|dosya|jar|exe)\b.{0,40}\b(dene|test|bak|indir|calistir|çalıştır|kur|aç)\w*/i },
  { w: 2, re: /\b(indir|download|çalıştır|calistir|run|aç|kur|install)\b.{0,30}\b(bu|şu|su|this|the)\b.{0,20}\b(dosya|mod|program|jar|exe|client|hile|file)\b/i },
  { w: 2, re: /\b(anydesk|teamviewer|quick ?support|ekran paylaş|ekran paylas|screen ?share|uzak masaüstü|uzak masaustu|remote desktop)\b/i },
  { w: 3, re: /\b(free|bedava|ücretsiz|ucretsiz)\b.{0,20}\b(nitro|robux|v-?bucks|hesap|account|key|lisans|cheat|hile|client)\b/i },
  { w: 2, re: /\b(sana|size)\s+(özel|ozel|bir)\s+(hile|mod|client|program)/i },
  { w: 1, re: /\b(test et|test eder misin|test eder|beta tester|testçi|testci)\b/i },
  { w: 2, re: /\b(hesab[ıi]n[ıi]?|account)\b.{0,20}\b(devret|transfer|ver|sat)\b/i },
  { w: 3, re: /\b(şifre|sifre|password|token|2fa|doğrulama kodu|dogrulama kodu)\b.{0,20}\b(ver|gönder|gonder|send|paylaş|paylas)\b/i },
];

// Toplam >= 3 ise mesaj "yem" kalıplarına benziyor demektir (ceza değil, risk sinyali).
function socScore(text) {
  const s = String(text || '').slice(0, 2000);
  let total = 0;
  for (const p of SOC_PATTERNS) if (p.re.test(s)) total += p.w;
  return total;
}

/* ------------------------------------------------ reklam */
const AD_PATTERNS = [
  /\b(sunucumuza|sunucuma|serverimize|serverıma)\s+(gel|katıl|katil|bekliyoruz)/i,
  /\b(join|check\s*out)\s+(my|our)\s+(server|discord|community)/i,
  /\b(ücretsiz|ucretsiz|bedava|free)\s+(nitro|robux|v-?bucks|steam|hesap|gift)/i,
  /\b(takip\s*et|follow)\b.{0,25}\b(instagram|tiktok|youtube|twitch)\b/i,
  /\b(satılık|satilik|for sale|alım satım|alim satim)\b.{0,40}\b(hesap|account|rank|key|sunucu)\b/i,
  /\b(?:play|mc|oyna|sunucu)\.[a-z0-9-]{3,}\.(?:com|net|xyz|gg|org|io|fun|tr|az)\b/i,
  /\bip\s*[:=]\s*[a-z0-9.-]+\.[a-z]{2,}/i,
];

/* ------------------------------------------------ jar / mod statik göstergeleri */
const JAR_INDICATORS = [
  { name: 'Discord webhook adresi', needle: 'discord.com/api/webhooks', w: 3 },
  { name: 'Discord webhook adresi (eski)', needle: 'discordapp.com/api/webhooks', w: 3 },
  { name: 'Telegram bot API çağrısı', needle: 'api.telegram.org/bot', w: 3 },
  { name: 'Dış süreç başlatma (ProcessBuilder)', needle: 'java/lang/ProcessBuilder', w: 2 },
  { name: 'PowerShell çağrısı', needle: 'powershell', w: 3 },
  { name: 'cmd.exe çağrısı', needle: 'cmd.exe', w: 2 },
  { name: 'Tarayıcı verisi (Login Data)', needle: 'Login Data', w: 4 },
  { name: 'Discord yerel depolama (leveldb)', needle: 'leveldb', w: 3 },
  { name: 'Tarayıcı çerezleri (Cookies)', needle: 'Cookies', w: 1 },
  { name: 'Uzak sınıf yükleme (URLClassLoader)', needle: 'java/net/URLClassLoader', w: 2 },
  { name: 'Base64 çözücü', needle: 'java/util/Base64', w: 1 },
  { name: 'Çalıştırılabilir dosya referansı (.exe)', needle: '.exe', w: 2 },
];

const LOADER_FILES = [
  'fabric.mod.json', 'quilt.mod.json', 'META-INF/mods.toml', 'META-INF/neoforge.mods.toml',
  'mcmod.info', 'plugin.yml', 'paper-plugin.yml', 'bungee.yml', 'velocity-plugin.json',
];

const EMBEDDED_EXEC_RE = /\.(exe|dll|bat|cmd|ps1|vbs|scr|msi|sh)$/i;

module.exports = {
  SECRET_PATTERNS, findSecret, SOC_PATTERNS, socScore, AD_PATTERNS,
  JAR_INDICATORS, LOADER_FILES, EMBEDDED_EXEC_RE,
};
