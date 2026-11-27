'use strict';
// Kurtarma: sunucu silinirse (ya da bot atılırsa) GÖNÜLLÜ KAYIT olanlara (/izin-ver ya da hesap bağlama) DM duyurusu + yedek sunucu bağlantısı.
// Kayıt olmayan üyeye toplu/izinsiz DM gönderilmez (Discord kuralları + gizlilik); izin /izni-iptal ile geri çekilebilir.
// İki anahtar: yedek sunucu hedefi değişikliği 12 saat bekler; diğer anahtar (OWNER_IDS ↔ BACKUP_OWNER_IDS) onaylayabilir ya da iptal eder.
const {
  SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, Events, InteractionContextType, MessageFlags, ChannelType,
} = require('discord.js');
const { encrypt, decrypt, randomId } = require('../crypto');
const { respond, truncate, unixRel, fmtDuration } = require('../util');
const { DEFAULT_RECOVERY_MESSAGE } = require('../defaults');
const L = require('./links');

function normalizeInvite(s) {
  const m = /^(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([A-Za-z0-9-]{2,32})\/?$/i.exec(String(s || '').trim());
  return m ? { code: m[1], url: `https://discord.gg/${m[1]}` } : null;
}

const hasLink = (text) => L.extract(text).length > 0 || /discord\.gg|discord(?:app)?\.com\/invite/i.test(text);

function init(ctx) {
  const { client, env, store, log } = ctx;
  const jobs = () => (store.data.meta.recoveryJobs ||= {});
  const running = new Set();
  const joinCool = new Map();

  const keyOf = (uid) => (ctx.isBackupOwner(uid) && !ctx.isBotOwner(uid) ? 'backup' : 'main');
  const ownerIdsFor = (cfg) => {
    const ids = new Set([...env.ownerIds, ...env.backupOwnerIds]);
    if (!ids.size && cfg.recovery.ownerId) ids.add(cfg.recovery.ownerId);
    return [...ids];
  };
  const canManage = (gid, uid) => {
    const cfg = ctx.gcfg(gid);
    if (env.ownerIds.length) return ctx.isBotOwner(uid);
    return !!uid && uid === cfg.recovery.ownerId;
  };
  const canConfirm = (gid, uid) => canManage(gid, uid) || ctx.isBackupOwner(uid);

  /* ------------------------------------------------------------ duyuru içeriği */
  function currentLinkEnc(cfg) { return cfg.recovery.linkEnc || null; }

  async function makeInvite(cfg) {
    const bg = cfg.recovery.backupGuildId && client.guilds.cache.get(cfg.recovery.backupGuildId);
    if (!bg) return null;
    const me = bg.members.me;
    const pick = [bg.systemChannel, bg.rulesChannel, ...bg.channels.cache.values()]
      .find((c) => c && c.type === ChannelType.GuildText && me && c.permissionsFor(me).has(PermissionFlagsBits.CreateInstantInvite));
    if (!pick) return null;
    try {
      const inv = await pick.createInvite({ maxAge: 0, maxUses: 0, unique: false, reason: 'Kalkan: kurtarma duyurusu' });
      return `https://discord.gg/${inv.code}`;
    } catch { return null; }
  }

  // Duyuru alıcıları: yalnızca gönüllü kayıtlılar (ctx.privacy.audience).
  const audienceOf = (gid) => (ctx.privacy ? ctx.privacy.audience(gid) : []);

  function buildPayload(job, uid) {
    const cfg = ctx.gcfg(job.gid);
    const r = cfg.recovery;
    const name = job.name || 'Sunucu';
    const text = String(r.message || DEFAULT_RECOVERY_MESSAGE).replaceAll('{sunucu}', name);
    const embed = new EmbedBuilder().setColor(job.drill ? 0xf1c40f : 0xe74c3c)
      .setTitle(`${job.drill ? '🧪 TATBİKAT — ' : '⚠️ '}${truncate(name, 80)} — önemli duyuru`)
      .setDescription(truncate(text, 3500))
      .setFooter({ text: job.drill ? 'Bu bir tatbikattır; gerçek bir duyuru değildir.' : `${env.botName} tarafından otomatik gönderildi` });
    const row = new ActionRowBuilder();
    let url = null;
    try { url = job.linkEnc ? decrypt(job.linkEnc) : null; } catch { url = null; }
    if (url) row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Yedek sunucuya katıl').setEmoji('🔗').setURL(url));
    if (r.backupGuildId && ctx.oauth && ctx.oauth.has(uid)) {
      row.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Success).setCustomId(`rec:join:${job.gid}`).setLabel('Beni otomatik ekle').setEmoji('⚡'));
    }
    return row.components.length ? { embeds: [embed], components: [row] } : { embeds: [embed] };
  }

  /* ------------------------------------------------------------ toplu gönderim */
  async function runJob(job) {
    if (running.has(job.id)) return;
    running.add(job.id);
    try {
      while (job.idx < job.queue.length && !job.closed) {
        const uid = job.queue[job.idx];
        // Kuyruk oluştuktan sonra izni geri çeken kişiye gönderme.
        if (!job.drill && ctx.privacy && !ctx.privacy.consentHas(job.gid, uid)) { job.skipped = (job.skipped || 0) + 1; job.idx++; continue; }
        const ok = await ctx.dm(uid, buildPayload(job, uid), { bulk: true });
        if (ok) job.sent++; else job.failed++;
        job.idx++;
        if (job.idx % 20 === 0) store.save();
      }
      const stopped = job.closed && job.idx < job.queue.length;
      job.closed = true;
      job.endedAt = Date.now();
      store.save();
      if (!job.drill) {
        ctx.gcfg(job.gid).recovery.lastBroadcast = { at: job.endedAt, sent: job.sent, failed: job.failed, total: job.queue.length };
        store.save();
      }
      await ctx.alert({
        guildId: job.gid, level: 'ok', title: job.drill ? 'Tatbikat DM\'i gönderildi' : (stopped ? 'Kurtarma duyurusu durduruldu' : 'Kurtarma duyurusu tamamlandı'),
        description: `Gönderilen: **${job.sent}** • Gönderilemeyen (DM kapalı vb.): **${job.failed}** • İzni geri çeken (atlandı): **${job.skipped || 0}** • Toplam: ${job.queue.length}`,
      });
    } catch (e) {
      log.error('kurtarma duyurusu hatası:', e);
    } finally {
      running.delete(job.id);
    }
  }

  async function startBroadcast(gid, { by = 'otomatik', drillUid = null } = {}) {
    const cfg = ctx.gcfg(gid);
    if (!drillUid) {
      const open = Object.values(jobs()).find((j) => j.gid === gid && !j.closed && !j.drill);
      if (open) return { already: true, job: open };
    }
    const queue = drillUid ? [drillUid] : audienceOf(gid);
    if (!queue.length) return { empty: true };
    let linkEnc = currentLinkEnc(cfg);
    if (!linkEnc) { const u = await makeInvite(cfg); if (u) linkEnc = encrypt(u); }
    const job = {
      id: randomId(4), gid, name: cfg.recovery.name || 'Sunucu', by, startedAt: Date.now(), queue, idx: 0, sent: 0, failed: 0,
      closed: false, drill: !!drillUid, linkEnc,
    };
    jobs()[job.id] = job;
    store.save();
    runJob(job);
    return { job };
  }

  /* ------------------------------------------------------------ sunucu kaybı */
  async function askOwners(gid, name, members, verdict) {
    const cfg = ctx.gcfg(gid);
    const embed = new EmbedBuilder().setColor(0xe74c3c).setTitle(`🛑 ${truncate(name, 60)} sunucusuna erişim kayboldu`)
      .setDescription([
        `Sunucu **silinmiş** ya da bot **atılmış** olabilir; otomatik olarak ayırt edilemedi (doğrulanmış ${verdict.checked || 0} üye kontrol edildi).`,
        `Duyuruyu almayı kabul etmiş (gönüllü kayıtlı) üye: **${members}**. DM gönderilsin mi?`,
        `Yedek sunucu: ${cfg.recovery.backupGuildId ? `\`${cfg.recovery.backupGuildId}\`` : 'ayarlı değil'}`,
        'Gönderim yaklaşık 1 saniye aralıkla yapılır (hız sınırlarına takılmamak için).',
      ].join('\n'));
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`rec:send:${gid}`).setLabel('Duyuruyu gönder').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`rec:skip:${gid}`).setLabel('Gönderme').setStyle(ButtonStyle.Secondary),
    );
    for (const id of ownerIdsFor(cfg)) ctx.dm(id, { embeds: [embed], components: [row] }).catch(() => {});
  }

  async function handleGuildGone(guild) {
    if (guild.available === false) return;
    const gid = guild.id;
    const cfg = ctx.gcfg(gid);
    if (guild.name) cfg.recovery.name = guild.name;
    if (guild.ownerId) cfg.recovery.ownerId = guild.ownerId;
    ctx.save();
    const name = cfg.recovery.name || gid;
    const members = audienceOf(gid).length;
    await ctx.alert({
      guildId: gid, level: 'critical', title: `Sunucuya erişim kayboldu: ${name}`,
      description: 'Sunucu silinmiş ya da bot sunucudan atılmış olabilir. Durum kontrol ediliyor…', key: `gone:${gid}`,
    });
    if (members < 1) {
      await ctx.alert({ guildId: gid, level: 'warn', title: `Duyuru gönderilecek gönüllü kayıt yok: ${name}`, description: 'Hiç kimse kurtarma bildirimine kayıt olmamış; DM gönderilmedi. İleride üyelerin `/izin-ver` kullanmasını ya da hesabını bağlamasını teşvik et.' });
      return;
    }
    // Aynı olay için üyelere ikinci kez DM yağmasın (yinelenen GuildDelete olayı ya da bot yeniden eklenip çıkarılırsa).
    const lb = cfg.recovery.lastBroadcast;
    if (lb && Date.now() - lb.at < 24 * 3600e3) {
      await ctx.alert({ guildId: gid, level: 'warn', title: `Duyuru yeniden gönderilmedi: ${name}`, description: `Son 24 saat içinde zaten ${lb.sent} kişiye duyuru gönderilmişti. Gerekirse elle: \`/kurtarma duyur\`.` });
      return;
    }
    let verdict = { verdict: 'unknown', checked: 0 };
    try { verdict = await ctx.oauth.checkGuildGone(gid); } catch (e) { log.warn('sunucu durumu denetlenemedi:', e.message); }
    if (verdict.verdict === 'exists') {
      await ctx.alert({ guildId: gid, level: 'critical', title: `Bot sunucudan atıldı: ${name}`, description: 'Sunucu hâlâ mevcut (doğrulanmış üyelerin listesinde görünüyor). Duyuru GÖNDERİLMEDİ. Botu yeniden ekle ve neden atıldığını incele.' });
      return;
    }
    if (verdict.verdict === 'gone' && cfg.recovery.autoBroadcast) {
      await ctx.alert({ guildId: gid, level: 'critical', title: `Sunucunun SİLİNDİĞİ doğrulandı: ${name}`, description: `${verdict.checked} doğrulanmış üyenin sunucu listesinde artık yok. ${members} gönüllü kayıtlı kişiye duyuru başlatılıyor.` });
      await startBroadcast(gid, { by: 'otomatik' });
      return;
    }
    await askOwners(gid, name, members, verdict);
  }

  client.on(Events.GuildDelete, (guild) => { handleGuildGone(guild).catch((e) => log.error('GuildDelete işleme hatası:', e)); });
  client.on(Events.GuildUpdate, (_o, g) => {
    const r = ctx.gcfg(g.id).recovery;
    if (r.name !== g.name || r.ownerId !== g.ownerId) { r.name = g.name; r.ownerId = g.ownerId; ctx.save(); }
  });
  // Bot geri eklendiyse açık duyuruyu durdur.
  client.on(Events.GuildCreate, (g) => {
    for (const j of Object.values(jobs())) if (j.gid === g.id && !j.closed && !j.drill) { j.closed = true; store.save(); }
  });

  /* ------------------------------------------------------------ iki anahtarlı hedef değişikliği */
  async function applyPending(gid, how) {
    const cfg = ctx.gcfg(gid);
    const p = cfg.recovery.pending;
    if (!p) return false;
    cfg.recovery.backupGuildId = p.backupGuildId;
    cfg.recovery.linkEnc = p.linkEnc;
    cfg.recovery.pending = null;
    ctx.save();
    const g = client.guilds.cache.get(gid);
    await ctx.alert({
      guild: g || undefined, guildId: gid, level: 'high', title: 'Kurtarma hedefi (yedek sunucu) güncellendi',
      description: `Yeni yedek sunucu: \`${p.backupGuildId || '-'}\`${p.linkEnc ? ' • davet bağlantısı ayarlandı' : ''}\nÖneren: <@${p.by}> • ${how}`,
    });
    return true;
  }

  async function notifyProposal(gid, p, name) {
    const cfg = ctx.gcfg(gid);
    const approvers = (p.key === 'main' ? env.backupOwnerIds : env.ownerIds).filter((id) => id !== p.by);
    const informed = (p.key === 'main' ? env.ownerIds : env.backupOwnerIds).filter((id) => id !== p.by);
    const embed = new EmbedBuilder().setColor(0xe67e22).setTitle('Kurtarma hedefi değişikliği önerildi')
      .setDescription([
        `Sunucu: **${truncate(name, 60)}**`,
        `Öneren: <@${p.by}>`,
        `Yeni yedek sunucu: \`${p.backupGuildId || '-'}\`${p.linkEnc ? ' • yeni davet bağlantısı' : ''}`,
        `Otomatik uygulanma: ${unixRel(p.applyAt)} (${fmtDuration(cfg.recovery.delayHours * 3600e3)} bekleme)`,
        'Bu değişikliği **sen yapmadıysan hemen iptal et**: hesap ele geçirilmiş olabilir.',
      ].join('\n'));
    const rowFor = (canApprove) => {
      const row = new ActionRowBuilder();
      if (canApprove) row.addComponents(new ButtonBuilder().setCustomId(`rec:ok:${p.id}`).setLabel('Onayla (hemen uygula)').setStyle(ButtonStyle.Success));
      row.addComponents(new ButtonBuilder().setCustomId(`rec:cancel:${p.id}`).setLabel('İptal et').setStyle(ButtonStyle.Danger));
      return row;
    };
    for (const id of approvers) ctx.dm(id, { embeds: [embed], components: [rowFor(true)] }).catch(() => {});
    for (const id of informed) ctx.dm(id, { embeds: [embed], components: [rowFor(false)] }).catch(() => {});
  }

  /* ------------------------------------------------------------ düğmeler */
  ctx.router.button('rec:', async (i) => {
    const [, act, arg] = i.customId.split(':');

    if (act === 'join') {
      const now = Date.now();
      if (now - (joinCool.get(i.user.id) || 0) < 5000) return respond(i, '⏳ Biraz bekle.');
      joinCool.set(i.user.id, now);
      const cfg = ctx.gcfg(arg);
      const bg = cfg.recovery.backupGuildId;
      if (!bg) return respond(i, 'ℹ️ Yedek sunucu henüz ayarlanmamış. Yöneticilerin duyurusunu bekle.');
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const r = await ctx.oauth.addToGuild(i.user.id, bg);
      if (r.ok) return respond(i, r.already ? '✅ Zaten yedek sunucudasın.' : '✅ Yedek sunucuya eklendin! Discord\'u açıp kontrol et.');
      return respond(i, '⚠️ Otomatik eklenemedi. Mesajdaki **Yedek sunucuya katıl** bağlantısını kullan.');
    }

    if (act === 'ok' || act === 'cancel') {
      const found = Object.keys(store.data.guilds).map((g) => [g, ctx.gcfg(g).recovery.pending]).find(([, p]) => p && p.id === arg);
      if (!found) return respond(i, 'ℹ️ Bu istek artık geçerli değil (uygulanmış ya da iptal edilmiş).');
      const [gid, p] = found;
      const isOwner = ctx.isBotOwner(i.user.id) || ctx.isBackupOwner(i.user.id);
      if (!isOwner) return respond(i, '🔒 Bu düğme sana ait değil.');
      if (act === 'cancel') {
        ctx.gcfg(gid).recovery.pending = null;
        ctx.save();
        await ctx.alert({ guildId: gid, level: 'high', title: 'Kurtarma hedefi değişikliği İPTAL edildi', description: `İptal eden: <@${i.user.id}> • Öneren: <@${p.by}>` });
        return i.update({ content: '❌ Değişiklik iptal edildi.', embeds: [], components: [] });
      }
      const otherKey = p.key === 'main' ? ctx.isBackupOwner(i.user.id) && !ctx.isBotOwner(i.user.id) : ctx.isBotOwner(i.user.id);
      if (!otherKey || i.user.id === p.by) return respond(i, '🔒 Değişikliği yalnızca **diğer anahtar** sahibi onaylayabilir.');
      await applyPending(gid, `onaylayan: <@${i.user.id}>`);
      return i.update({ content: '✅ Onaylandı ve uygulandı.', embeds: [], components: [] });
    }

    if (act === 'send' || act === 'skip') {
      if (!canConfirm(arg, i.user.id)) return respond(i, '🔒 Bu düğme sana ait değil.');
      if (act === 'skip') return i.update({ content: '👍 Duyuru gönderilmeyecek.', embeds: [], components: [] });
      await i.update({ content: '⏳ Duyuru başlatılıyor…', embeds: [], components: [] });
      const r = await startBroadcast(arg, { by: `<@${i.user.id}>` });
      return i.editReply({ content: r.already ? 'ℹ️ Zaten devam eden bir duyuru var.' : r.empty ? 'ℹ️ Gönüllü kayıtlı kimse yok; DM gönderilmedi.' : `📨 Duyuru başladı: ${r.job.queue.length} gönüllü kayıtlı kişi. Bitince haber vereceğim.` });
    }
  });

  /* ------------------------------------------------------------ komutlar */
  ctx.router.add(
    new SlashCommandBuilder()
      .setName('kurtarma')
      .setDescription('Sunucu kaybı durumunda üyelere duyuru ve yedek sunucu')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((s) => s.setName('durum').setDescription('Kurtarma ayarlarını göster'))
      .addSubcommand((s) => s.setName('hedef').setDescription('Yedek sunucuyu / davet bağlantısını belirle (12 saat beklemeli)')
        .addStringOption((o) => o.setName('sunucu-id').setDescription('Yedek sunucunun ID\'si (bot orada da olmalı)').setMaxLength(25))
        .addStringOption((o) => o.setName('davet').setDescription('Süresiz Discord daveti (discord.gg/...)').setMaxLength(100)))
      .addSubcommand((s) => s.setName('hedef-iptal').setDescription('Bekleyen hedef değişikliğini iptal et'))
      .addSubcommand((s) => s.setName('metin-ayarla').setDescription('Duyuru metnini değiştir'))
      .addSubcommand((s) => s.setName('tatbikat').setDescription('Duyuruyu yalnızca sana göndererek dene'))
      .addSubcommand((s) => s.setName('duyur').setDescription('Duyuruyu şimdi gönüllü kayıtlı üyelere gönder'))
      .addSubcommand((s) => s.setName('durdur').setDescription('Devam eden duyuruyu durdur'))
      .addSubcommand((s) => s.setName('otomatik').setDescription('Sunucu silinince duyuruyu otomatik başlat')
        .addBooleanOption((o) => o.setName('acik').setDescription('Açık mı?').setRequired(true))),
    async (i) => {
      const sub = i.options.getSubcommand();
      const gid = i.guildId;
      const cfg = ctx.gcfg(gid);
      const r = cfg.recovery;
      const uid = i.user.id;
      const isMgr = ctx.canAdmin(i.guild, uid);
      const isAny = isMgr || ctx.isBackupOwner(uid);

      if (sub === 'durum') {
        if (!isAny) return respond(i, '🔒 Bu bilgi yalnızca bot sahipleri içindir.');
        const alive = audienceOf(gid).length;
        const bg = r.backupGuildId && client.guilds.cache.get(r.backupGuildId);
        const e = new EmbedBuilder().setColor(0x3498db).setTitle('🆘 Kurtarma durumu').addFields(
          { name: 'Gönüllü kayıtlı (DM alacak)', value: `${alive} (hesabını bağlayan: ${ctx.oauth.count(gid)})`, inline: true },
          { name: 'Otomatik duyuru', value: r.autoBroadcast ? 'Açık' : 'Kapalı', inline: true },
          { name: 'Yedek sunucu', value: r.backupGuildId ? `${bg ? `**${bg.name}**` : 'bot orada değil!'} (\`${r.backupGuildId}\`)` : 'ayarlı değil', inline: false },
          { name: 'Davet bağlantısı', value: r.linkEnc ? 'ayarlı (şifreli saklanıyor)' : (r.backupGuildId ? 'yok — duyuru anında bot yeni davet oluşturur' : 'yok'), inline: false },
          { name: 'Bekleyen değişiklik', value: r.pending ? `<@${r.pending.by}> önerdi • uygulanma ${unixRel(r.pending.applyAt)}` : 'yok', inline: false },
          { name: 'Son duyuru', value: r.lastBroadcast ? `${r.lastBroadcast.sent}/${r.lastBroadcast.total} gönderildi • <t:${Math.floor(r.lastBroadcast.at / 1000)}:R>` : 'yok', inline: false },
          { name: 'Anahtarlar', value: `Ana: ${env.ownerIds.length} kişi • Yedek: ${env.backupOwnerIds.length} kişi${env.backupOwnerIds.length ? '' : ' ⚠️ (ikinci anahtar yok)'}`, inline: false },
        );
        return respond(i, { embeds: [e] });
      }

      if (sub === 'hedef' || sub === 'hedef-iptal') {
        if (!isAny) return respond(i, '🔒 Yalnızca ana ya da yedek anahtar sahibi yapabilir.');
        if (sub === 'hedef-iptal') {
          if (!r.pending) return respond(i, 'ℹ️ Bekleyen bir değişiklik yok.');
          r.pending = null;
          ctx.save();
          await ctx.alert({ guild: i.guild, level: 'high', title: 'Kurtarma hedefi değişikliği iptal edildi', description: `İptal eden: <@${uid}>` });
          return respond(i, '✅ Bekleyen değişiklik iptal edildi.');
        }
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        let newGuild = (i.options.getString('sunucu-id') || '').replace(/\D/g, '') || null;
        const invOpt = i.options.getString('davet');
        if (!newGuild && !invOpt) return respond(i, '❌ En az birini ver: `sunucu-id` veya `davet`.');
        let linkEnc = r.pending ? r.pending.linkEnc : r.linkEnc;
        if (invOpt) {
          const inv = normalizeInvite(invOpt);
          if (!inv) return respond(i, '❌ Yalnızca `discord.gg/...` biçiminde bir Discord daveti kabul edilir.');
          const fetched = await client.fetchInvite(inv.code).catch(() => null);
          if (!fetched) return respond(i, '❌ Davet geçersiz ya da süresi dolmuş.');
          if (fetched.expiresTimestamp) return respond(i, '❌ Bu davetin süresi var. Süresiz (hiç dolmayan) bir davet oluştur.');
          if (newGuild && fetched.guild && fetched.guild.id !== newGuild) return respond(i, '❌ Bu davet, verdiğin sunucu ID\'sine ait değil.');
          if (!newGuild && fetched.guild) newGuild = fetched.guild.id;
          linkEnc = encrypt(inv.url);
        }
        newGuild ||= r.backupGuildId;
        if (newGuild === gid) return respond(i, '❌ Yedek sunucu, korunan sunucunun kendisi olamaz.');
        if (!newGuild || !client.guilds.cache.has(newGuild)) return respond(i, '❌ Bot yedek sunucuda değil. Önce botu o sunucuya ekle (botun "Public" ayarı kapalı olmalı).');
        const first = !r.backupGuildId && !r.linkEnc;
        const p = { id: randomId(4), by: uid, key: keyOf(uid), at: Date.now(), applyAt: Date.now() + r.delayHours * 3600e3, backupGuildId: newGuild, linkEnc };
        r.pending = p;
        ctx.save();
        if (first) {
          await applyPending(gid, 'ilk kurulum (bekleme yok)');
          return respond(i, `✅ Yedek sunucu ayarlandı: \`${newGuild}\`.`);
        }
        await notifyProposal(gid, p, r.name || i.guild.name);
        await ctx.alert({
          guild: i.guild, level: 'warn', title: 'Kurtarma hedefi değişikliği önerildi',
          description: `<@${uid}> yedek sunucuyu \`${newGuild}\` olarak değiştirmeyi önerdi. ${unixRel(p.applyAt)} uygulanacak; diğer anahtar sahibi onaylayabilir ya da iptal edebilir.`,
        });
        return respond(i, `⏳ Değişiklik ${fmtDuration(r.delayHours * 3600e3)} sonra uygulanacak. Diğer anahtar sahibine bildirim gitti; o onaylarsa hemen, iptal ederse hiç uygulanmaz.`);
      }

      if (!isMgr) return respond(i, '🔒 Bu işlem yalnızca ana anahtar sahibi (bot sahibi) içindir.');

      if (sub === 'otomatik') {
        r.autoBroadcast = i.options.getBoolean('acik', true);
        ctx.save();
        return respond(i, r.autoBroadcast ? '✅ Sunucunun silindiği doğrulanırsa duyuru otomatik başlayacak.' : '✅ Otomatik duyuru kapatıldı; sunucu kaybında önce sana sorulacak.');
      }

      if (sub === 'metin-ayarla') {
        const modal = new ModalBuilder().setCustomId('rec:msg').setTitle('Kurtarma duyurusu metni')
          .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
            .setCustomId('text').setLabel('Metin ({sunucu} = sunucu adı). Bağlantı yazma.').setStyle(TextInputStyle.Paragraph)
            .setMaxLength(1500).setRequired(true).setValue(String(r.message || DEFAULT_RECOVERY_MESSAGE).slice(0, 1500))));
        return i.showModal(modal);
      }

      if (sub === 'tatbikat') {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const out = await startBroadcast(gid, { by: `<@${uid}>`, drillUid: uid });
        return respond(i, out.job ? '🧪 Tatbikat DM\'i yollandı. DM\'lerini kontrol et (kapalıysa açıp tekrar dene).' : '❌ Başlatılamadı.');
      }

      if (sub === 'durdur') {
        const open = Object.values(jobs()).filter((j) => j.gid === gid && !j.closed);
        for (const j of open) j.closed = true;
        ctx.save();
        return respond(i, open.length ? `⏹️ ${open.length} duyuru durduruldu.` : 'ℹ️ Devam eden duyuru yok.');
      }

      // duyur
      const alive = audienceOf(gid).length;
      if (!alive) return respond(i, 'ℹ️ Gönüllü kayıtlı kimse yok; DM gönderilecek kişi bulunmuyor. Üyeler `/izin-ver` ile kayıt olabilir.');
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`rec:send:${gid}`).setLabel(`Evet, ${alive} gönüllüye gönder`).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`rec:skip:${gid}`).setLabel('Vazgeç').setStyle(ButtonStyle.Secondary),
      );
      return respond(i, { content: `⚠️ Bu işlem izin vermiş **${alive} gönüllü üyeye** özel mesaj gönderir. Yalnızca gerçek bir kriz için kullan. Önce \`/kurtarma tatbikat\` ile içeriği dene.`, components: [row] });
    },
  );

  ctx.router.modal('rec:msg', async (i) => {
    if (!i.guild || !ctx.canAdmin(i.guild, i.user.id)) return respond(i, '🔒 Bu işlem yalnızca ana anahtar sahibi içindir.');
    const text = i.fields.getTextInputValue('text').trim();
    if (!text) return respond(i, '❌ Metin boş olamaz.');
    if (hasLink(text)) return respond(i, '❌ Metinde bağlantı olamaz (kimlik avı riskini önlemek için). Yedek sunucu bağlantısı otomatik düğme olarak eklenir.');
    ctx.gcfg(i.guildId).recovery.message = text;
    ctx.save();
    await ctx.alert({ guild: i.guild, level: 'info', title: 'Kurtarma duyuru metni değişti', description: `Değiştiren: <@${i.user.id}>` });
    return respond(i, '✅ Metin kaydedildi. `/kurtarma tatbikat` ile nasıl göründüğüne bak.');
  });

  /* ------------------------------------------------------------ yaşam döngüsü */
  const api = {
    startBroadcast,
    normalizeInvite,
    touch(guild) {
      const r = ctx.gcfg(guild.id).recovery;
      if (r.name !== guild.name || r.ownerId !== guild.ownerId) { r.name = guild.name; r.ownerId = guild.ownerId; ctx.save(); }
    },
    // Yeniden başlatmada yarım kalan duyuruları sürdür.
    resume() {
      for (const job of Object.values(jobs())) {
        if (!job.closed && job.idx < job.queue.length) { log.info(`kurtarma duyurusu sürdürülüyor: ${job.id} (${job.idx}/${job.queue.length})`); runJob(job); }
      }
    },
  };
  ctx.recovery = api;

  ctx.every(60e3, async () => {
    for (const gid of Object.keys(store.data.guilds)) {
      const p = ctx.gcfg(gid).recovery.pending;
      if (p && p.applyAt <= Date.now()) await applyPending(gid, 'bekleme süresi doldu');
    }
  }, 'kurtarma-bekleyen');
  ctx.every(6 * 3600e3, () => {
    const cut = Date.now() - 30 * 864e5;
    for (const [id, j] of Object.entries(jobs())) if (j.closed && (j.endedAt || j.startedAt) < cut) delete jobs()[id];
    store.save();
  }, 'kurtarma-gc');
}

module.exports = { name: 'recovery', init, normalizeInvite, hasLink };
