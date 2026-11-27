'use strict';
// Sunucu başına varsayılan ayarlar. Eksik anahtarlar ilk erişimde otomatik tamamlanır.

const DEFAULT_RECOVERY_MESSAGE =
  '**{sunucu}** sunucusuna şu anda erişilemiyor. Bu bir güvenlik olayı olabilir.\n\n' +
  'Lütfen aşağıdaki yedek sunucuya katıl ve duyuruları oradan takip et.\n' +
  'Bu süreçte kimseden gelen link / dosya açma. Resmi duyurular yalnızca bu mesajdaki yedek sunucudan yapılır.';

const DEFAULTS = {
  channels: { log: null, alert: null, quarantine: null, watch: null, honeypot: [] },
  trusted: [],
  exemptRoles: [],
  modules: {
    antinuke: true, automod: true, files: true, secrets: true, honeypot: true, raid: true,
    roleGuard: true, risk: true, watchlist: true, blocklist: true, autoBackup: true, weeklyReport: true,
    // v1.1: topluluk ve yönetim modülleri (özellik içi "enabled" ayarları ayrıca vardır)
    moderation: true, welcome: true, tickets: true, selfroles: true, suggestions: true, polls: true,
    events: true, community: true, starboard: true, xp: true, birthdays: true,
  },
  automod: {
    profanity: { enabled: true, level: 'orta', custom: [], allow: [] },
    links: { enabled: true, allowDomains: [], blockInvites: true, allowInviteCodes: [], scamHosts: [], newMemberHours: 0 },
    ads: { enabled: true, selfDomains: [] },
    spam: {
      enabled: true,
      floodCount: 6, floodSeconds: 6,
      dupCount: 3, dupSeconds: 30,
      mentionsPerMessage: 6, mentionsWindowCount: 10, mentionsWindowSeconds: 15,
      capsMinLetters: 20, capsRatio: 0.75,
      emojiMax: 15, linesMax: 20,
      crossChannelCount: 3, crossChannelSeconds: 60,
    },
    punish: { steps: ['warn', 'timeout:5m', 'timeout:1h', 'timeout:6h'], decayMinutes: 10 },
    noticeSeconds: 6,
  },
  files: {
    blockedExt: [
      'exe', 'msi', 'scr', 'bat', 'cmd', 'com', 'pif', 'vbs', 'vbe', 'jse', 'wsf', 'wsh', 'ps1', 'psm1',
      'dll', 'jar', 'jnlp', 'lnk', 'hta', 'cpl', 'reg', 'msc', 'gadget', 'application', 'appx', 'msix',
      'url', 'scf', 'inf', 'chm', 'docm', 'xlsm', 'pptm', 'sh', 'run',
    ],
    warnExt: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'xz', 'bz2', 'cab', 'iso', 'img', 'dmg'],
    hashBlocked: true,
    newMemberArchiveHours: 72,
  },
  antinuke: {
    windowSec: 20,
    ownerPanic: true,
    autoRestore: true,
    thresholds: {
      channelDelete: 3, roleDelete: 3, channelCreate: 6, roleCreate: 6,
      ban: 3, kick: 4, webhookCreate: 2, prune: 1, emojiDelete: 5,
    },
  },
  panic: { active: false, at: 0, by: null, reason: null, saved: null },
  raid: {
    minAccountAgeDays: 3, newAccountAction: 'flag',
    joinThreshold: 8, joinWindowSec: 15, raidMinutes: 10, raidTimeoutMinutes: 30,
    active: false, until: 0, held: [],
    verifiedRoleId: null, unverifiedRoleId: null, verifyChannelId: null, verifyCreatedChannel: false,
    impersonation: 'alert', inviteFarmCount: 5,
  },
  roleGuard: { mode: 'revert', timeLockHours: 0, allowAdminIds: [] },
  night: { enabled: false, start: '01:00', end: '07:00', tz: 'Asia/Baku' },
  risk: { alertAt: 40, containAt: 70 },
  jit: { roleId: null, approvers: [], eligible: [], maxHours: 4 },
  watch: { autoReports: 3, defaultDays: 7, maxDays: 30 },
  blocklist: { action: 'kick' },
  backup: { intervalHours: 6, keep: 10 },
  recovery: {
    backupGuildId: null, linkEnc: null, pending: null, delayHours: 12,
    message: DEFAULT_RECOVERY_MESSAGE, autoBroadcast: true, lastBroadcast: null,
    name: null, ownerId: null,
  },
  oauth: { enabled: true },
  quiz: { roleId: null },
  report: { lastAt: 0 },

  /* ---------------------------------------------------------------- v1.1 */
  locale: 'tr',
  // Saklama süreleri (gün): süresi dolan kayıtlar günlük temizlikte otomatik silinir.
  privacy: { eventDays: 90, caseDays: 365, accessDays: 180, ticketDays: 90 },
  mod: {
    // İşlem bazlı yetki: her işlem için izinli rol listesi. Liste boşsa yalnızca Discord izni (ör. BanMembers) yeterlidir.
    perms: { warn: [], timeout: [], kick: [], ban: [], unban: [], softban: [], purge: [], slowmode: [], lock: [], note: [] },
    maxTimeoutDays: 28, dmOnAction: true, warnExpireDays: 90, warnTimeoutAt: 3, warnTimeoutMinutes: 60, caseCounter: 0,
  },
  welcome: {
    enabled: false, channel: null, leaveChannel: null, autoRole: null, botRole: null, dm: false,
    title: 'Hoş geldin, {kullanici}!', message: '**{sunucu}** sunucusuna katıldın. Sen {sayi}. üyesin.\nKuralları okumayı unutma.',
    leaveMessage: '**{ad}** sunucudan ayrıldı.', color: '#3498db', image: null,
    botPolicy: 'alert', // alert = bildir | kick = onaysız botu at | allow
    rules: { enabled: false, roleId: null, channelId: null, messageId: null, text: 'Sunucu kurallarını okudum ve kabul ediyorum.' },
    reportChannel: null,
  },
  tickets: {
    enabled: false, categoryId: null, logChannel: null, panelChannel: null, panelMessageId: null,
    maxOpenPerUser: 2, cooldownSec: 120, closedKeepHours: 24,
    types: [{ id: 'destek', label: 'Destek', emoji: '🛠️', staffRoles: [], description: 'Genel yardım' }],
  },
  selfroles: { panels: {} },
  suggest: { enabled: false, channel: null, reviewRoleIds: [], counter: 0 },
  events: { reminderChannel: null, tz: 'Asia/Baku', reminders: [60, 10] },
  community: {
    customCommands: {}, faq: [],
    starboard: { enabled: false, channel: null, emoji: '⭐', threshold: 3, selfStar: false },
    xp: { enabled: false, min: 10, max: 20, cooldownSec: 60, announceChannel: null, levelRoles: {} },
    birthdays: { enabled: false, channel: null, roleId: null },
    reports: { daily: false, channel: null, lastDaily: 0 },
  },
  setup: { step: 0, done: false },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

function fillDefaults(target, defaults) {
  for (const k of Object.keys(defaults)) {
    if (target[k] === undefined || target[k] === null && defaults[k] !== null) {
      target[k] = clone(defaults[k]);
    } else if (isObj(defaults[k]) && isObj(target[k])) {
      fillDefaults(target[k], defaults[k]);
    }
  }
  return target;
}

const filled = new WeakSet();

function getGuildConfig(store, guildId) {
  const all = store.data.guilds;
  if (!all[guildId]) all[guildId] = {};
  const cfg = all[guildId];
  if (!filled.has(cfg)) {
    fillDefaults(cfg, DEFAULTS);
    filled.add(cfg);
  }
  return cfg;
}

module.exports = { DEFAULTS, DEFAULT_RECOVERY_MESSAGE, fillDefaults, getGuildConfig, clone };
