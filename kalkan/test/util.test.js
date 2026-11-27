'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const u = require('../src/util');

test('parseDuration: Türkçe ve İngilizce birimler', () => {
  assert.equal(u.parseDuration('30sn'), 30e3);
  assert.equal(u.parseDuration('5dk'), 300e3);
  assert.equal(u.parseDuration('5m'), 300e3);
  assert.equal(u.parseDuration('2sa'), 7200e3);
  assert.equal(u.parseDuration('1h 30dk'), 5400e3);
  assert.equal(u.parseDuration('2g'), 2 * 864e5);
  assert.equal(u.parseDuration('1hf'), 7 * 864e5);
  assert.equal(u.parseDuration('1,5sa'), 5400e3);
});

test('parseDuration: geçersiz girdiler null döner', () => {
  for (const bad of ['', 'abc', '5', '5x', 'dk', '5dk abc', null, undefined]) assert.equal(u.parseDuration(bad), null, String(bad));
});

test('fmtDuration', () => {
  assert.equal(u.fmtDuration(0), '0 sn');
  assert.equal(u.fmtDuration(90e3), '1 dk 30 sn');
  assert.match(u.fmtDuration(26 * 3600e3), /1 g 2 sa/);
});

test('truncate / defang / chunk', () => {
  assert.equal(u.truncate('abcdef', 4).length, 4);
  assert.equal(u.truncate('abc', 10), 'abc');
  assert.ok(!u.defang('https://evil.com/x').includes('https://evil.com'));
  assert.deepEqual(u.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('kritik yetki maskesi', () => {
  const ADMIN = 1n << 3n;
  const MANAGE_ROLES = 1n << 28n;
  const SEND = 1n << 11n;
  assert.ok(u.hasCritical(ADMIN));
  assert.ok(u.hasCritical(MANAGE_ROLES));
  assert.ok(!u.hasCritical(SEND));
  assert.ok(u.criticalList(ADMIN).length >= 1);
  assert.equal(u.toBig('8'), 8n);
  assert.equal(u.toBig(null), 0n);
});

test('gece penceresi gece yarısını aşabilir', () => {
  const night = { enabled: true, start: '23:00', end: '02:00', tz: 'UTC' };
  assert.equal(u.inNightWindow(night, new Date('2026-11-25T23:30:00Z')), true);
  assert.equal(u.inNightWindow(night, new Date('2026-11-26T01:59:00Z')), true);
  assert.equal(u.inNightWindow(night, new Date('2026-11-26T02:00:00Z')), false);
  assert.equal(u.inNightWindow(night, new Date('2026-11-26T12:00:00Z')), false);
  const day = { enabled: true, start: '01:00', end: '07:00', tz: 'UTC' };
  assert.equal(u.inNightWindow(day, new Date('2026-11-26T03:00:00Z')), true);
  assert.equal(u.inNightWindow(day, new Date('2026-11-26T08:00:00Z')), false);
  assert.equal(u.inNightWindow({ ...day, enabled: false }, new Date('2026-11-26T03:00:00Z')), false);
  // saat dilimi: Bakü UTC+4 -> 20:00Z = 00:00 yerel
  assert.equal(u.inNightWindow({ enabled: true, start: '23:00', end: '02:00', tz: 'Asia/Baku' }, new Date('2026-11-25T20:00:00Z')), true);
});

test('weekKey biçimi', () => {
  assert.match(u.weekKey(new Date('2026-11-25T10:00:00Z')), /^2026-W\d{2}$/);
  assert.equal(u.weekKey(new Date('2026-01-01T00:00:00Z')), '2026-W01');
});

test('RateQueue sırayla ve aralıklı çalışır', async () => {
  const q = new u.RateQueue(5, 0);
  const order = [];
  await Promise.all([1, 2, 3].map((n) => q.add(async () => { order.push(n); return n; })));
  assert.deepEqual(order, [1, 2, 3]);
});

test('downloadLimited: HTTP ve izinsiz sunucuyu reddeder', async () => {
  await assert.rejects(() => u.downloadLimited('http://cdn.discordapp.com/a', 100), /HTTPS/);
  await assert.rejects(() => u.downloadLimited('https://evil.example/a', 100, { allowHosts: ['cdn.discordapp.com'] }));
});
