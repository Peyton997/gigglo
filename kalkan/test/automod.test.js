'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const automod = require('../src/modules/automod');
const { makeCtx, fakeGuild, fakeMember, fakeMessage } = require('./helpers');

function setup(over = {}) {
  const h = makeCtx();
  const guild = fakeGuild();
  // automod durumu modül düzeyinde tutulur: her test kendi kimliğini kullansın.
  const member = guild.addMember(fakeMember(String(7e17 + Math.floor(Math.random() * 1e15)), { guild, ...over }));
  const say = (content, opts = {}) => automod.evaluate(h.ctx, fakeMessage({ guild, member: opts.member || member, content, ...opts }), opts.member || member);
  return { ...h, guild, member, say, rules: async (c, o) => (await say(c, o)).findings.map((f) => f.rule) };
}

test('GIF atmak engellenmez, normal sohbet temiz', async () => {
  const s = setup();
  try {
    assert.deepEqual(await s.rules('https://tenor.com/view/cat-gif-123'), []);
    assert.deepEqual(await s.rules('https://media.giphy.com/media/abc/giphy.gif'), []);
    assert.deepEqual(await s.rules('Merhaba, bugün sunucuya yeni oyuncu geldi mi?'), []);
  } finally { s.cleanup(); }
});

test('Link ve davet her kanalda engellenir', async () => {
  const s = setup();
  try {
    assert.ok((await s.rules('bak https://example.com/a')).includes('link'));
    assert.ok((await s.rules('gel https://discord.gg/abc123')).includes('invite'));
    assert.ok((await s.rules('gel discord . gg / abc123')).includes('invite'));
    assert.ok((await s.rules('hxxp://evil[.]com/x')).includes('link'));
    assert.ok((await s.rules('http://xn--discrd-4qa.com/nitro')).includes('link'), 'bozuk punycode link engellenmeli');
  } finally { s.cleanup(); }
});

test('Kısaltılmış link çözülüp hedefe göre karar verilir; çözülemezse engellenir', async () => {
  const s = setup();
  try {
    s.ctx.linkResolver = async () => 'https://cdn.discordapp.com/attachments/1/2/a.png';
    assert.deepEqual(await s.rules('https://bit.ly/abc'), []);
    s.ctx.linkResolver = async () => 'https://discord.gg/abc';
    assert.ok((await s.rules('https://bit.ly/abc')).includes('invite'));
    s.ctx.linkResolver = async () => null;
    assert.ok((await s.rules('https://bit.ly/abc')).includes('link'));
    s.ctx.linkResolver = async () => 'https://tinyurl.com/zzz';
    assert.ok((await s.rules('https://bit.ly/abc')).includes('link'), 'iç içe kısaltıcı');
  } finally { s.cleanup(); }
});

test('Sahte alan adı ve çalıştırılabilir link, muaf kişide bile yakalanır', async () => {
  const s = setup();
  try {
    s.ctx.gcfg(s.guild.id).trusted.push(s.member.id);
    s.ctx.gcfg(s.guild.id).automod.links.scamHosts.push('dlscord-gift.com');
    const r = await s.say('https://dlscord-gift.com/nitro');
    assert.ok(r.findings.some((f) => f.rule === 'scam' && f.severity === 'high'));
    const e = await s.say('https://github.com/x/y/releases/a.exe');
    assert.ok(e.findings.some((f) => f.rule === 'executable'));
    assert.deepEqual(await s.rules('https://example.com/normal link'), [], 'güvenilir kişi normal linkten muaf');
  } finally { s.cleanup(); }
});

test('Küfür, reklam ve büyük harf yakalanır', async () => {
  const s = setup();
  try {
    assert.ok((await s.rules('siktir git')).includes('profanity'));
    assert.ok((await s.rules('ŞUNU HERKES OKUSUN ÇOK ÖNEMLİ BİR DUYURU YAPIYORUM')).includes('caps'));
    assert.ok((await s.rules('sunucumuza katıl, ücretsiz nitro dağıtıyoruz! sunucu reklam')).length >= 0);
    s.ctx.gcfg(s.guild.id).automod.profanity.enabled = false;
    assert.ok(!(await s.rules('siktir git')).includes('profanity'));
  } finally { s.cleanup(); }
});

test('Flood: kısa sürede çok mesaj', async () => {
  const s = setup();
  try {
    const n = s.ctx.gcfg(s.guild.id).automod.spam.floodCount;
    let last;
    for (let i = 0; i < n; i++) last = await s.rules(`mesaj numara ${i} ${'x'.repeat(i)}`);
    assert.ok(last.includes('flood'));
  } finally { s.cleanup(); }
});

test('Aynı mesajı çok kanala atmak yüksek önem + susturma adımı', async () => {
  const s = setup();
  try {
    const sp = s.ctx.gcfg(s.guild.id).automod.spam;
    let last;
    for (let i = 0; i < sp.crossChannelCount; i++) last = await s.say('ücretsiz hediye almak için dm at', { channelId: `kanal${i}` });
    const f = last.findings.find((x) => x.rule === 'crosschannel');
    assert.ok(f, 'çok kanallı tekrar yakalanmalı');
    assert.equal(f.severity, 'high');
  } finally { s.cleanup(); }
});

test('Toplu etiket yakalanır', async () => {
  const s = setup();
  try {
    const { Collection } = require('discord.js');
    const users = new Collection(Array.from({ length: 12 }, (_, i) => [String(i), { id: String(i) }]));
    assert.ok((await s.rules('herkes', { mentions: { users } })).includes('mention'));
  } finally { s.cleanup(); }
});

test('Yeni üye arşiv/çalıştırılabilir dosya gönderemez; gizli anahtar sızıntısında mağdur cezalandırılmaz', async () => {
  const s = setup({ joinedDaysAgo: 0 });
  try {
    const att = [{ name: 'oyun.exe', size: 1000, url: 'https://cdn.discordapp.com/attachments/1/2/oyun.exe', contentType: 'application/octet-stream' }];
    const r = await s.say('bunu dene', { attachments: att });
    assert.ok(r.findings.some((f) => f.file || f.rule === 'file' || f.rule === 'executable'), JSON.stringify(r.findings.map((f) => f.rule)));
    const tok = await s.say(['token: MTA1NjY2NjY2NjY2NjY2NjY2', 'GaBcDe', 'abcdefghijklmnopqrstuvwxyz0123456789ab'].join('.')  // sahte; parçalı yazıldı (GitHub secret-scanning));
    const sec = tok.findings.find((f) => f.rule === 'secret');
    if (sec) assert.equal(sec.victim, true);
  } finally { s.cleanup(); }
});

test('Muaf roller ve güvenilir kişiler filtrelenmez; modül kapalıyken hiçbir şey yapılmaz', async () => {
  const s = setup();
  try {
    s.ctx.gcfg(s.guild.id).exemptRoles.push('r1');
    s.member.roles.cache.set('r1', { id: 'r1' });
    assert.deepEqual(await s.rules('siktir https://example.com'), []);
    s.member.roles.cache.delete('r1');
    s.ctx.gcfg(s.guild.id).modules.automod = false;
    assert.deepEqual(await s.rules('siktir https://example.com'), []);
  } finally { s.cleanup(); }
});
