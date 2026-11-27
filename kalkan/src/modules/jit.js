'use strict';
// Süreli (JIT) yönetici yetkisi: kalıcı "yönetici" yok. Gerektiğinde ikinci bir kişinin onayıyla süreli rol verilir, süre bitince otomatik alınır.
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, InteractionContextType, MessageFlags } = require('discord.js');
const { randomId } = require('../crypto');
const { respond, parseDuration, fmtDuration, unixRel, truncate } = require('../util');

const PENDING_TTL = 30 * 60e3;

function init(ctx) {
  const { client, env, store, log } = ctx;
  const items = () => store.data.jit;
  const timers = new Map();

  const approverIds = (guild, requesterId) => {
    const cfg = ctx.gcfg(guild.id);
    const s = new Set([...cfg.jit.approvers, ...env.ownerIds]);
    if (!s.size && guild.ownerId) s.add(guild.ownerId);
    s.delete(requesterId);
    return s;
  };

  const isEligible = (guild, member) => {
    const el = ctx.gcfg(guild.id).jit.eligible;
    if (el.includes(member.id)) return true;
    if (member.roles.cache.some((r) => el.includes(r.id))) return true;
    return !el.length && ctx.isTrusted(guild, member.id);
  };

  /* ------------------------------------------------------------ süre yönetimi */
  function clear(id) {
    const t = timers.get(id);
    if (t) clearTimeout(t);
    timers.delete(id);
  }

  function arm(it) {
    clear(it.id);
    const delay = Math.max(1000, Math.min(it.until - Date.now(), 2 ** 31 - 1));
    const t = setTimeout(() => expire(it.id).catch((e) => log.error('JIT süre sonu hatası:', e)), delay);
    if (t.unref) t.unref();
    timers.set(it.id, t);
  }

  async function revoke(it, why) {
    clear(it.id);
    it.status = 'ended';
    it.endedAt = Date.now();
    store.save();
    const guild = client.guilds.cache.get(it.gid);
    if (!guild) return;
    const m = await guild.members.fetch(it.uid).catch(() => null);
    if (m && m.roles.cache.has(it.rid)) await m.roles.remove(it.rid, `Kalkan JIT: ${why}`).catch(() => {});
    await ctx.alert({ guild, level: 'info', title: 'Geçici yetki sona erdi', description: `<@${it.uid}> — ${why}` });
  }

  async function expire(id) {
    const it = items()[id];
    if (!it || it.status !== 'active') return;
    if (it.until > Date.now() + 5000) return arm(it);
    await revoke(it, 'süre doldu');
  }

  ctx.jit = {
    list: (gid) => Object.values(items()).filter((x) => x.gid === gid),
    restore() {
      for (const it of Object.values(items())) {
        if (it.status !== 'active') continue;
        if (it.until <= Date.now()) revoke(it, 'süre doldu (bot yeniden başladı)').catch(() => {});
        else arm(it);
      }
    },
    async revokeAll(gid, why = 'toplu iptal') {
      let n = 0;
      for (const it of Object.values(items())) if (it.gid === gid && it.status === 'active') { await revoke(it, why); n++; }
      return n;
    },
  };

  /* ------------------------------------------------------------ komut */
  ctx.router.add(
    new SlashCommandBuilder()
      .setName('yetki')
      .setDescription('Süreli yönetici yetkisi (ikinci kişi onayıyla)')
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((s) => s.setName('al').setDescription('Süreli yetki iste')
        .addStringOption((o) => o.setName('sebep').setDescription('Neden gerekli?').setRequired(true).setMaxLength(200))
        .addStringOption((o) => o.setName('sure').setDescription('Süre (örn. 30dk, 2sa). Varsayılan 1sa').setMaxLength(20)))
      .addSubcommand((s) => s.setName('birak').setDescription('Süreli yetkini erken bırak'))
      .addSubcommand((s) => s.setName('iptal').setDescription('Bekleyen talebi ya da zaman kilidini iptal et')
        .addStringOption((o) => o.setName('id').setDescription('Talep ya da kilit kimliği').setRequired(true).setMaxLength(80)))
      .addSubcommand((s) => s.setName('liste').setDescription('Aktif ve bekleyen yetkileri göster')),
    async (i) => {
      const guild = i.guild;
      const cfg = ctx.gcfg(guild.id);
      const sub = i.options.getSubcommand();
      const uid = i.user.id;

      if (sub === 'liste') {
        if (!ctx.isTrusted(guild, uid) && !cfg.jit.approvers.includes(uid)) return respond(i, '🔒 Bu liste yalnızca güvenilir kişiler içindir.');
        const act = ctx.jit.list(guild.id).filter((x) => x.status === 'active' || x.status === 'pending');
        const locks = ctx.timelock ? ctx.timelock.list(guild.id) : [];
        const lines = [
          ...act.map((x) => `${x.status === 'active' ? '🟢' : '🟡'} \`${x.id}\` <@${x.uid}> — ${x.status === 'active' ? `bitiş ${unixRel(x.until)}` : 'onay bekliyor'} — ${truncate(x.reason, 60)}`),
          ...locks.map((t) => `🔒 \`${t.id}\` <@${t.uid}> → <@&${t.rid}> ${unixRel(t.at)}`),
        ];
        return respond(i, lines.length ? lines.join('\n') : 'ℹ️ Aktif ya da bekleyen kayıt yok.');
      }

      if (sub === 'iptal') {
        const id = i.options.getString('id', true).trim();
        if (ctx.timelock && store.data.timelock[id]) {
          if (!ctx.isTrusted(guild, uid)) return respond(i, '🔒 Zaman kilidini yalnızca güvenilir kişiler iptal edebilir.');
          ctx.timelock.cancel(id);
          return respond(i, '✅ Zaman kilidi iptal edildi; rol verilmeyecek.');
        }
        const it = items()[id];
        if (!it || it.gid !== guild.id) return respond(i, '❌ Böyle bir kayıt bulunamadı.');
        if (it.uid !== uid && !approverIds(guild, '').has(uid)) return respond(i, '🔒 Bu talebi yalnızca talep eden ya da onaylayıcılar iptal edebilir.');
        if (it.status === 'active') { await revoke(it, `iptal: <@${uid}>`); return respond(i, '✅ Yetki geri alındı.'); }
        if (it.status !== 'pending') return respond(i, 'ℹ️ Bu talep zaten sonlanmış.');
        it.status = 'cancelled';
        store.save();
        return respond(i, '✅ Talep iptal edildi.');
      }

      if (sub === 'birak') {
        const mine = ctx.jit.list(guild.id).find((x) => x.uid === uid && x.status === 'active');
        if (!mine) return respond(i, 'ℹ️ Aktif bir süreli yetkin yok.');
        await revoke(mine, 'kişi kendisi bıraktı');
        return respond(i, '✅ Yetkin geri alındı.');
      }

      // al
      const role = cfg.jit.roleId && guild.roles.cache.get(cfg.jit.roleId);
      if (!role) return respond(i, 'ℹ️ Süreli yetki kapalı: önce `/ayar jit` ile bir rol belirlenmeli.');
      const member = i.member;
      if (!isEligible(guild, member)) return respond(i, '🔒 Süreli yetki isteme iznin yok.');
      if (member.roles.cache.has(role.id)) return respond(i, 'ℹ️ Bu role zaten sahipsin.');
      if (ctx.jit.list(guild.id).some((x) => x.uid === uid && (x.status === 'active' || (x.status === 'pending' && Date.now() - x.at < PENDING_TTL)))) {
        return respond(i, 'ℹ️ Zaten aktif ya da bekleyen bir talebin var.');
      }
      const approvers = approverIds(guild, uid);
      if (!approvers.size) return respond(i, '❌ Onaylayacak ikinci bir kişi tanımlı değil. `/ayar jit` ile onaylayıcı ekle.');
      let ms = parseDuration(i.options.getString('sure') || '1sa');
      if (!ms) return respond(i, '❌ Süre anlaşılamadı. Örnek: `30dk`, `2sa`.');
      ms = Math.max(5 * 60e3, Math.min(ms, cfg.jit.maxHours * 3600e3));
      const it = { id: randomId(3), gid: guild.id, uid, rid: role.id, ms, reason: i.options.getString('sebep', true), at: Date.now(), status: 'pending' };
      items()[it.id] = it;
      store.save();

      const embed = new EmbedBuilder().setColor(0xe67e22).setTitle('🔑 Süreli yönetici yetkisi talebi')
        .setDescription(`<@${uid}> **${role.name}** rolünü **${fmtDuration(ms)}** için istiyor.`)
        .addFields({ name: 'Sebep', value: truncate(it.reason, 300) }, { name: 'Talep kimliği', value: `\`${it.id}\`` })
        .setFooter({ text: 'Onaylayan kişi talep edenden farklı olmalı. Talep 30 dk içinde onaylanmazsa düşer.' });
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`jit:ok:${it.id}`).setLabel('Onayla').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`jit:no:${it.id}`).setLabel('Reddet').setStyle(ButtonStyle.Danger),
      );
      await ctx.sendToChannel(guild, cfg.channels.alert || cfg.channels.log, { embeds: [embed], components: [row] });
      for (const id of [...approvers].slice(0, 10)) ctx.dm(id, { embeds: [embed], components: [row] }).catch(() => {});
      return respond(i, `⏳ Talep gönderildi (\`${it.id}\`). Onaylayıcılar bilgilendirildi; onaylanınca rol otomatik verilir.`);
    },
  );

  ctx.router.button('jit:', async (i) => {
    const [, act, id] = i.customId.split(':');
    const it = items()[id];
    if (!it || it.status !== 'pending') return respond(i, 'ℹ️ Bu talep artık geçerli değil.');
    if (Date.now() - it.at > PENDING_TTL) { it.status = 'expired'; store.save(); return respond(i, '⌛ Talebin süresi dolmuş. Yeniden istenmeli.'); }
    const guild = client.guilds.cache.get(it.gid);
    if (!guild) return respond(i, '❌ Sunucuya erişilemiyor.');
    if (!approverIds(guild, it.uid).has(i.user.id)) return respond(i, '🔒 Bu talebi onaylama yetkin yok (talep eden kendi talebini onaylayamaz).');

    if (act === 'no') {
      it.status = 'denied';
      it.by = i.user.id;
      store.save();
      ctx.dm(it.uid, `❌ **${guild.name}** sunucusundaki süreli yetki talebin reddedildi.`).catch(() => {});
      await ctx.alert({ guild, level: 'info', title: 'Süreli yetki talebi reddedildi', description: `<@${it.uid}> talebi <@${i.user.id}> tarafından reddedildi.` });
      return i.update({ content: `❌ Reddedildi (<@${i.user.id}>).`, embeds: [], components: [] });
    }

    const role = guild.roles.cache.get(it.rid);
    const member = await guild.members.fetch(it.uid).catch(() => null);
    if (!role || !member) return respond(i, '❌ Rol ya da kişi bulunamadı.');
    if (!role.editable) return respond(i, '❌ Bot bu rolü veremiyor: botun rolü bu rolün üstünde olmalı.');
    try {
      await member.roles.add(role, `Kalkan JIT: onaylayan ${i.user.tag || i.user.id}`);
    } catch (e) {
      return respond(i, `❌ Rol verilemedi: ${e.message}`);
    }
    it.status = 'active';
    it.by = i.user.id;
    it.until = Date.now() + it.ms;
    store.save();
    arm(it);
    ctx.stat(guild.id, 'jitGrant');
    ctx.dm(it.uid, `✅ **${guild.name}**: **${role.name}** yetkin ${fmtDuration(it.ms)} süreyle verildi (bitiş ${unixRel(it.until)}). İşin bitince \`/yetki birak\` ile erken bırakabilirsin.`).catch(() => {});
    await ctx.alert({
      guild, level: 'warn', title: 'Süreli yönetici yetkisi verildi',
      description: `<@${it.uid}> → **${role.name}** (${fmtDuration(it.ms)})\nOnaylayan: <@${i.user.id}>\nSebep: ${truncate(it.reason, 200)}`,
    });
    return i.update({ content: `✅ Onaylandı (<@${i.user.id}>). Bitiş: ${unixRel(it.until)}`, embeds: [], components: [] });
  });

  ctx.every(10 * 60e3, () => {
    const now = Date.now();
    for (const [id, it] of Object.entries(items())) {
      if (it.status === 'pending' && now - it.at > PENDING_TTL) it.status = 'expired';
      if (['ended', 'denied', 'cancelled', 'expired'].includes(it.status) && now - (it.endedAt || it.at) > 14 * 864e5) delete items()[id];
    }
    store.save();
  }, 'jit-temizlik');
}

module.exports = { name: 'jit', init };
