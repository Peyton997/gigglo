'use strict';
const { PermissionFlagsBits: P, MessageFlags } = require('discord.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ süre */
// sn = saniye, dk/m = dakika, sa/s/h = saat, g/d = gün, hf/w = hafta   (örn. 2s = 2 saat, 30dk, 1g 2sa)
const UNIT_MS = { sn: 1e3, dk: 6e4, m: 6e4, sa: 36e5, s: 36e5, h: 36e5, g: 864e5, d: 864e5, hf: 6048e5, w: 6048e5 };

function parseDuration(input) {
  if (input === null || input === undefined) return null;
  const str = String(input).trim().toLowerCase().replace(',', '.');
  if (!str) return null;
  const re = /(\d+(?:\.\d+)?)\s*(sn|dk|sa|hf|s|h|m|g|d|w)(?![a-zçğıöşü])/g;
  let total = 0;
  let consumed = '';
  let m;
  while ((m = re.exec(str))) {
    total += parseFloat(m[1]) * UNIT_MS[m[2]];
    consumed += m[0];
  }
  if (!consumed || consumed.replace(/\s+/g, '') !== str.replace(/\s+/g, '')) return null;
  return Math.round(total);
}

function fmtDuration(ms) {
  if (!(ms > 0)) return '0 sn';
  let s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60;
  const parts = [];
  if (d) parts.push(`${d} g`);
  if (h) parts.push(`${h} sa`);
  if (m) parts.push(`${m} dk`);
  if (s && !d && !h) parts.push(`${s} sn`);
  return parts.join(' ') || '0 sn';
}

function minutesOfDay(tz, date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
    const h = Number(parts.find((p) => p.type === 'hour').value) % 24;
    const m = Number(parts.find((p) => p.type === 'minute').value);
    return h * 60 + m;
  } catch {
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }
}

function hhmm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// Gece modu penceresinde miyiz?
function inNightWindow(night, date = new Date()) {
  if (!night || !night.enabled) return false;
  const a = hhmm(night.start);
  const b = hhmm(night.end);
  if (a === null || b === null) return false;
  const now = minutesOfDay(night.tz || 'UTC', date);
  return a <= b ? now >= a && now < b : now >= a || now < b;
}

function weekKey(d = new Date()) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ metin */
const truncate = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s;
};
const defang = (u) => String(u).replace(/^http/i, 'hxxp').replace(/\./g, '[.]');
const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
const unixRel = (t) => `<t:${Math.floor(t / 1000)}:R>`;
const unixFull = (t) => `<t:${Math.floor(t / 1000)}:f>`;
const code = (s) => '`' + String(s ?? '').replace(/`/g, "'") + '`';

/* ------------------------------------------------------------------ kuyruk */
class RateQueue {
  constructor(gap = 1000, jitter = 0) {
    this.gap = gap;
    this.jitter = jitter;
    this.q = [];
    this.busy = false;
  }
  add(fn) {
    return new Promise((resolve, reject) => {
      this.q.push({ fn, resolve, reject });
      this._pump();
    });
  }
  async _pump() {
    if (this.busy) return;
    this.busy = true;
    while (this.q.length) {
      const { fn, resolve, reject } = this.q.shift();
      try { resolve(await fn()); } catch (e) { reject(e); }
      await sleep(this.gap + Math.random() * this.jitter);
    }
    this.busy = false;
  }
  get size() { return this.q.length; }
}

/* ------------------------------------------------------------------ yetkiler */
const CRIT_DEFS = [
  ['Administrator', 'Yönetici'],
  ['ManageGuild', 'Sunucuyu Yönet'],
  ['ManageRoles', 'Rolleri Yönet'],
  ['ManageChannels', 'Kanalları Yönet'],
  ['ManageWebhooks', 'Webhookları Yönet'],
  ['BanMembers', 'Üyeleri Yasakla'],
  ['KickMembers', 'Üyeleri At'],
  ['ManageGuildExpressions', 'İfadeleri Yönet'],
].filter(([k]) => P[k] !== undefined).map(([k, tr]) => ({ key: k, bit: P[k], tr }));

const CRIT_MASK = CRIT_DEFS.reduce((a, d) => a | d.bit, 0n);

const toBig = (v) => {
  if (typeof v === 'bigint') return v;
  if (v && v.bitfield !== undefined) return BigInt(v.bitfield);
  try { return BigInt(v ?? 0); } catch { return 0n; }
};

function criticalList(perms) {
  const b = toBig(perms);
  if ((b & P.Administrator) === P.Administrator) return ['Yönetici'];
  return CRIT_DEFS.filter((d) => (b & d.bit) === d.bit).map((d) => d.tr);
}
const hasCritical = (perms) => criticalList(perms).length > 0;

/* ------------------------------------------------------------------ etkileşim */
async function respond(i, payload) {
  const p = typeof payload === 'string' ? { content: payload } : { ...payload };
  if (!p.allowedMentions) p.allowedMentions = { parse: [] };
  if (i.deferred || i.replied) {
    delete p.flags;
    return i.editReply(p);
  }
  return i.reply({ ...p, flags: MessageFlags.Ephemeral });
}

/* ------------------------------------------------------------------ ağ */
// Boyut sınırlı, SSRF korumalı indirme (ayrıntı: src/net.js). İmza geriye dönük uyumludur.
const downloadLimited = (url, maxBytes, opts = {}) => require('./net').download(url, maxBytes, opts);
// Dosyanın yalnızca ilk n baytı (tür imzası için).
const peekBytes = (url, n, opts = {}) => require('./net').peek(url, n, opts);

module.exports = {
  sleep, parseDuration, fmtDuration, minutesOfDay, hhmm, inNightWindow, weekKey,
  truncate, defang, chunk, unixRel, unixFull, code,
  RateQueue, CRIT_DEFS, CRIT_MASK, toBig, criticalList, hasCritical,
  respond, downloadLimited, peekBytes,
};
