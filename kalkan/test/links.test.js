'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/modules/links');

const cls = (text, opts = {}) => L.extract(text).map((i) => ({ host: i.hostBare, ...L.classify(i, opts) }));
const first = (text, opts) => cls(text, opts)[0];

test('GIF bağlantıları link sayılmaz (Tenor/Giphy ve alt alan adları)', () => {
  for (const u of [
    'https://tenor.com/view/cat-gif-123', 'https://media.tenor.com/abc/cat.gif', 'https://giphy.com/gifs/xyz',
    'https://i.giphy.com/media/abc/giphy.gif', 'https://image.tenor.com/x.gif', 'bak şuna https://tenor.com/view/a-1 :D',
  ]) assert.equal(first(u).action, 'allow', u);
});

test('Discord CDN medyası ve mesaj bağlantıları serbest', () => {
  assert.equal(first('https://cdn.discordapp.com/attachments/1/2/a.png').action, 'allow');
  assert.equal(first('https://media.discordapp.net/attachments/1/2/a.png').action, 'allow');
  assert.equal(first('https://discord.com/channels/1/2/3').action, 'allow');
});

test('Davet bağlantıları her kanalda engellenir (kendi daveti hariç)', () => {
  assert.equal(first('https://discord.gg/abc123').type, 'invite');
  assert.equal(first('https://discord.com/invite/abcd').type, 'invite');
  assert.equal(first('discord.gg/abc123').type, 'invite');
  assert.equal(first('https://discord.gg/benim', { allowInviteCodes: ['benim'] }).action, 'allow');
  assert.equal(first('https://discord.gg/baskasi', { allowInviteCodes: ['benim'] }).action, 'block');
});

test('Gizlenmiş davetler yakalanır', () => {
  assert.deepEqual(L.inviteCodes('discord . gg / abc123'), ['abc123']);
  assert.deepEqual(L.inviteCodes('discord[.]gg/Zxy-9'), ['zxy-9']);
  assert.deepEqual(L.inviteCodes('merhaba, nasılsın?'), []);
});

test('Bilinmeyen siteler varsayılan olarak engellenir, izinli alan adı serbest', () => {
  assert.equal(first('https://www.youtube.com/watch?v=1').action, 'block');
  assert.equal(first('https://www.youtube.com/watch?v=1', { allowDomains: ['youtube.com'] }).action, 'allow');
  assert.equal(first('example.com').action, 'block');
  assert.equal(first('steamcommunity.com/gift/1').action, 'block');
});

test('Çalıştırılabilir dosya bağlantısı izinli alan adında bile engellenir', () => {
  const c = first('https://github.com/a/b/releases/download/v1/mod.exe', { allowDomains: ['github.com'] });
  assert.equal(c.action, 'block');
  assert.equal(c.type, 'executable');
});

test('IP, punycode ve bozuk biçimli adresler engellenir', () => {
  assert.equal(first('http://192.168.1.1/a').type, 'ip');
  assert.equal(first('http://[::1]/x').type, 'ip');
  assert.equal(first('http://аррӏе.com/login').type, 'punycode');
  assert.equal(first('https://dіscord.com').type, 'punycode');
  // Geçersiz punycode: önceden "link yok" sayılıyordu (açık). Şimdi engellenmeli.
  const bad = first('http://xn--discrd-4qa.com/nitro');
  assert.ok(bad, 'bozuk punycode link olarak algılanmalı');
  assert.equal(bad.action, 'block');
});

test('Kısaltıcılar çözülmek üzere işaretlenir', () => {
  assert.equal(first('https://bit.ly/3xyz').action, 'resolve');
  assert.equal(first('https://t.co/abc').action, 'resolve');
});

test('Sahte alan adı listesi (küçük ve büyük/Set) çalışır', () => {
  assert.equal(first('https://dlscord-gift.com/x', { scamHosts: ['dlscord-gift.com'] }).type, 'scam');
  assert.equal(first('https://sub.dlscord-gift.com/x', { scamHosts: ['dlscord-gift.com'] }).type, 'scam');
  const big = new Set(['evil-nitro.ru']);
  assert.equal(first('https://evil-nitro.ru/a', { scamSet: big }).type, 'scam');
  assert.equal(first('https://notevil-nitro.ru/a', { scamSet: big }).type, 'unknown');
});

test('Normal cümleler link sanılmaz', () => {
  for (const t of ['Ben iyiyim.Sen nasılsın?', 'merhaba.sen nasılsın', 'dosya.exe', 'v1.20.1 sürümü', 'saat 14.30 gibi', 'a.b', 'mail@ornek.com']) {
    assert.equal(L.extract(t).length, 0, t);
  }
});

test('Gizlenmiş noktalar ve hxxp çözülür', () => {
  const u = L.extract('hxxp://evil[.]com/a');
  assert.equal(u.length, 1);
  assert.equal(u[0].hostBare, 'evil.com');
});

test('Şüpheli çok sayıda bağlantı üst sınırla işlenir', () => {
  const many = Array.from({ length: 100 }, (_, i) => `https://a${i}.com`).join(' ');
  assert.ok(L.extract(many).length <= 15);
});
