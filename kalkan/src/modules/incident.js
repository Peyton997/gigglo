'use strict';
// Olay analizi: denetim günlüğünden zaman çizelgesi + "bunu muhtemelen kim yaptı" sıralaması (olasılıksal dille) + kanıt paketi.
const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, AttachmentBuilder, InteractionContextType, MessageFlags } = require('discord.js');
const { respond, truncate, code, toBig, CRIT_MASK } = require('../util');

const WEIGHTS = {
  ChannelDelete: 3, RoleDelete: 3, MemberBanAdd: 2, MemberKick: 2, WebhookCreate: 2, MemberPrune: 4, EmojiDelete: 1,
  BotAdd: 4, GuildUpdate: 2, RoleUpdate: 1, ChannelOverwriteUpdate: 0.5, ChannelCreate: 0.5, RoleCreate: 0.5,
  InviteCreate: 0.3, WebhookUpdate: 1, IntegrationCreate: 2, StickerDelete: 1, MemberRoleUpdate: 0.5, MemberUpdate: 0.2,
};
const TR = {
  ChannelDelete: 'kanal sildi', RoleDelete: 'rol sildi', MemberBanAdd: 'yasakladı', MemberKick: 'attı', WebhookCreate: 'webhook oluşturdu',
  MemberPrune: 'üye budadı', EmojiDelete: 'emoji sildi', BotAdd: 'bot ekledi', GuildUpdate: 'sunucu ayarı değiştirdi', RoleUpdate: 'rolü düzenledi',
  ChannelOverwriteUpdate: 'kanal iznini değiştirdi', ChannelCreate: 'kanal açtı', RoleCreate: 'rol açtı', InviteCreate: 'davet oluşturdu',
  WebhookUpdate: 'webhook düzenledi', MemberRoleUpdate: 'üye rolü değiştirdi',
};

// events: eventlog kayıtları. Dönen liste puana göre azalan sıradadır.
function rank(guild, events, { members = {}, isTrusted = () => false, riskOf = () => 0 } = {}) {
  const by = new Map();
  const total = { v: 0 };
  for (const e of events) {
    if (!e.actor || String(e.type).startsWith('WATCH_') || e.type === 'ALERT') continue;
    let w = WEIGHTS[e.type];
    if (w === undefined) continue;
    const s = by.get(e.actor) || { id: e.actor, score: 0, counts: {}, first: e.t, last: e.t, notes: new Set() };
    if (e.type === 'RoleUpdate' && e.permNew !== undefined) {
      const gained = toBig(e.permNew) & ~toBig(e.permOld) & CRIT_MASK;
      if (gained) { w += 3; s.notes.add('bir rolün kritik yetkilerini artırdı'); }
    }
    if (e.type === 'MemberRoleUpdate' && Array.isArray(e.add) && guild) {
      for (const rid of e.add) {
        const r = guild.roles && guild.roles.cache && guild.roles.cache.get(rid);
        if (r && (toBig(r.permissions) & CRIT_MASK)) { w += 3; s.notes.add(`kritik yetkili rol verdi (${r.name})`); }
      }
    }
    s.score += w;
    s.counts[e.type] = (s.counts[e.type] || 0) + 1;
    s.first = Math.min(s.first, e.t);
    s.last = Math.max(s.last, e.t);
    by.set(e.actor, s);
  }
  for (const s of by.values()) {
    const m = members[s.id];
    if (m) {
      if (m.bot) s.notes.add('bir bot hesabı');
      if (m.createdAt && s.first - m.createdAt < 7 * 864e5) { s.score *= 1.5; s.notes.add('hesap 7 günden yeni'); }
      if (m.joinedAt && s.first - m.joinedAt < 48 * 3600e3) { s.score *= 1.5; s.notes.add('sunucuya 48 saatten kısa süre önce katıldı'); }
      if (m.n >= 30 && m.hours) {
        const tot = m.hours.reduce((a, b) => a + b, 0) || 1;
        if (m.hours[new Date(s.first).getUTCHours()] / tot < 0.02) { s.score *= 1.3; s.notes.add('normalde aktif olmadığı saatte işlem yaptı'); }
      }
    }
    if (isTrusted(s.id)) s.notes.add('güvenilir hesap → ele geçirilmiş olabilir');
    const r = riskOf(s.id);
    if (r >= 40) { s.score += r / 20; s.notes.add(`risk skoru ${r}`); }
    total.v += s.score;
    s.notes = [...s.notes];
  }
  const list = [...by.values()].sort((a, b) => b.score - a.score);
  for (const s of list) s.share = total.v ? s.score / total.v : 0;
  return list;
}

function wording(s) {
  if (s.score < 3) return 'belirgin bir şüphe yok';
  if (s.share >= 0.6 && s.score >= 6) return 'yüksek olasılıkla sorumlu';
  if (s.share >= 0.3) return 'olası sorumlu';
  return 'düşük olasılıklı / katkı sağlamış olabilir';
}

function init(ctx) {
  const { env, store } = ctx;
  const briefAt = new Map();

  function build(guild, hours) {
    const since = Date.now() - hours * 3600e3;
    const events = ctx.events.read(guild.id, { since, limit: 8000 });
    const members = store.data.members[guild.id] || {};
    const suspects = rank(guild, events, {
      members, isTrusted: (id) => ctx.isTrusted(guild, id), riskOf: (id) => (ctx.risk ? ctx.risk.current(guild.id, id) : 0),
    });
    const counts = {};
    for (const e of events) if (e.type !== 'ALERT' && !String(e.type).startsWith('WATCH_')) counts[e.type] = (counts[e.type] || 0) + 1;
    const alerts = events.filter((e) => e.type === 'ALERT' && (e.level === 'high' || e.level === 'critical'));
    return { since, events, suspects, counts, alerts };
  }

  function suspectLines(list, n = 5) {
    return list.slice(0, n).map((s, idx) => {
      const acts = Object.entries(s.counts).map(([t, c]) => `${c}× ${TR[t] || t}`).join(', ');
      return `**${idx + 1}.** <@${s.id}> (${code(s.id)}) — ${wording(s)} (%${Math.round(s.share * 100)} pay)\n${acts}${s.notes.length ? `\n_${s.notes.join('; ')}_` : ''}`;
    }).join('\n\n');
  }

  function toMarkdown(guild, hours, r) {
    const L = [`# Olay raporu — ${guild.name}`, '', `Dönem: son ${hours} saat • Oluşturulma: ${new Date().toISOString()}`, '',
      '> Bu analiz denetim günlüğüne dayanan bir sezgiseldir. Kesin hüküm değildir; son kararı insan verir.', '', '## Olay sayıları'];
    for (const [t, c] of Object.entries(r.counts)) L.push(`- ${TR[t] || t}: ${c}`);
    L.push('', '## Şüpheli sıralaması');
    r.suspects.slice(0, 10).forEach((s, i) => {
      L.push(`${i + 1}. ${s.id} — ${wording(s)} (%${Math.round(s.share * 100)}) — puan ${s.score.toFixed(1)}`);
      L.push(`   - ${Object.entries(s.counts).map(([t, c]) => `${c}× ${TR[t] || t}`).join(', ')}`);
      if (s.notes.length) L.push(`   - notlar: ${s.notes.join('; ')}`);
    });
    L.push('', '## Zaman çizelgesi');
    for (const e of r.events.filter((x) => !String(x.type).startsWith('WATCH_')).slice(-300)) {
      L.push(`- ${new Date(e.t).toISOString()} ${e.type}${e.actor ? ` aktör=${e.actor}` : ''}${e.target ? ` hedef=${e.target}` : ''}${e.name ? ` ${String(e.name).replace(/\n/g, ' ')}` : ''}`);
    }
    return L.join('\n');
  }

  // İsteğe bağlı: olay özetini Anthropic API ile Türkçe doğal dile çevirir. Yalnızca olay türleri/kimlikler gönderilir; mesaj içeriği asla.
  async function llmSummary(guild, hours, r) {
    if (!env.anthropicKey) return null;
    const lines = r.events.filter((x) => !String(x.type).startsWith('WATCH_')).slice(-120)
      .map((e) => `${new Date(e.t).toISOString().slice(11, 19)} ${e.type} aktör=${e.actor || '-'} hedef=${e.target || '-'} ${e.name || ''}`).join('\n');
    const prompt = `Aşağıda bir Discord sunucusunun son ${hours} saatlik denetim günlüğü var. Türkçe, kısa (en fazla 8 cümle) ve yalnızca verilere dayanarak ne olduğunu özetle. `
      + 'Kimin yaptığını kesinmiş gibi söyleme; olasılık dili kullan. Veride olmayan bir şey uydurma.\n\n'
      + `Şüpheli sıralaması (sezgisel): ${r.suspects.slice(0, 3).map((s) => `${s.id} puan=${s.score.toFixed(1)}`).join(', ') || 'yok'}\n\nOlaylar:\n${lines}`;
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': env.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: env.anthropicModel, max_tokens: 600, messages: [{ role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) return null;
      const j = await res.json();
      return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim() || null;
    } catch { return null; }
  }

  ctx.incident = {
    rank, build,
    // Kötü bir olaydan hemen sonra uyarı kanalına kısa "kim yapmış olabilir" özeti bırakır.
    async postBrief(guild, hours = 1) {
      try {
        const last = briefAt.get(guild.id) || 0;
        if (Date.now() - last < 120e3) return; // aynı olay için iki kez özet gönderme
        briefAt.set(guild.id, Date.now());
        const r = build(guild, hours);
        if (!r.suspects.length || r.suspects[0].score < 3) return;
        const embed = new EmbedBuilder().setColor(0xe74c3c).setTitle('🔎 Otomatik olay özeti (ön analiz)')
          .setDescription(`Son ${hours} saatteki denetim kayıtlarına göre olası sorumlular:\n\n${truncate(suspectLines(r.suspects, 3), 3500)}`)
          .setFooter({ text: 'Sezgisel tahmindir, kesin değildir. Ayrıntı: /olay rapor' }).setTimestamp();
        await ctx.logEmbed(guild, embed, 'alert');
      } catch { /* analiz başarısız olsa da koruma akışı etkilenmesin */ }
    },
  };

  ctx.router.add(
    new SlashCommandBuilder()
      .setName('olay')
      .setDescription('Olay analizi: ne oldu, kim yapmış olabilir?')
      .setDefaultMemberPermissions(PermissionFlagsBits.ViewAuditLog)
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((s) => s.setName('rapor').setDescription('Zaman çizelgesi, olası sorumlular ve kanıt dosyası')
        .addIntegerOption((o) => o.setName('saat').setDescription('Kaç saat geriye? (varsayılan 24)').setMinValue(1).setMaxValue(168))
        .addBooleanOption((o) => o.setName('ozet').setDescription('Yapay zekâ ile doğal dilde özet ekle (ANTHROPIC_API_KEY gerekir)')))
      .addSubcommand((s) => s.setName('kisi').setDescription('Bir kişinin son olaylarını göster')
        .addUserOption((o) => o.setName('kullanici').setDescription('Kullanıcı').setRequired(true))
        .addIntegerOption((o) => o.setName('saat').setDescription('Kaç saat geriye? (varsayılan 72)').setMinValue(1).setMaxValue(720))),
    async (i) => {
      if (!ctx.isTrusted(i.guild, i.user.id) && !i.memberPermissions.has(PermissionFlagsBits.ViewAuditLog)) return respond(i, '🔒 Bu komut yalnızca yetkililer içindir.');
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const guild = i.guild;
      if (i.options.getSubcommand() === 'kisi') {
        const u = i.options.getUser('kullanici', true);
        const hours = i.options.getInteger('saat') || 72;
        const ev = ctx.events.read(guild.id, { since: Date.now() - hours * 3600e3, limit: 8000 }).filter((e) => e.actor === u.id || e.target === u.id);
        if (!ev.length) return respond(i, 'ℹ️ Bu dönemde bu kişiyle ilgili kayıt yok.');
        const lines = ev.slice(-25).map((e) => `<t:${Math.floor(e.t / 1000)}:t> ${e.actor === u.id ? '→' : '←'} ${String(e.type).replace('WATCH_', '👁 ')} ${truncate(e.name || '', 60)}`);
        return respond(i, `**<@${u.id}> — son ${hours} saat (${ev.length} kayıt)**\n${truncate(lines.join('\n'), 1800)}`);
      }
      const hours = i.options.getInteger('saat') || 24;
      const r = build(guild, hours);
      const embed = new EmbedBuilder().setColor(r.suspects[0] && r.suspects[0].score >= 6 ? 0xe74c3c : 0x3498db)
        .setTitle(`🔎 Olay raporu — son ${hours} saat`).setTimestamp()
        .setFooter({ text: 'Sezgisel analizdir; kesin hüküm değildir. İnsan kararıyla değerlendir.' });
      const countLine = Object.entries(r.counts).map(([t, c]) => `${TR[t] || t}: **${c}**`).join(' • ');
      embed.setDescription(countLine || 'Bu dönemde kayıtlı yıkıcı/yönetsel işlem yok.');
      if (r.suspects.length) embed.addFields({ name: 'Olası sorumlular', value: truncate(suspectLines(r.suspects), 1000) });
      if (r.alerts.length) embed.addFields({ name: 'Yükselen uyarılar', value: truncate(r.alerts.slice(-6).map((a) => `<t:${Math.floor(a.t / 1000)}:t> ${truncate(a.name || '', 80)}`).join('\n'), 1000) });
      if (i.options.getBoolean('ozet')) {
        const text = await llmSummary(guild, hours, r);
        embed.addFields({ name: '🤖 Doğal dilde özet', value: truncate(text || (env.anthropicKey ? 'Özet alınamadı.' : 'ANTHROPIC_API_KEY tanımlı değil.'), 1000) });
      }
      const files = [
        new AttachmentBuilder(Buffer.from(toMarkdown(guild, hours, r), 'utf8'), { name: `olay-raporu-${guild.id}.md` }),
        new AttachmentBuilder(Buffer.from(JSON.stringify({ guild: guild.id, hours, suspects: r.suspects, counts: r.counts, events: r.events.slice(-3000) }, null, 1), 'utf8'), { name: `olay-kanit-${guild.id}.json` }),
      ];
      return respond(i, { embeds: [embed], files });
    },
  );
}

module.exports = { name: 'incident', init, rank, wording, TR };
