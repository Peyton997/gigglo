'use strict';
// Ortak arayüz parçaları: tutarlı embed renkleri, sayfalama (◀ ▶) ve onay düğmesi (Onayla / Vazgeç).
// Tasarım ilkeleri: sade embed, başarı/uyarı/hata için ayrı renk, yönetici yanıtları ephemeral, mobilde sığan kısa metinler.
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { randomId } = require('./crypto');
const { truncate, respond } = require('./util');

// Gigglo görünümü: bilgi/nötr embedler Gigglo pembesi, durum renkleri (başarı/uyarı/hata) anlamını korur.
const GIGGLO_PINK = 0xff7ac6;
const FOOTER = 'Gigglo Security 🛡️';
const COLORS = { ok: 0x2ecc71, info: GIGGLO_PINK, warn: 0xf1c40f, error: 0xe74c3c, high: 0xe67e22, mod: 0x9b59b6, neutral: GIGGLO_PINK };

function embed(kind, title, description = '', fields = []) {
  const e = new EmbedBuilder().setColor(COLORS[kind] ?? COLORS.info).setFooter({ text: FOOTER }).setTimestamp();
  if (title) e.setTitle(truncate(title, 250));
  if (description) e.setDescription(truncate(description, 4000));
  for (const f of fields.slice(0, 25)) {
    e.addFields({ name: truncate(String(f.name) || '​', 250), value: truncate(String(f.value ?? '-') || '-', 1000), inline: !!f.inline });
  }
  return e;
}

// Uzun listeleri embed açıklaması sayfalarına böler (satır bölünmez).
function pagesFromLines(lines, { title = '', kind = 'info', perPage = 10, maxChars = 3800, empty = 'Kayıt yok.' } = {}) {
  if (!lines.length) return [embed(kind, title, empty)];
  const pages = [];
  let cur = [];
  let len = 0;
  for (const l of lines) {
    if (cur.length >= perPage || (len + l.length + 1 > maxChars && cur.length)) { pages.push(cur); cur = []; len = 0; }
    cur.push(l);
    len += l.length + 1;
  }
  if (cur.length) pages.push(cur);
  return pages.map((p, n) => embed(kind, title, p.join('\n')).setFooter({ text: `${FOOTER} • Sayfa ${n + 1}/${pages.length}` }));
}

const sessions = new Map(); // sayfalama: id → { pages, uid, idx, at }
const pending = new Map(); // onay: id → { uid, onYes, at, ttl }
const installed = new WeakSet();
const SESSION_TTL = 10 * 60e3;

function pageRow(sid, idx, total) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`pg:${sid}:first`).setEmoji('⏮️').setStyle(ButtonStyle.Secondary).setDisabled(idx === 0),
    new ButtonBuilder().setCustomId(`pg:${sid}:prev`).setEmoji('◀️').setStyle(ButtonStyle.Primary).setDisabled(idx === 0),
    new ButtonBuilder().setCustomId(`pg:${sid}:noop`).setLabel(`${idx + 1}/${total}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(`pg:${sid}:next`).setEmoji('▶️').setStyle(ButtonStyle.Primary).setDisabled(idx >= total - 1),
    new ButtonBuilder().setCustomId(`pg:${sid}:last`).setEmoji('⏭️').setStyle(ButtonStyle.Secondary).setDisabled(idx >= total - 1),
  );
}

const view = (pages, sid, idx) => {
  const p = pages[idx];
  const base = p && typeof p.toJSON === 'function' ? { embeds: [p] } : { ...p };
  return { ...base, components: pages.length > 1 ? [pageRow(sid, idx, pages.length)] : [], allowedMentions: { parse: [] } };
};

// Sayfalı yanıt. pages: EmbedBuilder dizisi (ya da {content, embeds} nesneleri).
async function paginate(ctx, i, pages, { ephemeral = true } = {}) {
  ensure(ctx);
  if (!pages.length) pages = [embed('info', '', 'Gösterilecek kayıt yok.')];
  const sid = randomId(4);
  if (pages.length > 1) sessions.set(sid, { pages, uid: i.user.id, idx: 0, at: Date.now() });
  const payload = view(pages, sid, 0);
  if (i.deferred || i.replied) return i.editReply(payload);
  return i.reply({ ...payload, ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}) });
}

// Onay isteği: kullanıcı "Onayla"ya basarsa onYes(buttonInteraction) çalışır. 60 sn sonra geçersiz olur.
async function confirm(ctx, i, { text, onYes, yes = 'Onayla', no = 'Vazgeç', danger = true, ttlMs = 60e3 }) {
  ensure(ctx);
  const id = randomId(4);
  pending.set(id, { uid: i.user.id, onYes, at: Date.now(), ttl: ttlMs });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`cf:${id}:y`).setLabel(yes).setStyle(danger ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`cf:${id}:n`).setLabel(no).setStyle(ButtonStyle.Secondary),
  );
  const payload = { content: truncate(text, 1900), components: [row], allowedMentions: { parse: [] } };
  if (i.deferred || i.replied) return i.editReply(payload);
  return i.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

function ensure(ctx) {
  if (installed.has(ctx)) return;
  installed.add(ctx);
  const t = (gid, k) => (ctx.t ? ctx.t(gid, k) : k);

  ctx.router.button('pg:', async (b) => {
    const [, sid, act] = b.customId.split(':');
    const s = sessions.get(sid);
    if (!s) return b.update({ components: [] }).catch(() => {});
    if (s.uid !== b.user.id) return respond(b, t(b.guildId, 'err.notYours'));
    const last = s.pages.length - 1;
    if (act === 'first') s.idx = 0;
    else if (act === 'prev') s.idx = Math.max(0, s.idx - 1);
    else if (act === 'next') s.idx = Math.min(last, s.idx + 1);
    else if (act === 'last') s.idx = last;
    s.at = Date.now();
    return b.update(view(s.pages, sid, s.idx));
  });

  ctx.router.button('cf:', async (b) => {
    const [, id, act] = b.customId.split(':');
    const p = pending.get(id);
    if (!p || Date.now() - p.at > p.ttl) {
      pending.delete(id);
      return b.update({ content: t(b.guildId, 'err.expired'), components: [] });
    }
    if (p.uid !== b.user.id) return respond(b, t(b.guildId, 'err.notYours'));
    pending.delete(id);
    if (act !== 'y') return b.update({ content: 'Vazgeçildi.', components: [] });
    return p.onYes(b);
  });

  ctx.every(60e3, () => {
    const now = Date.now();
    for (const [k, v] of sessions) if (now - v.at > SESSION_TTL) sessions.delete(k);
    for (const [k, v] of pending) if (now - v.at > v.ttl + 30e3) pending.delete(k);
  }, 'ui-gc');
}

module.exports = { COLORS, embed, pagesFromLines, paginate, confirm, ensure, _sessions: sessions, _pending: pending };
