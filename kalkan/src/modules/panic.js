'use strict';
// Acil kilit: kanallarda herkesin yazmasını kapatır, davetleri durdurur, doğrulama seviyesini yükseltir.
const { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField, ChannelType, InteractionContextType, MessageFlags } = require('discord.js');
const { respond, chunk, toBig, CRIT_MASK, criticalList } = require('../util');

const LOCK_PERMS = ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads', 'AddReactions'];
const LOCK_FLAGS = Object.fromEntries(LOCK_PERMS.map((p) => [p, false]));
const LOCKABLE = new Set([
  ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia,
  ChannelType.GuildVoice, ChannelType.GuildStageVoice,
].filter((x) => x !== undefined));

function init(ctx) {
  const api = {
    async activate(guild, { by = 'sistem', reason = '', deep = false } = {}) {
      const cfg = ctx.gcfg(guild.id);
      if (cfg.panic.active) return { already: true };
      const saved = { channels: {}, roles: {}, verification: guild.verificationLevel, invitesWereDisabled: false, invites: false };
      try { saved.invitesWereDisabled = !!(guild.features && guild.features.includes('INVITES_DISABLED')); } catch { /* yoksay */ }
      cfg.panic = { active: true, at: Date.now(), by, reason, saved };
      ctx.save();

      const targets = [...guild.channels.cache.values()].filter((c) => LOCKABLE.has(c.type) && c.permissionOverwrites);
      let locked = 0;
      let failed = 0;
      for (const group of chunk(targets, 5)) {
        await Promise.all(group.map(async (ch) => {
          try {
            const ow = ch.permissionOverwrites.cache.get(guild.id);
            saved.channels[ch.id] = { had: !!ow, allow: ow ? ow.allow.bitfield.toString() : '0', deny: ow ? ow.deny.bitfield.toString() : '0' };
            await ch.permissionOverwrites.edit(guild.roles.everyone, LOCK_FLAGS, { reason: 'Kalkan panic: kilit' });
            locked++;
          } catch {
            delete saved.channels[ch.id];
            failed++;
          }
        }));
        ctx.save();
      }

      const extra = [];
      try {
        if (typeof guild.disableInvites === 'function') {
          await guild.disableInvites(true);
          saved.invites = true;
          extra.push('davetler kapatıldı');
        }
      } catch { /* yetki yok */ }
      try {
        if (guild.verificationLevel < 4) {
          await guild.setVerificationLevel(4, 'Kalkan panic');
          extra.push('doğrulama seviyesi en yükseğe alındı');
        }
      } catch { /* yetki yok */ }

      if (deep) {
        const safe = new Set(cfg.panic.safeRoleIds || []);
        let n = 0;
        for (const role of guild.roles.cache.values()) {
          if (role.id === guild.id || role.managed || !role.editable || safe.has(role.id)) continue;
          if (!criticalList(role.permissions).length) continue;
          try {
            saved.roles[role.id] = toBig(role.permissions).toString();
            await role.setPermissions(new PermissionsBitField(toBig(role.permissions) & ~CRIT_MASK), 'Kalkan panic: derin mod');
            n++;
          } catch { delete saved.roles[role.id]; }
        }
        if (n) extra.push(`${n} rolden kritik yetkiler geçici alındı`);
      }
      ctx.save();
      ctx.stat(guild.id, 'panic');
      await ctx.alert({
        guild, level: 'critical', title: 'PANİK MODU AÇILDI',
        description: `Sebep: ${reason || '-'}\nBaşlatan: ${by}\n${locked} kanal kilitlendi${failed ? `, ${failed} kanal kilitlenemedi` : ''}${extra.length ? `\n${extra.join(', ')}` : ''}\n\nKapatmak için: \`/panic kapat\` (yalnızca bot sahipleri).`,
        key: 'panic-on',
      });
      if (ctx.incident) ctx.incident.postBrief(guild, 1).catch(() => {});
      return { locked, failed, extra };
    },

    async deactivate(guild, by = 'sistem') {
      const cfg = ctx.gcfg(guild.id);
      if (!cfg.panic.active) return { already: true };
      const saved = cfg.panic.saved || { channels: {}, roles: {} };
      let restored = 0;
      for (const group of chunk(Object.entries(saved.channels || {}), 5)) {
        await Promise.all(group.map(async ([id, s]) => {
          const ch = guild.channels.cache.get(id);
          if (!ch || !ch.permissionOverwrites) return;
          try {
            if (!s.had) {
              await ch.permissionOverwrites.delete(guild.roles.everyone, 'Kalkan panic bitti');
            } else {
              const allow = BigInt(s.allow);
              const deny = BigInt(s.deny);
              const flags = {};
              for (const p of LOCK_PERMS) {
                const bit = PermissionFlagsBits[p];
                flags[p] = (allow & bit) === bit ? true : (deny & bit) === bit ? false : null;
              }
              await ch.permissionOverwrites.edit(guild.roles.everyone, flags, { reason: 'Kalkan panic bitti' });
            }
            restored++;
          } catch { /* kanal silinmiş olabilir */ }
        }));
      }
      for (const [rid, bits] of Object.entries(saved.roles || {})) {
        const role = guild.roles.cache.get(rid);
        if (role) await role.setPermissions(BigInt(bits), 'Kalkan panic bitti').catch(() => {});
      }
      try { if (saved.invites && !saved.invitesWereDisabled && typeof guild.disableInvites === 'function') await guild.disableInvites(false); } catch { /* yoksay */ }
      try { if (typeof saved.verification === 'number' && guild.verificationLevel !== saved.verification) await guild.setVerificationLevel(saved.verification, 'Kalkan panic bitti'); } catch { /* yoksay */ }
      cfg.panic = { active: false, at: 0, by: null, reason: null, saved: null };
      ctx.save();
      await ctx.alert({ guild, level: 'ok', title: 'Panik modu kapatıldı', description: `${restored} kanal eski haline getirildi. Kapatan: ${by}` });
      return { restored };
    },
  };
  ctx.panic = api;

  ctx.router.add(
    new SlashCommandBuilder()
      .setName('panic')
      .setDescription('Acil durum kilidi')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((s) => s
        .setName('ac').setDescription('Sunucuyu kilitle (kanallar, davetler, doğrulama)')
        .addBooleanOption((o) => o.setName('derin').setDescription('Rollerdeki kritik yetkileri de geçici al'))
        .addStringOption((o) => o.setName('sebep').setDescription('Sebep').setMaxLength(200)))
      .addSubcommand((s) => s.setName('kapat').setDescription('Kilidi kaldır (yalnızca bot sahipleri)')),
    async (i) => {
      if (i.options.getSubcommand() === 'ac') {
        if (!ctx.isTrusted(i.guild, i.user.id)) return respond(i, '🔒 Bu komut yalnızca güvenilir kişiler içindir.');
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const r = await api.activate(i.guild, {
          by: `<@${i.user.id}>`, reason: i.options.getString('sebep') || 'Manuel', deep: !!i.options.getBoolean('derin'),
        });
        return respond(i, r.already ? 'ℹ️ Panik modu zaten açık.' : `🛑 Panik modu açıldı. ${r.locked} kanal kilitlendi.`);
      }
      if (!ctx.canAdmin(i.guild, i.user.id)) return respond(i, '🔒 Kilidi yalnızca bot sahipleri kaldırabilir.');
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const r = await api.deactivate(i.guild, `<@${i.user.id}>`);
      return respond(i, r.already ? 'ℹ️ Panik modu zaten kapalı.' : `✅ Panik modu kapatıldı. ${r.restored} kanal eski haline döndü.`);
    },
  );
}

module.exports = { name: 'panic', init, LOCK_PERMS };
