'use strict';
// /ayar: tüm ayarlar Discord içinden. Her değişiklik yalnızca canAdmin tarafından yapılır ve uyarı kanalına yazılır.
const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ChannelType, InteractionContextType } = require('discord.js');
const { respond, truncate, fmtDuration, parseDuration, criticalList } = require('../util');
const { DEFAULTS } = require('../defaults');

/* ------------------------------------------------------------------ şema: /ayar deger */
// t: int | float | bool | enum. Güvenlik açısından hassas olan recovery.* bilerek burada YOK.
const S = (label, t, o = {}) => ({ label, t, ...o });
const SCHEMA = {
  'antinuke.windowSec': S('Anti-nuke ölçüm penceresi (sn)', 'int', { min: 5, max: 120 }),
  'antinuke.ownerPanic': S('Sahip hesabı şüpheliyse sunucuyu kilitle', 'bool'),
  'antinuke.autoRestore': S('Silinenleri otomatik geri yükle', 'bool'),
  'antinuke.thresholds.channelDelete': S('Eşik: kanal silme', 'int', { min: 1, max: 20 }),
  'antinuke.thresholds.roleDelete': S('Eşik: rol silme', 'int', { min: 1, max: 20 }),
  'antinuke.thresholds.channelCreate': S('Eşik: kanal açma', 'int', { min: 2, max: 40 }),
  'antinuke.thresholds.roleCreate': S('Eşik: rol açma', 'int', { min: 2, max: 40 }),
  'antinuke.thresholds.ban': S('Eşik: yasaklama', 'int', { min: 1, max: 30 }),
  'antinuke.thresholds.kick': S('Eşik: atma', 'int', { min: 1, max: 30 }),
  'antinuke.thresholds.webhookCreate': S('Eşik: webhook açma', 'int', { min: 1, max: 20 }),
  'antinuke.thresholds.prune': S('Eşik: üye budama', 'int', { min: 1, max: 5 }),
  'antinuke.thresholds.emojiDelete': S('Eşik: emoji silme', 'int', { min: 2, max: 50 }),
  'roleGuard.mode': S('Rol koruması', 'enum', { values: ['revert', 'off'] }),
  'roleGuard.timeLockHours': S('Kritik rol zaman kilidi (saat, 0=kapalı)', 'int', { min: 0, max: 72 }),
  'raid.minAccountAgeDays': S('Çok yeni hesap sınırı (gün)', 'int', { min: 0, max: 30 }),
  'raid.newAccountAction': S('Çok yeni hesaba işlem', 'enum', { values: ['off', 'flag', 'timeout', 'kick'] }),
  'raid.joinThreshold': S('Baskın: katılım sayısı', 'int', { min: 3, max: 60 }),
  'raid.joinWindowSec': S('Baskın: ölçüm penceresi (sn)', 'int', { min: 5, max: 120 }),
  'raid.raidMinutes': S('Baskın modu süresi (dk)', 'int', { min: 1, max: 240 }),
  'raid.raidTimeoutMinutes': S('Baskında tutulan üyenin susturma süresi (dk)', 'int', { min: 1, max: 1440 }),
  'raid.impersonation': S('Yetkili taklidi (isim benzerliği)', 'enum', { values: ['off', 'alert', 'timeout', 'kick'] }),
  'raid.inviteFarmCount': S('Davet çiftliği: aynı davetle yeni hesap sayısı', 'int', { min: 2, max: 50 }),
  'risk.alertAt': S('Risk uyarı eşiği', 'int', { min: 10, max: 95 }),
  'risk.containAt': S('Risk otomatik müdahale eşiği', 'int', { min: 20, max: 100 }),
  'watch.autoReports': S('Otomatik izleme: gereken farklı ihbarcı sayısı', 'int', { min: 2, max: 10 }),
  'watch.defaultDays': S('İzleme varsayılan süresi (gün)', 'int', { min: 1, max: 30 }),
  'watch.maxDays': S('İzleme en uzun süre (gün)', 'int', { min: 1, max: 90 }),
  'blocklist.action': S('Kara listedeki katılımcıya işlem', 'enum', { values: ['alert', 'timeout', 'kick', 'ban'] }),
  'backup.intervalHours': S('Otomatik yedek aralığı (saat)', 'int', { min: 1, max: 48 }),
  'backup.keep': S('Saklanan yedek sayısı', 'int', { min: 2, max: 30 }),
  'files.hashBlocked': S('Engellenen dosyayı hash\'le ve VirusTotal\'e sor', 'bool'),
  'files.newMemberArchiveHours': S('Yeni üyenin arşiv göndermesi yasak (saat)', 'int', { min: 0, max: 720 }),
  'automod.profanity.enabled': S('Küfür filtresi', 'bool'),
  'automod.links.enabled': S('Link filtresi', 'bool'),
  'automod.links.blockInvites': S('Başka sunucu davetlerini engelle', 'bool'),
  'automod.links.newMemberHours': S('Yeni üye link yasağı (saat, 0=kapalı)', 'int', { min: 0, max: 168 }),
  'automod.ads.enabled': S('Reklam filtresi', 'bool'),
  'automod.spam.enabled': S('Spam/flood filtresi', 'bool'),
  'automod.spam.floodCount': S('Flood: mesaj sayısı', 'int', { min: 3, max: 20 }),
  'automod.spam.floodSeconds': S('Flood: süre (sn)', 'int', { min: 2, max: 30 }),
  'automod.spam.dupCount': S('Tekrar: aynı mesaj sayısı', 'int', { min: 2, max: 10 }),
  'automod.spam.dupSeconds': S('Tekrar: süre (sn)', 'int', { min: 10, max: 120 }),
  'automod.spam.mentionsPerMessage': S('Tek mesajda etiket sınırı', 'int', { min: 3, max: 30 }),
  'automod.spam.mentionsWindowCount': S('Etiket seli: toplam etiket', 'int', { min: 3, max: 60 }),
  'automod.spam.mentionsWindowSeconds': S('Etiket seli: süre (sn)', 'int', { min: 5, max: 60 }),
  'automod.spam.capsMinLetters': S('BÜYÜK HARF: en az harf sayısı', 'int', { min: 8, max: 100 }),
  'automod.spam.capsRatio': S('BÜYÜK HARF oranı (0.5-1)', 'float', { min: 0.5, max: 1 }),
  'automod.spam.emojiMax': S('Mesajda en çok emoji', 'int', { min: 5, max: 60 }),
  'automod.spam.linesMax': S('Mesajda en çok satır', 'int', { min: 5, max: 60 }),
  'automod.spam.crossChannelCount': S('Çok kanala aynı mesaj: kanal sayısı', 'int', { min: 2, max: 10 }),
  'automod.spam.crossChannelSeconds': S('Çok kanala aynı mesaj: süre (sn)', 'int', { min: 15, max: 300 }),
  'automod.punish.decayMinutes': S('Ceza adımı unutma süresi (dk)', 'int', { min: 1, max: 120 }),
  'automod.noticeSeconds': S('Uyarı mesajı kaç sn görünsün', 'int', { min: 0, max: 30 }),
  'oauth.enabled': S('Hesap bağlama (kurtarma DM\'i) açık', 'bool'),
};

const BOOL_TRUE = ['evet', 'acik', 'açık', 'ac', 'aç', 'true', 'on', '1', 'e'];
const BOOL_FALSE = ['hayir', 'hayır', 'kapali', 'kapalı', 'kapat', 'false', 'off', '0', 'h'];

// Dönüş: { ok:true, value } | { ok:false, error }
function parseValue(def, raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(',', '.');
  if (def.t === 'bool') {
    if (BOOL_TRUE.includes(s)) return { ok: true, value: true };
    if (BOOL_FALSE.includes(s)) return { ok: true, value: false };
    return { ok: false, error: 'Değer `evet` ya da `hayır` olmalı.' };
  }
  if (def.t === 'enum') {
    if (def.values.includes(s)) return { ok: true, value: s };
    return { ok: false, error: `Değer şunlardan biri olmalı: ${def.values.join(', ')}.` };
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return { ok: false, error: 'Değer bir sayı olmalı.' };
  const n = def.t === 'int' ? Math.round(Number(s)) : Number(s);
  if (def.t === 'int' && !Number.isInteger(Number(s))) return { ok: false, error: 'Değer tam sayı olmalı.' };
  if (n < def.min || n > def.max) return { ok: false, error: `Değer ${def.min} ile ${def.max} arasında olmalı.` };
  return { ok: true, value: n };
}

const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function setPath(o, p, v) {
  const ks = p.split('.');
  const last = ks.pop();
  const t = ks.reduce((a, k) => a[k], o);
  t[last] = v;
}

// Çapraz doğrulama: birbirine bağlı ayarlar tutarsız kalmasın.
function crossCheck(cfg, key, value) {
  if (key === 'risk.containAt' && value <= cfg.risk.alertAt) return 'Müdahale eşiği, uyarı eşiğinden büyük olmalı.';
  if (key === 'risk.alertAt' && value >= cfg.risk.containAt) return 'Uyarı eşiği, müdahale eşiğinden küçük olmalı.';
  if (key === 'watch.defaultDays' && value > cfg.watch.maxDays) return 'Varsayılan süre, en uzun süreden büyük olamaz.';
  if (key === 'watch.maxDays' && value < cfg.watch.defaultDays) return 'En uzun süre, varsayılan süreden küçük olamaz.';
  return null;
}

/* ------------------------------------------------------------------ yardımcılar */
function normDomain(input) {
  let s = String(input || '').trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0].replace(/\.+$/, '');
  return /^(?=.{3,100}$)([a-z0-9-]+\.)+[a-z]{2,24}$/.test(s) ? s : null;
}
function normInviteCode(input) {
  const s = String(input || '').trim();
  const m = s.match(/(?:discord\.gg|discord(?:app)?\.com\/invite)\/([A-Za-z0-9-]{2,32})/i);
  const code = m ? m[1] : s;
  return /^[A-Za-z0-9-]{2,32}$/.test(code) ? code : null;
}
function normWord(input) {
  const s = String(input || '').trim().toLocaleLowerCase('tr');
  return /^[a-zçğıöşü0-9*_-]{2,30}$/.test(s) ? s : null;
}
// "uyari, 5dk, 1sa" -> ['warn','timeout:300sn','timeout:3600sn']
function parseSteps(input) {
  const parts = String(input || '').split(/[,;\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!parts.length || parts.length > 6) return { ok: false, error: '1 ile 6 adım gir (ör. `uyari, 5dk, 1sa, 6sa`).' };
  const steps = [];
  for (const p of parts) {
    if (['uyari', 'uyarı', 'warn'].includes(p)) { steps.push('warn'); continue; }
    const ms = parseDuration(p);
    if (!ms || ms < 5000 || ms > 28 * 864e5) return { ok: false, error: `Geçersiz adım: \`${truncate(p, 20)}\`. Süre 5 sn ile 28 gün arasında olmalı (ör. 5dk, 1sa, 2g).` };
    steps.push(`timeout:${Math.round(ms / 1000)}sn`);
  }
  return { ok: true, steps };
}
const stepLabel = (s) => (s === 'warn' ? 'uyarı' : `${fmtDuration(parseDuration(s.slice(8)))} susturma`);

const MODULE_LABELS = {
  antinuke: 'Anti-nuke', automod: 'Otomatik moderasyon', files: 'Dosya koruması', secrets: 'Token/sır koruması', honeypot: 'Bal küpü',
  raid: 'Baskın/yeni hesap', roleGuard: 'Rol koruması', risk: 'Risk skoru', watchlist: 'Kullanıcı izleme', blocklist: 'Kara liste',
  autoBackup: 'Otomatik yedek', weeklyReport: 'Haftalık rapor',
};

const list = (arr, fmt = (x) => x, max = 12) => (arr.length ? truncate(arr.slice(0, max).map(fmt).join(', ') + (arr.length > max ? ` … +${arr.length - max}` : ''), 900) : '—');

function init(ctx) {
  const lock = '🔒 Bu ayarı yalnızca bot sahibi (OWNER_IDS) ya da sunucu sahibi değiştirebilir.';

  async function commit(i, title, detail, level = 'warn') {
    ctx.save();
    ctx.events.append(i.guild.id, { type: 'SETTINGS', actor: i.user.id, name: truncate(`${title}: ${detail}`, 90) });
    await ctx.alert({ guild: i.guild, level, title: `Ayar değişti: ${title}`, description: `<@${i.user.id}> → ${detail}` });
    return respond(i, `✅ **${title}** — ${detail}`);
  }

  const builder = new SlashCommandBuilder()
    .setName('ayar').setDescription('Kalkan ayarlarını yönet')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName('goster').setDescription('Mevcut ayarların özeti'))
    .addSubcommand((s) => s.setName('kanal').setDescription('Log / uyarı / karantina / izleme kanalını belirle')
      .addStringOption((o) => o.setName('tur').setDescription('Hangi kanal?').setRequired(true).addChoices(
        { name: 'Log kanalı', value: 'log' }, { name: 'Uyarı kanalı', value: 'alert' },
        { name: 'Karantina (dosya) kanalı', value: 'quarantine' }, { name: 'İzleme kanalı', value: 'watch' }))
      .addChannelOption((o) => o.setName('kanal').setDescription('Boş bırakırsan ayar temizlenir').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand((s) => s.setName('guvenilir').setDescription('Güvenilir kişi ekle/çıkar (anti-nuke muafiyeti)')
      .addStringOption((o) => o.setName('islem').setDescription('Ne yapılsın?').setRequired(true).addChoices({ name: 'Ekle', value: 'ekle' }, { name: 'Çıkar', value: 'cikar' }))
      .addUserOption((o) => o.setName('kullanici').setDescription('Kullanıcı').setRequired(true)))
    .addSubcommand((s) => s.setName('muaf-rol').setDescription('Otomatik moderasyondan muaf rol ekle/çıkar')
      .addStringOption((o) => o.setName('islem').setDescription('Ne yapılsın?').setRequired(true).addChoices({ name: 'Ekle', value: 'ekle' }, { name: 'Çıkar', value: 'cikar' }))
      .addRoleOption((o) => o.setName('rol').setDescription('Rol').setRequired(true)))
    .addSubcommand((s) => s.setName('modul').setDescription('Bir koruma modülünü aç/kapat')
      .addStringOption((o) => o.setName('ad').setDescription('Modül').setRequired(true).addChoices(...Object.entries(MODULE_LABELS).map(([value, name]) => ({ name, value }))))
      .addBooleanOption((o) => o.setName('durum').setDescription('Açık mı?').setRequired(true)))
    .addSubcommand((s) => s.setName('link-izin').setDescription('Link izin listesi: alan adı / davet kodu / dolandırıcı alan')
      .addStringOption((o) => o.setName('tur').setDescription('Liste').setRequired(true).addChoices(
        { name: 'İzinli alan adı', value: 'alan' }, { name: 'İzinli davet kodu', value: 'davet' }, { name: 'Dolandırıcı alan adı (engelle)', value: 'dolandirici' }))
      .addStringOption((o) => o.setName('islem').setDescription('Ne yapılsın?').setRequired(true).addChoices({ name: 'Ekle', value: 'ekle' }, { name: 'Çıkar', value: 'cikar' }))
      .addStringOption((o) => o.setName('deger').setDescription('Alan adı (ör. youtube.com) ya da davet kodu').setRequired(true).setMaxLength(100)))
    .addSubcommand((s) => s.setName('kufur-seviye').setDescription('Küfür filtresi seviyesi')
      .addStringOption((o) => o.setName('seviye').setDescription('Seviye').setRequired(true).addChoices(
        { name: 'Kapalı', value: 'kapali' }, { name: 'Hafif (yalnızca ağır küfür)', value: 'hafif' }, { name: 'Orta (önerilen)', value: 'orta' }, { name: 'Sert (hakaret dahil)', value: 'sert' })))
    .addSubcommand((s) => s.setName('kufur-kelime').setDescription('Küfür filtresine özel kelime ekle/çıkar')
      .addStringOption((o) => o.setName('liste').setDescription('Liste').setRequired(true).addChoices({ name: 'Yasaklı kelime', value: 'engelle' }, { name: 'İzinli kelime (yanlış alarm)', value: 'izin' }))
      .addStringOption((o) => o.setName('islem').setDescription('Ne yapılsın?').setRequired(true).addChoices({ name: 'Ekle', value: 'ekle' }, { name: 'Çıkar', value: 'cikar' }))
      .addStringOption((o) => o.setName('kelime').setDescription('Kelime (sonuna * koyarsan ön ek olarak çalışır)').setRequired(true).setMaxLength(30)))
    .addSubcommand((s) => s.setName('gece-modu').setDescription('Gece modu: gece saatlerinde kritik işlemler daha sıkı')
      .addBooleanOption((o) => o.setName('durum').setDescription('Açık mı?'))
      .addStringOption((o) => o.setName('baslangic').setDescription('Başlangıç saati (SS:DD)').setMaxLength(5))
      .addStringOption((o) => o.setName('bitis').setDescription('Bitiş saati (SS:DD)').setMaxLength(5))
      .addStringOption((o) => o.setName('saat-dilimi').setDescription('Saat dilimi (ör. Europe/Istanbul, Asia/Baku)').setMaxLength(40)))
    .addSubcommand((s) => s.setName('dogrulama-rol').setDescription('Doğrulananlara verilecek rol (isteğe bağlı)')
      .addRoleOption((o) => o.setName('rol').setDescription('Rol (boş bırakırsan kaldırılır)')))
    .addSubcommand((s) => s.setName('jit').setDescription('Süreli yetki (/yetki) ayarları')
      .addRoleOption((o) => o.setName('rol').setDescription('Geçici olarak verilecek yetkili rol'))
      .addUserOption((o) => o.setName('onaylayici').setDescription('Onaylayıcı ekle/çıkar'))
      .addRoleOption((o) => o.setName('uygun-rol').setDescription('Süreli yetki isteyebilecek rol ekle/çıkar'))
      .addStringOption((o) => o.setName('islem').setDescription('Onaylayıcı/uygun rol için işlem').addChoices({ name: 'Ekle', value: 'ekle' }, { name: 'Çıkar', value: 'cikar' }))
      .addIntegerOption((o) => o.setName('maks-saat').setDescription('En uzun süre (saat)').setMinValue(1).setMaxValue(24)))
    .addSubcommand((s) => s.setName('sinav-rol').setDescription('Güvenlik sınavını geçenlere verilecek rol')
      .addRoleOption((o) => o.setName('rol').setDescription('Rol (boş bırakırsan kaldırılır)')))
    .addSubcommand((s) => s.setName('ceza').setDescription('Otomatik moderasyon ceza basamakları')
      .addStringOption((o) => o.setName('adimlar').setDescription('Ör: uyari, 5dk, 1sa, 6sa (en fazla 6 adım)').setRequired(true).setMaxLength(100)))
    .addSubcommand((s) => s.setName('deger').setDescription('Diğer tüm sayısal/açık-kapalı ayarlar (eşikler, süreler…)')
      .addStringOption((o) => o.setName('anahtar').setDescription('Ayar').setRequired(true).setAutocomplete(true).setMaxLength(60))
      .addStringOption((o) => o.setName('deger').setDescription('Yeni değer').setRequired(true).setAutocomplete(true).setMaxLength(20)));

  ctx.router.add(builder, async (i) => {
    const guild = i.guild;
    const cfg = ctx.gcfg(guild.id);
    const sub = i.options.getSubcommand();

    if (sub === 'goster') {
      if (!i.memberPermissions.has(PermissionFlagsBits.ManageGuild) && !ctx.isTrusted(guild, i.user.id)) return respond(i, '🔒 Yetkili değilsin.');
      const ch = (k) => (cfg.channels[k] ? `<#${cfg.channels[k]}>` : '—');
      const embed = new EmbedBuilder().setColor(0x3498db).setTitle(`⚙️ ${ctx.env.botName} ayarları`).setTimestamp()
        .addFields(
          { name: 'Kanallar', value: `Log: ${ch('log')}\nUyarı: ${ch('alert')}\nKarantina: ${ch('quarantine')}\nİzleme: ${ch('watch')}\nBal küpü: ${list(cfg.channels.honeypot, (id) => `<#${id}>`)}` },
          { name: 'Modüller', value: Object.entries(MODULE_LABELS).map(([k, t]) => `${cfg.modules[k] ? '🟢' : '🔴'} ${t}`).join('\n') },
          { name: 'Moderasyon', value: `Küfür: ${cfg.automod.profanity.enabled ? cfg.automod.profanity.level : 'kapalı'} (+${cfg.automod.profanity.custom.length} özel, ${cfg.automod.profanity.allow.length} izin)\nLink: ${cfg.automod.links.enabled ? 'açık' : 'kapalı'} • izinli alan: ${list(cfg.automod.links.allowDomains)}\nİzinli davet: ${list(cfg.automod.links.allowInviteCodes)}\nCeza: ${cfg.automod.punish.steps.map(stepLabel).join(' → ')}` },
          { name: 'Anti-nuke', value: `Pencere ${cfg.antinuke.windowSec} sn • Kanal sil ${cfg.antinuke.thresholds.channelDelete} • Rol sil ${cfg.antinuke.thresholds.roleDelete} • Ban ${cfg.antinuke.thresholds.ban} • Kick ${cfg.antinuke.thresholds.kick}\nSahip panik: ${cfg.antinuke.ownerPanic ? 'açık' : 'kapalı'} • Oto geri yükle: ${cfg.antinuke.autoRestore ? 'açık' : 'kapalı'}` },
          { name: 'Baskın / hesap', value: `Yeni hesap: <${cfg.raid.minAccountAgeDays} gün → ${cfg.raid.newAccountAction}\nBaskın: ${cfg.raid.joinThreshold} kişi / ${cfg.raid.joinWindowSec} sn\nDoğrulama: ${cfg.raid.unverifiedRoleId ? 'kurulu' : 'kapalı'}` },
          { name: 'Diğer', value: `Gece modu: ${cfg.night.enabled ? `${cfg.night.start}–${cfg.night.end} (${cfg.night.tz})` : 'kapalı'}\nRisk: uyarı ${cfg.risk.alertAt} / müdahale ${cfg.risk.containAt}\nYedek: her ${cfg.backup.intervalHours} sa, ${cfg.backup.keep} adet\nGüvenilir: ${list(cfg.trusted, (id) => `<@${id}>`)}\nMuaf roller: ${list(cfg.exemptRoles, (id) => `<@&${id}>`)}\nSüreli yetki rolü: ${cfg.jit.roleId ? `<@&${cfg.jit.roleId}>` : '—'} • Sınav rolü: ${cfg.quiz.roleId ? `<@&${cfg.quiz.roleId}>` : '—'}` },
        )
        .setFooter({ text: 'Kurtarma ayarları: /kurtarma durum • Diğer eşikler: /ayar deger' });
      return respond(i, { embeds: [embed] });
    }

    if (!ctx.canAdmin(guild, i.user.id)) return respond(i, lock);

    if (sub === 'kanal') {
      const tur = i.options.getString('tur', true);
      const ch = i.options.getChannel('kanal');
      const names = { log: 'Log', alert: 'Uyarı', quarantine: 'Karantina', watch: 'İzleme' };
      if (!ch) { cfg.channels[tur] = null; return commit(i, `${names[tur]} kanalı`, 'temizlendi'); }
      const me = guild.members.me;
      const perms = ch.permissionsFor(me);
      if (!perms || !perms.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) return respond(i, `❌ Botun <#${ch.id}> kanalında mesaj gönderme/yerleştirme yetkisi yok. Önce kanal iznini düzelt.`);
      cfg.channels[tur] = ch.id;
      return commit(i, `${names[tur]} kanalı`, `<#${ch.id}>`, 'info');
    }

    if (sub === 'guvenilir') {
      const u = i.options.getUser('kullanici', true);
      const add = i.options.getString('islem', true) === 'ekle';
      if (add) {
        if (u.bot) return respond(i, '❌ Botlar güvenilir listeye eklenemez.');
        if (cfg.trusted.includes(u.id)) return respond(i, 'ℹ️ Zaten listede.');
        if (cfg.trusted.length >= 15) return respond(i, '❌ Güvenilir liste en fazla 15 kişi olabilir (her biri anti-nuke muafiyeti demektir).');
        cfg.trusted.push(u.id);
        return commit(i, 'Güvenilir liste', `<@${u.id}> eklendi (anti-nuke ve moderasyondan muaf)`, 'high');
      }
      if (!cfg.trusted.includes(u.id)) return respond(i, 'ℹ️ Zaten listede değil.');
      cfg.trusted = cfg.trusted.filter((x) => x !== u.id);
      return commit(i, 'Güvenilir liste', `<@${u.id}> çıkarıldı`, 'info');
    }

    if (sub === 'muaf-rol') {
      const r = i.options.getRole('rol', true);
      const add = i.options.getString('islem', true) === 'ekle';
      if (r.id === guild.id) return respond(i, '❌ @everyone muaf yapılamaz.');
      if (add) {
        if (cfg.exemptRoles.includes(r.id)) return respond(i, 'ℹ️ Zaten muaf.');
        if (cfg.exemptRoles.length >= 20) return respond(i, '❌ En fazla 20 muaf rol.');
        cfg.exemptRoles.push(r.id);
        return commit(i, 'Muaf rol', `<@&${r.id}> eklendi`, 'high');
      }
      cfg.exemptRoles = cfg.exemptRoles.filter((x) => x !== r.id);
      return commit(i, 'Muaf rol', `<@&${r.id}> çıkarıldı`, 'info');
    }

    if (sub === 'modul') {
      const k = i.options.getString('ad', true);
      const on = i.options.getBoolean('durum', true);
      if (!(k in cfg.modules)) return respond(i, '❌ Bilinmeyen modül.');
      if (cfg.modules[k] === on) return respond(i, `ℹ️ ${MODULE_LABELS[k]} zaten ${on ? 'açık' : 'kapalı'}.`);
      cfg.modules[k] = on;
      return commit(i, MODULE_LABELS[k], on ? 'açıldı' : 'KAPATILDI', on ? 'info' : 'high');
    }

    if (sub === 'link-izin') {
      const tur = i.options.getString('tur', true);
      const add = i.options.getString('islem', true) === 'ekle';
      const raw = i.options.getString('deger', true);
      const links = cfg.automod.links;
      const [arr, label, val] = tur === 'davet'
        ? [links.allowInviteCodes, 'İzinli davet kodu', normInviteCode(raw)]
        : tur === 'dolandirici' ? [links.scamHosts, 'Dolandırıcı alan adı', normDomain(raw)] : [links.allowDomains, 'İzinli alan adı', normDomain(raw)];
      if (!val) return respond(i, tur === 'davet' ? '❌ Geçerli bir davet kodu gir (ör. `abc123` ya da `discord.gg/abc123`).' : '❌ Geçerli bir alan adı gir (ör. `youtube.com`).');
      if (add) {
        if (arr.includes(val)) return respond(i, 'ℹ️ Zaten listede.');
        if (arr.length >= 200) return respond(i, '❌ Liste dolu (200).');
        arr.push(val);
        return commit(i, label, `\`${val}\` eklendi`, tur === 'dolandirici' ? 'info' : 'warn');
      }
      const idx = arr.indexOf(val);
      if (idx < 0) return respond(i, 'ℹ️ Listede yok.');
      arr.splice(idx, 1);
      return commit(i, label, `\`${val}\` çıkarıldı`, 'info');
    }

    if (sub === 'kufur-seviye') {
      const v = i.options.getString('seviye', true);
      if (v === 'kapali') { cfg.automod.profanity.enabled = false; return commit(i, 'Küfür filtresi', 'KAPATILDI', 'high'); }
      cfg.automod.profanity.enabled = true;
      cfg.automod.profanity.level = v;
      return commit(i, 'Küfür filtresi', `seviye: ${v}`, 'info');
    }

    if (sub === 'kufur-kelime') {
      const key = i.options.getString('liste', true) === 'izin' ? 'allow' : 'custom';
      const add = i.options.getString('islem', true) === 'ekle';
      const w = normWord(i.options.getString('kelime', true));
      if (!w) return respond(i, '❌ Kelime 2-30 karakter olmalı; yalnızca harf, rakam, `*`, `_`, `-` kullan.');
      const arr = cfg.automod.profanity[key];
      if (add) {
        if (arr.includes(w)) return respond(i, 'ℹ️ Zaten listede.');
        if (arr.length >= 300) return respond(i, '❌ Liste dolu (300).');
        arr.push(w);
      } else {
        const idx = arr.indexOf(w);
        if (idx < 0) return respond(i, 'ℹ️ Listede yok.');
        arr.splice(idx, 1);
      }
      return commit(i, key === 'allow' ? 'Küfür izin listesi' : 'Özel yasaklı kelime', `\`${w}\` ${add ? 'eklendi' : 'çıkarıldı'}`, 'info');
    }

    if (sub === 'gece-modu') {
      const on = i.options.getBoolean('durum');
      const st = i.options.getString('baslangic');
      const en = i.options.getString('bitis');
      const tz = i.options.getString('saat-dilimi');
      const hhmm = /^([01]?\d|2[0-3]):[0-5]\d$/;
      const pad = (t) => t.padStart(5, '0');
      if (st && !hhmm.test(st)) return respond(i, '❌ Başlangıç saati `SS:DD` biçiminde olmalı (ör. 01:00).');
      if (en && !hhmm.test(en)) return respond(i, '❌ Bitiş saati `SS:DD` biçiminde olmalı (ör. 07:00).');
      if (tz) { try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { return respond(i, '❌ Geçersiz saat dilimi (ör. `Europe/Istanbul`, `Asia/Baku`).'); } }
      if (on === null && !st && !en && !tz) return respond(i, 'ℹ️ En az bir seçenek gir.');
      if (on !== null) cfg.night.enabled = on;
      if (st) cfg.night.start = pad(st);
      if (en) cfg.night.end = pad(en);
      if (tz) cfg.night.tz = tz;
      return commit(i, 'Gece modu', cfg.night.enabled ? `açık (${cfg.night.start}–${cfg.night.end}, ${cfg.night.tz})` : 'kapalı', cfg.night.enabled ? 'info' : 'warn');
    }

    if (sub === 'dogrulama-rol' || sub === 'sinav-rol') {
      const r = i.options.getRole('rol');
      const field = sub === 'sinav-rol' ? ['quiz', 'roleId', 'Sınav rolü'] : ['raid', 'verifiedRoleId', 'Doğrulanmış rolü'];
      if (!r) { cfg[field[0]][field[1]] = null; return commit(i, field[2], 'kaldırıldı'); }
      if (r.id === guild.id || r.managed) return respond(i, '❌ Bu rol seçilemez (@everyone ya da bot/entegrasyon rolü).');
      const crit = criticalList(r.permissions);
      if (crit.length) return respond(i, `❌ Bu rolde kritik yetkiler var (${crit.slice(0, 3).join(', ')}). Yetki yükseltme yoluna dönüşmemesi için yalnızca sıradan yetkili roller seçilebilir.`);
      if (!r.editable) return respond(i, '❌ Bu rol botun rolünden yukarıda; bot veremez. Bot rolünü yukarı taşı.');
      cfg[field[0]][field[1]] = r.id;
      return commit(i, field[2], `<@&${r.id}>`, 'info');
    }

    if (sub === 'jit') {
      const role = i.options.getRole('rol');
      const who = i.options.getUser('onaylayici');
      const elig = i.options.getRole('uygun-rol');
      const op = i.options.getString('islem');
      const max = i.options.getInteger('maks-saat');
      if (!role && !who && !elig && !max) return respond(i, 'ℹ️ En az bir seçenek gir.');
      if ((who || elig) && !op) return respond(i, '❌ Onaylayıcı/uygun rol için `islem` (ekle/çıkar) seç.');
      const out = [];
      if (role) {
        if (role.id === guild.id || role.managed) return respond(i, '❌ Bu rol seçilemez.');
        if (!role.editable) return respond(i, '❌ Bu rol botun rolünden yukarıda; bot veremez/alamaz.');
        cfg.jit.roleId = role.id; out.push(`rol <@&${role.id}>`);
      }
      if (max) { cfg.jit.maxHours = max; out.push(`en uzun ${max} sa`); }
      if (who) {
        if (who.bot) return respond(i, '❌ Bot onaylayıcı olamaz.');
        if (op === 'ekle') { if (!cfg.jit.approvers.includes(who.id)) cfg.jit.approvers.push(who.id); } else cfg.jit.approvers = cfg.jit.approvers.filter((x) => x !== who.id);
        out.push(`onaylayıcı <@${who.id}> ${op === 'ekle' ? 'eklendi' : 'çıkarıldı'}`);
      }
      if (elig) {
        if (op === 'ekle') { if (!cfg.jit.eligible.includes(elig.id)) cfg.jit.eligible.push(elig.id); } else cfg.jit.eligible = cfg.jit.eligible.filter((x) => x !== elig.id);
        out.push(`uygun rol <@&${elig.id}> ${op === 'ekle' ? 'eklendi' : 'çıkarıldı'}`);
      }
      return commit(i, 'Süreli yetki', out.join(', '), 'high');
    }

    if (sub === 'ceza') {
      const r = parseSteps(i.options.getString('adimlar', true));
      if (!r.ok) return respond(i, `❌ ${r.error}`);
      cfg.automod.punish.steps = r.steps;
      return commit(i, 'Ceza basamakları', r.steps.map(stepLabel).join(' → '), 'info');
    }

    if (sub === 'deger') {
      const key = i.options.getString('anahtar', true);
      const def = SCHEMA[key];
      if (!def) return respond(i, '❌ Bilinmeyen ayar. Listeden seçmek için yazmaya başla (otomatik tamamlama çıkar).');
      const parsed = parseValue(def, i.options.getString('deger', true));
      if (!parsed.ok) return respond(i, `❌ ${parsed.error}`);
      const cross = crossCheck(cfg, key, parsed.value);
      if (cross) return respond(i, `❌ ${cross}`);
      const before = getPath(cfg, key);
      if (before === parsed.value) return respond(i, 'ℹ️ Değer zaten bu.');
      setPath(cfg, key, parsed.value);
      // Güvenliği gevşeten değişiklikler daha yüksek öncelikle bildirilir.
      const loosening = (def.t === 'bool' && parsed.value === false) || (def.t === 'enum' && key !== 'blocklist.action' && parsed.value === 'off');
      return commit(i, def.label, `${String(before)} → **${String(parsed.value)}**`, loosening ? 'high' : 'warn');
    }
    return respond(i, '❌ Bilinmeyen alt komut.');
  });

  ctx.router.autocomplete('ayar', async (i) => {
    const f = i.options.getFocused(true);
    const q = String(f.value || '').toLowerCase();
    if (f.name === 'anahtar') {
      return Object.entries(SCHEMA)
        .filter(([k, d]) => !q || k.toLowerCase().includes(q) || d.label.toLowerCase().includes(q))
        .map(([k, d]) => ({ name: truncate(`${d.label} — ${k}`, 100), value: k }));
    }
    if (f.name === 'deger') {
      const def = SCHEMA[i.options.getString('anahtar')];
      if (!def) return [];
      if (def.t === 'bool') return [{ name: 'evet (aç)', value: 'evet' }, { name: 'hayır (kapat)', value: 'hayir' }];
      if (def.t === 'enum') return def.values.map((v) => ({ name: v, value: v }));
      return [{ name: `${def.min} ile ${def.max} arasında bir sayı yaz`, value: String(q && /^[\d.]+$/.test(q) ? q : def.min) }];
    }
    return [];
  });
}

module.exports = { name: 'settings', init, SCHEMA, parseValue, parseSteps, normDomain, normInviteCode, normWord, crossCheck, getPath, setPath, DEFAULTS };
