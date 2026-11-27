'use strict';
// Sunucu yedeği: roller, kanallar, izinler, üye-rol eşleşmesi. Şifreli + sıkıştırılmış dosyalar.
// Geri yükleme yalnızca EKLER: var olan hiçbir şeyi silmez veya değiştirmez. Mesajlar yedeklenmez.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  Events, InteractionContextType, MessageFlags, OverwriteType,
} = require('discord.js');
const { encryptBuffer, decryptBuffer, randomId } = require('../crypto');
const { respond, toBig, RateQueue, truncate } = require('../util');

const TEXTY = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia].filter((x) => x !== undefined));
const VOICEY = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);
const FALLBACK = {
  [ChannelType.GuildAnnouncement]: ChannelType.GuildText,
  [ChannelType.GuildStageVoice]: ChannelType.GuildVoice,
  [ChannelType.GuildForum]: ChannelType.GuildText,
  [ChannelType.GuildMedia]: ChannelType.GuildText,
};

/* ------------------------------------------------------------ serileştirme */
function serializeRole(role) {
  return {
    id: role.id, name: role.name, color: role.color, hoist: !!role.hoist, position: role.position,
    permissions: toBig(role.permissions).toString(), mentionable: !!role.mentionable, managed: !!role.managed,
  };
}

function serializeChannel(ch) {
  const o = {
    id: ch.id, type: ch.type, name: ch.name, parentId: ch.parentId || null,
    position: ch.rawPosition ?? ch.position ?? 0,
    overwrites: ch.permissionOverwrites
      ? [...ch.permissionOverwrites.cache.values()].map((ow) => ({
        id: ow.id, type: ow.type, allow: toBig(ow.allow).toString(), deny: toBig(ow.deny).toString(),
      }))
      : [],
  };
  if (ch.topic) o.topic = ch.topic;
  if (ch.nsfw) o.nsfw = true;
  if (ch.rateLimitPerUser) o.rateLimitPerUser = ch.rateLimitPerUser;
  if (ch.bitrate) o.bitrate = ch.bitrate;
  if (ch.userLimit) o.userLimit = ch.userLimit;
  if (ch.rtcRegion) o.rtcRegion = ch.rtcRegion;
  if (ch.defaultAutoArchiveDuration) o.defaultAutoArchiveDuration = ch.defaultAutoArchiveDuration;
  if (Array.isArray(ch.availableTags)) o.availableTags = ch.availableTags.map((t) => ({ name: t.name, moderated: !!t.moderated }));
  return o;
}

const byPos = (a, b) => (a.position - b.position) || String(a.id).localeCompare(String(b.id));

function fmtLocal(at, tz = 'UTC') {
  try {
    return new Intl.DateTimeFormat('tr-TR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(at));
  } catch {
    return new Date(at).toISOString().slice(0, 16).replace('T', ' ');
  }
}

function init(ctx) {
  const { client, store, log, env } = ctx;
  const tomb = { channels: new Map(), roles: new Map() };
  const lastSkipAlert = new Map();

  const metaList = (gid) => (store.data.backupsMeta[gid] ||= []);
  const dirOf = (gid) => path.join(env.dataDir, 'backups', String(gid).replace(/[^0-9]/g, ''));

  /* ------------------------------------------------------------ dosya işlemleri */
  function writeSnapshot(snap) {
    const dir = dirOf(snap.gid);
    fs.mkdirSync(dir, { recursive: true });
    const id = `${snap.takenAt.toString(36)}${randomId(2)}`;
    const file = `${id}.bin`;
    const buf = encryptBuffer(zlib.gzipSync(Buffer.from(JSON.stringify(snap), 'utf8')));
    const full = path.join(dir, file);
    fs.writeFileSync(full + '.tmp', buf);
    fs.renameSync(full + '.tmp', full);
    return { id, file, size: buf.length };
  }

  function readSnapshot(gid, id) {
    const meta = metaList(gid).find((m) => m.id === id);
    if (!meta) return null;
    const buf = fs.readFileSync(path.join(dirOf(gid), meta.file));
    return JSON.parse(zlib.gunzipSync(decryptBuffer(buf)).toString('utf8'));
  }

  function latestSnapshot(gid) {
    const list = metaList(gid);
    for (let i = list.length - 1; i >= 0; i--) {
      try { const s = readSnapshot(gid, list[i].id); if (s) return s; } catch (e) { log.warn(`yedek okunamadı (${list[i].id}): ${e.message}`); }
    }
    return null;
  }

  function rotate(gid, keep) {
    const list = metaList(gid);
    while (list.length > Math.max(1, keep)) {
      const old = list.shift();
      try { fs.unlinkSync(path.join(dirOf(gid), old.file)); } catch { /* dosya zaten yok */ }
    }
  }

  /* ------------------------------------------------------------ anlık görüntü */
  function buildSnapshot(guild, by) {
    const reg = store.data.members[guild.id] || {};
    const members = {};
    for (const [uid, m] of Object.entries(reg)) {
      if (!m.left && Array.isArray(m.roles) && m.roles.length) members[uid] = m.roles;
    }
    return {
      v: 1, gid: guild.id, name: guild.name, takenAt: Date.now(), by: by || null,
      panic: !!ctx.gcfg(guild.id).panic.active,
      guild: {
        verificationLevel: guild.verificationLevel, explicitContentFilter: guild.explicitContentFilter,
        defaultMessageNotifications: guild.defaultMessageNotifications, preferredLocale: guild.preferredLocale,
        afkChannelId: guild.afkChannelId, afkTimeout: guild.afkTimeout, systemChannelId: guild.systemChannelId,
      },
      roles: [...guild.roles.cache.values()].filter((r) => r.id !== guild.id).map(serializeRole),
      channels: [...guild.channels.cache.values()].filter((c) => c.permissionOverwrites).map(serializeChannel),
      members,
    };
  }

  const api = {
    list: (gid) => [...metaList(gid)],
    load: (gid, id) => readSnapshot(gid, id),
    latest: (gid) => latestSnapshot(gid),

    // opts: { by, auto }
    async snapshot(guild, { by = null, auto = false } = {}) {
      const cfg = ctx.gcfg(guild.id);
      const snap = buildSnapshot(guild, by);
      const list = metaList(guild.id);
      const last = list[list.length - 1];
      if (auto && last) {
        const dropC = snap.channels.length < last.channels * 0.7;
        const dropR = snap.roles.length < last.roles * 0.7;
        if (dropC || dropR) {
          if (Date.now() - (lastSkipAlert.get(guild.id) || 0) > 6 * 3600e3) {
            lastSkipAlert.set(guild.id, Date.now());
            await ctx.alert({
              guild, level: 'warn', title: 'Otomatik yedek atlandı',
              description: `Kanal/rol sayısı ani düştü (kanal ${last.channels}→${snap.channels.length}, rol ${last.roles}→${snap.roles.length}). Saldırı olabilir; eski yedekler korunuyor.\nDüzen bilerek değiştiyse yeni durumu \`/yedek al\` ile elle kaydet.`,
            });
          }
          return null;
        }
      }
      const w = writeSnapshot(snap);
      const meta = {
        id: w.id, file: w.file, at: snap.takenAt, size: w.size, roles: snap.roles.length, channels: snap.channels.length,
        members: Object.keys(snap.members).length, by, auto: !!auto, panic: snap.panic,
      };
      list.push(meta);
      rotate(guild.id, cfg.backup.keep);
      ctx.save();
      ctx.stat(guild.id, 'backup');
      return meta;
    },

    async autoTick() {
      for (const guild of client.guilds.cache.values()) {
        try {
          const cfg = ctx.gcfg(guild.id);
          if (!cfg.modules.autoBackup || cfg.panic.active) continue;
          const last = metaList(guild.id).slice(-1)[0];
          if (last && Date.now() - last.at < cfg.backup.intervalHours * 3600e3) continue;
          await api.snapshot(guild, { auto: true });
        } catch (e) { log.error(`otomatik yedek hatası (${guild.name}):`, e); }
      }
    },

    // Anti-nuke: silinen kanal/rolleri geri getirir. Önce silinme anındaki canlı kopyayı, yoksa son yedeği kullanır.
    async restoreDeleted(guild, { channels = [], roles = [] } = {}) {
      const snap = latestSnapshot(guild.id);
      const t = (kind, id) => (tomb[kind].get(`${guild.id}:${id}`) || {}).data;
      const roleDefs = roles.map((id) => t('roles', id) || (snap && snap.roles.find((r) => r.id === id))).filter(Boolean);
      const chDefs = channels.map((id) => t('channels', id) || (snap && snap.channels.find((c) => c.id === id))).filter(Boolean);
      if (!roleDefs.length && !chDefs.length) return null;
      return recreate(guild, snap, roleDefs, chDefs, { reason: 'Kalkan: anti-nuke geri yükleme' });
    },
  };
  ctx.backup = api;

  /* ------------------------------------------------------------ canlı silinme kaydı (mezar taşı) */
  client.on(Events.ChannelDelete, (ch) => {
    try {
      if (!ch.guild || !ch.permissionOverwrites) return;
      tomb.channels.set(`${ch.guild.id}:${ch.id}`, { data: serializeChannel(ch), at: Date.now() });
      if (tomb.channels.size > 600) tomb.channels.delete(tomb.channels.keys().next().value);
    } catch { /* yoksay */ }
  });
  client.on(Events.GuildRoleDelete, (role) => {
    try {
      tomb.roles.set(`${role.guild.id}:${role.id}`, { data: serializeRole(role), at: Date.now() });
      if (tomb.roles.size > 600) tomb.roles.delete(tomb.roles.keys().next().value);
    } catch { /* yoksay */ }
  });

  /* ------------------------------------------------------------ yeniden oluşturma */
  function channelOptions(guild, def, parentId, overwrites, type) {
    const o = { name: def.name, type };
    if (overwrites && overwrites.length) o.permissionOverwrites = overwrites;
    if (parentId && type !== ChannelType.GuildCategory) o.parent = parentId;
    if (def.topic && (TEXTY.has(type))) o.topic = def.topic.slice(0, 1024);
    if (def.nsfw && TEXTY.has(type)) o.nsfw = true;
    if (def.rateLimitPerUser && TEXTY.has(type)) o.rateLimitPerUser = def.rateLimitPerUser;
    if (VOICEY.has(type)) {
      if (def.bitrate) o.bitrate = Math.min(def.bitrate, guild.maximumBitrate || 96000);
      if (def.userLimit) o.userLimit = def.userLimit;
      if (def.rtcRegion) o.rtcRegion = def.rtcRegion;
    }
    if (def.defaultAutoArchiveDuration && TEXTY.has(type)) o.defaultAutoArchiveDuration = def.defaultAutoArchiveDuration;
    if (Array.isArray(def.availableTags) && def.availableTags.length && (type === ChannelType.GuildForum || type === ChannelType.GuildMedia)) {
      o.availableTags = def.availableTags.slice(0, 20).map((x) => ({ name: x.name, moderated: !!x.moderated }));
    }
    return o;
  }

  function mapOverwrites(guild, snap, def, roleMap, canGrantAll, mine) {
    const out = [];
    for (const ow of def.overwrites || []) {
      let id = null;
      if (ow.type === OverwriteType.Role) id = roleMap.get(ow.id) || (snap && ow.id === snap.gid ? guild.id : null);
      else if (guild.members.cache.has(ow.id)) id = ow.id;
      if (!id) continue;
      let allow = BigInt(ow.allow);
      if (!canGrantAll) allow &= mine;
      out.push({ id, type: ow.type, allow, deny: BigInt(ow.deny) });
    }
    return out;
  }

  // roleDefs / chDefs: yeniden oluşturulacak tanımlar. snap: üye-rol eşleşmesi ve kategori çocukları için (boş olabilir).
  async function recreate(guild, snap, roleDefs, chDefs, { reason }) {
    const res = { roles: 0, channels: 0, partial: 0, failedRoles: [], failedChannels: [], assigned: 0, queued: 0 };
    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!me) return res;
    const mine = toBig(me.permissions);
    const canGrantAll = (mine & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator;
    const botTop = me.roles.highest.position;

    const roleMap = new Map();
    for (const r of guild.roles.cache.values()) roleMap.set(r.id, r.id);
    if (snap && snap.gid !== guild.id) roleMap.set(snap.gid, guild.id);

    // 1) roller (alttan yukarı)
    const createdRoles = [];
    for (const def of [...roleDefs].filter((r) => !r.managed && r.id !== guild.id).sort(byPos)) {
      try {
        let perms = BigInt(def.permissions);
        if (!canGrantAll) perms &= mine;
        const role = await guild.roles.create({
          name: def.name, color: def.color, hoist: def.hoist, permissions: perms, mentionable: def.mentionable, reason,
        });
        roleMap.set(def.id, role.id);
        createdRoles.push({ def, role });
        res.roles++;
      } catch { res.failedRoles.push(def.name); }
    }
    if (createdRoles.length) {
      try {
        await guild.roles.setPositions(createdRoles
          .map(({ def, role }) => ({ role: role.id, position: Math.max(1, Math.min(def.position, botTop - 1)) })));
      } catch { /* rol sırası elle kontrol edilmeli */ }
    }

    // 2) kanallar (önce kategoriler)
    const chMap = new Map();
    for (const c of guild.channels.cache.values()) chMap.set(c.id, c.id);
    const createdCh = [];
    const ordered = [
      ...chDefs.filter((c) => c.type === ChannelType.GuildCategory).sort(byPos),
      ...chDefs.filter((c) => c.type !== ChannelType.GuildCategory).sort(byPos),
    ];
    for (const def of ordered) {
      const parentId = def.parentId ? (chMap.get(def.parentId) || null) : null;
      const overwrites = mapOverwrites(guild, snap, def, roleMap, canGrantAll, mine);
      let ch = null;
      try {
        ch = await guild.channels.create({ ...channelOptions(guild, def, parentId, overwrites, def.type), reason });
      } catch {
        try {
          const t = FALLBACK[def.type] ?? def.type;
          const min = { name: def.name, type: t, reason };
          if (parentId && t !== ChannelType.GuildCategory) min.parent = parentId;
          ch = await guild.channels.create(min);
          res.partial++;
        } catch { res.failedChannels.push(def.name); }
      }
      if (ch) { chMap.set(def.id, ch.id); createdCh.push({ def, ch }); res.channels++; }
    }
    if (createdCh.length) {
      try {
        await guild.channels.setPositions(createdCh.map(({ def, ch }) => ({ channel: ch.id, position: def.position })));
      } catch { /* sıra elle düzeltilebilir */ }
    }

    // 3) silinen kategorinin çocukları ana kanala bağlı kalmaz: yeniden bağla
    if (snap) {
      for (const { def, ch } of createdCh) {
        if (def.type !== ChannelType.GuildCategory) continue;
        for (const child of snap.channels.filter((c) => c.parentId === def.id)) {
          const cur = guild.channels.cache.get(chMap.get(child.id) || child.id);
          if (cur && !cur.parentId && cur.id !== ch.id && cur.type !== ChannelType.GuildCategory) {
            await cur.setParent(ch.id, { lockPermissions: false, reason }).catch(() => {});
          }
        }
      }
    }

    // 4) rol üyeleri (arka planda, hız sınırına uyarak)
    if (snap && createdRoles.length) {
      const newByOld = new Map(createdRoles.map(({ def, role }) => [def.id, role.id]));
      const jobs = [];
      for (const [uid, rids] of Object.entries(snap.members || {})) {
        const add = rids.filter((r) => newByOld.has(r)).map((r) => newByOld.get(r));
        if (add.length) jobs.push([uid, add]);
      }
      res.queued = jobs.length;
      if (jobs.length) {
        const q = new RateQueue(350, 120);
        Promise.all(jobs.map(([uid, add]) => q.add(async () => {
          const m = guild.members.cache.get(uid) || await guild.members.fetch(uid).catch(() => null);
          if (m) { await m.roles.add(add, reason).then(() => { res.assigned++; }).catch(() => {}); }
        }))).then(() => ctx.alert({
          guild, level: 'ok', title: 'Rol üyelikleri geri yüklendi',
          description: `${res.assigned}/${jobs.length} üyeye geri verildi (yeniden oluşturulan ${createdRoles.length} rol için).`,
        })).catch(() => {});
      }
    }
    return res;
  }

  /* ------------------------------------------------------------ geri yükleme planı */
  function planRestore(guild, snap) {
    const same = guild.id === snap.gid;
    const roleCount = new Map();
    for (const r of guild.roles.cache.values()) roleCount.set(r.name, (roleCount.get(r.name) || 0) + 1);
    const present = (def) => same && guild.roles.cache.has(def.id);
    for (const def of snap.roles) if (present(def)) roleCount.set(def.name, Math.max(0, (roleCount.get(def.name) || 0) - 1));
    const rolesToMake = [];
    for (const def of snap.roles) {
      if (def.managed || present(def)) continue;
      const n = roleCount.get(def.name) || 0;
      if (n > 0) { roleCount.set(def.name, n - 1); continue; }
      rolesToMake.push(def);
    }

    const defById = new Map(snap.channels.map((c) => [c.id, c]));
    const keyDef = (c) => `${c.type}|${c.name}|${c.parentId ? (defById.get(c.parentId) || {}).name || '' : ''}`;
    const chCount = new Map();
    for (const c of guild.channels.cache.values()) {
      const k = `${c.type}|${c.name}|${c.parent ? c.parent.name : ''}`;
      chCount.set(k, (chCount.get(k) || 0) + 1);
    }
    const presentCh = (def) => same && guild.channels.cache.has(def.id);
    for (const def of snap.channels) {
      if (presentCh(def)) { const k = keyDef(def); chCount.set(k, Math.max(0, (chCount.get(k) || 0) - 1)); }
    }
    const channelsToMake = [];
    for (const def of snap.channels) {
      if (presentCh(def)) continue;
      const k = keyDef(def);
      const n = chCount.get(k) || 0;
      if (n > 0) { chCount.set(k, n - 1); continue; }
      channelsToMake.push(def);
    }
    return { rolesToMake, channelsToMake };
  }

  /* ------------------------------------------------------------ komutlar */
  const targetGid = (i) => (i.options.getString('sunucu-id') || '').replace(/\D/g, '') || i.guildId;

  ctx.router.add(
    new SlashCommandBuilder()
      .setName('yedek')
      .setDescription('Sunucu yedekleri (roller, kanallar, izinler)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((s) => s.setName('al').setDescription('Şimdi yedek al'))
      .addSubcommand((s) => s.setName('liste').setDescription('Yedekleri listele')
        .addStringOption((o) => o.setName('sunucu-id').setDescription('Başka bir sunucunun yedekleri (silinmiş sunucu için)').setMaxLength(25)))
      .addSubcommand((s) => s.setName('geri-yukle').setDescription('Eksik rol ve kanalları yedekten geri oluştur (silme yapmaz)')
        .addStringOption((o) => o.setName('yedek-id').setDescription('Hangi yedek? (boşsa en yenisi)').setAutocomplete(true))
        .addStringOption((o) => o.setName('sunucu-id').setDescription('Yedeğin ait olduğu sunucu (silinmiş sunucuyu yeni sunucuya taşırken)').setMaxLength(25))),
    async (i) => {
      if (!ctx.canAdmin(i.guild, i.user.id)) return respond(i, '🔒 Yedekleme yalnızca bot sahipleri içindir.');
      const guild = i.guild;
      const cfg = ctx.gcfg(guild.id);
      const sub = i.options.getSubcommand();
      if (sub === 'al') {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const meta = await api.snapshot(guild, { by: i.user.id });
        return respond(i, `✅ Yedek alındı: \`${meta.id}\`\n${meta.channels} kanal, ${meta.roles} rol, ${meta.members} üyenin rol bilgisi • ${(meta.size / 1024).toFixed(1)} KB (şifreli)${meta.panic ? '\n⚠️ Panik modu açıkken alındı: kanal izinleri kilitli halde kaydedildi.' : ''}`);
      }
      const gid = targetGid(i);
      if (sub === 'liste') {
        const list = metaList(gid).slice(-10).reverse();
        if (!list.length) return respond(i, 'ℹ️ Bu sunucu için yedek yok.');
        const lines = list.map((m) => `\`${m.id}\` • ${fmtLocal(m.at, cfg.night.tz)} • ${m.channels} kanal / ${m.roles} rol${m.auto ? ' • otomatik' : ''}`);
        return respond(i, `**Yedekler (${gid})**\n${lines.join('\n')}`);
      }
      // geri-yukle
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const id = i.options.getString('yedek-id') || (metaList(gid).slice(-1)[0] || {}).id;
      if (!id) return respond(i, '❌ Bu sunucu için yedek bulunamadı.');
      let snap;
      try { snap = readSnapshot(gid, id); } catch (e) { return respond(i, `❌ Yedek okunamadı (şifreleme anahtarı değişmiş olabilir): ${e.message}`); }
      if (!snap) return respond(i, '❌ Yedek bulunamadı.');
      const plan = planRestore(guild, snap);
      if (!plan.rolesToMake.length && !plan.channelsToMake.length) return respond(i, '✅ Yedekteki her şey zaten sunucuda var; yapılacak bir şey yok.');
      const embed = new EmbedBuilder().setColor(0xe67e22).setTitle('Yedekten geri yükleme önizlemesi')
        .setDescription(`Yedek: \`${id}\` • ${fmtLocal(snap.takenAt, cfg.night.tz)} • kaynak: **${snap.name}**\nYalnızca **eksik** olanlar oluşturulur; var olan hiçbir şey silinmez/değiştirilmez.`)
        .addFields(
          { name: `Oluşturulacak roller (${plan.rolesToMake.length})`, value: truncate(plan.rolesToMake.map((r) => r.name).join(', ') || '-', 900) },
          { name: `Oluşturulacak kanallar (${plan.channelsToMake.length})`, value: truncate(plan.channelsToMake.map((c) => c.name).join(', ') || '-', 900) },
          { name: 'Not', value: 'Mesajlar geri gelmez. Rol sırasını ve izinleri sonra kontrol et. Rol üyelikleri arka planda iade edilir.' },
        );
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`backup:go:${gid}:${id}:${i.user.id}`).setLabel('Onayla ve geri yükle').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`backup:no:${i.user.id}`).setLabel('Vazgeç').setStyle(ButtonStyle.Secondary),
      );
      return respond(i, { embeds: [embed], components: [row] });
    },
  );

  ctx.router.autocomplete('yedek', async (i) => {
    if (!ctx.canAdmin(i.guild, i.user.id)) return [];
    const gid = (i.options.getString('sunucu-id') || i.guildId || '').replace(/\D/g, '');
    const tz = i.guildId ? ctx.gcfg(i.guildId).night.tz : 'UTC';
    return metaList(gid).slice(-25).reverse().map((m) => ({
      name: `${fmtLocal(m.at, tz)} · ${m.channels} kanal · ${m.roles} rol${m.auto ? ' · otomatik' : ''}`.slice(0, 100), value: m.id,
    }));
  });

  ctx.router.button('backup:', async (i) => {
    const parts = i.customId.split(':');
    if (parts[1] === 'no') {
      if (parts[2] !== i.user.id) return respond(i, '🔒 Bu düğme sana ait değil.');
      return i.update({ content: 'Vazgeçildi.', embeds: [], components: [] });
    }
    if (parts[1] !== 'go') return;
    const [, , gid, id, uid] = parts;
    if (uid !== i.user.id || !ctx.canAdmin(i.guild, i.user.id)) return respond(i, '🔒 Bu düğme sana ait değil.');
    await i.deferUpdate();
    let snap;
    try { snap = readSnapshot(gid, id); } catch (e) { return i.editReply({ content: `❌ Yedek okunamadı: ${e.message}`, embeds: [], components: [] }); }
    if (!snap) return i.editReply({ content: '❌ Yedek bulunamadı.', embeds: [], components: [] });
    await i.editReply({ content: '⏳ Geri yükleme başladı; kanal sayısına göre birkaç dakika sürebilir…', embeds: [], components: [] });
    const plan = planRestore(i.guild, snap);
    const res = await recreate(i.guild, snap, plan.rolesToMake, plan.channelsToMake, { reason: `Kalkan: yedekten geri yükleme (${id})` });
    await ctx.alert({
      guild: i.guild, level: 'info', title: 'Yedekten geri yükleme tamamlandı',
      description: `<@${i.user.id}> yedek \`${id}\` ile ${res.roles} rol ve ${res.channels} kanal oluşturdu.${res.failedRoles.length || res.failedChannels.length ? `\nBaşarısız: ${[...res.failedRoles, ...res.failedChannels].join(', ')}` : ''}`,
    });
    const lines = [
      `✅ ${res.roles} rol, ${res.channels} kanal oluşturuldu${res.partial ? ` (${res.partial} kanal basitleştirilmiş haliyle)` : ''}.`,
      res.queued ? `👥 ${res.queued} üyeye rolleri arka planda iade ediliyor.` : null,
      res.failedRoles.length ? `⚠️ Oluşturulamayan roller: ${truncate(res.failedRoles.join(', '), 300)}` : null,
      res.failedChannels.length ? `⚠️ Oluşturulamayan kanallar: ${truncate(res.failedChannels.join(', '), 300)}` : null,
      'Rol sırasını ve kanal izinlerini gözden geçirmeyi unutma.',
    ].filter(Boolean);
    return i.editReply({ content: lines.join('\n'), embeds: [], components: [] });
  });

  ctx.every(30 * 60e3, () => api.autoTick(), 'otomatik-yedek');
  ctx.every(30 * 60e3, () => {
    const cut = Date.now() - 6 * 3600e3;
    for (const m of [tomb.channels, tomb.roles]) for (const [k, v] of m) if (v.at < cut) m.delete(k);
  }, 'mezar-gc');
}

module.exports = { name: 'backup', init, serializeRole, serializeChannel };
