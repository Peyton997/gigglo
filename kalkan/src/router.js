'use strict';
const crypto = require('crypto');
const { MessageFlags, PermissionFlagsBits: P } = require('discord.js');

// Modüllerin komut, buton, menü ve modal işleyicilerini tek yerde toplar; ortak yetki kontrolü ve hata yönetimini yapar.
//
// router.add(builder, handler, meta?)   meta.access: 'public' (varsayılan) | 'mod' | 'trusted' | 'admin'
//                                       meta.dm: true ise DM'de de çalışır (varsayılan: yalnızca sunucuda)
// Yetki iki yerde denetlenir: Discord tarafında (builder.setDefaultMemberPermissions) ve burada (uygulama tarafı).
function createRouter() {
  const builders = [];
  const handlers = new Map(); // komut adı → { fn, meta }
  const comps = { button: [], select: [], modal: [] };
  const completers = new Map();
  const stats = { total: 0, errors: 0, denied: 0, lastMs: 0, maxMs: 0 };

  function addPrefix(kind, prefix, fn) {
    if (!prefix) throw new Error(`${kind} öneki boş olamaz`);
    if (comps[kind].some((c) => c.prefix === prefix)) throw new Error(`Yinelenen ${kind} öneki: ${prefix}`);
    comps[kind].push({ prefix, fn });
    comps[kind].sort((a, b) => b.prefix.length - a.prefix.length); // en uzun önek önce eşleşsin
  }
  const findPrefix = (kind, id) => comps[kind].find((c) => id.startsWith(c.prefix))?.fn || null;

  const STAFF_BITS = [P.ModerateMembers, P.KickMembers, P.BanMembers, P.ManageMessages].filter(Boolean);

  // Uygulama tarafı yetki denetimi. Reddedilirse kullanıcıya gösterilecek metni döndürür.
  function denyReason(ctx, i, meta) {
    const t = (k, v) => (ctx.t ? ctx.t(i.guildId, k, v) : k);
    if (!meta.dm && i.inGuild && !i.inGuild()) return t('err.guildOnly');
    const access = meta.access || 'public';
    if (access === 'public' || !i.guild) return null;
    const uid = i.user.id;
    if (access === 'admin') return ctx.canAdmin(i.guild, uid) ? null : t('err.needOwner');
    if (access === 'trusted') return ctx.isTrusted(i.guild, uid) ? null : t('err.needTrusted');
    if (access === 'mod') {
      if (ctx.isTrusted(i.guild, uid)) return null;
      if (i.memberPermissions && STAFF_BITS.some((b) => i.memberPermissions.has(b))) return null;
      if (ctx.perm && i.member && ctx.perm.isStaff(i.guild, i.member)) return null;
      return t('err.noPerm');
    }
    return null;
  }

  async function reply(i, msg) {
    const payload = { content: msg, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
    try {
      if (i.deferred || i.replied) await i.followUp(payload);
      else await i.reply(payload);
    } catch { /* yanıt verilemedi (süre dolmuş olabilir) */ }
  }

  return {
    add(builder, handler, meta = {}) {
      if (handlers.has(builder.name)) throw new Error(`Yinelenen komut adı: ${builder.name}`);
      builders.push(builder);
      handlers.set(builder.name, { fn: handler, meta });
    },
    button(prefix, fn) { addPrefix('button', prefix, fn); },
    select(prefix, fn) { addPrefix('select', prefix, fn); },
    modal(prefix, fn) { addPrefix('modal', prefix, fn); },
    autocomplete(commandName, fn) { completers.set(commandName, fn); },
    json() { return builders.map((b) => b.toJSON()); },
    names() { return [...handlers.keys()]; },
    stats() { return { ...stats }; },
    prefixes() { return { button: comps.button.map((c) => c.prefix), select: comps.select.map((c) => c.prefix), modal: comps.modal.map((c) => c.prefix) }; },

    async dispatch(ctx, interaction) {
      if (interaction.isAutocomplete?.()) {
        const ac = completers.get(interaction.commandName);
        if (!ac) return;
        try {
          await interaction.respond((await ac(interaction, ctx)).slice(0, 25));
        } catch { /* zaman aşımı: sessizce geç */ }
        return;
      }
      let fn = null;
      let meta = {};
      let label = '';
      if (interaction.isChatInputCommand?.() || interaction.isUserContextMenuCommand?.() || interaction.isMessageContextMenuCommand?.()) {
        const h = handlers.get(interaction.commandName);
        if (h) { fn = h.fn; meta = h.meta; label = `/${interaction.commandName}`; }
      } else if (interaction.isButton?.()) {
        fn = findPrefix('button', interaction.customId); label = interaction.customId;
      } else if (interaction.isAnySelectMenu?.() || interaction.isStringSelectMenu?.()) {
        fn = findPrefix('select', interaction.customId); label = interaction.customId;
      } else if (interaction.isModalSubmit?.()) {
        fn = findPrefix('modal', interaction.customId); label = interaction.customId;
      }
      if (!fn) return;

      const denied = denyReason(ctx, interaction, meta);
      if (denied) { stats.denied++; return reply(interaction, denied); }

      const t0 = Date.now();
      stats.total++;
      try {
        await fn(interaction, ctx);
      } catch (e) {
        stats.errors++;
        // Discord tarafında süresi dolmuş / zaten yanıtlanmış etkileşimler kullanıcıya hata göstermeyi gerektirmez.
        if (e && (e.code === 10062 || e.code === 40060)) {
          ctx.log.warn(`etkileşim yanıtlanamadı (${e.code}): ${label}`);
        } else {
          const id = crypto.randomBytes(3).toString('hex');
          ctx.log.error(`etkileşim hatası [${id}] ${label}:`, e);
          const msg = e && e.code === 50013
            ? (ctx.t ? ctx.t(interaction.guildId, 'err.botPerm', { perm: 'bu işlem için gereken izin / rol sırası' }) : 'Botun yetkisi yetersiz.')
            : (ctx.t ? ctx.t(interaction.guildId, 'err.generic', { id }) : `Bir hata oluştu (${id}).`);
          await reply(interaction, msg);
        }
      } finally {
        stats.lastMs = Date.now() - t0;
        if (stats.lastMs > stats.maxMs) stats.maxMs = stats.lastMs;
      }
    },

    async register(client, guildIds) {
      const json = this.json();
      if (json.length > 100) throw new Error(`Komut sayısı Discord sınırını aşıyor: ${json.length}/100`);
      const ids = guildIds && guildIds.length ? guildIds : [...client.guilds.cache.keys()];
      let ok = 0;
      for (const gid of ids) {
        try {
          await client.application.commands.set(json, gid);
          ok++;
        } catch (e) {
          console.warn(`[komutlar] ${gid} için kaydedilemedi: ${e.message}`);
        }
      }
      return ok;
    },
  };
}

module.exports = { createRouter };
