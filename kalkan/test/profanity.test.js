'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkProfanity } = require('../src/modules/profanity');

const flag = (s, o = {}) => !!checkProfanity(s, { level: 'orta', custom: [], allow: [], ...o });

test('Bilinen küfürler ve gizlenmiş yazımlar yakalanır', () => {
  for (const s of ['siktir git', 'amk', 'a m k', 's1kt1r', 's.i.k.t.i.r', 'amına koyayım', 'orospu çocuğu', 'yarrak', 'sikerim']) {
    assert.equal(flag(s), true, s);
  }
});

test('Masum Türkçe kelimeler yanlış alarm vermez', () => {
  for (const s of ['sıktı', 'şikayet', 'sikke', 'amca', 'götürdü', 'Ankara', 'sıkıntı', 'analiz', 'amiral', 'Sikkim', 'classic', 'assassin', 'Merhaba nasılsın', 'Bu oyunu çok sevdim']) {
    assert.equal(flag(s), false, s);
  }
});

test('Seviye ayarı: hafif yalnızca ağır küfürleri yakalar', () => {
  assert.equal(flag('siktir', { level: 'hafif' }), true);
  assert.equal(flag('göt', { level: 'hafif' }), false);
  assert.equal(flag('göt', { level: 'orta' }), true);
});

test('Özel kelime ve izin listesi çalışır', () => {
  assert.equal(flag('bu kelime yasak', { custom: ['yasak'] }), true);
  assert.equal(flag('yasaklı', { custom: ['yasak'] }), false);
  assert.equal(flag('yasaklı', { custom: ['yasak*'] }), true);
  assert.equal(flag('siktir', { allow: ['siktir'] }), false);
});

test('Görünmez karakterlerle gizleme yakalanır', () => {
  assert.equal(flag('sik​tir'), true);
  assert.equal(flag('s­iktir'), true);
});

test('Çok uzun girdi hızlı işlenir', () => {
  const t = Date.now();
  flag('a'.repeat(4000));
  flag('siktir '.repeat(500));
  assert.ok(Date.now() - t < 1500, 'ReDoS belirtisi: çok yavaş');
});
