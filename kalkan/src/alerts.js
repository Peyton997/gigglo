'use strict';
const { EmbedBuilder } = require('discord.js');
const { truncate } = require('./util');

const COLORS = { info: 0xff7ac6, ok: 0x2ecc71, warn: 0xf1c40f, high: 0xe67e22, critical: 0xe74c3c }; // info = Gigglo pembesi
const ICONS = { info: 'ℹ️', ok: '✅', warn: '⚠️', high: '🚨', critical: '🛑' };

function createAlerts(ctx) {
  const { client, env, log } = ctx;
  const recent = new Map();

  async function sendToChannel(guild, channelId, payload) {
    if (!guild || !channelId) return false;
    try {
      const ch = guild.channels.cache.get(channelId) || (await guild.channels.fetch(channelId).catch(() => null));
      if (!ch || !ch.isTextBased || !ch.isTextBased()) return false;
      await ch.send({ allowedMentions: { parse: [] }, ...payload });
      return true;
    } catch (e) {
      if (log.debug) log.debug('kanala mesaj gönderilemedi:', e.message);
      return false;
    }
  }

  async function logEmbed(guild, embed, kind = 'log') {
    if (!guild) return false;
    const cfg = ctx.gcfg(guild.id);
    return sendToChannel(guild, cfg.channels[kind] || cfg.channels.log, { embeds: [embed] });
  }

  // Sunucu dışı acil uyarı: Telegram, ntfy ve/veya webhook. Yapılandırılmamışsa sessizce atlanır.
  function externalChannels() {
    const out = [];
    if (env.telegramToken && env.telegramChat) out.push('Telegram');
    if (env.ntfyTopic) out.push('ntfy');
    if (env.alertWebhook) out.push('Webhook');
    return out;
  }

  async function externalAlert(level, title, text) {
    const body = `[${env.botName}] ${title}\n${text || ''}`.slice(0, 3500);
    const jobs = [];
    const post = (url, json) => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(json), signal: AbortSignal.timeout(8000),
    });
    if (env.telegramToken && env.telegramChat) {
      jobs.push(post(`https://api.telegram.org/bot${env.telegramToken}/sendMessage`, {
        chat_id: env.telegramChat, text: body.slice(0, 4000), disable_web_page_preview: true,
      }));
    }
    if (env.ntfyTopic) {
      jobs.push(post(env.ntfyServer, {
        topic: env.ntfyTopic, title: `${env.botName}: ${title}`.slice(0, 200),
        message: (text || title).slice(0, 3000), priority: level === 'critical' ? 5 : 4, tags: ['rotating_light'],
      }));
    }
    if (env.alertWebhook) {
      jobs.push(post(env.alertWebhook, { username: env.botName, content: body.slice(0, 1900), allowed_mentions: { parse: [] } }));
    }
    await Promise.allSettled(jobs);
    return jobs.length;
  }

  async function alert({ guild = null, guildId = null, level = 'warn', title, description = '', fields = [], key = null }) {
    try {
      const gid = (guild && guild.id) || guildId || 'global';
      if (key) {
        const k = `${gid}:${key}`;
        const now = Date.now();
        if (now - (recent.get(k) || 0) < (level === 'critical' ? 10000 : 60000)) return;
        recent.set(k, now);
        if (recent.size > 500) for (const [kk, v] of recent) if (now - v > 120000) recent.delete(kk);
      }
      const g = guild || (guildId ? client.guilds.cache.get(guildId) : null);
      const embed = new EmbedBuilder()
        .setColor(COLORS[level] ?? COLORS.warn)
        .setTitle(truncate(`${ICONS[level] || ''} ${title}`, 250))
        .setDescription(truncate(description || '​', 3800))
        .setFooter({ text: 'Gigglo Security 🛡️' })
        .setTimestamp();
      for (const f of fields.slice(0, 20)) {
        embed.addFields({ name: truncate(f.name, 250) || '​', value: truncate(String(f.value ?? '-') || '-', 1000), inline: !!f.inline });
      }
      if (g) {
        const cfg = ctx.gcfg(g.id);
        await sendToChannel(g, cfg.channels.alert || cfg.channels.log, { embeds: [embed] });
      }
      if (level === 'high' || level === 'critical') {
        const ids = new Set(env.ownerIds);
        if (level === 'critical') for (const id of env.backupOwnerIds) ids.add(id);
        for (const id of ids) ctx.dm(id, { embeds: [embed] }).catch(() => {});
        externalAlert(level, title, `${description}\n${fields.map((f) => `${f.name}: ${f.value}`).join('\n')}`).catch(() => {});
      }
      if (ctx.events) ctx.events.append(gid, { type: 'ALERT', level, name: title });
    } catch (e) {
      log.error('uyarı gönderilemedi:', e);
    }
  }

  return { alert, logEmbed, sendToChannel, externalAlert, externalChannels };
}

module.exports = { createAlerts, COLORS, ICONS };
