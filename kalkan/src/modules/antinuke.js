'use strict';
// Denetim günlüğü hattı: her olayı diske yedekler; anti-nuke sayaçları, rol koruması, bot ekleme koruması, süreli yetki kilidi.
const {
  Events, AuditLogEvent: A, SlashCommandBuilder, PermissionFlagsBits, InteractionContextType, MessageFlags,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const { criticalList, toBig, CRIT_MASK, code, respond } = require('../util');

const COUNT_MAP = {
  [A.ChannelDelete]: 'channelDelete',
  [A.ChannelCreate]: 'channelCreate',
  [A.RoleDelete]: 'roleDelete',
  [A.RoleCreate]: 'roleCreate',
  [A.MemberBanAdd]: 'ban',
  [A.MemberKick]: 'kick',
  [A.WebhookCreate]: 'webhookCreate',
  [A.MemberPrune]: 'prune',
  [A.EmojiDelete]: 'emojiDelete',
};
const DESTRUCTIVE = new Set(['channelDelete', 'roleDelete', 'ban', 'kick', 'webhookCreate', 'prune', 'emojiDelete']);
const LABEL = {
  channelDelete: 'kanal silme', roleDelete: 'rol silme', channelCreate: 'kanal oluşturma', roleCreate: 'rol oluşturma',
  ban: 'toplu yasaklama', kick: 'toplu atma', webhookCreate: 'webhook oluşturma', prune: 'üye budama', emojiDelete: 'emoji silme',
};
const NOISY = new Set([A.MessageDelete, A.MessagePin, A.MessageUnpin, A.MemberMove, A.MemberDisconnect].filter((x) => x !== undefined));

const counters = new Map();
const bursts = new Map();
const flagged = new Map();
const restoreTimers = new Map();
const botAddSeen = new Map(); // gid:yapan:bot → son ekleme zamanı (aynı botu tekrar eklemek risk puanını katlamasın)

function describe(entry, typeName) {
  const ch = entry.changes || [];
  const nameCh = ch.find((c) => c.key === 'name');
  const name = nameCh ? (nameCh.old ?? nameCh.new) : entry.target && entry.target.name;
  const rec = { type: typeName, actor: entry.executorId || null, target: entry.targetId || null };
  if (name) rec.name = String(name).slice(0, 80);
  if (entry.action === A.MemberRoleUpdate) {
    rec.add = (ch.find((c) => c.key === '$add')?.new || []).map((r) => r.id);
    rec.rem = (ch.find((c) => c.key === '$remove')?.new || []).map((r) => r.id);
  }
  if (entry.action === A.RoleUpdate) {
    const p = ch.find((c) => c.key === 'permissions');
    if (p) { rec.permOld = String(p.old ?? '0'); rec.permNew = String(p.new ?? '0'); }
  }
  if (entry.reason) rec.reason = String(entry.reason).slice(0, 100);
  return rec;
}

function init(ctx) {
  const { client, log, store } = ctx;

  /* ---------------------------------------------------------- süreli yetki kilidi (time-lock) */
  const tlTimers = new Map();
  const timelock = {
    list(gid) { return Object.values(store.data.timelock).filter((t) => !gid || t.gid === gid); },
    schedule(item) {
      store.data.timelock[item.id] = item;
      store.save();
      timelock._arm(item);
    },
    _arm(item) {
      const delay = Math.max(1000, Math.min(item.at - Date.now(), 2 ** 31 - 1));
      const t = setTimeout(() => timelock._fire(item.id).catch((e) => log.error('timelock:', e)), delay);
      if (t.unref) t.unref();
      tlTimers.set(item.id, t);
    },
    async _fire(id) {
      const item = store.data.timelock[id];
      if (!item) return;
      if (item.at > Date.now() + 5000) return timelock._arm(item);
      delete store.data.timelock[id];
      store.save();
      const guild = client.guilds.cache.get(item.gid);
      if (!guild) return;
      const member = await guild.members.fetch(item.uid).catch(() => null);
      const role = guild.roles.cache.get(item.rid);
      if (member && role) {
        await member.roles.add(role.id, 'Kalkan: yetki zaman kilidi doldu').catch(() => {});
        await ctx.alert({ guild, level: 'info', title: 'Yetki zaman kilidi doldu', description: `<@${item.uid}> kişisine **${role.name}** rolü verildi.` });
      }
    },
    cancel(id) {
      const had = !!store.data.timelock[id];
      delete store.data.timelock[id];
      const t = tlTimers.get(id);
      if (t) clearTimeout(t);
      tlTimers.delete(id);
      store.save();
      return had;
    },
    restore() { for (const item of Object.values(store.data.timelock)) timelock._arm(item); },
  };
  ctx.timelock = timelock;

  /* ---------------------------------------------------------- yardımcılar */
  async function restoreBurst(guild, key) {
    const b = bursts.get(key);
    if (!b || !ctx.backup) return null;
    const channels = [...b.channels];
    const roles = [...b.roles];
    b.channels.clear();
    b.roles.clear();
    if (!channels.length && !roles.length) return null;
    return ctx.backup.restoreDeleted(guild, { channels, roles }).catch((e) => { log.error('otomatik geri yükleme:', e); return null; });
  }

  async function onTrigger(guild, cfg, exec, kind, count, key, isOwnerTier) {
    ctx.stat(guild.id, 'antinukeTrigger');
    const actions = [];
    if (isOwnerTier) {
      actions.push('Sahip/güvenilir hesap olduğu için hesaba müdahale edilmedi');
      if (cfg.antinuke.ownerPanic && ctx.panic) {
        const r = await ctx.panic.activate(guild, { by: 'anti-nuke', reason: `${LABEL[kind]} ×${count} (sahip/güvenilir hesap)` }).catch(() => null);
        if (r && !r.already) actions.push('Sunucu kilitlendi (panic)');
      }
      actions.push('Silinenleri geri yüklemek için: /yedek geri-yukle');
    } else {
      const member = await guild.members.fetch(exec).catch(() => null);
      if (member) {
        if (member.user.bot) {
          try { await member.kick('Kalkan anti-nuke'); actions.push('Bot sunucudan atıldı'); } catch { actions.push('Bot atılamadı (rol sırasını kontrol et)'); }
        } else {
          const strip = member.roles.cache.filter((r) => !r.managed && r.id !== guild.id && r.editable && criticalList(r.permissions).length);
          if (strip.size) {
            try {
              await member.roles.remove([...strip.keys()], 'Kalkan anti-nuke');
              ctx.members.ensure(guild.id, exec).stripped = [...strip.keys()];
              actions.push(`${strip.size} kritik rol alındı`);
            } catch { actions.push('Roller alınamadı'); }
          }
          try {
            if (member.moderatable) { await member.timeout(60 * 60e3, 'Kalkan anti-nuke'); actions.push('1 saat susturuldu'); }
          } catch { /* yetki yetersiz */ }
        }
      } else {
        actions.push('Üye sunucuda değil / getirilemedi');
      }
      if (ctx.risk) await ctx.risk.signal(guild, exec, 40, `Anti-nuke: ${LABEL[kind]} ×${count}`);
      if (ctx.watch) ctx.watch.add(guild.id, exec, { reason: `Anti-nuke: ${LABEL[kind]} ×${count}`, by: client.user.id, days: 7 });
      if (cfg.antinuke.autoRestore) {
        const r = await restoreBurst(guild, key);
        if (r) actions.push(`Geri yüklendi: ${r.channels || 0} kanal, ${r.roles || 0} rol`);
        else actions.push('Geri yükleme yapılamadı (yedek yok?)');
      }
    }
    await ctx.alert({
      guild, level: 'critical', title: 'ANTİ-NUKE: toplu yıkıcı işlem tespit edildi',
      description: `<@${exec}> (${code(exec)}) kısa sürede **${LABEL[kind]} ×${count}** yaptı.`,
      fields: [{ name: 'Alınan önlemler', value: actions.map((a) => `• ${a}`).join('\n') }],
      key: `nuke:${exec}`,
    });
    if (ctx.incident) ctx.incident.postBrief(guild, 1).catch(() => {});
  }

  async function countAndAct(entry, guild, cfg, kind) {
    const exec = entry.executorId;
    const now = Date.now();
    const key = `${guild.id}:${exec}`;
    const windowMs = cfg.antinuke.windowSec * 1000;

    if (kind === 'channelDelete' || kind === 'roleDelete') {
      let b = bursts.get(key);
      if (!b || now - b.at > 120e3) { b = { channels: new Set(), roles: new Set(), at: now }; bursts.set(key, b); }
      (kind === 'channelDelete' ? b.channels : b.roles).add(entry.targetId);
      b.at = now;
    }
    const ck = `${key}:${kind}`;
    const arr = (counters.get(ck) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    counters.set(ck, arr);

    const isOwnerTier = guild.ownerId === exec || ctx.isBotOwner(exec);
    let threshold = cfg.antinuke.thresholds[kind] ?? 5;
    if (ctx.isNight(guild.id)) threshold = Math.max(1, Math.floor(threshold / 2));
    if (isOwnerTier) threshold *= 2;

    const already = (flagged.get(key) || 0) > now;
    if (!already) {
      if (arr.length < threshold) return;
      flagged.set(key, now + 10 * 60e3);
      await onTrigger(guild, cfg, exec, kind, arr.length, key, isOwnerTier);
    } else if (cfg.antinuke.autoRestore && !isOwnerTier && (kind === 'channelDelete' || kind === 'roleDelete')) {
      clearTimeout(restoreTimers.get(key));
      const t = setTimeout(() => restoreBurst(guild, key), 3000);
      if (t.unref) t.unref();
      restoreTimers.set(key, t);
    }
  }

  async function guardMemberRoles(entry, guild, cfg) {
    const added = (entry.changes || []).find((c) => c.key === '$add')?.new || [];
    if (!added.length || cfg.roleGuard.mode === 'off') return;
    const exec = entry.executorId;
    const targetId = entry.targetId;
    const night = ctx.isNight(guild.id);
    for (const r of added) {
      const role = guild.roles.cache.get(r.id);
      if (!role || role.managed) continue;
      const crit = criticalList(role.permissions);
      if (!crit.length) continue;
      const execTrusted = ctx.isTrusted(guild, exec);
      const allowedTarget = cfg.roleGuard.allowAdminIds.includes(targetId);
      const lockH = cfg.roleGuard.timeLockHours;
      let verdict = 'allow';
      if (allowedTarget) verdict = 'allow';
      else if (!execTrusted) verdict = 'revert';
      else if (night && !ctx.isBotOwner(exec)) verdict = 'revert';
      else if (lockH > 0) verdict = 'timelock';

      const member = await guild.members.fetch(targetId).catch(() => null);
      const info = `<@${exec}> → <@${targetId}>: **${role.name}** (${crit.join(', ')})`;
      if (verdict === 'allow') {
        await ctx.alert({ guild, level: 'info', title: 'Kritik yetkili rol verildi', description: info });
      } else if (verdict === 'revert') {
        if (member) await member.roles.remove(role.id, 'Kalkan: yetkisiz kritik rol').catch(() => {});
        ctx.stat(guild.id, 'roleGuardRevert');
        if (ctx.risk) await ctx.risk.signal(guild, exec, 40, `Yetkisiz kritik rol verdi (${role.name})`);
        await ctx.alert({
          guild, level: 'high', title: 'Yetkisiz kritik rol geri alındı',
          description: `${info}\n${night ? 'Gece modu açık olduğu için' : 'Yürüten kişi güvenilir listede olmadığı için'} rol geri alındı.`,
          key: `roleguard:${exec}:${targetId}`,
        });
      } else {
        if (member) await member.roles.remove(role.id, 'Kalkan: yetki zaman kilidi').catch(() => {});
        const id = `${guild.id}-${targetId}-${role.id}-${Date.now().toString(36)}`;
        timelock.schedule({ id, gid: guild.id, uid: targetId, rid: role.id, at: Date.now() + lockH * 3600e3, by: exec });
        await ctx.alert({
          guild, level: 'warn', title: `Yetki zaman kilidi: ${lockH} saat beklemeye alındı`,
          description: `${info}\nRol ${lockH} saat sonra otomatik verilecek. İptal için: \`/yetki iptal id:${id}\``,
        });
      }
    }
  }

  async function guardRoleUpdate(entry, guild, cfg) {
    if (cfg.roleGuard.mode === 'off') return;
    const p = (entry.changes || []).find((c) => c.key === 'permissions');
    if (!p) return;
    const oldP = toBig(p.old ?? 0);
    const newP = toBig(p.new ?? 0);
    const gained = newP & ~oldP & CRIT_MASK;
    if (!gained) return;
    const exec = entry.executorId;
    const role = guild.roles.cache.get(entry.targetId);
    if (!role) return;
    const ok = ctx.isTrusted(guild, exec) && !(ctx.isNight(guild.id) && !ctx.isBotOwner(exec));
    if (ok) {
      await ctx.alert({ guild, level: 'info', title: 'Rolün kritik yetkileri artırıldı', description: `<@${exec}> → **${role.name}**: ${criticalList(gained).join(', ')}` });
      return;
    }
    try { await role.setPermissions(oldP, 'Kalkan: yetkisiz yetki yükseltme'); } catch { /* rol sırası yetersiz */ }
    ctx.stat(guild.id, 'roleGuardRevert');
    if (ctx.risk) await ctx.risk.signal(guild, exec, 40, `Rol yetkilerini yükseltti (${role.name})`);
    await ctx.alert({
      guild, level: 'high', title: 'Yetkisiz yetki yükseltme geri alındı',
      description: `<@${exec}> **${role.name}** rolüne kritik yetki ekledi (${criticalList(gained).join(', ')}). Geri alındı.`,
      key: `roleup:${exec}:${role.id}`,
    });
  }

  function botRow(gid, botId, execId) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`kb:allow:${gid}:${botId}`).setLabel('Bu bota izin ver').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`kb:restore:${gid}:${execId}`).setLabel('Kullanıcının yetkisini geri yükle').setEmoji('🔓').setStyle(ButtonStyle.Primary),
    );
  }

  async function guardBotAdd(entry, guild) {
    const botId = entry.targetId;
    const exec = entry.executorId;
    const cfg = ctx.gcfg(guild.id);
    const member = await guild.members.fetch(botId).catch(() => null);
    const perms = member ? criticalList(member.permissions) : [];
    const allowedBot = (cfg.allowedBots || []).includes(botId);
    const trusted = ctx.isTrusted(guild, exec) && !(ctx.isNight(guild.id) && !ctx.isBotOwner(exec));
    if (!trusted && !allowedBot) {
      let action = 'tespit edildi';
      if (member) {
        try { await member.kick('Kalkan: yetkisiz bot ekleme'); action = 'bot sunucudan atıldı'; } catch { action = 'bot atılamadı (rol sırasını kontrol et)'; }
      }
      const seenKey = `${guild.id}:${exec}:${botId}`;
      const repeat = Date.now() - (botAddSeen.get(seenKey) || 0) < 30 * 60e3;
      botAddSeen.set(seenKey, Date.now());
      if (botAddSeen.size > 500) for (const [k, t] of botAddSeen) if (Date.now() - t > 30 * 60e3) botAddSeen.delete(k);
      if (ctx.risk && !repeat) await ctx.risk.signal(guild, exec, 40, 'Yetkisiz bot ekledi');
      ctx.stat(guild.id, 'botKick');
      await ctx.alert({
        guild, level: 'high', title: 'Yetkisiz bot ekleme',
        description: `<@${exec}> sunucuya <@${botId}> botunu ekledi → ${action}.\nBotun kritik yetkileri: ${perms.join(', ') || 'yok'}${repeat ? '\nAynı bot kısa süre önce de eklenmişti; risk puanı tekrar artırılmadı.' : ''}\n\nBu bot güvenilirse aşağıdan izin ver, sonra yeniden eklenebilir.`,
        key: `botadd:${botId}`,
        components: [botRow(guild.id, botId, exec)],
      });
    } else {
      await ctx.alert({
        guild, level: perms.length ? 'warn' : 'info', title: allowedBot && !trusted ? 'İzinli bot eklendi' : 'Yeni bot eklendi',
        description: `<@${exec}> → <@${botId}>\nKritik yetkiler: ${perms.join(', ') || 'yok'}${perms.length ? '\nBotun gerçekten bu yetkilere ihtiyacı var mı kontrol et.' : ''}`,
      });
    }
  }

  // Düğmeler (sunucu kanalında ve bot sahibine giden DM'de çalışır; kimlik düğmenin içinde taşınır).
  ctx.router.button('kb:', async (i) => {
    const [, act, gid, id] = i.customId.split(':');
    const guild = client.guilds.cache.get(gid);
    if (!guild) return respond(i, '❌ Sunucuya erişilemiyor.');
    const admin = ctx.canAdmin(guild, i.user.id);
    if (act === 'allow') {
      if (!admin) return respond(i, '🔒 Bot izni yalnızca bot sahibi içindir.');
      const cfg = ctx.gcfg(gid);
      cfg.allowedBots = cfg.allowedBots || [];
      if (!cfg.allowedBots.includes(id)) cfg.allowedBots.push(id);
      ctx.save();
      ctx.events.append(gid, { type: 'BOT_ALLOW', actor: i.user.id, target: id });
      await ctx.alert({ guild, level: 'info', title: 'Bot izin listesine eklendi', description: `<@${i.user.id}> <@${id}> botuna izin verdi. Bot artık eklenince atılmaz; yeniden eklenebilir.` });
      try {
        const row = ActionRowBuilder.from(i.message.components[0]);
        for (const b of row.components) if (b.data.custom_id === i.customId) b.setDisabled(true).setLabel('İzin verildi').setStyle(ButtonStyle.Secondary);
        return await i.update({ components: [row] });
      } catch {
        return respond(i, '✅ Bot izin listesine eklendi. Şimdi yeniden ekleyebilirsin.');
      }
    }
    if (act === 'restore') {
      if (!admin && !ctx.isTrusted(guild, i.user.id)) return respond(i, '🔒 Bu işlem yalnızca güvenilir yetkililer içindir.');
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const done = ctx.risk ? await ctx.risk.undo(guild, id, i.user.username) : [];
      if (done === null) return respond(i, 'ℹ️ Üye sunucuda değil.');
      ctx.events.append(gid, { type: 'UNDO', actor: i.user.id, target: id });
      await ctx.alert({ guild, level: 'info', title: 'Önlemler geri alındı', description: `<@${i.user.id}>, <@${id}> için otomatik önlemleri geri aldı.\n${done.join(', ') || 'Geri alınacak bir şey yoktu.'}` });
      return respond(i, done.length ? `✅ ${done.join(', ')}.` : 'ℹ️ Geri alınacak bir şey yoktu.');
    }
  }, { dm: true });

  ctx.router.add(
    new SlashCommandBuilder().setName('bot-izin').setDescription('Eklenince atılmayacak (güvenilir) botlar')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator).setContexts(InteractionContextType.Guild)
      .addSubcommand((s) => s.setName('ekle').setDescription('Bir bota izin ver (bot kimliği)')
        .addStringOption((o) => o.setName('id').setDescription('Botun kullanıcı kimliği').setRequired(true)))
      .addSubcommand((s) => s.setName('sil').setDescription('Bot iznini kaldır')
        .addStringOption((o) => o.setName('id').setDescription('Botun kullanıcı kimliği').setRequired(true)))
      .addSubcommand((s) => s.setName('liste').setDescription('İzinli botları göster')),
    async (i) => {
      const cfg = ctx.gcfg(i.guild.id);
      cfg.allowedBots = cfg.allowedBots || [];
      const sub = i.options.getSubcommand();
      if (sub === 'liste') {
        return respond(i, cfg.allowedBots.length ? `✅ İzinli botlar:\n${cfg.allowedBots.map((b) => `• <@${b}> (${code(b)})`).join('\n')}` : 'ℹ️ İzinli bot yok. Yetkisiz eklenen botlar atılır.');
      }
      const id = (i.options.getString('id', true).match(/\d{15,25}/) || [])[0];
      if (!id) return respond(i, '❌ Geçerli bir kullanıcı kimliği gir (15-25 haneli sayı).');
      if (sub === 'ekle') {
        if (!cfg.allowedBots.includes(id)) cfg.allowedBots.push(id);
        ctx.save();
        ctx.events.append(i.guild.id, { type: 'BOT_ALLOW', actor: i.user.id, target: id });
        return respond(i, `✅ <@${id}> (${code(id)}) izinli. Bot şimdi eklenirse atılmaz.`);
      }
      cfg.allowedBots = cfg.allowedBots.filter((b) => b !== id);
      ctx.save();
      return respond(i, `✅ <@${id}> izni kaldırıldı.`);
    },
    { access: 'admin' },
  );

  async function handleEntry(entry, guild) {
    const cfg = ctx.gcfg(guild.id);
    const typeName = A[entry.action] || String(entry.action);
    if (!NOISY.has(entry.action)) ctx.events.append(guild.id, describe(entry, typeName));
    const exec = entry.executorId;
    if (!exec || (client.user && exec === client.user.id)) return;

    const kind = COUNT_MAP[entry.action];
    if (kind && DESTRUCTIVE.has(kind) && ctx.risk) ctx.risk.noteAudit(guild, exec, typeName).catch(() => {});
    if (cfg.modules.antinuke && kind) await countAndAct(entry, guild, cfg, kind);
    if (cfg.modules.roleGuard) {
      if (entry.action === A.MemberRoleUpdate) await guardMemberRoles(entry, guild, cfg);
      else if (entry.action === A.RoleUpdate) await guardRoleUpdate(entry, guild, cfg);
    }
    if (entry.action === A.BotAdd && cfg.modules.antinuke) await guardBotAdd(entry, guild);
    if (entry.action === A.GuildUpdate) {
      const keys = (entry.changes || []).map((c) => c.key);
      if (keys.includes('vanity_url_code') || keys.includes('owner_id')) {
        await ctx.alert({
          guild, level: 'high', title: 'Sunucu özel URL\'si / sahipliği değişti',
          description: `<@${exec}> şu ayarları değiştirdi: ${keys.join(', ')}`, key: `guildupdate:${exec}`,
        });
      }
    }
  }

  client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
    handleEntry(entry, guild).catch((e) => log.error('denetim günlüğü işleme hatası:', e));
  });

  ctx.every(10 * 60e3, () => {
    const now = Date.now();
    for (const [k, v] of flagged) if (v < now) flagged.delete(k);
    for (const [k, arr] of counters) { const kept = arr.filter((t) => now - t < 120e3); if (kept.length) counters.set(k, kept); else counters.delete(k); }
    for (const [k, b] of bursts) if (now - b.at > 300e3) bursts.delete(k);
  }, 'antinuke-gc');
}

module.exports = { name: 'antinuke', init, COUNT_MAP, describe, _internals: { counters, bursts, flagged } };
