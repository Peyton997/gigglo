'use strict';
// Çok dilli metin altyapısı. Varsayılan dil Türkçe. Eksik anahtar önce Türkçe'ye, o da yoksa anahtarın kendisine düşer.
// Yeni dil eklemek: src/locales/<kod>.js dosyası oluştur (anahtar → metin) ve LOCALES listesine ekle.
const tr = require('./locales/tr');
const en = require('./locales/en');
const az = require('./locales/az');

const LOCALES = { tr, en, az };
const DEFAULT_LOCALE = 'tr';

function format(text, vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}

function t(locale, key, vars) {
  const cat = LOCALES[locale] || LOCALES[DEFAULT_LOCALE];
  const text = cat[key] ?? LOCALES[DEFAULT_LOCALE][key] ?? key;
  return format(text, vars);
}

const has = (locale, key) => !!(LOCALES[locale] && LOCALES[locale][key] !== undefined);
const available = () => Object.keys(LOCALES);

module.exports = { t, has, available, format, LOCALES, DEFAULT_LOCALE };
