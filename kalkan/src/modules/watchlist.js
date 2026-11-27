'use strict';
// Kullanıcı izleme (watchlist): şüpheli bir hesabı (özellikle RAT / zararlı dosya dağıtmaya çalışanı) canlı izler,
// dosya ve bağlantıları çalıştırmadan analiz eder, kanıt toplar, rapor üretir. Üye ihbarları da buraya akar.
const {
  SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType, PermissionFlagsBits, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, Events, InteractionContextType, MessageFlags,
} = require('discord.js');
const L = require('./links');
const { vtLookup, CDN_HOSTS, extOf } = require('./files');
const { scanJar, verdict } = require('./modcheck');
const { sha256, randomId } = require('../crypto');
const { socScore } = require('../data/patterns');
const { respond, truncate, defang, code, unixRel, unixFull, fmtDuration, downloadLimited } = require('../util');

const zero = () => ({ msgs: 0, edits: 0, deletes: 0, files: 0, links: 0, lures: 0, voice: 0, joins: 0, leaves: 0, roles: 0, profile: 0 });
const MAX_BYTES = 10 * 1024 * 1024;
const MEDIA_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp3', 'mp4', 'mov', 'webm', 'ogg', 'wav', 'pdf']);
const TEXT_EXT = new Set(['txt', 'md', 'json', 'log', 'csv']);

const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(0.1, n / 1024).toFixed(1)} KB`);
const codeBlock = (text, max = 900) => '```\n' + truncate(String(text).replace(/```/g, "'''"), max) + '\n```';

// Dosyanın gerçek türünü ilk baytlarından anlar (uzantıya güvenmez).
function sniff(buf) {
  if (!buf || buf.length < 4) return null;
  const [a, b, c, d] = buf;
  if (a === 0x4d && b === 0x5a) return 'exe';
  if (a === 0x7f && b === 0x45 && c === 0x4c && d === 0x46) return 'elf';
  if (a === 0xca && b === 0xfe && c === 0xba && d === 0xbe) return 'class';
  if (a === 0x50 && b === 0x4b && (c === 0x03 || c === 0x05)) return 'zip';
  if (a === 0x23 && b === 0x21) return 'script';
  if (a === 0x52 && b === 0x61 && c === 0x72 && d === 0x21) return 'rar';
  if (a === 0x37 && b === 0x7a && c === 0xbc && d === 0xaf) return '7z';
  return null;
}

function mismatchOf(ext, kind) {
  if (!kind) return null;
  if (MEDIA_EXT.has(ext) && ['exe', 'elf', 'class', 'zip', 'script', 'rar', '7z'].includes(kind)) return `uzantı .${ext} ama gerçek içerik: ${kind}`;
  if (TEXT_EXT.has(ext) && ['exe', 'elf', 'class'].includes(kind)) return `uzantı .${ext} ama gerçek içerik: ${kind}`;
  return null;
}

function init(ctx) {
  const { client, env, store, log } = ctx;
  const buckets = new Map();
  const delTimes = new Map();

  const reg = (gid) => (store.data.watch[gid] ||= {});
  const active = (gid, uid) => {
    const e = (store.data.watch[gid] || {})[uid];
    return e && e.until > Date.now() ? e : null;
  };
  const reports = (gid) => (store.data.reports[gid] ||= []);

  /* ------------------------------------------------------------ akışa yazma (hız sınırlı) */
  function post(guild, uid, embed, type, summary) {
    ctx.events.append(guild.id, { type: `WATCH_${type}`, actor: uid, name: truncate(summary, 160) });
    const k = `${guild.id}:${uid}`;
    const now = Date.now();
    const b = buckets.get(k) || { t: now, n: 0, dropped: 0 };
    if (now - b.t > 60e3) { b.t = now; b.n = 0; }
    b.n++;
    buckets.set(k, b);
    if (b.n > 14) { b.dropped++; return Promise.resolve(false); }
    if (b.dropped) { embed.setFooter({ text: `(+${b.dropped} olay çok hızlı geldiği için gösterilmedi; hepsi rapora yazıldı)` }); b.dropped = 0; }
    return ctx.logEmbed(guild, embed, 'watch');
  }

  const authorOf = (user) => ({ name: `${user.username} • ${user.id}`, iconURL: user.displayAvatarURL({ size: 64 }) });

  /* ------------------------------------------------------------ dosya analizi (çalıştırmadan) */
  async function analyzeAttachment(att) {
    const ext = extOf(att.name);
    const info = { name: att.name || 'dosya', ext, size: att.size || 0 };
    if (info.size > MAX_BYTES) { info.skipped = `çok büyük (${fmtSize(info.size)}), indirilmedi`; return info; }
    try {
      const buf = await downloadLimited(att.url, MAX_BYTES, { allowHosts: CDN_HOSTS, timeoutMs: 20000 });
      info.sha256 = sha256(buf);
      info.kind = sniff(buf);
      info.mismatch = mismatchOf(ext, info.kind);
      if (ctx.blocklist && ctx.blocklist.hasHash(info.sha256)) info.known = true;
      if (ext === 'jar' || ext === 'zip' || info.kind === 'zip') {
        const scan = scanJar(buf);
        info.scan = { score: scan.score, indicators: scan.indicators.slice(0, 6), embedded: scan.embedded.slice(0, 4) };
        info.verdict = verdict(scan.score).label;
      }
      const vt = await vtLookup(env, info.sha256);
      if (vt) info.vt = vt;
    } catch (e) {
      info.error = e.message;
    }
    return info;
  }

  function assess(cfg, a) {
    const reasons = [];
    if (new Set(cfg.files.blockedExt).has(a.ext)) reasons.push(`engelli dosya türü (.${a.ext})`);
    if (a.mismatch) reasons.push(a.mismatch);
    if (a.scan && a.scan.score >= 3) reasons.push(`statik tarama: ${a.verdict}`);
    if (a.vt && a.vt.found && a.vt.malicious >= 3) reasons.push(`VirusTotal: ${a.vt.malicious} motor zararlı buldu`);
    if (a.known) reasons.push('daha önce engellenen/işaretlenen dosya');
    const critical = !!((a.vt && a.vt.found && a.vt.malicious >= 3) || (a.scan && a.scan.score >= 6) || a.known);
    return { reasons, risky: reasons.length > 0, critical };
  }

  const fmtAttachment = (a) => {
    const bits = [`• **${truncate(a.name, 50)}** (${fmtSize(a.size)})`];
    if (a.sha256) bits.push(`sha256 ${code(a.sha256.slice(0, 16))}…`);
    if (a.kind) bits.push(`tür: ${a.kind}`);
    if (a.vt) bits.push(a.vt.found ? `VT ${a.vt.malicious}/${a.vt.suspicious}` : 'VT: kayıt yok');
    if (a.verdict) bits.push(a.verdict);
    if (a.skipped) bits.push(a.skipped);
    if (a.error) bits.push(`indirilemedi: ${truncate(a.error, 40)}`);
    return bits.join(' • ');
  };

  const linkOpts = (cfg) => ({
    allowDomains: cfg.automod.links.allowDomains, blockInvites: cfg.automod.links.blockInvites,
    allowInviteCodes: cfg.automod.links.allowInviteCodes, scamHosts: cfg.automod.links.scamHosts, scamSet: ctx.scamSet || null,
    blockedExt: new Set(cfg.files.blockedExt),
  });

  function addEvidence(e, item) {
    e.evidence.push({ t: Date.now(), ...item });
    while (e.evidence.length > 50) e.evidence.shift();
  }

  /* ------------------------------------------------------------ genel API */
  const api = {
    get: (gid, uid) => (store.data.watch[gid] || {})[uid] || null,
    isActive: (gid, uid) => !!active(gid, uid),
    list: (gid) => Object.values(store.data.watch[gid] || {}).filter((e) => e.until > Date.now()),

    add(gid, uid, { reason = '-', by = null, days } = {}) {
      const cfg = ctx.gcfg(gid);
      if (!cfg.modules.watchlist || !uid || (client.user && uid === client.user.id)) return null;
      const guild = client.guilds.cache.get(gid);
      if (guild && (guild.ownerId === uid || ctx.isBotOwner(uid))) return null;
      const d = Math.max(1, Math.min(Number(days) || cfg.watch.defaultDays, cfg.watch.maxDays));
      const now = Date.now();
      const until = now + d * 864e5;
      const r = reg(gid);
      let e = r[uid];
      let kind = null;
      if (!e) {
        e = r[uid] = { uid, tag: null, reason: truncate(reason, 300), by, at: now, until, reporters: [], notes: [], stats: zero(), evidence: [], lastSeen: null, closed: false };
        kind = 'yeni';
      } else if (e.until <= now) {
        Object.assign(e, { until, closed: false, by, reason: truncate(reason, 300), at: now });
        kind = 'yeniden';
      } else {
        e.until = Math.max(e.until, until);
        if (reason && reason !== '-' && !e.reason.includes(reason)) e.reason = truncate(`${e.reason} | ${reason}`, 300);
      }
      const m = ctx.members.get(gid, uid);
      if (m && m.tag) e.tag = m.tag;
      store.save();
      if (kind && guild) {
        ctx.stat(gid, 'watchAdd');
        const embed = new EmbedBuilder().setColor(0x9b59b6).setTitle(`👁️ ${kind === 'yeni' ? 'İzlemeye alındı' : 'Yeniden izlemeye alındı'}`)
          .setDescription(`<@${uid}> (${code(uid)})\n**Sebep:** ${truncate(reason, 300)}\n**Süre:** ${fmtDuration(until - now)} • **Ekleyen:** ${by ? `<@${by}>` : '-'}`)
          .setTimestamp();
        ctx.logEmbed(guild, embed, 'watch').catch(() => {});
        ctx.events.append(gid, { type: 'WATCH_START', actor: uid, name: truncate(reason, 160) });
      }
      return e;
    },

    // Kaydı siler değil, izlemeyi bitirir (geçmiş 30 gün raporda kalır).
    remove(gid, uid) {
      const e = (store.data.watch[gid] || {})[uid];
      if (!e || e.until <= Date.now()) return false;
      e.until = Date.now() - 1;
      e.closed = true;
      store.save();
      return true;
    },

    note(gid, uid, by, text) {
      const e = api.get(gid, uid);
      if (!e) return false;
      e.notes.push({ by, at: Date.now(), text: truncate(text, 300) });
      while (e.notes.length > 20) e.notes.shift();
      store.save();
      return true;
    },

    async buildReport(guild, uid) {
      const gid = guild.id;
      const e = api.get(gid, uid);
      const regE = ctx.members.get(gid, uid);
      const user = await client.users.fetch(uid).catch(() => null);
      const member = guild.members.cache.get(uid) || null;
      const created = user ? user.createdTimestamp : regE && regE.createdAt;
      const risk = ctx.risk ? ctx.risk.explain(gid, uid) : { score: 0, reasons: [] };
      const reps = reports(gid).filter((r) => r.uid === uid);
      const name = (user && user.username) || (e && e.tag) || (regE && regE.tag) || uid;
      const emb = new EmbedBuilder().setColor(0x9b59b6).setTitle(`🕵️ İzleme raporu: ${truncate(name, 60)}`).setTimestamp()
        .setFooter({ text: 'Bu rapor olasılıksal bulgular içerir; kesin hüküm değildir. İnsan kararıyla değerlendir.' });
      const who = [
        `**Kimlik:** ${code(uid)}${user && user.bot ? ' (bot)' : ''}`,
        created ? `**Hesap açıldı:** ${unixFull(created)} (${unixRel(created)})` : null,
        member && member.joinedTimestamp ? `**Sunucuya katıldı:** ${unixRel(member.joinedTimestamp)}` : (regE && regE.left ? `**Sunucudan ayrıldı:** ${unixRel(regE.left)}` : '**Sunucuda değil / kayıt yok**'),
        regE && regE.inviter ? `**Davet eden:** <@${regE.inviter}> (\`${regE.invite || '?'}\`)` : null,
        member ? `**Roller:** ${truncate([...member.roles.cache.values()].filter((r) => r.id !== gid).map((r) => r.name).join(', ') || '-', 300)}` : null,
      ].filter(Boolean).join('\n');
      emb.setDescription(truncate(who, 1800));
      emb.addFields({ name: '⚖️ Risk skoru', value: `${risk.score}/100${risk.reasons.length ? `\n${risk.reasons.map((r) => `• ${truncate(r, 100)}`).join('\n')}` : ''}`.slice(0, 1000), inline: false });
      if (e) {
        const s = e.stats;
        emb.addFields(
          { name: '👁️ İzleme', value: truncate(`Sebep: ${e.reason}\nBaşlangıç: ${unixRel(e.at)} • ${e.until > Date.now() ? `bitiş ${unixRel(e.until)}` : 'süre doldu/kapatıldı'}\nEkleyen: ${e.by ? `<@${e.by}>` : '-'} • İhbar eden: ${e.reporters.length}`, 1000) },
          { name: '📊 Etkinlik', value: `mesaj ${s.msgs} • düzenleme ${s.edits} • silme ${s.deletes}\ndosya ${s.files} • bağlantı ${s.links} • yem metni ${s.lures}\nses ${s.voice} • giriş ${s.joins} • çıkış ${s.leaves} • rol/profil ${s.roles + s.profile}` },
        );
        if (e.evidence.length) {
          const lines = e.evidence.slice(-8).map((x) => (x.kind === 'file'
            ? `• 📎 ${truncate(x.name, 40)} — ${x.sha256 ? x.sha256.slice(0, 12) + '…' : 'hash yok'}${x.vt ? ` — VT ${x.vt.m}/${x.vt.s}` : ''}${x.verdict ? ` — ${x.verdict}` : ''}${x.risky ? ' ⚠️' : ''}`
            : `• 🔗 ${truncate(x.url || '-', 60)} — ${x.type || ''}`));
          emb.addFields({ name: `🧪 Kanıtlar (${e.evidence.length})`, value: truncate(lines.join('\n'), 1000) });
        }
        if (e.notes.length) emb.addFields({ name: '📝 Notlar', value: truncate(e.notes.slice(-3).map((n) => `• <@${n.by}>: ${truncate(n.text, 120)}`).join('\n'), 1000) });
      } else {
        emb.addFields({ name: '👁️ İzleme', value: 'Bu kullanıcı için izleme kaydı yok.' });
      }
      if (reps.length) {
        emb.addFields({ name: `📣 İhbarlar (${new Set(reps.map((r) => r.by)).size} kişi)`, value: truncate(reps.slice(-3).map((r) => `• ${unixRel(r.at)}: ${truncate(r.text.replace(/https?:\/\/\S+/g, (u) => defang(u)), 140)}`).join('\n'), 1000) });
      }
      const tl = ctx.events.read(gid, { since: Date.now() - 3 * 864e5, limit: 5000 }).filter((x) => x.actor === uid).slice(-10);
      if (tl.length) {
        emb.addFields({ name: '🕒 Son olaylar', value: truncate(tl.map((x) => `<t:${Math.floor(x.t / 1000)}:t> ${String(x.type).replace('WATCH_', '').toLowerCase()} ${truncate(x.name || '', 60)}`).join('\n'), 1000) });
      }
      return emb;
    },

    async fileReport(guild, { targetId, by, text, att = null }) {
      const cfg = ctx.gcfg(guild.id);
      const list = reports(guild.id);
      const now = Date.now();
      const mine = list.filter((r) => r.by === by && now - r.at < 864e5);
      if (mine.length >= 5) return { ok: false, msg: 'Bugün en fazla 5 ihbar gönderebilirsin.' };
      if (mine.some((r) => r.uid === targetId)) return { ok: false, msg: 'Bu kullanıcıyı son 24 saatte zaten bildirdin.' };
      list.push({ id: randomId(3), uid: targetId, by, at: now, text: truncate(text, 500), att: att ? { name: att.name, size: att.size } : null });
      while (list.length > 500) list.shift();
      store.save();
      ctx.stat(guild.id, 'reports');
      const distinct = new Set(list.filter((r) => r.uid === targetId && now - r.at < 7 * 864e5).map((r) => r.by));
      const trusted = ctx.isTrusted(guild, targetId);

      const embed = new EmbedBuilder().setColor(trusted ? 0xe74c3c : 0xe67e22).setTitle('📣 Şüpheli kullanıcı ihbarı')
        .setDescription(`**Bildirilen:** <@${targetId}> (${code(targetId)})\n**Bildiren:** <@${by}>\n${codeBlock(text.replace(/https?:\/\/\S+/gi, (u) => defang(u)), 600)}`)
        .addFields({ name: 'Son 7 günde farklı ihbar eden', value: String(distinct.size), inline: true })
        .setTimestamp();
      if (att) {
        embed.addFields({ name: 'Ek', value: `${truncate(att.name, 60)} (${fmtSize(att.size || 0)})\n⚠️ Dosyayı AÇMA; gerekirse \`/modkontrol\` ile kontrol et.` });
        if (String(att.contentType || '').startsWith('image/')) embed.setImage(att.url);
      }
      await ctx.logEmbed(guild, embed, 'watch');
      if (trusted) {
        await ctx.alert({
          guild, level: 'critical', title: 'GÜVENİLİR hesap hakkında ihbar',
          description: `<@${targetId}> hakkında bir üye ihbar gönderdi. Hesap ele geçirilmiş olabilir; ilgili kişiye **başka bir kanaldan** ulaş.\n${truncate(text, 300)}`,
          key: `rep-trusted:${targetId}`,
        });
        return { ok: true, count: distinct.size };
      }
      if (ctx.risk && distinct.size <= 2) await ctx.risk.signal(guild, targetId, 10, 'Üyeler tarafından şüpheli bildirildi');
      const existing = active(guild.id, targetId);
      if (existing) {
        for (const r of distinct) if (!existing.reporters.includes(r)) existing.reporters.push(r);
        store.save();
      } else if (distinct.size >= cfg.watch.autoReports) {
        const e = api.add(guild.id, targetId, { reason: `${distinct.size} farklı kişi şüpheli bildirdi`, by: client.user.id });
        if (e) {
          e.reporters = [...distinct];
          store.save();
          await ctx.alert({
            guild, level: 'high', title: 'Üye ihbarlarıyla izlemeye alındı',
            description: `<@${targetId}> için ${distinct.size} farklı kişi şüpheli bildirdi; otomatik izlemeye alındı.\nDetay: \`/izle rapor\``, key: `autowatch:${targetId}`,
          });
        }
      }
      return { ok: true, count: distinct.size };
    },
  };
  ctx.watch = api;

  /* ------------------------------------------------------------ mesajlar */
  async function onMessage(m) {
    if (!m.guild || !m.author || m.author.bot || m.webhookId) return;
    const e = active(m.guild.id, m.author.id);
    if (!e) return;
    const guild = m.guild;
    const cfg = ctx.gcfg(guild.id);
    const uid = m.author.id;
    const text = m.content || '';
    const urls = L.extract(text);
    const soc = text ? socScore(text) : 0;
    const atts = [...m.attachments.values()].slice(0, 5);
    e.lastSeen = Date.now();
    e.tag = m.author.username;
    e.stats.msgs++;
    e.stats.links += urls.length;
    e.stats.files += atts.length;
    if (soc >= 3) e.stats.lures++;
    store.save();

    const flags = [];
    const linkLines = [];
    const opts = linkOpts(cfg);
    for (const info of urls.slice(0, 4)) {
      let c = L.classify(info, opts);
      let final = null;
      if (c.action === 'resolve') {
        final = await L.resolveShortener(info.url).catch(() => null);
        const fi = final ? L.parse(final) : null;
        c = fi ? L.classify(fi, opts) : { action: 'block', type: 'shortener', detail: 'çözülemedi' };
      }
      const shown = defang(`${info.hostBare}${info.path}`).slice(0, 70);
      linkLines.push(`${c.action === 'allow' ? '✅' : '🚫'} ${shown} — ${c.type}${final ? ` → ${defang(final).slice(0, 70)}` : ''}`);
      if (c.action !== 'allow') {
        flags.push(`Engelli türde bağlantı (${c.type})`);
        addEvidence(e, { kind: 'link', url: shown, type: c.type, channelId: m.channelId });
      }
    }

    const analyses = atts.length ? await Promise.all(atts.map(analyzeAttachment)) : [];
    let worst = null;
    for (const a of analyses) {
      const as = assess(cfg, a);
      addEvidence(e, {
        kind: 'file', name: a.name, ext: a.ext, size: a.size, sha256: a.sha256 || null,
        vt: a.vt && a.vt.found ? { m: a.vt.malicious, s: a.vt.suspicious } : null, verdict: a.verdict || null, risky: as.risky, channelId: m.channelId,
      });
      if (as.risky) {
        flags.push(`${truncate(a.name, 40)}: ${as.reasons.join('; ')}`);
        if (a.sha256 && ctx.blocklist) ctx.blocklist.addHash(a.sha256, { name: a.name, by: uid, gid: guild.id });
        if (!worst || (as.critical && !worst.critical)) worst = { a, ...as };
      }
    }
    if (soc >= 3) flags.push('Sosyal mühendislik yemi gibi görünüyor ("dene / test et / DM at" kalıpları)');
    store.save();

    const type = atts.length ? 'FILE' : urls.length ? 'LINK' : 'MSG';
    const embed = new EmbedBuilder().setColor(worst ? 0xe74c3c : flags.length ? 0xe67e22 : 0x95a5a6)
      .setAuthor(authorOf(m.author))
      .setTitle(`${atts.length ? '📎' : urls.length ? '🔗' : '💬'} #${(m.channel && m.channel.name) || m.channelId}`)
      .setTimestamp(m.createdTimestamp);
    if (text) embed.setDescription(codeBlock(text.replace(/https?:\/\/\S+/gi, (u) => defang(u))));
    if (linkLines.length) embed.addFields({ name: '🔗 Bağlantılar', value: truncate(linkLines.join('\n'), 1000) });
    if (analyses.length) embed.addFields({ name: '📎 Dosyalar', value: truncate(analyses.map(fmtAttachment).join('\n'), 1000) });
    if (flags.length) embed.addFields({ name: '⚠️ Bayraklar', value: truncate(flags.map((f) => `• ${f}`).join('\n'), 1000) });
    embed.addFields({ name: 'Mesaj', value: `[Mesaja git](${m.url})`, inline: true });
    await post(guild, uid, embed, type, `${(m.channel && m.channel.name) || ''}: ${truncate(text, 80)}${atts.length ? ` [${atts.map((a) => a.name).join(', ')}]` : ''}`);

    if (worst) {
      await m.delete().catch(() => {});
      ctx.stat(guild.id, 'watchRisky');
      if (ctx.risk) await ctx.risk.signal(guild, uid, worst.critical ? 50 : 30, `İzlenen hesap riskli dosya paylaştı (${truncate(worst.a.name, 40)})`);
      const actions = ['mesaj silindi'];
      if (worst.critical && !ctx.isTrusted(guild, uid)) {
        const member = m.member || await guild.members.fetch(uid).catch(() => null);
        if (member && member.moderatable) { await member.timeout(24 * 3600e3, 'Kalkan: izlenen hesap zararlı dosya paylaştı').then(() => actions.push('24 saat susturuldu')).catch(() => {}); }
      }
      await ctx.alert({
        guild, level: worst.critical ? 'critical' : 'high', title: 'İzlenen hesap riskli dosya paylaştı',
        description: `<@${uid}> → #${(m.channel && m.channel.name) || m.channelId}\nDosya: **${truncate(worst.a.name, 60)}**\nNeden: ${worst.reasons.join('; ')}\nAlınan önlemler: ${actions.join(', ')}\n\nDosyayı **açma**. Kara listeye almak için: \`/karaliste ekle\``,
        key: `watchfile:${uid}`,
      });
    }
  }

  client.on(Events.MessageCreate, (m) => { onMessage(m).catch((e) => log.error('izleme (mesaj) hatası:', e)); });

  client.on(Events.MessageUpdate, async (oldM, newM) => {
    try {
      if (newM.partial) newM = await newM.fetch().catch(() => null);
      if (!newM || !newM.guild || !newM.author || newM.author.bot) return;
      const e = active(newM.guild.id, newM.author.id);
      if (!e || oldM.content == null || oldM.content === newM.content) return;
      e.stats.edits++;
      const gained = L.extract(newM.content || '').filter((n) => !L.extract(oldM.content || '').some((o) => o.url === n.url));
      const embed = new EmbedBuilder().setColor(gained.length ? 0xe67e22 : 0x95a5a6).setAuthor(authorOf(newM.author))
        .setTitle(`✏️ Mesajı düzenledi • #${(newM.channel && newM.channel.name) || newM.channelId}`)
        .addFields(
          { name: 'Önce', value: codeBlock((oldM.content || '').replace(/https?:\/\/\S+/gi, (u) => defang(u)), 450) },
          { name: 'Sonra', value: codeBlock((newM.content || '').replace(/https?:\/\/\S+/gi, (u) => defang(u)), 450) },
        ).setTimestamp();
      if (gained.length) embed.addFields({ name: '⚠️', value: 'Düzenlemeyle yeni bağlantı eklendi (filtre atlatma şüphesi).' });
      await post(newM.guild, newM.author.id, embed, 'EDIT', truncate(newM.content || '', 100));
    } catch (err) { log.error('izleme (düzenleme) hatası:', err); }
  });

  client.on(Events.MessageDelete, (m) => {
    try {
      if (!m.guild || !m.author || m.author.bot) return;
      const e = active(m.guild.id, m.author.id);
      if (!e) return;
      e.stats.deletes++;
      const k = `${m.guild.id}:${m.author.id}`;
      const arr = (delTimes.get(k) || []).filter((t) => Date.now() - t < 10 * 60e3);
      arr.push(Date.now());
      delTimes.set(k, arr);
      const embed = new EmbedBuilder().setColor(arr.length >= 5 ? 0xe67e22 : 0x95a5a6).setAuthor(authorOf(m.author))
        .setTitle(`🗑️ Mesaj silindi • #${(m.channel && m.channel.name) || m.channelId}`).setTimestamp();
      embed.setDescription(m.content ? codeBlock(m.content.replace(/https?:\/\/\S+/gi, (u) => defang(u)), 700) : '(içerik önbellekte yok)');
      embed.addFields({ name: 'Not', value: 'Kendisi ya da bir yetkili/bot silmiş olabilir.' });
      if (arr.length >= 5) embed.addFields({ name: '⚠️', value: '10 dakikada 5+ mesaj silindi (iz silme şüphesi).' });
      post(m.guild, m.author.id, embed, 'DELETE', truncate(m.content || '', 100));
    } catch (err) { log.error('izleme (silme) hatası:', err); }
  });

  /* ------------------------------------------------------------ üyelik, profil, ses */
  client.on(Events.GuildMemberAdd, (member) => {
    const e = active(member.guild.id, member.id);
    if (!e) return;
    e.stats.joins++;
    e.tag = member.user.username;
    store.save();
    ctx.alert({
      guild: member.guild, level: 'high', title: 'İzlenen kullanıcı sunucuya katıldı',
      description: `<@${member.id}> (${code(member.id)}) izleme listesinde.\nSebep: ${truncate(e.reason, 200)}\nAkış: izleme kanalı • Detay: \`/izle rapor\``, key: `watchjoin:${member.id}`,
    }).catch(() => {});
    const embed = new EmbedBuilder().setColor(0x9b59b6).setAuthor(authorOf(member.user)).setTitle('🚪 Sunucuya katıldı').setTimestamp();
    post(member.guild, member.id, embed, 'JOIN', 'katıldı');
  });

  client.on(Events.GuildMemberRemove, (member) => {
    const e = active(member.guild.id, member.id);
    if (!e) return;
    e.stats.leaves++;
    store.save();
    post(member.guild, member.id, new EmbedBuilder().setColor(0x95a5a6).setAuthor(authorOf(member.user)).setTitle('👋 Sunucudan ayrıldı').setTimestamp(), 'LEAVE', 'ayrıldı');
  });

  client.on(Events.GuildMemberUpdate, (o, n) => {
    const e = active(n.guild.id, n.id);
    if (!e || o.partial) return;
    const lines = [];
    const added = n.roles.cache.filter((r) => !o.roles.cache.has(r.id));
    const removed = o.roles.cache.filter((r) => !n.roles.cache.has(r.id));
    if (added.size) lines.push(`Rol eklendi: ${added.map((r) => r.name).join(', ')}`);
    if (removed.size) lines.push(`Rol alındı: ${removed.map((r) => r.name).join(', ')}`);
    if (o.nickname !== n.nickname) lines.push(`Takma ad: ${o.nickname || '-'} → ${n.nickname || '-'}`);
    if ((o.communicationDisabledUntilTimestamp || 0) !== (n.communicationDisabledUntilTimestamp || 0)) lines.push('Susturma durumu değişti');
    if (!lines.length) return;
    e.stats.roles += added.size + removed.size;
    store.save();
    post(n.guild, n.id, new EmbedBuilder().setColor(0x95a5a6).setAuthor(authorOf(n.user)).setTitle('🎭 Üye güncellendi').setDescription(truncate(lines.join('\n'), 800)).setTimestamp(), 'ROLE', lines.join('; '));
  });

  client.on(Events.UserUpdate, (o, n) => {
    if (o.partial) return;
    const ch = [];
    if (o.username !== n.username) ch.push(`Kullanıcı adı: ${o.username} → ${n.username}`);
    if (o.globalName !== n.globalName) ch.push(`Görünen ad: ${o.globalName || '-'} → ${n.globalName || '-'}`);
    if (o.avatar !== n.avatar) ch.push('Profil resmi değişti');
    if (!ch.length) return;
    for (const guild of client.guilds.cache.values()) {
      const e = active(guild.id, n.id);
      if (!e) continue;
      e.stats.profile++;
      e.tag = n.username;
      store.save();
      post(guild, n.id, new EmbedBuilder().setColor(0x95a5a6).setAuthor(authorOf(n)).setTitle('🪪 Profil değişti').setDescription(ch.join('\n')).setFooter({ text: 'İsim değiştirmek tespitten kaçmak için kullanılır.' }).setTimestamp(), 'PROFILE', ch.join('; '));
    }
  });

  client.on(Events.VoiceStateUpdate, (o, n) => {
    const guild = n.guild || o.guild;
    const e = guild && active(guild.id, n.id);
    if (!e || o.channelId === n.channelId) return;
    const what = !o.channelId ? `Ses kanalına katıldı: ${n.channel ? n.channel.name : '?'}`
      : !n.channelId ? `Ses kanalından ayrıldı: ${o.channel ? o.channel.name : '?'}`
        : `Ses kanalı değişti: ${o.channel ? o.channel.name : '?'} → ${n.channel ? n.channel.name : '?'}`;
    e.stats.voice++;
    store.save();
    const user = (n.member && n.member.user) || (o.member && o.member.user);
    const embed = new EmbedBuilder().setColor(0x95a5a6).setTitle(`🔊 ${what}`).setTimestamp();
    if (user) embed.setAuthor(authorOf(user));
    post(guild, n.id, embed, 'VOICE', what);
  });

  client.on(Events.InviteCreate, (inv) => {
    const guild = inv.guild && client.guilds.cache.get(inv.guild.id);
    const uid = inv.inviterId || (inv.inviter && inv.inviter.id);
    const e = guild && uid && active(guild.id, uid);
    if (!e) return;
    post(guild, uid, new EmbedBuilder().setColor(0xe67e22).setTitle('📨 Davet bağlantısı oluşturdu').setDescription(`Kod: ${code(inv.code)} • ${inv.maxAge ? `${fmtDuration(inv.maxAge * 1000)} geçerli` : 'süresiz'}`).setTimestamp(), 'INVITE', `davet ${inv.code}`);
  });

  /* ------------------------------------------------------------ komutlar */
  const isStaff = (i) => ctx.isTrusted(i.guild, i.user.id) || (i.memberPermissions && i.memberPermissions.has(PermissionFlagsBits.ModerateMembers));

  ctx.router.add(
    new SlashCommandBuilder()
      .setName('izle')
      .setDescription('Şüpheli kullanıcı izleme (özellikle RAT / zararlı dosya dağıtanlar için)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((s) => s.setName('ekle').setDescription('Kullanıcıyı izlemeye al')
        .addUserOption((o) => o.setName('kullanici').setDescription('İzlenecek kullanıcı').setRequired(true))
        .addStringOption((o) => o.setName('sebep').setDescription('Sebep (örn. DM ile RAT/dosya göndermeye çalışıyor)').setRequired(true).setMaxLength(200))
        .addIntegerOption((o) => o.setName('gun').setDescription('Kaç gün izlensin (1-30)').setMinValue(1).setMaxValue(30)))
      .addSubcommand((s) => s.setName('kaldir').setDescription('İzlemeyi bitir')
        .addUserOption((o) => o.setName('kullanici').setDescription('Kullanıcı').setRequired(true)))
      .addSubcommand((s) => s.setName('liste').setDescription('İzlenen kullanıcıları listele'))
      .addSubcommand((s) => s.setName('rapor').setDescription('Kullanıcı için ayrıntılı rapor')
        .addUserOption((o) => o.setName('kullanici').setDescription('Kullanıcı').setRequired(true)))
      .addSubcommand((s) => s.setName('not').setDescription('İzleme kaydına not ekle')
        .addUserOption((o) => o.setName('kullanici').setDescription('Kullanıcı').setRequired(true))
        .addStringOption((o) => o.setName('metin').setDescription('Not').setRequired(true).setMaxLength(300))),
    async (i) => {
      if (!isStaff(i)) return respond(i, '🔒 Bu komut yalnızca yetkililer içindir.');
      const guild = i.guild;
      const cfg = ctx.gcfg(guild.id);
      const sub = i.options.getSubcommand();
      if (sub === 'liste') {
        const rows = api.list(guild.id);
        if (!rows.length) return respond(i, 'ℹ️ Şu an izlenen kullanıcı yok.');
        return respond(i, rows.slice(0, 20).map((e) => `<@${e.uid}> — ${truncate(e.reason, 70)} • kalan ${fmtDuration(e.until - Date.now())} • ${e.stats.msgs} mesaj, ${e.stats.files} dosya`).join('\n'));
      }
      const target = i.options.getUser('kullanici', true);
      if (sub === 'rapor') {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        return respond(i, { embeds: [await api.buildReport(guild, target.id)] });
      }
      if (sub === 'not') {
        return respond(i, api.note(guild.id, target.id, i.user.id, i.options.getString('metin', true)) ? '✅ Not eklendi.' : 'ℹ️ Bu kullanıcı için izleme kaydı yok.');
      }
      if (sub === 'kaldir') {
        const e = api.get(guild.id, target.id);
        if (e && e.by && e.by !== i.user.id && !ctx.isTrusted(guild, i.user.id)) return respond(i, '🔒 İzlemeyi yalnızca ekleyen kişi ya da güvenilir biri kaldırabilir.');
        return respond(i, api.remove(guild.id, target.id) ? '✅ İzleme bitirildi (geçmiş 30 gün raporda kalır).' : 'ℹ️ Bu kullanıcı zaten izlenmiyor.');
      }
      // ekle
      if (target.id === client.user.id) return respond(i, '❌ Botun kendisi izlenemez.');
      if (guild.ownerId === target.id || ctx.isBotOwner(target.id)) return respond(i, '❌ Sunucu sahibi ve bot sahipleri izlenemez.');
      const e = api.add(guild.id, target.id, { reason: i.options.getString('sebep', true), by: i.user.id, days: i.options.getInteger('gun') || cfg.watch.defaultDays });
      if (!e) return respond(i, '❌ İzleme eklenemedi (izleme modülü kapalı olabilir).');
      const inGuild = guild.members.cache.has(target.id);
      const hints = [
        `✅ <@${target.id}> **${fmtDuration(e.until - Date.now())}** boyunca izlenecek.`,
        !cfg.channels.watch && !cfg.channels.log ? '⚠️ İzleme akışı için kanal ayarlı değil: `/ayar kanal` ile **izleme** kanalı seç.' : null,
        inGuild ? null : 'ℹ️ Kullanıcı şu an sunucuda değil; katılırsa hemen uyarı gelir. Özel mesajları botlar göremez: mağdurlara `/ihbar` kullanmalarını söyle.',
        'İpucu: dosya gönderirse çalıştırılmadan hash + statik tarama + VirusTotal ile incelenir. Kalıcı engel için `/karaliste ekle`.',
      ].filter(Boolean);
      return respond(i, hints.join('\n'));
    },
  );

  /* ------------------------------------------------------------ ihbar (slash + sağ tık menüsü) */
  const refusal = (guild, i, targetId) => {
    if (targetId === i.user.id) return '❌ Kendini bildiremezsin.';
    if (targetId === client.user.id) return '❌ Botu bildiremezsin.';
    return null;
  };

  ctx.router.add(
    new SlashCommandBuilder()
      .setName('ihbar')
      .setDescription('Şüpheli bir kullanıcıyı yetkililere bildir (ör. DM ile dosya/RAT gönderdi)')
      .setContexts(InteractionContextType.Guild)
      .addUserOption((o) => o.setName('kullanici').setDescription('Bildirilecek kullanıcı').setRequired(true))
      .addStringOption((o) => o.setName('aciklama').setDescription('Ne oldu? Şüpheli dosyayı AÇMA.').setRequired(true).setMaxLength(500))
      .addAttachmentOption((o) => o.setName('ekran-goruntusu').setDescription('Ekran görüntüsü (zararlı dosyanın kendisini yükleme!)')),
    async (i) => {
      const target = i.options.getUser('kullanici', true);
      const why = refusal(i.guild, i, target.id);
      if (why) return respond(i, why);
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const r = await api.fileReport(i.guild, { targetId: target.id, by: i.user.id, text: i.options.getString('aciklama', true), att: i.options.getAttachment('ekran-goruntusu') });
      return respond(i, r.ok ? '✅ İhbarın yetkililere iletildi, teşekkürler. Şüpheli dosyayı açma, mesajı silme; yetkililer inceleyecek.' : `ℹ️ ${r.msg}`);
    },
  );

  ctx.router.add(
    new ContextMenuCommandBuilder().setName('Şüpheli Bildir').setType(ApplicationCommandType.User).setContexts(InteractionContextType.Guild),
    async (i) => {
      const why = refusal(i.guild, i, i.targetId);
      if (why) return respond(i, why);
      const modal = new ModalBuilder().setCustomId(`ihbar:modal:${i.targetId}`).setTitle('Şüpheli kullanıcı ihbarı')
        .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId('aciklama').setLabel('Ne oldu? (şüpheli dosyayı AÇMA)').setStyle(TextInputStyle.Paragraph)
          .setMinLength(5).setMaxLength(500).setRequired(true)));
      return i.showModal(modal);
    },
  );

  ctx.router.modal('ihbar:modal:', async (i) => {
    if (!i.guild) return;
    const targetId = i.customId.split(':')[2];
    const why = refusal(i.guild, i, targetId);
    if (why) return respond(i, why);
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const r = await api.fileReport(i.guild, { targetId, by: i.user.id, text: i.fields.getTextInputValue('aciklama') });
    return respond(i, r.ok ? '✅ İhbarın yetkililere iletildi, teşekkürler.' : `ℹ️ ${r.msg}`);
  });

  /* ------------------------------------------------------------ süre sonu */
  ctx.every(10 * 60e3, async () => {
    const now = Date.now();
    for (const gid of Object.keys(store.data.watch)) {
      const guild = client.guilds.cache.get(gid);
      for (const [uid, e] of Object.entries(store.data.watch[gid])) {
        if (e.until <= now && !e.closed) {
          e.closed = true;
          if (guild) {
            const s = e.stats;
            await ctx.logEmbed(guild, new EmbedBuilder().setColor(0x95a5a6).setTitle('👁️ İzleme süresi doldu')
              .setDescription(`<@${uid}> — ${s.msgs} mesaj, ${s.files} dosya, ${s.links} bağlantı, ${s.lures} yem metni, ${e.evidence.length} kanıt.\nUzatmak için: \`/izle ekle\` • Rapor: \`/izle rapor\``), 'watch');
          }
        }
        if (e.until + 30 * 864e5 < now) delete store.data.watch[gid][uid];
      }
    }
    for (const [k, arr] of delTimes) { const kept = arr.filter((t) => now - t < 10 * 60e3); if (kept.length) delTimes.set(k, kept); else delTimes.delete(k); }
    for (const [k, b] of buckets) if (now - b.t > 120e3) buckets.delete(k);
    store.save();
  }, 'izleme-sure');
}

module.exports = { name: 'watchlist', init, sniff, mismatchOf };
