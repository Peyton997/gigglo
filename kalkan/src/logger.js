'use strict';
// Günlük: konsol + (isteğe bağlı) döner dosya. Gizli bilgiler (token, API anahtarı, webhook adresi) her satırdan maskelenir.
const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const min = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || 20;
const ring = [];

/* ------------------------------------------------------------------ gizli bilgi maskeleme */
const secrets = new Set();
const PATTERNS = [
  /[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,40}/g, // Discord bot token biçimi
  /https:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+/gi, // webhook adresi
  /bot\d{6,}:[A-Za-z0-9_-]{30,}/g, // Telegram
  /sk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic anahtarı
  /(client_secret|access_token|refresh_token|x-apikey|authorization)(["'\s:=]+)(?:Bearer\s+)?[A-Za-z0-9._-]{12,}/gi,
];

// Bilinen gizli değerleri kaydet (env'den): bunlar metnin neresinde geçerse geçsin maskelenir.
function addSecret(value) {
  const v = String(value || '').trim();
  if (v.length >= 8) secrets.add(v);
}

function redact(text) {
  let s = String(text);
  for (const sec of secrets) if (s.includes(sec)) s = s.split(sec).join('***');
  // Yakalama grubu olmayan desenlerde replace'in 2. ve 3. argümanları "konum" ve "tüm metin"dir; yalnızca gerçek grup (string) varsa koru.
  for (const re of PATTERNS) s = s.replace(re, (m, a, b) => (typeof a === 'string' && typeof b === 'string' ? `${a}${b}***` : '***'));
  return s;
}

/* ------------------------------------------------------------------ dosya (döner) */
let sink = null;
function enableFile(dir, { maxBytes = 2 * 1024 * 1024, keep = 3 } = {}) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    sink = { file: path.join(dir, 'kalkan.log'), maxBytes, keep, size: 0 };
    try { sink.size = fs.statSync(sink.file).size; } catch { sink.size = 0; }
  } catch { sink = null; }
}

function rotate() {
  const { file, keep } = sink;
  try {
    for (let i = keep - 1; i >= 1; i--) {
      if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    if (keep >= 1) fs.renameSync(file, `${file}.1`);
    const old = `${file}.${keep + 1}`;
    if (fs.existsSync(old)) fs.unlinkSync(old);
  } catch { /* yoksay */ }
  sink.size = 0;
}

function writeFile(line) {
  if (!sink) return;
  try {
    if (sink.size > sink.maxBytes) rotate();
    fs.appendFileSync(sink.file, line + '\n');
    sink.size += Buffer.byteLength(line) + 1;
  } catch { /* disk dolu vb.: günlük yüzünden bot durmasın */ }
}

function fmt(a) {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === 'object' && a !== null) {
    try { return JSON.stringify(a); } catch { return String(a); }
  }
  return String(a);
}

function emit(level, args) {
  if (LEVELS[level] < min) return;
  const line = redact(`${new Date().toISOString()} [${level.toUpperCase()}] ${args.map(fmt).join(' ')}`);
  ring.push(line);
  if (ring.length > 300) ring.shift();
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
  writeFile(line);
}

module.exports = {
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
  tail: (n = 15) => ring.slice(-n),
  redact, addSecret, enableFile,
};
