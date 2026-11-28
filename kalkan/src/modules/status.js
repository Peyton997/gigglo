'use strict';
// /durum, /guvenlik (güvenlik duruşu puanı), /audit, /uye + haftalık rapor.
const os = require('os');
const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, InteractionContextType, PermissionsBitField, MessageFlags } = require('discord.js');
const { respond, truncate, code, fmtDuration, weekKey, toBig, CRIT_MASK } = require('../util');

const NEEDED = [
  ['ViewAuditLog', 'Denetim günlüğünü görüntüle'], ['ManageRoles', 'Rolleri yönet'], ['ManageChannels', 'Kanalları yönet'],
  ['KickMembers', 'Üyeleri at'], ['BanMembers', 'Üyeleri yasakla'], ['ModerateMembers', 'Üyeleri sustur'],
  ['ManageMessages', 'Mesajları yönet'], ['ManageGuild', 'Sunucuyu yönet (davetler)'],
  ['ViewChannel', 'Kanalları gör'], ['SendMessages', 'Mesaj gönder'], ['EmbedLinks', 'Bağlantı yerleştir'], ['AttachFiles', 'Dosya ekle'],
];

const STAT_LABELS = {
  blocked: 'Engellenen mesaj', antinukeTrigger: 'Anti-nuke tetiklenmesi', panic: 'Panik modu', raid: 'Baskın modu', raidJoin: 'Baskın sırasında tutulan üye',
  youngAccount: 'Genç hesap işlemi', impersonation: 'Taklit uyarısı', honeypot: 'Bal küpü yakalaması', riskAlert: 'Risk uyarısı', riskContain: 'Otomatik müdahale',
  roleGuardRevert: 'Geri alınan rol değişikliği', botKick: 'Atılan yetkisiz bot', blocklistHit: 'Kara liste eşleşmesi', watchAdd: 'İzlemeye alınan', watchRisky: 'İzlenenden riskli dosya',
  reports: 'Kullanıcı ihbarı', verified: 'Doğrulanan üye', backup: 'Alınan yedek', jitGrant: 'Süreli yetki verildi',
};

function init(ctx) {
  const { client, env, store, log } = ctx;
  const startedAt = Date.now();

  /* ------------------------------------------------------------ güvenlik duruşu */
  // Her madde: { w: ağırlık, ok: true|false|null(uygulanamaz), msg: öneri }
  async function posture(guild) {
    const cfg = ctx.gcfg(guild.id);
    const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
    const checks = [];
    const add = (name, w, ok, tip) => checks.push({ name, w, ok, tip });

    // Bot yetkileri ve rol sırası
    const perms = me ? me.permissions : new PermissionsBitField();
    const admin = perms.has(PermissionFlagsBits.Administrator);
    const missing = NEEDED.filter(([p]) => !admin && !perms.has(PermissionFlagsBits[p])).map(([, t]) => t);
    add('Bot yetkileri', 12, !missing.length, `Botta eksik yetki var: ${missing.join(', ')}.`);
    if (me) {
      const above = guild.roles.cache.filter((r) => r.position > me.roles.highest.position && !r.managed && r.id !== guild.id);
      const strong = above.filter((r) => toBig(r.permissions) & CRIT_MASK);
      add('Bot rolü yeterince yüksekte', 8, strong.size === 0,
        `${strong.size} yetkili rol botun üstünde (${strong.first() ? strong.first().name : ''}…). Bot rolünü sürükleyip en üste yakın bir yere koy; yoksa bu rollere müdahale edemez.`);
    }

    // @everyone ve yönetici sayısı
    const everyoneCrit = toBig(guild.roles.everyone.permissions) & CRIT_MASK;
    add('@everyone tehlikeli yetki içermiyor', 10, !everyoneCrit, '@everyone rolünde kritik yetki var (yönetici, rol/kanal yönetimi, atma/yasaklama…). Hemen kaldır.');
    const adminHumans = guild.members.cache.filter((m) => !m.user.bot && m.permissions.has(PermissionFlagsBits.Administrator) && m.id !== guild.ownerId);
    add('Yönetici sayısı makul', 6, adminHumans.size <= 3, `${adminHumans.size} kişide Yönetici yetkisi var. Gerçekten gerekenle sınırla; geri kalanına süreli yetki (/yetki) kullan.`);
    const adminBots = guild.members.cache.filter((m) => m.user.bot && m.id !== client.user.id && m.permissions.has(PermissionFlagsBits.Administrator));
    add('Başka botlarda Yönetici yok', 6, adminBots.size === 0, `${adminBots.size} botta Yönetici yetkisi var (${adminBots.map((m) => m.user.username).slice(0, 3).join(', ')}). Gerekli yetkilerle değiştir.`);

    // Sunucu ayarları
    add('Yetkili işlemler için 2FA zorunlu', 8, guild.mfaLevel === 1, 'Sunucu Ayarları → Güvenlik: "Moderatörler için 2FA gerektir" seçeneğini aç (yalnızca sunucu sahibi açabilir).');
    add('Doğrulama seviyesi', 4, guild.verificationLevel >= 2, 'Doğrulama seviyesini en az "Orta" yap.');
    add('Uygunsuz içerik filtresi', 3, guild.explicitContentFilter >= 2, 'Tüm üyelerin medyasını tara seçeneğini aç.');

    // Kalkan ayarları
    add('Uyarı/log kanalı', 8, !!(cfg.channels.alert || cfg.channels.log), 'Uyarı kanalı yok: /ayar kanal ile belirle (yalnızca yetkililerin gördüğü bir kanal).');
    add('Anti-nuke açık', 8, !!cfg.modules.antinuke, 'Anti-nuke kapalı: /ayar modul ile aç.');
    add('Rol koruması açık', 4, !!cfg.modules.roleGuard, 'Rol koruması kapalı.');
    const last = ctx.backup ? ctx.backup.list(guild.id).slice(-1)[0] : null;
    add('Yakın tarihli yedek', 7, !!last && Date.now() - last.at < Math.max(cfg.backup.intervalHours, 1) * 3 * 3600e3, last ? `Son yedek ${fmtDuration(Date.now() - last.at)} önce. /yedek al ile yenile.` : 'Hiç yedek yok. /yedek al çalıştır.');
    add('Bal küpü kanalı', 3, cfg.channels.honeypot.length > 0, 'Bal küpü kanalı yok: /honeypot ile kur (sahte kanal, yazan otomatik yakalanır).');
    add('Doğrulama kapısı', 4, !!cfg.raid.unverifiedRoleId, '/dogrulama kur ile yeni üyeleri doğrulama kanalına yönlendir.');
    add('Güvenilir liste küçük', 3, cfg.trusted.length <= 5, `Güvenilir listede ${cfg.trusted.length} kişi var; bu hesaplar anti-nuke'tan muaf. Sayıyı azalt.`);

    // İki anahtarlı kurtarma
    add('Yedek sahip(ler) tanımlı', 6, env.backupOwnerIds.length > 0, '.env içinde BACKUP_OWNER_IDS yok: ikinci anahtar olmadan kurtarma tek hesaba bağlı.');
    add('Yedek sunucu tanımlı', 6, !!cfg.recovery.backupGuildId, 'Yedek sunucu yok: /kurtarma hedef ile ekle (sunucu silinirse üyelere buradan haber verilir).');

    const total = checks.reduce((a, c) => a + c.w, 0);
    const got = checks.reduce((a, c) => a + (c.ok ? c.w : 0), 0);
    return { score: Math.round((got / total) * 100), checks };
  }

  function grade(score) {
    if (score >= 90) return { label: 'Çok güçlü', color: 0x2ecc71, icon: '🟢' };
    if (score >= 75) return { label: 'İyi', color: 0x2ecc71, icon: '🟢' };
    if (score >= 55) return { label: 'Orta', color: 0xf1c40f, icon: '🟡' };
    return { label: 'Zayıf', color: 0xe74c3c, icon: '🔴' };
  }

  /* ------------------------------------------------------------ haftalık rapor */
  async function weekly(guild, force = false) {
    const cfg = ctx.gcfg(guild.id);
    if (!force && (!cfg.modules.weeklyReport || Date.now() - (cfg.report.lastAt || 0) < 7 * 864e5 - 3600e3)) return false;
    const all = store.data.stats[guild.id] || {};
    const keys = Object.keys(all).sort();
    const cur = weekKey();
    const wk = force ? (all[cur] ? cur : keys[keys.length - 1]) : [...keys].reverse().find((k) => k !== cur);
    const stats = (wk && all[wk]) || {};
    const lines = Object.entries(stats).sort((a, b) => b[1] - a[1]).map(([k, v]) => {
      const [base, sub] = k.split(':');
      return `• ${STAT_LABELS[base] || base}${sub ? ` (${sub})` : ''}: **${v}**`;
    });
    const p = await posture(guild).catch(() => null);
    const embed = new EmbedBuilder().setColor(0x3498db).setTitle(`📊 Haftalık güvenlik raporu${wk ? ` — ${wk}` : ''}`).setTimestamp()
      .setDescription(lines.length ? truncate(lines.join('\n'), 3500) : 'Bu hafta kayda değer bir olay yok. 🎉');
    if (p) embed.addFields({ name: 'Güvenlik duruşu', value: `${grade(p.score).icon} **${p.score}/100** — ${grade(p.score).label}\n\`/guvenlik\` ile ayrıntıları gör.` });
    await ctx.logEmbed(guild, embed, 'log');
    cfg.report.lastAt = Date.now();
    ctx.save();
    return true;
  }

  ctx.status = { posture, weekly };
  ctx.every(6 * 3600e3, async () => {
    for (const g of client.guilds.cache.values()) await weekly(g).catch((e) => log.error('haftalık rapor:', e));
  }, 'haftalık rapor');

  /* ------------------------------------------------------------ /durum */
  const MODULES = [
    ['members', 'Üye kaydı'], ['risk', 'Risk skoru'], ['antinuke', 'Anti-nuke'], ['panic', 'Panik'], ['raid', 'Baskın/doğrulama'], ['backup', 'Yedekleme'],
    ['recovery', 'Kurtarma'], ['oauth', 'Hesap bağlama'], ['jit', 'Süreli yetki'], ['watch', 'İzleme'], ['blocklist', 'Kara liste'], ['incident', 'Olay analizi'],
  ];

  ctx.router.add(
    new SlashCommandBuilder().setName('durum').setDescription('Botun çalışma durumu ve modüller')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setContexts(InteractionContextType.Guild),
    async (i) => {
      const guild = i.guild;
      const cfg = ctx.gcfg(guild.id);
      const me = guild.members.me;
      const mem = process.memoryUsage();
      const mods = MODULES.map(([k, t]) => `${ctx[k] ? '✅' : '❌'} ${t}`).join('\n');
      const last = ctx.backup ? ctx.backup.list(guild.id).slice(-1)[0] : null;
      const miss = me ? NEEDED.filter(([p]) => !me.permissions.has(PermissionFlagsBits[p]) && !me.permissions.has(PermissionFlagsBits.Administrator)).map(([, t]) => t) : [];
      const embed = new EmbedBuilder().setColor(miss.length ? 0xf1c40f : 0x2ecc71).setTitle(`🛡️ ${env.botName} durumu`).setTimestamp()
        .addFields(
          { name: 'Çalışma', value: `Açık kalma: ${fmtDuration(Date.now() - startedAt)}\nGecikme: ${Math.round(client.ws.ping)} ms\nBellek: ${(mem.rss / 1048576).toFixed(0)} MB • Node ${process.versions.node}\nSistem: ${os.platform()} ${os.arch()}`, inline: true },
          { name: 'Kayıtlar', value: `Sunucu: ${client.guilds.cache.size}\nÜye kaydı: ${ctx.members ? ctx.members.count(guild.id) : 0}\nBağlı hesap (OAuth): ${ctx.oauth ? ctx.oauth.count(guild.id) : 0}\nİzlenen: ${ctx.watch ? ctx.watch.list(guild.id).length : 0}\nKara liste: ${ctx.blocklist ? ctx.blocklist.counts().users : 0} kişi`, inline: true },
          { name: 'Durum', value: `Panik: ${cfg.panic.active ? '🛑 AÇIK' : 'kapalı'}\nBaskın: ${ctx.raid && ctx.raid.isRaid(guild.id) ? '🚨 AKTİF' : 'yok'}\nSon yedek: ${last ? `<t:${Math.floor(last.at / 1000)}:R>` : 'yok'}\nGece modu: ${cfg.night.enabled ? 'açık' : 'kapalı'}`, inline: true },
          { name: 'Modüller', value: mods, inline: false },
        );
      if (miss.length) embed.addFields({ name: '⚠️ Eksik bot yetkileri', value: truncate(miss.join(', '), 1000) });
      return respond(i, { embeds: [embed] });
    },
  );

  /* ------------------------------------------------------------ /guvenlik */
  ctx.router.add(
    new SlashCommandBuilder().setName('guvenlik').setDescription('Sunucunun güvenlik duruşu: puan ve öneriler')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setContexts(InteractionContextType.Guild),
    async (i) => {
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const p = await posture(i.guild);
      const g = grade(p.score);
      const bad = p.checks.filter((c) => !c.ok).sort((a, b) => b.w - a.w);
      const good = p.checks.filter((c) => c.ok);
      const embed = new EmbedBuilder().setColor(g.color).setTitle(`${g.icon} Güvenlik puanı: ${p.score}/100 — ${g.label}`).setTimestamp();
      embed.setDescription(bad.length
        ? truncate(bad.slice(0, 8).map((c) => `❌ **${c.name}** _(önem ${c.w})_\n${c.tip}`).join('\n\n'), 3800)
        : 'Kontrol ettiğim her şey yolunda. 🎉');
      if (good.length) embed.addFields({ name: `Tamam (${good.length})`, value: truncate(good.map((c) => `✅ ${c.name}`).join('\n'), 1000) });
      embed.setFooter({ text: 'Puan yalnızca botun görebildiği ayarlara dayanır; Discord dışı riskleri (cihaz güvenliği, mod/dosya) ölçmez.' });
      return respond(i, { embeds: [embed] });
    },
  );

  /* ------------------------------------------------------------ /audit */
  ctx.router.add(
    new SlashCommandBuilder().setName('audit').setDescription('Kalkan olay kayıtları')
      .setDefaultMemberPermissions(PermissionFlagsBits.ViewAuditLog).setContexts(InteractionContextType.Guild)
      .addSubcommand((s) => s.setName('son').setDescription('Son kayıtları göster')
        .addIntegerOption((o) => o.setName('adet').setDescription('Kaç kayıt? (varsayılan 15)').setMinValue(1).setMaxValue(30))
        .addUserOption((o) => o.setName('kullanici').setDescription('Yalnızca bu kişiyle ilgili'))),
    async (i) => {
      const n = i.options.getInteger('adet') || 15;
      const u = i.options.getUser('kullanici');
      let ev = ctx.events.read(i.guild.id, { since: Date.now() - 7 * 864e5, limit: 4000 }).filter((e) => !String(e.type).startsWith('WATCH_'));
      if (u) ev = ev.filter((e) => e.actor === u.id || e.target === u.id);
      ev = ev.slice(-n).reverse();
      if (!ev.length) return respond(i, 'ℹ️ Kayıt bulunamadı.');
      const lines = ev.map((e) => `<t:${Math.floor(e.t / 1000)}:R> **${e.type}**${e.actor ? ` <@${e.actor}>` : ''}${e.target && e.target !== e.actor ? ` → ${code(e.target)}` : ''}${e.name ? ` ${truncate(String(e.name).replace(/\n/g, ' '), 50)}` : ''}`);
      return respond(i, truncate(lines.join('\n'), 1950));
    },
  );

  /* ------------------------------------------------------------ /uye */
  ctx.router.add(
    new SlashCommandBuilder().setName('uye').setDescription('Üye kaydı ve geri alma')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers).setContexts(InteractionContextType.Guild)
      .addSubcommand((s) => s.setName('bilgi').setDescription('Üyenin Kalkan kaydını göster')
        .addUserOption((o) => o.setName('kullanici').setDescription('Üye').setRequired(true)))
      .addSubcommand((s) => s.setName('geri-al').setDescription('Otomatik alınan önlemleri geri al (roller, susturma, risk skoru)')
        .addUserOption((o) => o.setName('kullanici').setDescription('Üye').setRequired(true))),
    async (i) => {
      const guild = i.guild;
      const sub = i.options.getSubcommand();
      const u = i.options.getUser('kullanici', true);
      const m = ctx.members.get(guild.id, u.id);
      if (sub === 'bilgi') {
        const risk = ctx.risk ? ctx.risk.explain(guild.id, u.id) : { score: 0, reasons: [] };
        const mem = guild.members.cache.get(u.id) || (await guild.members.fetch(u.id).catch(() => null));
        const embed = new EmbedBuilder().setColor(risk.score >= 40 ? 0xe67e22 : 0x3498db).setTitle(`👤 ${truncate(u.username, 60)}`).setThumbnail(u.displayAvatarURL({ size: 128 }))
          .addFields(
            { name: 'Kimlik', value: `${code(u.id)}${u.bot ? ' • 🤖 bot' : ''}`, inline: true },
            { name: 'Hesap yaşı', value: `<t:${Math.floor(u.createdTimestamp / 1000)}:R>`, inline: true },
            { name: 'Sunucuya katıldı', value: mem && mem.joinedTimestamp ? `<t:${Math.floor(mem.joinedTimestamp / 1000)}:R>` : m && m.left ? `Ayrıldı <t:${Math.floor(m.left / 1000)}:R>` : 'bilinmiyor', inline: true },
            { name: 'Etkinlik', value: m ? `${m.msgs} mesaj • ${m.links} link • ${m.files} dosya` : 'kayıt yok', inline: true },
            { name: 'Risk skoru', value: `${risk.score}/100${risk.reasons.length ? `\n${truncate(risk.reasons.slice(-4).map((r) => `• ${r}`).join('\n'), 400)}` : ''}`, inline: true },
            { name: 'Durum', value: [
              ctx.watch && ctx.watch.isActive(guild.id, u.id) ? '👁 izleniyor' : null,
              ctx.blocklist && ctx.blocklist.check(u.id) ? '⛔ kara listede' : null,
              ctx.oauth && ctx.oauth.has(u.id) ? '🔗 hesap bağlı' : null,
              m && m.verified ? '✅ doğrulandı' : null,
              mem && mem.communicationDisabledUntilTimestamp > Date.now() ? '🔇 susturulmuş' : null,
              m && m.stripped && m.stripped.length ? `🔒 ${m.stripped.length} rolü alınmış` : null,
            ].filter(Boolean).join('\n') || 'normal', inline: true },
          );
        return respond(i, { embeds: [embed] });
      }
      // geri-al
      if (!ctx.isTrusted(guild, i.user.id)) return respond(i, '🔒 Bu işlem yalnızca güvenilir yetkililer içindir.');
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const done = ctx.risk ? await ctx.risk.undo(guild, u.id, i.user.username) : [];
      if (done === null) return respond(i, 'ℹ️ Üye sunucuda değil.');
      ctx.events.append(guild.id, { type: 'UNDO', actor: i.user.id, target: u.id });
      await ctx.alert({ guild, level: 'info', title: 'Önlemler geri alındı', description: `<@${i.user.id}>, <@${u.id}> için otomatik önlemleri geri aldı.\n${done.join(', ') || 'Geri alınacak bir şey yoktu.'}` });
      return respond(i, done.length ? `✅ ${done.join(', ')}.` : 'ℹ️ Geri alınacak bir şey yoktu.');
    },
  );
}

module.exports = { name: 'status', init, NEEDED, STAT_LABELS };
