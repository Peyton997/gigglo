'use strict';
// Kalkan — Discord güvenlik botu. Giriş noktası.
const fs = require('fs');
const path = require('path');
const { env } = require('./env');
const log = require('./logger');

const MODULES = require('./module-list');

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

/* ------------------------------------------------------------------ tek kopya kilidi */
// Aynı anda iki kopya çalışırsa her olaya iki kez tepki verilir (çift ban, çift DM). Bunu engelle.
// Android'de çöken sürecin PID'i başka bir sürece verilebilir; bu yüzden kilit dosyası canlı kopya tarafından 20 sn'de bir
// "yenilenir" ve 90 sn'den eski kilit (PID canlı görünse bile) bayat sayılır.
const LOCK_STALE_MS = 90 * 1000;
function acquireLock(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, '.lock');
  try {
    const pid = parseInt(fs.readFileSync(f, 'utf8'), 10);
    const fresh = Date.now() - fs.statSync(f).mtimeMs < LOCK_STALE_MS;
    if (pid && pid !== process.pid && fresh) {
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch { /* süreç yok */ }
      if (alive) fail(`Bot zaten çalışıyor (PID ${pid}). İkinci kopya başlatılmadı.\nTakılı kaldıysa "${f}" dosyasını silip tekrar dene.`);
    }
  } catch { /* kilit yok */ }
  fs.writeFileSync(f, String(process.pid));
  const beat = setInterval(() => { try { const n = new Date(); fs.utimesSync(f, n, n); } catch { /* yoksay */ } }, 20 * 1000);
  beat.unref();
  return () => { clearInterval(beat); try { if (parseInt(fs.readFileSync(f, 'utf8'), 10) === process.pid) fs.unlinkSync(f); } catch { /* yoksay */ } };
}

async function main() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 18) fail(`Node.js 18 veya üstü gerekli (sende ${process.versions.node}). Termux: pkg upgrade && pkg install nodejs`);
  if (!env.token) fail('DISCORD_TOKEN yok. .env dosyasına DISCORD_TOKEN=... satırını ekle (README\'ye bak).');

  const snow = /^\d{15,25}$/;
  for (const [name, arr] of [['OWNER_IDS', env.ownerIds], ['BACKUP_OWNER_IDS', env.backupOwnerIds], ['GUILD_IDS', env.guildIds]]) {
    const bad = arr.filter((x) => !snow.test(x));
    if (bad.length) fail(`${name} içinde geçersiz kimlik var: ${bad.join(', ')} (yalnızca rakamlardan oluşan Discord ID yaz).`);
  }
  if (!env.ownerIds.length) log.warn('OWNER_IDS boş: hassas ayarları yalnızca sunucu sahibi değiştirebilir ve DM uyarıları gönderilemez. .env\'e kendi Discord ID\'ni ekle.');
  const both = env.ownerIds.filter((x) => env.backupOwnerIds.includes(x));
  if (both.length) log.warn('Aynı kişi hem OWNER_IDS hem BACKUP_OWNER_IDS içinde: iki anahtarlı kurtarma korumasız kalır. İkinci anahtar başka bir kişi/hesap olmalı.');

  for (const v of [env.token, env.clientSecret, env.vtKey, env.telegramToken, env.alertWebhook, env.mirrorWebhook, env.anthropicKey, env.dataKey, env.dataKeyOld]) log.addSecret(v);
  if (env.logToFile) log.enableFile(path.join(env.dataDir, 'logs'));

  const releaseLock = acquireLock(env.dataDir);

  const { Client, GatewayIntentBits, Partials, Events, Options, ActivityType, Status } = require('discord.js');
  const { initKey } = require('./crypto');
  const { Store } = require('./store');
  const { EventLog } = require('./eventlog');
  const { createContext } = require('./ctx');

  const keySrc = initKey(env);
  if (keySrc === 'generated') log.warn(`Şifreleme anahtarı oluşturuldu: ${path.join(env.dataDir, '.key')} — bu dosyayı da yedekle! Kaybolursa şifreli veriler (bağlı hesaplar, yedekler) açılamaz.`);

  const store = new Store(env.dataDir).load();
  const events = new EventLog(env.dataDir, { mirrorWebhook: env.mirrorWebhook, botName: env.botName, log });

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration,
      GatewayIntentBits.GuildInvites, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.GuildMember, Partials.User, Partials.Channel, Partials.Reaction],
    allowedMentions: { parse: [], repliedUser: false },
    // Telefonda bellek tasarrufu: mesaj önbelleği küçük, tepki/varlık önbelleği kapalı.
    makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 60, ReactionManager: 0, PresenceManager: 0 }),
  });

  const ctx = createContext({ client, env, store, events, log });
  ctx.shutdown = (code) => shutdown(code);
  ctx.health = require('./health').start(ctx, { onRestart: () => shutdown(3) });

  /* ---------------------------------------------------------------- modüller */
  const failed = [];
  for (const name of MODULES) {
    try {
      require(`./modules/${name}`).init(ctx);
    } catch (e) {
      failed.push(name);
      log.error(`modül başlatılamadı: ${name}`, e);
    }
  }
  log.info(`Modüller: ${MODULES.length - failed.length}/${MODULES.length} hazır${failed.length ? ` — BAŞARISIZ: ${failed.join(', ')}` : ''}`);

  /* ---------------------------------------------------------------- olaylar */
  const allowedGuild = (id) => !env.guildIds.length || env.guildIds.includes(id);

  client.on(Events.InteractionCreate, (i) => {
    if (i.user && i.user.bot) return;
    ctx.router.dispatch(ctx, i).catch((e) => log.error('dispatch hatası:', e));
  });

  client.on(Events.GuildCreate, async (guild) => {
    try {
      if (!allowedGuild(guild.id)) {
        log.warn(`İzin listesinde olmayan sunucuya eklendim, ayrılıyorum: ${guild.name} (${guild.id})`);
        for (const id of env.ownerIds) ctx.dm(id, `⚠️ Bot izin listesinde (GUILD_IDS) olmayan **${guild.name}** (${guild.id}) sunucusuna eklendi ve otomatik ayrıldı. Yedek sunucuysa GUILD_IDS'e ekle.`).catch(() => {});
        await guild.leave();
        return;
      }
      await client.application.commands.set(ctx.router.json(), guild.id).catch((e) => log.warn(`komutlar kaydedilemedi (${guild.name}): ${e.message}`));
      if (ctx.members) await ctx.members.sync(guild);
      if (ctx.recovery) ctx.recovery.touch(guild);
      if (ctx.raid) await ctx.raid.refreshInvites(guild);
      const cfg = ctx.gcfg(guild.id);
      if (!cfg.channels.log && !cfg.channels.alert) log.info(`${guild.name}: log/uyarı kanalı yok — /ayar kanal ile belirle.`);
    } catch (e) { log.error('GuildCreate hatası:', e); }
  });

  client.on(Events.Error, (e) => log.error('discord.js hatası:', e));
  client.on(Events.Warn, (m) => log.warn('discord.js:', m));
  client.on(Events.ShardDisconnect, (ev, id) => log.warn(`Shard ${id} bağlantısı koptu (kod ${ev && ev.code}).`));
  client.on(Events.ShardReconnecting, (id) => log.info(`Shard ${id} yeniden bağlanıyor…`));
  client.on(Events.ShardResume, (id) => log.info(`Shard ${id} bağlantı geri geldi.`));

  /* ---------------------------------------------------------------- hazır */
  let readyAt = 0;
  client.once(Events.ClientReady, async () => {
    readyAt = Date.now();
    log.info(`Giriş yapıldı: ${client.user.tag} • ${client.guilds.cache.size} sunucu`);
    try { client.user.setPresence({ activities: [{ name: 'sunucuyu koruyor 🛡️', type: ActivityType.Watching }], status: 'online' }); } catch { /* yoksay */ }

    for (const g of client.guilds.cache.values()) {
      if (!allowedGuild(g.id)) log.warn(`${g.name} (${g.id}) GUILD_IDS içinde değil; yine de çalışıyorum (başlangıçta otomatik ayrılmam). Yeni eklenmelerde ayrılırım.`);
      try {
        const n = ctx.members ? await ctx.members.sync(g) : 0;
        if (ctx.recovery) ctx.recovery.touch(g);
        if (ctx.raid) await ctx.raid.refreshInvites(g);
        log.info(`${g.name}: ${n} üye kaydedildi`);
      } catch (e) { log.error(`hazırlık hatası (${g.name}):`, e); }
    }

    try {
      const ids = env.guildIds.length ? env.guildIds : [...client.guilds.cache.keys()];
      const n = await ctx.router.register(client, ids);
      log.info(`Komutlar ${n} sunucuya kaydedildi (${ctx.router.names().length} komut).`);
    } catch (e) { log.error('komut kaydı hatası:', e); }

    for (const [label, fn] of [
      ['timelock', () => ctx.timelock && ctx.timelock.restore()],
      ['jit', () => ctx.jit && ctx.jit.restore()],
      ['recovery', () => ctx.recovery && ctx.recovery.resume()],
      ['oauth', () => ctx.oauth && ctx.oauth.start()],
      ['backup', () => ctx.backup && ctx.backup.autoTick()],
      ['blocklist', () => ctx.blocklist && Promise.all([ctx.blocklist.syncRemote(), ctx.blocklist.syncScam()])],
    ]) {
      try { await fn(); } catch (e) { log.error(`başlangıç görevi (${label}):`, e); }
    }

    ctx.every(24 * 3600e3, () => {
      const n = ctx.members.purgeLeft(30);
      if (n) log.info(`${n} eski üye kaydı temizlendi (30 gün).`);
      if (ctx.privacy) ctx.privacy.purgeExpired();
    }, 'gizlilik temizliği');

    // Veritabanı bozuk çıktıysa sahibe açıkça haber ver (sessizce boş ayarlarla çalışma).
    if (store.loadStatus === 'recovered' || store.loadStatus === 'reset') {
      const msg = store.loadStatus === 'recovered'
        ? '⚠️ **Veritabanı dosyası bozuktu**; son yedekten (en fazla ~1 saat eski) geri yüklendi. Bozuk dosya `data/db.corrupt-*.json` olarak saklandı. Ayarlarını kontrol et (`/guvenlik`).'
        : '🛑 **Veritabanı dosyası bozuktu ve yedekten de okunamadı**; bot BOŞ ayarlarla başladı (güvenilir listesi, kanallar, kurtarma hedefi sıfırlandı). `/ayar goster` ile kontrol edip yeniden ayarla. Bozuk dosya `data/db.corrupt-*.json` olarak saklandı.';
      for (const id of env.ownerIds) ctx.dm(id, msg).catch(() => {});
      log.error(`veritabanı durumu: ${store.loadStatus}`);
    }

    // Başlangıç bildirimi: yeniden başlatma döngüsünde DM yağmuru olmasın diye 10 dk'da bir.
    try {
      const meta = store.data.meta;
      if (!meta.lastStartDm || Date.now() - meta.lastStartDm > 10 * 60e3) {
        meta.lastStartDm = Date.now();
        store.save();
        const text = `🛡️ **${env.botName}** çevrimiçi. ${client.guilds.cache.size} sunucu, ${MODULES.length - failed.length}/${MODULES.length} modül hazır.${failed.length ? `\n⚠️ Başlatılamayan modüller: ${failed.join(', ')} (konsol kaydına bak).` : ''}`;
        for (const id of env.ownerIds) ctx.dm(id, text).catch(() => {});
      }
    } catch { /* yoksay */ }
  });

  /* ---------------------------------------------------------------- dayanıklılık */
  const errTimes = [];
  process.on('unhandledRejection', (e) => log.error('işlenmeyen söz reddi:', e));
  process.on('uncaughtException', (e) => {
    log.error('yakalanmamış hata:', e);
    const now = Date.now();
    errTimes.push(now);
    while (errTimes.length && now - errTimes[0] > 5 * 60e3) errTimes.shift();
    if (errTimes.length >= 10) { log.error('5 dakikada 10 yakalanmamış hata: temiz yeniden başlatma için çıkılıyor.'); shutdown(1); }
  });

  // Bağlantı 5 dakikadan uzun kopuk kalırsa süreci bitir; start.sh yeniden başlatır.
  let downSince = 0;
  const watchdog = setInterval(() => {
    if (!readyAt) return;
    if (client.ws.status === Status.Ready) { downSince = 0; return; }
    downSince = downSince || Date.now();
    if (Date.now() - downSince > 5 * 60e3) { log.error('Discord bağlantısı 5 dk\'dan uzun süredir yok; yeniden başlatılıyor.'); shutdown(2); }
  }, 30e3);
  watchdog.unref();

  let closing = false;
  async function shutdown(code = 0) {
    if (closing) return;
    closing = true;
    log.info('Kapanıyor…');
    const force = setTimeout(() => process.exit(code || 1), 8000);
    force.unref();
    try { store.flush(); } catch { /* yoksay */ }
    try { await events.flushMirror(); } catch { /* yoksay */ }
    try { if (ctx.oauth) ctx.oauth.stop(); } catch { /* yoksay */ }
    try { if (ctx.health) ctx.health.stop(); } catch { /* yoksay */ }
    try { await client.destroy(); } catch { /* yoksay */ }
    try { store.flush(); } catch { /* yoksay */ }
    releaseLock();
    process.exit(code);
  }
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('exit', () => { try { store.flush(); } catch { /* yoksay */ } });

  try {
    await client.login(env.token);
  } catch (e) {
    releaseLock();
    const m = String((e && e.message) || e);
    if (/disallowed intents/i.test(m)) fail('Discord "Privileged Gateway Intents" kapalı. Developer Portal → Bot → "Server Members Intent" ve "Message Content Intent" seçeneklerini aç, kaydet ve tekrar başlat.');
    if (/token/i.test(m)) fail('DISCORD_TOKEN geçersiz. Developer Portal → Bot → Reset Token ile yenisini alıp .env\'e yaz.');
    fail(`Giriş yapılamadı: ${m}`);
  }
}

main().catch((e) => {
  console.error('Başlatma hatası:', e);
  process.exit(1);
});
