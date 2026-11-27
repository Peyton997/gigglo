'use strict';
// Baskın (raid) koruması: yeni hesap kapısı, toplu giriş tespiti, doğrulama kapısı, davet takibi, taklit hesap uyarısı.
const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  Events, InteractionContextType, MessageFlags,
} = require('discord.js');
const { respond, chunk, code, fmtDuration, parseDuration, unixRel, sleep } = require('../util');

/* ------------------------------------------------------------ isim benzerliği (taklit tespiti) */
const CONFUSABLE = {
  '0': 'o', '1': 'i', 'l': 'i', '|': 'i', '!': 'i', 'ı': 'i', 'і': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's',
  'о': 'o', 'а': 'a', 'е': 'e', 'р': 'p', 'с': 'c', 'х': 'x', 'у': 'y', 'ѕ': 's', 'ј': 'j',
  // Kiril ve Yunan'dan Latin'e benzeyen ek harfler (küçük harfe çevrildikten sonra)
  'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'ɡ': 'g', 'һ': 'h', 'к': 'k', 'м': 'm', 'н': 'h', 'т': 't', 'в': 'b', 'ѵ': 'v',
  'α': 'a', 'β': 'b', 'ε': 'e', 'ζ': 'z', 'η': 'n', 'ι': 'i', 'κ': 'k', 'μ': 'm', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'γ': 'y',
};

// "Ad_min", "adm1n", "Аdmin" (Kiril A) gibi yazımları aynı biçime indirger.
function normName(s) {
  const base = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  let out = '';
  for (const ch of base) out += CONFUSABLE[ch] ?? ch;
  return out.replace(/[^a-z0-9]/g, '');
}

const ACTIONS_NEW = new Set(['off', 'flag', 'timeout', 'kick']);

function init(ctx) {
  const { client, log, store } = ctx;
  const joinLog = new Map(); // gid -> [{ t, id }]
  const inviteCache = new Map(); // gid -> Map(code -> { uses, inviterId })
  const farm = new Map(); // gid:code -> [{ t, young }]
  const staffCache = new Map(); // gid -> { at, map }
  const verifyCool = new Map();

  const isRaid = (gid) => {
    const r = ctx.gcfg(gid).raid;
    return !!(r.active && r.until > Date.now());
  };

  /* ------------------------------------------------------------ davet takibi */
  async function snapshotInvites(guild) {
    try {
      const invs = await guild.invites.fetch();
      const m = new Map();
      for (const inv of invs.values()) m.set(inv.code, { uses: inv.uses || 0, inviterId: inv.inviterId || (inv.inviter && inv.inviter.id) || null });
      inviteCache.set(guild.id, m);
      return m;
    } catch {
      return null; // "Sunucuyu Yönet" yetkisi yok
    }
  }

  async function detectInvite(guild) {
    const before = inviteCache.get(guild.id);
    const after = await snapshotInvites(guild);
    if (!before || !after) return null;
    for (const [c, v] of after) {
      const b = before.get(c);
      if ((b ? b.uses : 0) < v.uses) return { code: c, inviterId: v.inviterId };
    }
    const gone = [...before.entries()].filter(([c]) => !after.has(c));
    if (gone.length === 1) return { code: gone[0][0], inviterId: gone[0][1].inviterId, gone: true };
    return null;
  }

  /* ------------------------------------------------------------ yetkili isimleri */
  function staffNames(guild) {
    const hit = staffCache.get(guild.id);
    if (hit && Date.now() - hit.at < 5 * 60e3) return hit.map;
    const map = new Map();
    const add = (m) => {
      for (const n of [m.user.username, m.user.globalName, m.displayName]) {
        const k = normName(n);
        if (k.length >= 4 && !map.has(k)) map.set(k, m.id);
      }
    };
    const owner = guild.members.cache.get(guild.ownerId);
    if (owner) add(owner);
    for (const m of guild.members.cache.values()) {
      if (m.user.bot) continue;
      if (ctx.isTrusted(guild, m.id) || m.permissions.has(PermissionFlagsBits.ManageGuild)) add(m);
    }
    staffCache.set(guild.id, { at: Date.now(), map });
    return map;
  }

  async function checkImpersonation(member) {
    const guild = member.guild;
    const cfg = ctx.gcfg(guild.id);
    if (cfg.raid.impersonation === 'off' || member.user.bot || ctx.isExempt(guild, member)) return;
    const staff = staffNames(guild);
    let hitId = null;
    let hitName = null;
    for (const n of [member.user.username, member.user.globalName, member.displayName]) {
      const k = normName(n);
      const sid = k.length >= 4 ? staff.get(k) : null;
      if (sid && sid !== member.id) { hitId = sid; hitName = n; break; }
    }
    if (!hitId) return;
    const actions = [];
    if (cfg.raid.impersonation === 'timeout' && member.moderatable) {
      await member.timeout(60 * 60e3, 'Kalkan: yetkili taklidi').then(() => actions.push('1 saat susturuldu')).catch(() => {});
    } else if (cfg.raid.impersonation === 'kick' && member.kickable) {
      await member.kick('Kalkan: yetkili taklidi').then(() => actions.push('sunucudan atıldı')).catch(() => {});
    }
    if (ctx.risk) await ctx.risk.signal(guild, member.id, 25, 'Yetkili ismini taklit ediyor');
    ctx.stat(guild.id, 'impersonation');
    await ctx.alert({
      guild, level: 'high', title: 'Yetkili taklidi şüphesi',
      description: `<@${member.id}> (\`${hitName}\`) ismi, <@${hitId}> yetkilisinin ismine çok benziyor.${actions.length ? `\nAlınan önlem: ${actions.join(', ')}` : ''}\nGerçek yetkili olup olmadığını **başka bir kanaldan** doğrula.`,
      key: `imp:${member.id}`,
    });
  }

  /* ------------------------------------------------------------ baskın modu */
  const raidApi = {
    isRaid,
    async activate(guild, reason, minutes) {
      const cfg = ctx.gcfg(guild.id);
      const was = isRaid(guild.id);
      const mins = Math.max(1, Math.min(minutes || cfg.raid.raidMinutes, 720));
      cfg.raid.active = true;
      cfg.raid.until = Math.max(cfg.raid.until || 0, Date.now() + mins * 60e3);
      ctx.save();
      if (was) return { already: true };
      ctx.stat(guild.id, 'raid');
      const actions = [];
      // Son pencere içinde katılanları geriye dönük tut.
      const recent = (joinLog.get(guild.id) || []).filter((j) => Date.now() - j.t < cfg.raid.joinWindowSec * 1000 * 2);
      let held = 0;
      for (const grp of chunk(recent, 5)) {
        await Promise.all(grp.map(async (j) => {
          const m = guild.members.cache.get(j.id) || await guild.members.fetch(j.id).catch(() => null);
          if (m && await hold(guild, m)) held++;
        }));
      }
      if (held) actions.push(`${held} yeni üye ${cfg.raid.raidTimeoutMinutes} dk süreyle susturuldu`);
      await ctx.alert({
        guild, level: 'high', title: 'BASKIN MODU AÇILDI',
        description: `Sebep: ${reason}\nSüre: ${fmtDuration(mins * 60e3)}\nBu sürede katılan herkes ${cfg.raid.raidTimeoutMinutes} dk susturulur.${actions.length ? `\n${actions.join('\n')}` : ''}\n\nBittiğinde: \`/raid birak\` (gerçek üyeleri serbest bırakır) veya \`/raid at\` (hepsini atar).`,
        key: 'raid-on',
      });
      return { held };
    },
    async deactivate(guild, by = 'süre doldu') {
      const cfg = ctx.gcfg(guild.id);
      if (!cfg.raid.active) return false;
      cfg.raid.active = false;
      cfg.raid.until = 0;
      ctx.save();
      await ctx.alert({
        guild, level: 'ok', title: 'Baskın modu kapandı',
        description: `Kapatan: ${by}\nTutulan üye sayısı: **${cfg.raid.held.length}** — gerçek üyeleri bırakmak için \`/raid birak\`, hepsini atmak için \`/raid at\`.`,
      });
      return true;
    },
    async markVerified(guild, userId, via = 'buton') {
      const cfg = ctx.gcfg(guild.id);
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) return false;
      let changed = false;
      const un = cfg.raid.unverifiedRoleId;
      if (un && member.roles.cache.has(un)) {
        await member.roles.remove(un, `Kalkan: doğrulandı (${via})`).catch(() => {});
        changed = true;
      }
      const ver = cfg.raid.verifiedRoleId;
      if (ver && guild.roles.cache.has(ver) && !member.roles.cache.has(ver)) {
        await member.roles.add(ver, `Kalkan: doğrulandı (${via})`).catch(() => {});
        changed = true;
      }
      const reg = ctx.members.ensure(guild.id, userId);
      if (!reg.verified) { reg.verified = { at: Date.now(), via }; changed = true; }
      store.save();
      if (changed) ctx.stat(guild.id, 'verified');
      return changed;
    },
    refreshInvites: (guild) => snapshotInvites(guild),
    normName,
  };
  ctx.raid = raidApi;

  // Baskın sırasında gelen üyeyi tutar (susturur ve listeye yazar).
  async function hold(guild, member) {
    const cfg = ctx.gcfg(guild.id);
    if (member.user.bot || ctx.isTrusted(guild, member.id)) return false;
    let ok = false;
    try {
      if (member.moderatable) {
        await member.timeout(cfg.raid.raidTimeoutMinutes * 60e3, 'Kalkan: baskın modu');
        ok = true;
      }
    } catch { /* yetki yetersiz */ }
    if (!cfg.raid.held.includes(member.id)) {
      cfg.raid.held.push(member.id);
      while (cfg.raid.held.length > 500) cfg.raid.held.shift();
      ctx.save();
    }
    return ok;
  }

  /* ------------------------------------------------------------ katılma */
  async function onJoin(member) {
    const guild = member.guild;
    const cfg = ctx.gcfg(guild.id);
    const reg = ctx.members.upsert(member);
    if (member.user.bot || !cfg.modules.raid) return;

    const now = Date.now();
    const list = (joinLog.get(guild.id) || []).filter((j) => now - j.t < 5 * 60e3);
    list.push({ t: now, id: member.id });
    joinLog.set(guild.id, list);

    // Davet takibi (aşırı yoğunlukta atlanır: her katılma 1 API isteği demek)
    let inv = null;
    if (list.filter((j) => now - j.t < 10e3).length <= 5) inv = await detectInvite(guild).catch(() => null);
    if (inv) {
      reg.inviter = inv.inviterId;
      reg.invite = inv.code;
      store.save();
    }

    const ageDays = (now - member.user.createdTimestamp) / 864e5;
    const young = ageDays < cfg.raid.minAccountAgeDays;

    // Doğrulama kapısı
    if (cfg.raid.unverifiedRoleId && guild.roles.cache.has(cfg.raid.unverifiedRoleId)) {
      await member.roles.add(cfg.raid.unverifiedRoleId, 'Kalkan: doğrulama bekliyor').catch(() => {});
    }

    // Baskın tespiti
    let th = cfg.raid.joinThreshold;
    if (ctx.isNight(guild.id)) th = Math.max(3, Math.floor(th / 2));
    const inWindow = list.filter((j) => now - j.t < cfg.raid.joinWindowSec * 1000).length;
    if (!isRaid(guild.id) && inWindow >= th) {
      await raidApi.activate(guild, `${cfg.raid.joinWindowSec} sn içinde ${inWindow} kişi katıldı`);
    }
    if (isRaid(guild.id)) {
      await hold(guild, member);
      ctx.stat(guild.id, 'raidJoin');
    }

    // Yeni hesap kapısı
    if (young && cfg.raid.newAccountAction !== 'off' && !isRaid(guild.id)) {
      const act = cfg.raid.newAccountAction;
      const label = `${ageDays < 1 ? `${Math.max(1, Math.round(ageDays * 24))} saatlik` : `${Math.floor(ageDays)} günlük`} hesap`;
      if (act === 'timeout' && member.moderatable) {
        await member.timeout(60 * 60e3, 'Kalkan: çok yeni hesap').catch(() => {});
      } else if (act === 'kick' && member.kickable) {
        await Promise.race([
          ctx.dm(member.id, `**${guild.name}** sunucusuna giremedin: hesabın ${cfg.raid.minAccountAgeDays} günden yeni. Birkaç gün sonra tekrar deneyebilirsin.`),
          sleep(4000),
        ]);
        await member.kick('Kalkan: çok yeni hesap').catch(() => {});
      }
      if (ctx.risk) await ctx.risk.signal(guild, member.id, 15, `Çok yeni hesap (${label})`);
      ctx.stat(guild.id, 'youngAccount');
      await ctx.logEmbed(guild, new EmbedBuilder().setColor(0xf1c40f).setTitle('Yeni hesap katıldı')
        .setDescription(`<@${member.id}> (${code(member.user.username)}) — ${label}\nİşlem: ${act === 'flag' ? 'yalnızca işaretlendi' : act}`));
    }

    // Davet çiftliği: aynı davetle çok sayıda yeni hesap
    if (inv) {
      const k = `${guild.id}:${inv.code}`;
      const arr = (farm.get(k) || []).filter((x) => now - x.t < 15 * 60e3);
      arr.push({ t: now, young: ageDays < 7 });
      farm.set(k, arr);
      const youngCount = arr.filter((x) => x.young).length;
      if (youngCount >= cfg.raid.inviteFarmCount) {
        await ctx.alert({
          guild, level: 'warn', title: 'Davet çiftliği şüphesi',
          description: `\`${inv.code}\` davetiyle 15 dk içinde **${youngCount}** yeni hesap (7 günden genç) katıldı.${inv.inviterId ? `\nDaveti oluşturan: <@${inv.inviterId}>` : ''}`,
          key: `farm:${inv.code}`,
        });
      }
    }

    await checkImpersonation(member);
  }

  client.on(Events.GuildMemberAdd, (m) => { onJoin(m).catch((e) => log.error('katılma işleme hatası:', e)); });
  client.on(Events.GuildMemberUpdate, (oldM, newM) => {
    if (oldM.displayName === newM.displayName && oldM.user.username === newM.user.username) return;
    staffCache.delete(newM.guild.id);
    if (ctx.gcfg(newM.guild.id).modules.raid) checkImpersonation(newM).catch(() => {});
  });
  client.on(Events.InviteCreate, (inv) => { if (inv.guild && client.guilds.cache.get(inv.guild.id)) snapshotInvites(client.guilds.cache.get(inv.guild.id)); });
  client.on(Events.InviteDelete, (inv) => { if (inv.guild && client.guilds.cache.get(inv.guild.id)) snapshotInvites(client.guilds.cache.get(inv.guild.id)); });

  // Doğrulama kapısı açıkken yeni açılan kanallar da kapalı olsun.
  client.on(Events.ChannelCreate, (ch) => {
    try {
      if (!ch.guild || !ch.permissionOverwrites) return;
      const cfg = ctx.gcfg(ch.guild.id);
      const rid = cfg.raid.unverifiedRoleId;
      if (!rid || ch.id === cfg.raid.verifyChannelId || !ch.guild.roles.cache.has(rid)) return;
      ch.permissionOverwrites.edit(rid, { ViewChannel: false }, { reason: 'Kalkan: doğrulama kapısı' }).catch(() => {});
    } catch { /* yoksay */ }
  });

  ctx.every(30e3, async () => {
    for (const guild of client.guilds.cache.values()) {
      const r = ctx.gcfg(guild.id).raid;
      if (r.active && r.until <= Date.now()) await raidApi.deactivate(guild);
    }
    const now = Date.now();
    for (const [gid, arr] of joinLog) {
      const kept = arr.filter((j) => now - j.t < 5 * 60e3);
      if (kept.length) joinLog.set(gid, kept); else joinLog.delete(gid);
    }
    for (const [k, arr] of farm) {
      const kept = arr.filter((x) => now - x.t < 15 * 60e3);
      if (kept.length) farm.set(k, kept); else farm.delete(k);
    }
    for (const [k, t] of verifyCool) if (now - t > 60e3) verifyCool.delete(k);
  }, 'raid');

  /* ------------------------------------------------------------ doğrulama düğmesi */
  ctx.router.button('verify:', async (i) => {
    if (!i.guild) return;
    if (i.customId === 'verify:oauth') {
      const link = ctx.oauth && ctx.oauth.personalLink ? ctx.oauth.personalLink(i.guildId, i.user.id) : null;
      if (!link) return respond(i, 'ℹ️ Hesapla doğrulama şu an kapalı. Lütfen **Doğrula** düğmesini kullan.');
      return respond(i, [
        '🔐 **Hesapla doğrulama**',
        `1) Şu bağlantıyı aç ve izin ver: ${link}`,
        ctx.oauth.mode() === 'manual' ? '2) Sayfada görünen **kodu** kopyalayıp bu sunucuda `/hesap kod` komutuna yapıştır.' : '2) İşlem bitince otomatik doğrulanırsın.',
        'Şifren istenmez, mesajların okunmaz. Verilerini istediğin an `/hesap sil` ile silebilirsin.',
      ].join('\n'));
    }
    if (i.customId !== 'verify:basic') return;
    const now = Date.now();
    if (now - (verifyCool.get(i.user.id) || 0) < 3000) return respond(i, '⏳ Biraz yavaş :)');
    verifyCool.set(i.user.id, now);
    if (isRaid(i.guildId)) {
      return respond(i, '🛡️ Sunucu şu an baskın koruması altında; doğrulama geçici olarak durdu. Birkaç dakika sonra tekrar dene.');
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const changed = await raidApi.markVerified(i.guild, i.user.id, 'buton');
    return respond(i, changed ? '✅ Doğrulandın, hoş geldin!' : '✅ Zaten doğrulanmışsın.');
  });

  /* ------------------------------------------------------------ komutlar */
  ctx.router.add(
    new SlashCommandBuilder()
      .setName('raid')
      .setDescription('Baskın (raid) koruması')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((s) => s.setName('durum').setDescription('Baskın koruması durumunu göster'))
      .addSubcommand((s) => s.setName('ac').setDescription('Baskın modunu elle aç')
        .addStringOption((o) => o.setName('sure').setDescription('Süre (örn. 30dk, 2sa). Varsayılan: ayardaki süre').setMaxLength(20)))
      .addSubcommand((s) => s.setName('kapat').setDescription('Baskın modunu kapat'))
      .addSubcommand((s) => s.setName('birak').setDescription('Baskın sırasında tutulan üyelerin susturmasını kaldır'))
      .addSubcommand((s) => s.setName('at').setDescription('Baskın sırasında tutulan tüm üyeleri at (yalnızca bot sahipleri)')),
    async (i) => {
      const sub = i.options.getSubcommand();
      const guild = i.guild;
      const cfg = ctx.gcfg(guild.id);
      if (sub === 'durum') {
        const active = isRaid(guild.id);
        const recent = (joinLog.get(guild.id) || []).filter((j) => Date.now() - j.t < 60e3).length;
        const e = new EmbedBuilder().setColor(active ? 0xe74c3c : 0x2ecc71).setTitle(active ? '🚨 Baskın modu AÇIK' : '🛡️ Baskın modu kapalı')
          .addFields(
            { name: 'Son 1 dk giriş', value: String(recent), inline: true },
            { name: 'Tutulan üye', value: String(cfg.raid.held.length), inline: true },
            { name: 'Bitiş', value: active ? unixRel(cfg.raid.until) : '-', inline: true },
            { name: 'Eşik', value: `${cfg.raid.joinWindowSec} sn içinde ${cfg.raid.joinThreshold} giriş${ctx.isNight(guild.id) ? ' (gece modu: yarısı)' : ''}`, inline: false },
            { name: 'Yeni hesap kapısı', value: `${cfg.raid.minAccountAgeDays} günden genç → ${cfg.raid.newAccountAction}`, inline: false },
            { name: 'Doğrulama kapısı', value: cfg.raid.unverifiedRoleId ? `Açık (<@&${cfg.raid.unverifiedRoleId}>)` : 'Kapalı (`/dogrulama kur`)', inline: false },
          );
        return respond(i, { embeds: [e] });
      }
      if (!ctx.isTrusted(guild, i.user.id)) return respond(i, '🔒 Bu işlem yalnızca güvenilir kişiler içindir.');
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      if (sub === 'ac') {
        const raw = i.options.getString('sure');
        const ms = raw ? parseDuration(raw) : cfg.raid.raidMinutes * 60e3;
        if (!ms) return respond(i, '❌ Süre anlaşılamadı. Örnek: `30dk`, `2sa`.');
        const r = await raidApi.activate(guild, `Elle açıldı (<@${i.user.id}>)`, Math.round(ms / 60e3));
        return respond(i, r.already ? 'ℹ️ Baskın modu zaten açıktı; süre uzatıldı.' : '🚨 Baskın modu açıldı.');
      }
      if (sub === 'kapat') {
        const ok = await raidApi.deactivate(guild, `<@${i.user.id}>`);
        return respond(i, ok ? '✅ Baskın modu kapatıldı.' : 'ℹ️ Baskın modu zaten kapalıydı.');
      }
      if (sub === 'birak') {
        let n = 0;
        for (const grp of chunk([...cfg.raid.held], 5)) {
          await Promise.all(grp.map(async (id) => {
            const m = await guild.members.fetch(id).catch(() => null);
            if (m) { await m.timeout(null, 'Kalkan: baskın sonrası bırakıldı').then(() => { n++; }).catch(() => {}); }
          }));
        }
        const total = cfg.raid.held.length;
        cfg.raid.held = [];
        ctx.save();
        return respond(i, `✅ ${total} kişilik listeden ${n} kişinin susturması kaldırıldı.`);
      }
      if (!ctx.canAdmin(guild, i.user.id)) return respond(i, '🔒 Toplu atma yalnızca bot sahipleri içindir.');
      let n = 0;
      for (const grp of chunk([...cfg.raid.held], 5)) {
        await Promise.all(grp.map(async (id) => {
          const m = await guild.members.fetch(id).catch(() => null);
          if (m && m.kickable && !ctx.isTrusted(guild, id)) await m.kick('Kalkan: baskın').then(() => { n++; }).catch(() => {});
        }));
      }
      cfg.raid.held = [];
      ctx.save();
      return respond(i, `👢 ${n} üye sunucudan atıldı.`);
    },
  );

  ctx.router.add(
    new SlashCommandBuilder()
      .setName('dogrulama')
      .setDescription('Yeni üyeler için doğrulama kapısı')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((s) => s.setName('kur').setDescription('Doğrulama kapısını kur (yeni üyeler yalnızca doğrulama kanalını görür)')
        .addChannelOption((o) => o.setName('kanal').setDescription('Doğrulama mesajının gideceği kanal (boşsa yeni açılır)').addChannelTypes(ChannelType.GuildText)))
      .addSubcommand((s) => s.setName('durum').setDescription('Doğrulama kapısı durumu'))
      .addSubcommand((s) => s.setName('kaldir').setDescription('Doğrulama kapısını kaldır')),
    async (i) => {
      if (!ctx.canAdmin(i.guild, i.user.id)) return respond(i, '🔒 Bu ayarı yalnızca bot sahipleri değiştirebilir.');
      const guild = i.guild;
      const cfg = ctx.gcfg(guild.id);
      const sub = i.options.getSubcommand();
      if (sub === 'durum') {
        const role = cfg.raid.unverifiedRoleId && guild.roles.cache.get(cfg.raid.unverifiedRoleId);
        if (!role) return respond(i, 'ℹ️ Doğrulama kapısı kurulu değil. Kurmak için `/dogrulama kur`.');
        return respond(i, `✅ Kurulu.\nRol: <@&${role.id}> (${role.members.size} kişide)\nKanal: ${cfg.raid.verifyChannelId ? `<#${cfg.raid.verifyChannelId}>` : '-'}`);
      }
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      if (sub === 'kaldir') {
        const role = cfg.raid.unverifiedRoleId && guild.roles.cache.get(cfg.raid.unverifiedRoleId);
        if (role) await role.delete('Kalkan: doğrulama kapısı kaldırıldı').catch(() => {});
        if (cfg.raid.verifyCreatedChannel && cfg.raid.verifyChannelId) {
          const ch = guild.channels.cache.get(cfg.raid.verifyChannelId);
          if (ch) await ch.delete('Kalkan: doğrulama kapısı kaldırıldı').catch(() => {});
        }
        cfg.raid.unverifiedRoleId = null;
        cfg.raid.verifyChannelId = null;
        cfg.raid.verifyCreatedChannel = false;
        ctx.save();
        return respond(i, '✅ Doğrulama kapısı kaldırıldı. Rol silindi; rolü taşıyanlar artık tüm kanalları görür.');
      }
      // kur
      let role = cfg.raid.unverifiedRoleId ? guild.roles.cache.get(cfg.raid.unverifiedRoleId) : null;
      try {
        if (!role) {
          role = await guild.roles.create({ name: 'Doğrulanmamış', permissions: [], mentionable: false, reason: 'Kalkan: doğrulama kapısı' });
        }
        let ch = i.options.getChannel('kanal');
        let created = false;
        if (!ch) {
          ch = await guild.channels.create({ name: 'dogrulama', type: ChannelType.GuildText, reason: 'Kalkan: doğrulama kapısı' });
          created = true;
        }
        cfg.raid.unverifiedRoleId = role.id;
        cfg.raid.verifyChannelId = ch.id;
        cfg.raid.verifyCreatedChannel = created;
        ctx.save();

        let done = 0;
        let failed = 0;
        const targets = [...guild.channels.cache.values()].filter((c) => c.permissionOverwrites && !c.isThread() && c.id !== ch.id);
        for (const grp of chunk(targets, 5)) {
          await Promise.all(grp.map((c) => c.permissionOverwrites.edit(role, { ViewChannel: false }, { reason: 'Kalkan: doğrulama kapısı' })
            .then(() => { done++; }).catch(() => { failed++; })));
        }
        await ch.permissionOverwrites.edit(role, {
          ViewChannel: true, ReadMessageHistory: true, SendMessages: false, AddReactions: false,
        }, { reason: 'Kalkan: doğrulama kapısı' }).catch(() => {});
        if (created) await ch.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false }, { reason: 'Kalkan: doğrulama kapısı' }).catch(() => {});

        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('verify:basic').setLabel('Doğrula').setEmoji('✅').setStyle(ButtonStyle.Success));
        const oauthMode = ctx.oauth && ctx.oauth.mode ? ctx.oauth.mode() : 'off';
        const oauthUrl = oauthMode === 'server' ? ctx.oauth.verifyUrl(guild.id) : null;
        if (oauthUrl) row.addComponents(new ButtonBuilder().setLabel('Hesapla doğrula (önerilen)').setEmoji('🔐').setStyle(ButtonStyle.Link).setURL(oauthUrl));
        else if (oauthMode === 'manual') row.addComponents(new ButtonBuilder().setCustomId('verify:oauth').setLabel('Hesapla doğrula (önerilen)').setEmoji('🔐').setStyle(ButtonStyle.Primary));
        const embed = new EmbedBuilder().setColor(0x2ecc71).setTitle('✅ Sunucuya hoş geldin!')
          .setDescription([
            'Sunucuyu görmek için aşağıdaki düğmeye bas.',
            oauthMode !== 'off' ? '\n🔐 **Hesapla doğrula**: Discord hesabınla giriş yaparsın. Sunucu bir saldırıya uğrarsa seni yedek sunucuya hızlıca taşıyabiliriz. Şifren hiçbir zaman istenmez; `/hesap sil` ile verini istediğin an silebilirsin.' : null,
            '\n⚠️ Bu kanal dışında kimseden dosya (.jar, .exe, .zip) veya link açma. Yetkililer asla senden dosya çalıştırmanı istemez.',
          ].filter(Boolean).join('\n'));
        await ch.send({ embeds: [embed], components: [row] });
        return respond(i, `✅ Doğrulama kapısı kuruldu: <#${ch.id}>\n${done} kanal yeni üyelere kapatıldı${failed ? `, ${failed} kanalda yetki hatası oldu (bot rolünü yukarı taşı)` : ''}.\nEski üyeler etkilenmez; yalnızca bundan sonra katılanlar <@&${role.id}> rolüyle başlar.`);
      } catch (e) {
        return respond(i, `❌ Kurulamadı: ${e.message}\nBotun "Rolleri Yönet" ve "Kanalları Yönet" yetkisi olmalı.`);
      }
    },
  );
}

module.exports = { name: 'raid', init, normName, ACTIONS_NEW };
