'use strict';
// Risk skoru: şüpheli sinyaller birikir (yarı ömür 6 saat). Eşik aşılınca uyarı, yüksek eşikte geri alınabilir önlem.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { criticalList } = require('../util');

function init(ctx) {
  const { client, store } = ctx;
  const lastAlert = new Map();
  const lastContain = new Map();

  const decay = (r) => (r ? Math.max(0, r.score * Math.pow(0.5, (Date.now() - r.at) / (6 * 3600e3))) : 0);

  const api = {
    current(gid, uid) {
      const m = ctx.members.get(gid, uid);
      return Math.round(decay(m && m.risk));
    },

    explain(gid, uid) {
      const m = ctx.members.get(gid, uid);
      return { score: Math.round(decay(m && m.risk)), reasons: (m && m.risk && m.risk.reasons) || [] };
    },

    async signal(guild, userId, points, reason) {
      if (!guild || !userId || (client.user && userId === client.user.id)) return 0;
      const cfg = ctx.gcfg(guild.id);
      if (!cfg.modules.risk) return 0;
      const m = ctx.members.ensure(guild.id, userId);
      const score = Math.min(100, Math.round(decay(m.risk) + points));
      m.risk = { score, at: Date.now(), reasons: [...((m.risk && m.risk.reasons) || []), reason].slice(-8) };
      store.save();

      const now = Date.now();
      if (score >= cfg.risk.containAt) {
        await api.contain(guild, userId, score, m.risk.reasons);
      } else if (score >= cfg.risk.alertAt && now - (lastAlert.get(`${guild.id}:${userId}`) || 0) > 15 * 60e3) {
        lastAlert.set(`${guild.id}:${userId}`, now);
        ctx.stat(guild.id, 'riskAlert');
        await ctx.alert({
          guild, level: 'warn', title: 'Şüpheli davranış (risk skoru yükseldi)',
          description: `<@${userId}> için risk skoru **${score}/100**.`,
          fields: [{ name: 'Gerekçeler', value: m.risk.reasons.map((r) => `• ${r}`).join('\n') }],
        });
      }
      return score;
    },

    // Geri alınabilir müdahale: 1 sa susturma + kritik rolleri alma + son mesajları silme + izlemeye alma.
    async contain(guild, userId, score, reasons) {
      const key = `${guild.id}:${userId}`;
      if (Date.now() - (lastContain.get(key) || 0) < 10 * 60e3) return;
      lastContain.set(key, Date.now());
      const cfg = ctx.gcfg(guild.id);
      const fields = [
        { name: 'Kullanıcı', value: `<@${userId}> (\`${userId}\`)`, inline: true },
        { name: 'Risk skoru', value: `${score}/100`, inline: true },
        { name: 'Gerekçeler', value: reasons.map((r) => `• ${r}`).join('\n') || '-' },
      ];

      if (guild.ownerId === userId || ctx.isBotOwner(userId)) {
        await ctx.alert({
          guild, level: 'critical', title: 'Sahip / bot sahibi hesabında şüpheli davranış',
          description: 'Bu hesaba otomatik müdahale edilemez. Hesap ele geçirilmiş olabilir. Sahip değilsen hemen sahibe ulaş.',
          fields, key: `risk-owner:${userId}`,
        });
        if (cfg.antinuke.ownerPanic && score >= 85 && ctx.panic) {
          await ctx.panic.activate(guild, { by: 'risk', reason: 'Sahip hesabında yüksek risk skoru' }).catch(() => {});
        }
        return;
      }

      const actions = [];
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member) {
        try {
          if (member.moderatable) {
            await member.timeout(60 * 60e3, 'Kalkan: yüksek risk skoru');
            actions.push('1 saat susturuldu');
          }
        } catch { /* yetki yetersiz */ }
        const strip = member.roles.cache.filter((r) => !r.managed && r.id !== guild.id && r.editable && criticalList(r.permissions).length);
        if (strip.size) {
          try {
            await member.roles.remove([...strip.keys()], 'Kalkan: yüksek risk skoru');
            ctx.members.ensure(guild.id, userId).stripped = [...strip.keys()];
            actions.push(`${strip.size} kritik rol alındı`);
          } catch { /* yetki yetersiz */ }
        }
      }
      const del = await ctx.msgbuf.deleteRecent(guild, userId);
      if (del) actions.push(`${del} mesaj silindi`);
      if (ctx.watch) ctx.watch.add(guild.id, userId, { reason: `Otomatik: risk skoru ${score}`, by: client.user.id, days: 3 });
      ctx.stat(guild.id, 'riskContain');
      await ctx.alert({
        guild, level: 'critical', title: 'Hesap ele geçirilmiş olabilir — otomatik önlem alındı',
        description: 'Alınan önlemlerin hepsi geri alınabilir. Karar yetkililerde: gerekirse `/uye geri-al` ile roller iade edilir.',
        fields: [...fields, { name: 'Alınan önlemler', value: actions.join(', ') || 'Yapılamadı (bot yetkisi yetersiz olabilir)' }],
        key: `risk-contain:${userId}`,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`kb:restore:${guild.id}:${userId}`).setLabel('Kullanıcının yetkisini geri yükle').setEmoji('🔓').setStyle(ButtonStyle.Primary),
        )],
      });
    },

    // Otomatik önlemleri geri al: roller, susturma, risk skoru. Üye sunucuda değilse null döner.
    async undo(guild, userId, actor = 'yetkili') {
      const mem = await guild.members.fetch(userId).catch(() => null);
      if (!mem) return null;
      const done = [];
      const n = await api.restoreRoles(guild, userId).catch(() => 0);
      if (n) done.push(`${n} rol iade edildi`);
      if (mem.communicationDisabledUntilTimestamp > Date.now()) {
        try { await mem.timeout(null, `Kalkan: ${actor} geri aldı`); done.push('susturma kaldırıldı'); } catch { done.push('susturma kaldırılamadı (yetki)'); }
      }
      const m = ctx.members.get(guild.id, userId);
      if (m && m.risk && m.risk.score) { m.risk = { score: 0, at: Date.now(), reasons: [] }; store.save(); done.push('risk skoru sıfırlandı'); }
      return done;
    },

    async restoreRoles(guild, userId) {
      const m = ctx.members.get(guild.id, userId);
      const ids = (m && m.stripped) || [];
      if (!ids.length) return 0;
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) return 0;
      const ok = ids.filter((id) => guild.roles.cache.has(id));
      await member.roles.add(ok, 'Kalkan: roller iade edildi').catch(() => {});
      m.stripped = [];
      if (m.risk) m.risk = { score: 0, at: Date.now(), reasons: [] };
      store.save();
      return ok.length;
    },

    // Yönetici/yıkıcı denetim işlemi: olağandışı saat, yeni hesap, yeni katılan.
    async noteAudit(guild, userId, typeName) {
      if (!userId) return;
      const m = ctx.members.get(guild.id, userId);
      if (m && m.n >= 30) {
        const total = m.hours.reduce((a, b) => a + b, 0) || 1;
        if (m.hours[new Date().getUTCHours()] / total < 0.02) {
          await api.signal(guild, userId, 20, `Olağandışı saatte yönetici işlemi (${typeName})`);
        }
      }
      if (m && m.createdAt && Date.now() - m.createdAt < 7 * 864e5) await api.signal(guild, userId, 20, 'Yeni açılmış hesap kritik işlem yaptı');
      if (m && m.joinedAt && Date.now() - m.joinedAt < 48 * 3600e3) await api.signal(guild, userId, 20, 'Yeni katılan üye kritik işlem yaptı');
    },
  };

  ctx.risk = api;
}

module.exports = { name: 'risk', init };
