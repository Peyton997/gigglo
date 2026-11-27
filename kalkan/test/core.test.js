'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('../src/crypto');
const { Store } = require('../src/store');
const { EventLog } = require('../src/eventlog');
const { makeCtx } = require('./helpers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kalkan-core-'));

test('AES-GCM: şifrele/çöz, bozulan veri reddedilir', () => {
  crypto.initKey({ dataDir: tmp(), dataKey: 'bir-anahtar-123' });
  const enc = crypto.encrypt('gizli-token-123');
  assert.notEqual(enc, 'gizli-token-123');
  assert.equal(crypto.decrypt(enc), 'gizli-token-123');
  assert.notEqual(crypto.encrypt('a'), crypto.encrypt('a'), 'her şifreleme farklı nonce kullanmalı');
  const buf = Buffer.from(enc, 'base64');
  buf[buf.length - 1] ^= 1;
  assert.throws(() => crypto.decrypt(buf.toString('base64')));
  const big = crypto.encryptBuffer(Buffer.alloc(100000, 7));
  assert.ok(crypto.decryptBuffer(big).equals(Buffer.alloc(100000, 7)));
});

test('Anahtar dosyası otomatik üretilir ve kalıcıdır', () => {
  const dir = tmp();
  const how = crypto.initKey({ dataDir: dir });
  assert.equal(how, 'generated');
  const a = crypto.encrypt('x');
  crypto.initKey({ dataDir: dir });
  assert.equal(crypto.decrypt(a), 'x');
});

test('hmac / sha256 sabit ve doğru', () => {
  crypto.initKey({ dataDir: tmp(), dataKey: 'k-anahtar-12345' });
  assert.equal(crypto.hmac('a'), crypto.hmac('a'));
  assert.notEqual(crypto.hmac('a'), crypto.hmac('b'));
  assert.equal(crypto.sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('Store: yaz-oku, bozuk dosyada .bak\'a döner', () => {
  const dir = tmp();
  const s = new Store(dir).load();
  s.data.guilds.g1 = { a: 1 };
  s.save(); s.flush();
  s.data.guilds.g1.a = 2;
  s._lastBak = 0; s.save(); s.flush(); // ikinci yazımda .bak oluşur
  fs.writeFileSync(path.join(dir, 'db.json'), '{bozuk json');
  const s2 = new Store(dir).load();
  assert.ok(s2.data.guilds.g1, 'yedekten geri yüklenmeli');
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('db.corrupt-')), 'bozuk dosya saklanmalı');
});

test('Store: boş dizinde tüm bölümler hazır', () => {
  const s = new Store(tmp()).load();
  for (const k of ['guilds', 'members', 'watch', 'reports', 'oauth', 'jit', 'timelock', 'blocklist', 'quiz', 'stats', 'meta', 'backupsMeta']) {
    assert.equal(typeof s.data[k], 'object', k);
  }
});

test('Store: art arda save tek yazıma birleşir ve flush veriyi diske yazar', () => {
  const dir = tmp();
  const s = new Store(dir).load();
  for (let i = 0; i < 50; i++) { s.data.meta.n = i; s.save(); }
  s.flush();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8')).meta.n, 49);
  assert.ok(!fs.existsSync(path.join(dir, 'db.json.tmp')));
});

test('EventLog: ekle/oku, zaman süzgeci, bozuk satır atlanır', () => {
  const dir = tmp();
  const ev = new EventLog(dir, { log: { warn() {} } });
  ev.append('g1', { type: 'A', actor: '1' });
  const mid = Date.now() + 1;
  fs.appendFileSync(ev.file('g1'), 'bozuk satır\n');
  ev.append('g1', { type: 'B', actor: '2', t: mid + 5 });
  const all = ev.read('g1');
  assert.deepEqual(all.map((e) => e.type), ['A', 'B']);
  assert.deepEqual(ev.read('g1', { since: mid }).map((e) => e.type), ['B']);
  assert.deepEqual(ev.read('olmayan'), []);
});

test('Bağlam: yetki yardımcıları', () => {
  const { ctx, cleanup } = makeCtx();
  try {
    assert.equal(ctx.isBotOwner('900000000000000001'), true);
    assert.equal(ctx.isBotOwner('1'), false);
    assert.equal(ctx.isBackupOwner('900000000000000002'), true);
    const g = { id: 'g', ownerId: '5' };
    assert.equal(ctx.canAdmin(g, '900000000000000001'), true);
    assert.equal(ctx.canAdmin(g, '5'), false, 'OWNER_IDS tanımlıyken sunucu sahibi tek başına yetkili sayılmaz');
    ctx.gcfg('g').trusted.push('77');
    assert.equal(ctx.isTrusted(g, '77'), true);
    assert.equal(ctx.isTrusted(g, '78'), false);
  } finally { cleanup(); }
});

test('Bağlam: gcfg varsayılanları paylaşmaz (derin kopya)', () => {
  const { ctx, cleanup } = makeCtx();
  try {
    ctx.gcfg('a').trusted.push('1');
    assert.deepEqual(ctx.gcfg('b').trusted, []);
    ctx.gcfg('a').automod.links.allowDomains.push('x.com');
    assert.deepEqual(ctx.gcfg('b').automod.links.allowDomains, []);
  } finally { cleanup(); }
});
