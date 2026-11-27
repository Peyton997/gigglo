'use strict';
// Tuzak kanalı: normal üyeler asla yazmaz; her kanala toplu mesaj atan ele geçirilmiş hesap/bot buraya da yazar.
const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder, InteractionContextType } = require('discord.js');
const { respond, code } = require('../util');

function init(ctx) {
  const { client } = ctx;

  ctx.honeypot = {
    async hit(message, member) {
      const guild = message.guild;
      const uid = member.id;
      await message.delete().catch(() => {});
      ctx.stat(guild.id, 'honeypot');

      // Sunucu sahibi/bot sahibi tuzağa yazdıysa hesabı ele geçirilmiş olabilir; otomatik müdahale edilemez.
      if (guild.ownerId === uid || ctx.isBotOwner(uid)) {
        await ctx.alert({
          guild, level: 'critical', title: 'Tuzak kanalına SAHİP hesabından mesaj yazıldı',
          description: `<@${uid}> tuzak kanalına yazdı. Normal kullanıcı bunu yapmaz; hesap ele geçirilmiş olabilir ya da bu bir testti.`,
          key: `honeypot-owner:${uid}`,
        });
        return;
      }
      const actions = [];
      try {
        if (member.moderatable) {
          await member.timeout(24 * 60 * 60e3, 'Kalkan: tuzak kanalına yazdı');
          actions.push('24 saat susturuldu');
        }
      } catch { /* yetki yetersiz */ }
      const del = await ctx.msgbuf.deleteRecent(guild, uid, 15 * 60e3);
      if (del) actions.push(`${del} mesaj silindi`);
      if (ctx.risk) await ctx.risk.signal(guild, uid, 50, 'Tuzak kanalına yazdı');
      if (ctx.watch) ctx.watch.add(guild.id, uid, { reason: 'Tuzak kanalına yazdı', by: client.user.id, days: 3 });
      await ctx.alert({
        guild, level: 'high', title: 'Tuzak kanalı tetiklendi',
        description: `<@${uid}> (${code(uid)}) tuzak kanalına yazdı.\nAlınan önlemler: ${actions.join(', ') || 'yapılamadı (yetki yetersiz olabilir)'}\n\nGerçek kullanıcıysa \`/uye geri-al\` ve susturmayı kaldırarak serbest bırakabilirsin.`,
        key: `honeypot:${uid}`,
      });
    },
  };

  ctx.router.add(
    new SlashCommandBuilder()
      .setName('honeypot')
      .setDescription('Tuzak kanalı yönetimi')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((s) => s.setName('kur').setDescription('Tuzak kanalını otomatik oluştur'))
      .addSubcommand((s) => s.setName('kaldir').setDescription('Tuzak kanalı kaydını kaldır (kanal silinmez)')),
    async (i) => {
      if (!ctx.canAdmin(i.guild, i.user.id)) return respond(i, '🔒 Bu ayarı yalnızca bot sahipleri değiştirebilir.');
      const cfg = ctx.gcfg(i.guildId);
      if (i.options.getSubcommand() === 'kaldir') {
        cfg.channels.honeypot = [];
        ctx.save();
        return respond(i, '✅ Tuzak kanalı kaydı kaldırıldı.');
      }
      await i.deferReply({ flags: 64 });
      try {
        const ch = await i.guild.channels.create({
          name: 'yazmayin-otomatik-koruma',
          type: ChannelType.GuildText,
          topic: 'DİKKAT: Bu kanala yazma! Yazan hesap güvenlik nedeniyle otomatik susturulur.',
          reason: 'Kalkan: tuzak kanalı',
        });
        await ch.send({
          embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('🍯 Bu kanala YAZMA').setDescription(
            'Bu kanal bir güvenlik tuzağıdır. Buraya yazan her hesap **otomatik olarak 24 saat susturulur**.\nNormal sohbet için diğer kanalları kullan.',
          )],
        }).catch(() => {});
        if (!cfg.channels.honeypot.includes(ch.id)) cfg.channels.honeypot.push(ch.id);
        ctx.save();
        return respond(i, `✅ Tuzak kanalı kuruldu: <#${ch.id}>\nİpucu: kanalı kanal listesinin **en altına** taşı. Kanal herkese açık kalmalı ki ele geçirilmiş hesaplar da görebilsin.`);
      } catch (e) {
        return respond(i, `❌ Kanal oluşturulamadı: ${e.message}`);
      }
    },
  );
}

module.exports = { name: 'honeypot', init };
