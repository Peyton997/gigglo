'use strict';
// Kara liste: bilinen kötü hesaplar (katılırken yakalanır), bilinen zararlı dosya hash'leri ve sahte alan adı listesi.
// Dış kaynaklar (BLOCKLIST_URL, SCAM_LIST_URL) isteğe bağlıdır; dış listeden gelen eşleşmeler en fazla susturma ile sonuçlanır.
const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, Events, InteractionContextType, MessageFlags } = require('discord.js');
const { respond, downloadLimited, truncate, code, unixRel } = require('../util');

const ID_RE = /^\d{17,20}$/;
const HOST_RE = /^(?=.{3,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,24}$/;
const MAX_REMOTE_IDS = 50000;
const MAX_SCAM_HOSTS = 30000;

// "id" listesi: JSON dizi / {users:[...]} / satır satır metin kabul eder.
function parseIdList(text) {
  const out = new Map();
  let data = null;
  try { data = JSON.parse(text); } catch { /* düz metin */ }
  const push = (id, reason) => {
    id = String(id || '').trim();
    if (ID_RE.test(id) && out.size < MAX_REMOTE_IDS) out.set(id, String(reason || 'Dış kara liste').slice(0, 120));
  };
  if (Array.isArray(data) || (data && Array.isArray(data.users))) {
    for (const x of Array.isArray(data) ? data : data.users) {
      if (x && typeof x === 'object') push(x.id, x.reason); else push(x);
    }
  } else {
    for (const line of String(text).split(/\r?\n/)) {
      const m = /^\s*(\d{17,20})\s*[,;#]?\s*(.*)$/.exec(line);
      if (m) push(m[1], m[2]);
    }
  }
  return out;
}

function parseHostList(text) {
  const out = new Set();
  let data = null;
  try { data = JSON.parse(text); } catch { /* düz metin */ }
  const lines = Array.isArray(data) ? data.map(String) : String(text).split(/\r?\n/);
  for (let l of lines) {
    l = l.trim().toLowerCase();
    if (!l || l.startsWith('#') || l.startsWith('!')) continue;
    l = l.replace(/^(?:0\.0\.0\.0|127\.0\.0\.1)\s+/, '').replace(/^https?:\/\//, '').replace(/^\*\./, '').replace(/^www\./, '').split(/[\/\s?#]/)[0];
    if (HOST_RE.test(l) && out.size < MAX_SCAM_HOSTS) out.add(l);
  }
  return out;
}

function init(ctx) {
  const { client, env, store, log } = ctx;
  const db = () => {
    const b = store.data.blocklist;
    b.users ||= {};
    b.hashes ||= {};
    b.remote ||= { ids: {}, at: 0 };
    return b;
  };

  const api = {
    check(uid) {
      const b = db();
      if (b.users[uid]) return { ...b.users[uid], source: 'local' };
      if (b.remote.ids[uid]) return { reason: b.remote.ids[uid], source: 'remote', by: 'dış liste' };
      return null;
    },

    add(uid, { reason = '-', by = null } = {}) {
      if (!ID_RE.test(String(uid))) return false;
      db().users[uid] = { reason: String(reason).slice(0, 200), by, at: Date.now() };
      store.save();
      return true;
    },

    remove(uid) {
      const had = !!db().users[uid];
      delete db().users[uid];
      store.save();
      return had;
    },

    addHash(hash, meta = {}) {
      if (!/^[a-f0-9]{64}$/.test(String(hash))) return;
      const h = db().hashes;
      h[hash] = { ...meta, at: Date.now() };
      const keys = Object.keys(h);
      if (keys.length > 2000) for (const k of keys.slice(0, keys.length - 2000)) delete h[k];
      store.save();
    },
    hasHash: (hash) => db().hashes[hash] || null,
    counts: () => ({ users: Object.keys(db().users).length, remote: Object.keys(db().remote.ids).length, hashes: Object.keys(db().hashes).length, scam: ctx.scamSet ? ctx.scamSet.size : 0 }),

    // Üye kara listedeyse ayarlı işlemi uygular.
    async enforce(guild, member) {
      const cfg = ctx.gcfg(guild.id);
      if (!cfg.modules.blocklist) return false;
      const hit = api.check(member.id);
      if (!hit) return false;
      const trusted = ctx.isTrusted(guild, member.id);
      let action = trusted ? 'alert' : cfg.blocklist.action;
      if (hit.source === 'remote' && (action === 'kick' || action === 'ban')) action = 'timeout';
      const reason = `Kalkan: kara liste (${truncate(hit.reason, 80)})`;
      const done = [];
      try {
        if (action === 'ban') { await guild.members.ban(member.id, { reason }); done.push('yasaklandı'); }
        else if (action === 'kick' && member.kickable) { await member.kick(reason); done.push('atıldı'); }
        else if (action === 'timeout' && member.moderatable) { await member.timeout(24 * 3600e3, reason); done.push('24 saat susturuldu'); }
      } catch { /* yetki yetersiz */ }
      ctx.stat(guild.id, 'blocklistHit');
      if (ctx.watch && action !== 'ban' && action !== 'kick') ctx.watch.add(guild.id, member.id, { reason: `Kara liste: ${hit.reason}`, by: client.user.id, days: 7 });
      await ctx.alert({
        guild, level: 'high', title: 'Kara listedeki hesap tespit edildi',
        description: `<@${member.id}> (${code(member.id)}) kara listede.\nKaynak: ${hit.source === 'remote' ? 'dış liste' : `yerel (ekleyen: ${hit.by ? `<@${hit.by}>` : '-'})`}\nSebep: ${truncate(hit.reason, 200)}\nİşlem: ${done.join(', ') || (trusted ? 'güvenilir hesap olduğu için yalnızca uyarı' : action === 'alert' ? 'yalnızca uyarı' : 'uygulanamadı (yetki yetersiz olabilir)')}`,
        key: `bl:${member.id}`,
      });
      return true;
    },

    async sweep(guild) {
      let n = 0;
      for (const m of guild.members.cache.values()) if (!m.user.bot && await api.enforce(guild, m)) n++;
      return n;
    },

    async syncRemote() {
      if (!env.blocklistUrl) return null;
      try {
        const buf = await downloadLimited(env.blocklistUrl, 5 * 1024 * 1024, { timeoutMs: 30000 });
        const ids = parseIdList(buf.toString('utf8'));
        if (!ids.size) { log.warn('BLOCKLIST_URL: geçerli kimlik bulunamadı, mevcut liste korunuyor.'); return null; }
        db().remote = { ids: Object.fromEntries(ids), at: Date.now() };
        store.save();
        log.info(`Dış kara liste güncellendi: ${ids.size} kimlik`);
        return ids.size;
      } catch (e) { log.warn(`BLOCKLIST_URL alınamadı: ${e.message}`); return null; }
    },

    async syncScam() {
      if (!env.scamListUrl) return null;
      try {
        const buf = await downloadLimited(env.scamListUrl, 8 * 1024 * 1024, { timeoutMs: 30000 });
        const hosts = parseHostList(buf.toString('utf8'));
        if (!hosts.size) { log.warn('SCAM_LIST_URL: geçerli alan adı bulunamadı, mevcut liste korunuyor.'); return null; }
        ctx.scamSet = hosts;
        log.info(`Sahte alan adı listesi güncellendi: ${hosts.size} alan adı`);
        return hosts.size;
      } catch (e) { log.warn(`SCAM_LIST_URL alınamadı: ${e.message}`); return null; }
    },

    parseIdList,
    parseHostList,
  };
  ctx.blocklist = api;

  client.on(Events.GuildMemberAdd, (member) => {
    if (member.user.bot) return;
    api.enforce(member.guild, member).catch((e) => log.error('kara liste denetimi hatası:', e));
  });

  /* ------------------------------------------------------------ komut */
  ctx.router.add(
    new SlashCommandBuilder()
      .setName('karaliste')
      .setDescription('Kötü hesap kara listesi')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((s) => s.setName('ekle').setDescription('Hesabı kara listeye ekle (katılırken engellenir)')
        .addStringOption((o) => o.setName('kullanici-id').setDescription('Kullanıcı kimliği').setRequired(true).setMaxLength(25))
        .addStringOption((o) => o.setName('sebep').setDescription('Sebep').setMaxLength(200)))
      .addSubcommand((s) => s.setName('kaldir').setDescription('Hesabı kara listeden çıkar')
        .addStringOption((o) => o.setName('kullanici-id').setDescription('Kullanıcı kimliği').setRequired(true).setMaxLength(25)))
      .addSubcommand((s) => s.setName('kontrol').setDescription('Hesap kara listede mi?')
        .addStringOption((o) => o.setName('kullanici-id').setDescription('Kullanıcı kimliği').setRequired(true).setMaxLength(25)))
      .addSubcommand((s) => s.setName('liste').setDescription('Yerel kara listeyi göster'))
      .addSubcommand((s) => s.setName('durum').setDescription('Liste sayıları ve eşitleme durumu')),
    async (i) => {
      const guild = i.guild;
      const sub = i.options.getSubcommand();
      const uid = i.user.id;
      const idOpt = (i.options.getString('kullanici-id') || '').replace(/\D/g, '');
      if (sub === 'durum') {
        const c = api.counts();
        return respond(i, [
          `**Yerel kara liste:** ${c.users} hesap`,
          `**Dış kara liste:** ${env.blocklistUrl ? `${c.remote} hesap (son eşitleme ${db().remote.at ? unixRel(db().remote.at) : 'henüz yok'})` : 'kapalı (BLOCKLIST_URL tanımlı değil)'}`,
          `**Sahte alan adı listesi:** ${env.scamListUrl ? `${c.scam} alan adı` : 'kapalı (SCAM_LIST_URL tanımlı değil)'}`,
          `**Zararlı dosya hash'i:** ${c.hashes}`,
          `**Eşleşmede işlem:** ${ctx.gcfg(guild.id).blocklist.action}`,
        ].join('\n'));
      }
      if (sub === 'liste') {
        const rows = Object.entries(db().users).slice(-25).reverse();
        if (!rows.length) return respond(i, 'ℹ️ Yerel kara liste boş.');
        return respond(i, rows.map(([id, v]) => `\`${id}\` — ${truncate(v.reason, 80)} (${unixRel(v.at)})`).join('\n'));
      }
      if (!ID_RE.test(idOpt)) return respond(i, '❌ Geçerli bir kullanıcı kimliği gir (17–20 haneli sayı).');
      if (sub === 'kontrol') {
        const hit = api.check(idOpt);
        return respond(i, hit ? `🚫 Kara listede (${hit.source === 'remote' ? 'dış liste' : 'yerel'}): ${truncate(hit.reason, 150)}` : '✅ Kara listede değil.');
      }
      if (!ctx.isTrusted(guild, uid)) return respond(i, '🔒 Kara listeyi yalnızca güvenilir kişiler değiştirebilir.');
      if (sub === 'kaldir') return respond(i, api.remove(idOpt) ? '✅ Kara listeden çıkarıldı.' : 'ℹ️ Yerel listede böyle bir kayıt yok.');
      // ekle
      if (ctx.isTrusted(guild, idOpt) || idOpt === client.user.id) return respond(i, '❌ Güvenilir hesaplar (sahip, bot) kara listeye eklenemez.');
      api.add(idOpt, { reason: i.options.getString('sebep') || 'Elle eklendi', by: uid });
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const m = await guild.members.fetch(idOpt).catch(() => null);
      let note = '';
      if (m) { await api.enforce(guild, m); note = '\nHesap şu an sunucuda: ayarlı işlem uygulandı.'; }
      return respond(i, `✅ Kara listeye eklendi. Bu hesap sunucuya katılırsa **${ctx.gcfg(guild.id).blocklist.action}** uygulanır.${note}`);
    },
  );

  ctx.every(6 * 3600e3, async () => { await api.syncRemote(); await api.syncScam(); }, 'kara-liste-esitle');
}

module.exports = { name: 'blocklist', init, parseIdList, parseHostList };
