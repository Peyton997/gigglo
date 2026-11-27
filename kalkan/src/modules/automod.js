'use strict';
// Otomatik moderasyon: akıllı link filtresi (GIF serbest), dosya, gizli anahtar, küfür, spam/flood, reklam.
const { Events, EmbedBuilder } = require('discord.js');
const L = require('./links');
const files = require('./files');
const { checkProfanity } = require('./profanity');
const { findSecret, socScore, AD_PATTERNS } = require('../data/patterns');
const { truncate, defang, parseDuration, fmtDuration, code } = require('../util');

const state = {
  flood: new Map(), dup: new Map(), mention: new Map(), strikes: new Map(), notice: new Map(),
};

const RULE_TEXT = {
  link: 'bu sunucuda bağlantı paylaşmak yasak (GIF\'ler serbest).',
  invite: 'sunucu daveti / reklam paylaşmak yasak.',
  scam: 'şüpheli / sahte bir bağlantı tespit edildi.',
  executable: 'çalıştırılabilir dosya bağlantıları engellendi.',
  file: 'bu dosya türü güvenlik nedeniyle engellendi.',
  jar: 'mod/plugin dosyası paylaşmak yasak. Güvenli kontrol için /modkontrol komutunu kullan.',
  secret: 'mesajında gizli bir anahtar/token vardı ve silindi. Hemen yenilemelisin!',
  profanity: 'küfür / hakaret içeren mesajlar yasak.',
  flood: 'çok hızlı mesaj gönderiyorsun.',
  duplicate: 'aynı mesajı tekrar tekrar gönderme.',
  crosschannel: 'aynı mesajı birçok kanala gönderme.',
  mention: 'çok fazla etiket kullanma.',
  caps: 'BÜYÜK HARFLE yazma.',
  emoji: 'çok fazla emoji kullanma.',
  lines: 'çok uzun / satır dolu mesaj gönderme.',
  ads: 'reklam yapmak yasak.',
};

const RISK_DEFAULT = { invite: 8, executable: 25, file: 15, jar: 25, flood: 6, mention: 10, scam: 35, crosschannel: 45 };

function push(map, key, entry, windowMs, now) {
  const arr = (map.get(key) || []).filter((e) => now - e.t < windowMs);
  arr.push({ t: now, ...entry });
  map.set(key, arr);
  return arr;
}

const stepRank = (s) => (s && s.startsWith('timeout:') ? parseDuration(s.slice(8)) || 0 : 0);

/**
 * Mesajı değerlendirir, yan etki yapmaz (yalnızca sayaçları günceller).
 * Dönüş: { findings, urls, hasLink, soc }
 */
async function evaluate(ctx, message, member, { edited = false } = {}) {
  const guild = message.guild;
  const cfg = ctx.gcfg(guild.id);
  const am = cfg.automod;
  const content = String(message.content || '').slice(0, 4000);
  const exempt = ctx.isExempt(guild, member);
  const ageHours = member.joinedTimestamp ? (Date.now() - member.joinedTimestamp) / 3600e3 : Infinity;
  const findings = [];
  const add = (f) => findings.push({ del: true, points: 1, severity: 'low', ...f });
  const urls = L.extract(content);

  // 1) Dosyalar (herkes için)
  if (cfg.modules.files && message.attachments && message.attachments.size) {
    for (const f of files.inspect(message, cfg, { memberAgeHours: ageHours })) add(f);
  }

  // 2) Gizli anahtar sızıntısı (herkes için; mağdur cezalandırılmaz)
  if (cfg.modules.secrets) {
    const s = findSecret(content);
    if (s) add({ rule: 'secret', severity: 'high', detail: s, victim: true });
  }

  if (cfg.modules.automod) {
    // 3) Bağlantılar
    const linkOpts = {
      allowDomains: am.links.allowDomains,
      blockInvites: am.links.blockInvites,
      allowInviteCodes: am.links.allowInviteCodes,
      scamHosts: am.links.scamHosts,
      scamSet: ctx.scamSet || null,
      blockedExt: new Set(cfg.files.blockedExt),
    };
    const resolver = ctx.linkResolver || L.resolveShortener;
    for (const info of urls) {
      let c = L.classify(info, linkOpts);
      if (c.action === 'resolve') {
        const final = await resolver(info.url);
        const fi = final ? L.parse(final) : null;
        if (!fi) c = { action: 'block', type: 'shortener', detail: 'Kısaltılmış bağlantı çözülemedi' };
        else {
          c = L.classify(fi, linkOpts);
          if (c.action === 'resolve') c = { action: 'block', type: 'shortener', detail: 'İç içe kısaltılmış bağlantı' };
        }
      }
      const shown = defang(`${info.hostBare}${info.path}`).slice(0, 80);
      if (c.action === 'allow') {
        if (c.type === 'allowed-domain' && !exempt && am.links.newMemberHours > 0 && ageHours < am.links.newMemberHours) {
          add({ rule: 'link', detail: `Yeni üyeler bağlantı atamaz: ${shown}` });
        }
        continue;
      }
      if (c.action !== 'block') continue;
      if (['scam', 'executable', 'ip', 'punycode'].includes(c.type)) {
        const isExec = c.type === 'executable';
        add({
          rule: isExec ? 'executable' : 'scam', severity: 'high',
          detail: `${c.detail}: ${shown}`, minStep: isExec ? 'warn' : 'timeout:1h',
        });
      } else if (!exempt && am.links.enabled) {
        add({ rule: c.type === 'invite' ? 'invite' : 'link', detail: `${c.detail}: ${shown}` });
      }
    }
    // Gizlenmiş davet kodları (örn. "discord . gg / abc")
    if (!exempt && am.links.enabled && am.links.blockInvites && !findings.some((f) => f.rule === 'invite')) {
      const own = (am.links.allowInviteCodes || []).map((x) => x.toLowerCase());
      if (L.inviteCodes(content).some((c) => !own.includes(c))) add({ rule: 'invite', detail: 'Gizlenmiş Discord daveti' });
    }

    // 4) Reklam
    if (!exempt && am.ads.enabled) {
      const lower = content.toLowerCase();
      const self = (am.ads.selfDomains || []).map((s) => String(s).toLowerCase()).filter(Boolean);
      if (!self.some((s) => lower.includes(s)) && AD_PATTERNS.some((re) => re.test(content))) {
        add({ rule: 'ads', detail: 'Reklam kalıbı' });
      }
    }

    // 5) Küfür
    if (!exempt && am.profanity.enabled && content) {
      const p = checkProfanity(content, { level: am.profanity.level, custom: am.profanity.custom, allow: am.profanity.allow });
      if (p) add({ rule: 'profanity', detail: 'Küfür / hakaret' });
    }

    // 6) Spam / flood (düzenlemelerde sayılmaz)
    if (!exempt && am.spam.enabled && !edited) {
      const sp = am.spam;
      const now = Date.now();
      const key = `${guild.id}:${message.author.id}`;

      const fl = push(state.flood, key, {}, sp.floodSeconds * 1000, now);
      if (fl.length >= sp.floodCount) add({ rule: 'flood', detail: `${sp.floodSeconds} sn içinde ${fl.length} mesaj`, purge: sp.floodSeconds * 1000 });

      const norm = content.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
      if (norm.length >= 4) {
        const win = Math.max(sp.dupSeconds, sp.crossChannelSeconds) * 1000;
        const hist = push(state.dup, key, { h: norm, ch: message.channelId }, win, now).filter((e) => e.h === norm);
        const dupN = hist.filter((e) => now - e.t < sp.dupSeconds * 1000).length;
        if (dupN >= sp.dupCount) add({ rule: 'duplicate', detail: `Aynı mesaj ${dupN} kez`, purge: sp.dupSeconds * 1000 });
        const chans = new Set(hist.filter((e) => now - e.t < sp.crossChannelSeconds * 1000).map((e) => e.ch));
        if (chans.size >= sp.crossChannelCount) {
          add({ rule: 'crosschannel', severity: 'high', detail: `Aynı mesaj ${chans.size} kanalda`, minStep: 'timeout:1h', purge: 10 * 60e3 });
        }
      }

      const mc = ((message.mentions && message.mentions.users && message.mentions.users.size) || 0)
        + ((message.mentions && message.mentions.roles && message.mentions.roles.size) || 0)
        + (message.mentions && message.mentions.everyone ? 1 : 0);
      if (mc >= sp.mentionsPerMessage) {
        add({ rule: 'mention', detail: `${mc} etiket`, purge: 60e3 });
      } else if (mc > 0) {
        const mp = push(state.mention, key, { n: mc }, sp.mentionsWindowSeconds * 1000, now);
        const total = mp.reduce((a, e) => a + e.n, 0);
        if (total >= sp.mentionsWindowCount) add({ rule: 'mention', detail: `${total} etiket / ${sp.mentionsWindowSeconds} sn` });
      }

      const letters = content.match(/\p{L}/gu) || [];
      if (letters.length >= sp.capsMinLetters) {
        const up = letters.filter((ch) => ch !== ch.toLowerCase()).length;
        if (up / letters.length >= sp.capsRatio) add({ rule: 'caps', detail: 'Aşırı büyük harf' });
      }
      const emojiCount = (content.match(/<a?:\w+:\d+>/g) || []).length + (content.match(/\p{Extended_Pictographic}/gu) || []).length;
      if (emojiCount >= sp.emojiMax) add({ rule: 'emoji', detail: `${emojiCount} emoji` });
      if (content.split('\n').length > sp.linesMax) add({ rule: 'lines', detail: 'Çok fazla satır' });
    }
  }

  return { findings, urls, hasLink: urls.length > 0, soc: socScore(content) };
}

async function enforce(ctx, message, member, findings) {
  const guild = message.guild;
  const cfg = ctx.gcfg(guild.id);
  const am = cfg.automod;
  const uid = message.author.id;
  const now = Date.now();
  const high = findings.some((f) => f.severity === 'high');

  if (findings.some((f) => f.del !== false)) await message.delete().catch(() => {});
  const purge = Math.max(0, ...findings.map((f) => f.purge || 0));
  if (purge) await ctx.msgbuf.deleteRecent(guild, uid, purge).catch(() => 0);

  const fileFindings = findings.filter((f) => f.file);
  if (fileFindings.length) files.quarantine(ctx, message, fileFindings).catch(() => {});

  for (const f of findings) {
    ctx.stat(guild.id, `blocked:${f.rule}`);
    const pts = f.riskPoints ?? RISK_DEFAULT[f.rule] ?? 0;
    if (pts && !f.victim && ctx.risk) await ctx.risk.signal(guild, uid, pts, `Otomatik moderasyon: ${f.rule} (${f.detail})`);
  }
  ctx.stat(guild.id, 'blocked');

  // Gizli anahtar paylaşan kişi mağdurdur: ceza yok, özel mesajla uyar.
  const victimOnly = findings.every((f) => f.victim);
  let action = 'Mesaj silindi';
  if (victimOnly) {
    ctx.dm(uid, '🔐 Mesajında gizli bir anahtar/token vardı ve silindi. Hemen yenile / şifreni değiştir; başkaları görmüş olabilir.').catch(() => {});
  } else {
    const key = `${guild.id}:${uid}`;
    const arr = (state.strikes.get(key) || []).filter((t) => now - t < am.punish.decayMinutes * 60e3);
    arr.push(now);
    state.strikes.set(key, arr);
    const steps = am.punish.steps && am.punish.steps.length ? am.punish.steps : ['warn'];
    let step = steps[Math.min(arr.length - 1, steps.length - 1)];
    for (const f of findings) if (f.minStep && stepRank(f.minStep) > stepRank(step)) step = f.minStep;

    action = 'Uyarı';
    if (step.startsWith('timeout:')) {
      const ms = parseDuration(step.slice(8));
      if (ms && member.moderatable) {
        try {
          await member.timeout(Math.min(ms, 28 * 864e5), 'Kalkan otomatik moderasyon');
          action = `${fmtDuration(ms)} susturma`;
        } catch { action = 'Uyarı (susturma yapılamadı)'; }
      } else {
        action = 'Uyarı (susturma yapılamadı)';
      }
    }

    if (now - (state.notice.get(key) || 0) > 8000 && message.channel && message.channel.send) {
      state.notice.set(key, now);
      const reason = RULE_TEXT[findings[0].rule] || 'kural ihlali.';
      try {
        const sent = await message.channel.send({
          content: `⚠️ <@${uid}>, ${reason}${action.includes('susturma') && !action.includes('yapılamadı') ? ` (${action})` : ''}`,
          allowedMentions: { users: [uid] },
        });
        const t = setTimeout(() => sent.delete().catch(() => {}), (am.noticeSeconds || 6) * 1000);
        if (t.unref) t.unref();
      } catch { /* kanal yazma yetkisi yok */ }
    }
  }

  const embed = new EmbedBuilder()
    .setColor(high ? 0xe74c3c : 0xf1c40f)
    .setTitle('🛡️ Otomatik moderasyon')
    .setDescription(`Kullanıcı: <@${uid}> (${code(uid)})\nKanal: <#${message.channelId}>\nİşlem: **${action}**`)
    .addFields({ name: 'Kurallar', value: truncate(findings.map((f) => `• **${f.rule}** — ${f.detail}`).join('\n'), 1000) })
    .setTimestamp();
  const snippet = String(message.content || '').replace(/https?:\/\/\S+/gi, (u) => defang(u)).replace(/`/g, "'");
  if (snippet && !victimOnly) embed.addFields({ name: 'İçerik (bağlantılar zararsızlaştırıldı)', value: '```' + truncate(snippet, 300) + '```' });
  await ctx.logEmbed(guild, embed);
  return { action };
}

async function handle(ctx, message, { edited = false } = {}) {
  if (!message.guild || message.webhookId || message.system) return;
  if (message.partial) {
    try { message = await message.fetch(); } catch { return; }
  }
  if (!message.author || message.author.bot) return;
  const guild = message.guild;
  const cfg = ctx.gcfg(guild.id);
  const member = message.member || (await guild.members.fetch(message.author.id).catch(() => null));
  if (!member) return;

  if (!edited) ctx.msgbuf.push(guild.id, member.id, { id: message.id, channelId: message.channelId });

  if (!edited && cfg.modules.honeypot && cfg.channels.honeypot.includes(message.channelId) && ctx.honeypot) {
    await ctx.honeypot.hit(message, member);
    return;
  }
  if (!cfg.modules.automod && !cfg.modules.files && !cfg.modules.secrets) return;

  const prior = ctx.members.get(guild.id, member.id);
  const established = !!prior && prior.msgs >= 50 && prior.links === 0;
  const res = await evaluate(ctx, message, member, { edited });
  if (!edited) ctx.members.activity(guild.id, member.id, { link: res.hasLink, file: !!(message.attachments && message.attachments.size) });

  if (res.soc >= 3 && ctx.risk) {
    await ctx.risk.signal(guild, member.id, 12, 'Dosya/hile/uzaktan erişim yemi kalıbına benzeyen mesaj');
    if (res.hasLink || (message.attachments && message.attachments.size)) {
      await ctx.risk.signal(guild, member.id, 10, 'Yem kalıbı + bağlantı/dosya birlikte');
    }
  }
  if (res.findings.length) {
    if (established && res.findings.some((f) => ['link', 'scam', 'invite', 'executable'].includes(f.rule)) && ctx.risk) {
      await ctx.risk.signal(guild, member.id, 12, 'Köklü üye ilk kez bağlantı gönderdi');
    }
    await enforce(ctx, message, member, res.findings);
  }
}

function init(ctx) {
  const { client, log } = ctx;
  client.on(Events.MessageCreate, (m) => { handle(ctx, m).catch((e) => log.error('automod:', e)); });
  client.on(Events.MessageUpdate, (o, n) => {
    if (o && !o.partial && !n.partial && o.content === n.content) return;
    handle(ctx, n, { edited: true }).catch((e) => log.error('automod(düzenleme):', e));
  });
  ctx.every(5 * 60e3, () => {
    const now = Date.now();
    for (const map of [state.flood, state.dup, state.mention, state.strikes, state.notice]) {
      for (const [k, v] of map) {
        const last = Array.isArray(v) ? (v.length ? v[v.length - 1].t ?? v[v.length - 1] : 0) : v;
        if (!last || now - last > 10 * 60e3) map.delete(k);
      }
    }
    ctx.msgbuf.gc();
  }, 'automod-gc');
}

module.exports = { name: 'automod', init, evaluate, enforce, handle, state, RULE_TEXT };
