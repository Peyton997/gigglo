'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const { scanJar, verdict } = require('../src/modules/modcheck');
const { sniff, mismatchOf } = require('../src/modules/watchlist');
const files = require('../src/modules/files');

function jar(entries) {
  const z = new AdmZip();
  for (const [name, data] of Object.entries(entries)) z.addFile(name, Buffer.from(data));
  return z.toBuffer();
}

test('scanJar: temiz bir Fabric modu düşük puan alır', () => {
  const r = scanJar(jar({ 'fabric.mod.json': '{"id":"temiz"}', 'com/x/Main.class': '\xca\xfe\xba\xbe benign' }));
  assert.equal(r.isZip, true);
  assert.deepEqual(r.loaders, ['fabric.mod.json']);
  assert.equal(r.score, 0);
  assert.equal(verdict(r.score).label, 'Düşük belirti');
});

test('scanJar: webhook + PowerShell + gömülü exe yüksek risk verir', () => {
  const r = scanJar(jar({
    'plugin.yml': 'name: x',
    'a/Stealer.class': 'https://discord.com/api/webhooks/123/abc powershell java/lang/ProcessBuilder',
    'res/payload.exe': 'MZ....',
  }));
  assert.ok(r.indicators.some((x) => /webhook/i.test(x)), 'webhook yakalanmalı');
  assert.ok(r.embedded.length === 1);
  assert.ok(r.score >= 6);
  assert.equal(verdict(r.score).label, 'YÜKSEK RİSK');
});

test('scanJar: tanım dosyası olmayan arşiv şüpheli sayılır, ZIP olmayan veri çökertmez', () => {
  assert.ok(scanJar(jar({ 'rastgele.txt': 'merhaba' })).score >= 1);
  const r = scanJar(Buffer.from('bu bir zip değil'));
  assert.equal(r.isZip, false);
  assert.doesNotThrow(() => scanJar(Buffer.alloc(0)));
});

test('scanJar: zip bombası benzeri aşırı sıkıştırma atlanır', () => {
  const r = scanJar(jar({ 'plugin.yml': 'x', 'bomb.txt': 'A'.repeat(4 * 1024 * 1024) }));
  assert.ok(r.notes.some((n) => /sıkıştırılmış/.test(n)));
});

test('sniff: gerçek dosya türünü bayttan anlar', () => {
  assert.equal(sniff(Buffer.from([0x4d, 0x5a, 0, 0])), 'exe');
  assert.equal(sniff(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), 'elf');
  assert.equal(sniff(Buffer.from([0xca, 0xfe, 0xba, 0xbe])), 'class');
  assert.equal(sniff(Buffer.from([0x50, 0x4b, 0x03, 0x04])), 'zip');
  assert.equal(sniff(Buffer.from('#!/bin/sh')), 'script');
  assert.equal(sniff(Buffer.from('PNG...')), null);
  assert.equal(sniff(null), null);
});

test('mismatchOf: resim/metin gibi görünen çalıştırılabilir yakalanır', () => {
  assert.match(mismatchOf('png', 'exe'), /gerçek içerik: exe/);
  assert.match(mismatchOf('txt', 'class'), /gerçek içerik/);
  assert.equal(mismatchOf('jar', 'zip'), null);
  assert.equal(mismatchOf('png', null), null);
});

test('files.extOf: çift uzantıda son uzantıyı verir', () => {
  assert.equal(files.extOf('oyun.png.exe'), 'exe');
  assert.equal(files.extOf('A.JAR'), 'jar');
  assert.equal(files.extOf('uzantisiz'), '');
});
