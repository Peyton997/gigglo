'use strict';
const { PATTERNS, BUILTIN_ALLOW } = require('../data/profanity');

const LEVELS = { hafif: 1, orta: 2, sert: 3 };
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i', '|': 'i' };
const FOLD = { ç: 'c', ş: 's', ğ: 'g', ö: 'o', ü: 'u', ə: 'e', â: 'a', î: 'i', û: 'u', ê: 'e', ô: 'o' };
const INVISIBLE = /[​-‏‪-‮⁠﻿­]/g;

// r: ham, f: aksan katlı (ı korunur), c: f + tekrarlar tek harf
function variants(token) {
  const r = token;
  let f = '';
  for (const ch of r) f += FOLD[ch] ?? ch;
  f = f.normalize('NFD').replace(/\p{M}/gu, '');
  const c = f.replace(/(.)\1+/g, '$1');
  return { r, f, c };
}

function tokenize(text) {
  let s = String(text || '').normalize('NFC').replace(INVISIBLE, '');
  // Discord işaretleri ve bağlantılar küfür taramasına girmez
  s = s.replace(/<a?:\w+:\d+>|<[@#][!&]?\d+>|https?:\/\/\S+|www\.\S+/gi, ' ');
  s = s.toLocaleLowerCase('tr');
  const raw = s.split(/[^\p{L}\p{N}@$!|]+/u).filter(Boolean);
  const tokens = [];
  for (let t of raw) {
    t = t.replace(/^[!|$@]+|[!|]+$/g, '');
    if (!t) continue;
    const letters = (t.match(/\p{L}/gu) || []).length;
    if (letters === 0) continue;
    if (letters >= 2) t = t.replace(/[013457@$!|]/g, (m) => LEET[m]);
    t = t.replace(/[^\p{L}]/gu, '');
    if (t) tokens.push(t);
  }
  // "s i k t i r" gibi aralıklı harfleri birleştir
  const joined = [];
  let run = [];
  for (const t of tokens.concat(['\u0000\u0000'])) {
    if (t.length === 1) run.push(t);
    else {
      if (run.length >= 3) joined.push(run.join(''));
      run = [];
    }
  }
  return tokens.concat(joined);
}

// { word, level } ya da null
function checkProfanity(text, { level = 'orta', custom = [], allow = [] } = {}) {
  const max = LEVELS[level] || 2;
  const allowSet = new Set([...BUILTIN_ALLOW, ...allow.map((a) => String(a).toLocaleLowerCase('tr'))]);
  const customV = custom
    .map((w) => String(w).toLocaleLowerCase('tr').trim())
    .filter(Boolean)
    .map((w) => (w.endsWith('*') ? { prefix: true, c: variants(w.slice(0, -1)).c } : { prefix: false, c: variants(w).c }));

  for (const tok of tokenize(text)) {
    const v = variants(tok);
    if (allowSet.has(v.r) || allowSet.has(v.f) || allowSet.has(v.c)) continue;
    for (const p of PATTERNS) {
      if (p.l > max) continue;
      if (p.re.test(v[p.v])) return { word: tok, level: p.l };
    }
    for (const cw of customV) {
      if (cw.prefix ? v.c.startsWith(cw.c) : v.c === cw.c) return { word: tok, level: 0 };
    }
  }
  return null;
}

module.exports = { checkProfanity, tokenize, variants, LEVELS };
