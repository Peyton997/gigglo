'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const raid = require('../src/modules/raid');
const recovery = require('../src/modules/recovery');
const blocklist = require('../src/modules/blocklist');
const incident = require('../src/modules/incident');
const settings = require('../src/modules/settings');
const quiz = require('../src/modules/quiz');
const { makeCtx, fakeGuild, fakeMember, fakeRole } = require('./helpers');

test('raid.normName: taklit isimleri aynı biçime indirger', () => {
  assert.equal(raid.normName('Admin'), raid.normName('Αdmin')); // Yunan Alfa
  assert.equal(raid.normName('Аdmin'), raid.normName('Admin')); // Kiril A
  assert.equal(raid.normName('M0derat0r'), raid.normName('Moderator'));
  assert.equal(raid.normName('Ḿöd'), 'mod');
  assert.equal(raid.normName('a d m i n'), 'admin');
  assert.notEqual(raid.normName('Ayşe'), raid.normName('Admin'));
});

test('recovery.normalizeInvite: yalnızca discord.gg davet kodu kabul edilir', () => {
  assert.equal(recovery.normalizeInvite('https://discord.gg/abc123').code, 'abc123');
  assert.equal(recovery.normalizeInvite('discord.gg/abc-123').url, 'https://discord.gg/abc-123');
  assert.equal(recovery.normalizeInvite('https://discord.com/invite/XyZ').code, 'XyZ');
  for (const bad of ['https://evil.com/discord.gg/abc', 'https://discord.gg/abc/def', 'abc', '', null, 'https://discord.gg/', 'javascript:alert(1)']) {
    assert.equal(recovery.normalizeInvite(bad), null, String(bad));
  }
});

test('recovery.hasLink: özel kurtarma mesajında link yasak', () => {
  assert.equal(recovery.hasLink('Sunucumuz silindi, üzgünüz.'), false);
  assert.equal(recovery.hasLink('Buraya gel: https://evil.com'), true);
  assert.equal(recovery.hasLink('discord.gg/abc'), true);
  assert.equal(recovery.hasLink('örnek bir cümle. Devamı var'), false);
});

test('blocklist: kimlik ve alan adı listesi ayrıştırma', () => {
  const ids = blocklist.parseIdList('[{"id":"123456789012345678","reason":"rat"},"223456789012345678","bozuk","12"]');
  assert.deepEqual([...ids.keys()], ['123456789012345678', '223456789012345678']);
  assert.equal(ids.get('123456789012345678'), 'rat');
  assert.equal(blocklist.parseIdList('{"users":["323456789012345678"]}').size, 1);
  assert.equal(blocklist.parseIdList('423456789012345678\n# yorum\n523456789012345678').size, 2);
  const hosts = blocklist.parseHostList('0.0.0.0 evil.com\n# x\nhttps://www.fake-nitro.ru/a\n*.bad.net\nbozuk host\n');
  assert.deepEqual([...hosts].sort(), ['bad.net', 'evil.com', 'fake-nitro.ru']);
});

test('blocklist: yerel ekle/kaldır/kontrol ve hash', () => {
  const { ctx, cleanup } = makeCtx({ modules: ['blocklist'] });
  try {
    assert.equal(ctx.blocklist.check('111111111111111111'), null);
    ctx.blocklist.add('111111111111111111', { reason: 'RAT', by: 'x' });
    assert.ok(ctx.blocklist.check('111111111111111111'));
    assert.equal(ctx.blocklist.remove('111111111111111111'), true);
    assert.equal(ctx.blocklist.check('111111111111111111'), null);
    ctx.blocklist.addHash('ab'.repeat(32), { reason: 'VT' });
    assert.ok(ctx.blocklist.hasHash('ab'.repeat(32)));
    assert.equal(ctx.blocklist.hasHash('cd'.repeat(32)), null);
  } finally { cleanup(); }
});

test('oauth: durum imzası doğrulanır, kurcalanan/süresi dolan reddedilir', () => {
  const { ctx, cleanup } = makeCtx({ modules: ['oauth'] });
  try {
    const { signState, parseSigned } = ctx.oauth._test;
    const s = signState('800000000000000001', '700000000000000001');
    assert.deepEqual(parseSigned(s), { gid: '800000000000000001', uid: '700000000000000001' });
    const forged = s.replace('700000000000000001', '700000000000000002');
    assert.equal(parseSigned(forged), null);
    assert.equal(parseSigned('u.1.2.3.4'), null);
    assert.equal(parseSigned('rastgele'), null);
    const expired = (() => { const body = `u.8.7.${(Date.now() - 1000).toString(36)}`; return `${body}.${require('../src/crypto').hmac(body).slice(0, 20)}`; })();
    assert.equal(parseSigned(expired), null);
  } finally { cleanup(); }
});

test('oauth: HTML çıktısı kaçışlanır', () => {
  const o = require('../src/modules/oauth');
  assert.equal(o.esc('<img src=x onerror=1>"&'), '&lt;img src=x onerror=1&gt;&quot;&amp;');
});

test('incident.rank: yıkıcı işlem yapan ve yeni hesap öne çıkar', () => {
  const now = Date.now();
  const guild = { roles: { cache: new Map() } };
  const ev = [];
  for (let i = 0; i < 6; i++) ev.push({ t: now - 1000 * i, type: 'ChannelDelete', actor: 'saldirgan' });
  ev.push({ t: now, type: 'MemberBanAdd', actor: 'mod' });
  ev.push({ t: now, type: 'ALERT', level: 'high' });
  const members = { saldirgan: { createdAt: now - 2 * 864e5, joinedAt: now - 3600e3 } };
  const r = incident.rank(guild, ev, { members });
  assert.equal(r[0].id, 'saldirgan');
  assert.ok(r[0].share > 0.8);
  assert.ok(r[0].notes.some((n) => /7 günden yeni/.test(n)));
  assert.match(incident.wording(r[0]), /yüksek olasılıkla/);
  assert.ok(incident.wording(r[1]) !== 'yüksek olasılıkla sorumlu');
});

test('incident.rank: güvenilir hesap "ele geçirilmiş olabilir" notu alır; boş girdi çökertmez', () => {
  const r = incident.rank(null, [{ t: 1, type: 'RoleDelete', actor: 'a' }], { isTrusted: () => true });
  assert.ok(r[0].notes.some((n) => /ele geçirilmiş/.test(n)));
  assert.deepEqual(incident.rank(null, []), []);
});

test('settings.parseValue: tür ve aralık doğrulaması', () => {
  const S = settings.SCHEMA;
  assert.deepEqual(settings.parseValue(S['antinuke.thresholds.ban'], '5'), { ok: true, value: 5 });
  assert.equal(settings.parseValue(S['antinuke.thresholds.ban'], '0').ok, false);
  assert.equal(settings.parseValue(S['antinuke.thresholds.ban'], '999').ok, false);
  assert.equal(settings.parseValue(S['antinuke.thresholds.ban'], '2.5').ok, false);
  assert.equal(settings.parseValue(S['antinuke.thresholds.ban'], 'abc').ok, false);
  assert.equal(settings.parseValue(S['automod.spam.capsRatio'], '0,8').value, 0.8);
  assert.equal(settings.parseValue(S['antinuke.ownerPanic'], 'Evet').value, true);
  assert.equal(settings.parseValue(S['antinuke.ownerPanic'], 'hayır').value, false);
  assert.equal(settings.parseValue(S['antinuke.ownerPanic'], 'belki').ok, false);
  assert.equal(settings.parseValue(S['blocklist.action'], 'ban').value, 'ban');
  assert.equal(settings.parseValue(S['blocklist.action'], 'sil').ok, false);
});

test('settings: şema anahtarları varsayılanlarla uyumlu, kurtarma gecikmesi şemada yok', () => {
  const { DEFAULTS } = settings;
  for (const [k, d] of Object.entries(settings.SCHEMA)) {
    const v = settings.getPath(DEFAULTS, k);
    assert.notEqual(v, undefined, k);
    assert.equal(typeof v, d.t === 'bool' ? 'boolean' : d.t === 'enum' ? 'string' : 'number', k);
  }
  assert.ok(!Object.keys(settings.SCHEMA).some((k) => k.startsWith('recovery')), 'recovery.* /ayar ile değiştirilememeli');
});

test('settings: çapraz doğrulama ve yardımcılar', () => {
  const cfg = { risk: { alertAt: 40, containAt: 70 }, watch: { defaultDays: 7, maxDays: 30 } };
  assert.ok(settings.crossCheck(cfg, 'risk.containAt', 30));
  assert.equal(settings.crossCheck(cfg, 'risk.containAt', 80), null);
  assert.ok(settings.crossCheck(cfg, 'risk.alertAt', 70));
  assert.ok(settings.crossCheck(cfg, 'watch.maxDays', 3));
  assert.equal(settings.normDomain('https://www.YouTube.com/watch?v=1'), 'youtube.com');
  assert.equal(settings.normDomain('bozuk'), null);
  assert.equal(settings.normDomain('a b.com'), null);
  assert.equal(settings.normInviteCode('https://discord.gg/abc-12'), 'abc-12');
  assert.equal(settings.normInviteCode('abc'), 'abc');
  assert.equal(settings.normInviteCode('a/b'), null);
  assert.equal(settings.normWord('KIZ'), 'kız');
  assert.equal(settings.normWord('a'), null);
  assert.deepEqual(settings.parseSteps('uyari, 5dk, 1sa'), { ok: true, steps: ['warn', 'timeout:300sn', 'timeout:3600sn'] });
  assert.equal(settings.parseSteps('').ok, false);
  assert.equal(settings.parseSteps('1,2,3,4,5,6,7').ok, false);
  assert.equal(settings.parseSteps('5g, 99g').ok, false);
  assert.equal(settings.parseSteps('1sn').ok, false);
});

test('quiz: oturum rastgele, 6 soru, her soruda tek doğru cevap; havuz geçerli', () => {
  const s = quiz.makeSession('1', 'g');
  assert.equal(s.qs.length, quiz.PER_QUIZ);
  for (const q of s.qs) {
    assert.equal(q.opts.filter((o) => o.ok).length, 1);
    assert.equal(q.opts.length, 3);
    assert.ok(q.q.length < 400 && q.why);
  }
  assert.ok(quiz.POOL.length >= quiz.PER_QUIZ + 4);
  const texts = new Set(quiz.POOL.map((p) => p.q));
  assert.equal(texts.size, quiz.POOL.length, 'yinelenen soru var');
  // Doğru cevap hep aynı sırada olmamalı
  const positions = new Set();
  for (let i = 0; i < 40; i++) quiz.makeSession('1', 'g').qs.forEach((q) => positions.add(q.opts.findIndex((o) => o.ok)));
  assert.ok(positions.size >= 3, 'doğru şık konumu rastgele değil');
});

test('quiz: sorularda tıklanabilir bağlantı ve davet yok', () => {
  for (const p of quiz.POOL) for (const t of [p.q, p.ok, ...p.bad, p.why]) assert.ok(!/https?:\/\/|discord\.gg\//i.test(t), t);
});
