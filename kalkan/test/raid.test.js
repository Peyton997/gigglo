'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Events } = require('discord.js');
const { makeCtx, fakeGuild, fakeMember } = require('./helpers');

const tick = () => new Promise((r) => setTimeout(r, 25));

function setup() {
  const h = makeCtx({ modules: ['members', 'risk', 'raid'] });
  const g = fakeGuild();
  h.client.guilds.cache.set(g.id, g);
  h.g = g;
  h.cfg = h.ctx.gcfg(g.id);
  h.cfg.raid.minAccountAgeDays = 7;
  let n = 0;
  h.join = async (o = {}) => {
    const m = fakeMember(`73${String(1e16 + n++).slice(1)}`, { guild: g, joinedDaysAgo: 0, createdDaysAgo: 100, ...o });
    if (o.username) { m.user.username = o.username; m.displayName = o.username; }
    g.members.cache.set(m.id, m);
    h.client.emit(Events.GuildMemberAdd, m);
    await tick();
    return m;
  };
  return h;
}

test('Çok yeni hesap: timeout ayarında susturulur, kick ayarında atılır, off ayarında dokunulmaz', async () => {
  const h = setup();
  try {
    h.cfg.raid.newAccountAction = 'timeout';
    const a = await h.join({ createdDaysAgo: 1 });
    assert.deepEqual(a.timeouts, [3600e3]);
    h.cfg.raid.newAccountAction = 'kick';
    const b = await h.join({ createdDaysAgo: 1 });
    assert.equal(b.kicked, true);
    h.cfg.raid.newAccountAction = 'off';
    const c = await h.join({ createdDaysAgo: 1 });
    assert.equal(c.kicked, false);
    assert.deepEqual(c.timeouts, []);
    const old = await h.join({ createdDaysAgo: 400 });
    assert.deepEqual(old.timeouts, []);
  } finally { h.cleanup(); }
});

test('Yeni hesap kapısı kendi yeni üyesini (eski hesap) etkilemez ve botları yok sayar', async () => {
  const h = setup();
  try {
    h.cfg.raid.newAccountAction = 'kick';
    const bot = await h.join({ createdDaysAgo: 0, bot: true });
    assert.equal(bot.kicked, false);
  } finally { h.cleanup(); }
});

test('Toplu katılım: eşik aşılınca baskın modu açılır, sonraki katılanlar tutulur', async () => {
  const h = setup();
  try {
    h.cfg.raid.newAccountAction = 'off';
    const th = h.cfg.raid.joinThreshold;
    const joined = [];
    for (let i = 0; i < th; i++) joined.push(await h.join());
    assert.equal(h.cfg.raid.active, true, 'baskın modu açılmalı');
    assert.ok(h.alerts.some((a) => /BASKIN/.test(a.title)));
    const later = await h.join();
    assert.ok(h.cfg.raid.held.includes(later.id));
    assert.equal(later.timeouts[0], h.cfg.raid.raidTimeoutMinutes * 60e3);
    // geriye dönük tutma: eşiği aşmadan önce katılanların bir kısmı da tutulmuş olmalı
    assert.ok(joined.some((m) => h.cfg.raid.held.includes(m.id)));
    assert.equal(await h.ctx.raid.deactivate(h.g, 'test'), true);
    assert.equal(h.cfg.raid.active, false);
  } finally { h.cleanup(); }
});

test('Baskın modu güvenilir hesapları tutmaz', async () => {
  const h = setup();
  try {
    const t = h.g.addMember(fakeMember('740000000000000001', { guild: h.g }));
    h.cfg.trusted.push(t.id);
    await h.ctx.raid.activate(h.g, 'deneme', 5);
    h.client.emit(Events.GuildMemberAdd, t);
    await tick();
    assert.ok(!h.cfg.raid.held.includes(t.id));
  } finally { h.cleanup(); }
});

test('Yetkili taklidi: benzer isimli yeni üye için uyarı gelir (Kiril/Yunan harfli dahil)', async () => {
  const h = setup();
  try {
    h.cfg.raid.newAccountAction = 'off';
    h.cfg.raid.impersonation = 'timeout';
    const staff = h.g.addMember(fakeMember(h.g.ownerId, { guild: h.g }));
    staff.user.username = 'AdminAhmet';
    staff.displayName = 'AdminAhmet';
    const fake1 = await h.join({ username: 'Αdmin_Ahmet' }); // Yunan Alfa
    assert.ok(h.alerts.some((a) => /taklidi/.test(a.title)), h.alerts.map((a) => a.title).join('|'));
    assert.deepEqual(fake1.timeouts, [3600e3]);
    h.alerts.length = 0;
    const fine = await h.join({ username: 'Mehmet' });
    assert.ok(!h.alerts.some((a) => /taklidi/.test(a.title)));
    assert.deepEqual(fine.timeouts, []);
  } finally { h.cleanup(); }
});

test('Doğrulama: markVerified doğrulanmamış rolü alır, kaydı işler; tekrar çağrı değişiklik yapmaz', async () => {
  const h = setup();
  try {
    h.cfg.raid.unverifiedRoleId = 'unv';
    const { fakeRole } = require('./helpers');
    h.g.roles.cache.set('unv', fakeRole('unv'));
    const m = h.g.addMember(fakeMember('740000000000000002', { guild: h.g, roles: [fakeRole('unv')] }));
    assert.equal(await h.ctx.raid.markVerified(h.g, m.id, 'buton'), true);
    assert.ok(!m.roles.cache.has('unv'));
    assert.equal(h.ctx.members.ensure(h.g.id, m.id).verified.via, 'buton');
    assert.equal(await h.ctx.raid.markVerified(h.g, m.id, 'buton'), false);
  } finally { h.cleanup(); }
});
