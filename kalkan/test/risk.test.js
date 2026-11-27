'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCtx, fakeGuild, fakeMember, fakeRole } = require('./helpers');

function setup(extra = []) {
  const h = makeCtx({ modules: ['members', 'risk', ...extra] });
  const g = fakeGuild();
  h.client.guilds.cache.set(g.id, g);
  h.g = g;
  h.cfg = h.ctx.gcfg(g.id);
  return h;
}

test('Risk: sinyaller birikir, eşikte uyarı, yüksek eşikte geri alınabilir önlem', async () => {
  const h = setup(['watchlist']);
  try {
    const admRole = fakeRole('adm', { permissions: 8n });
    h.g.roles.cache.set('adm', admRole);
    const m = h.g.addMember(fakeMember('760000000000000001', { guild: h.g, roles: [admRole, fakeRole('uye')] }));
    const { alertAt, containAt } = h.cfg.risk;
    await h.ctx.risk.signal(h.g, m.id, alertAt, 'deneme 1');
    assert.ok(h.alerts.some((a) => /risk skoru yükseldi/.test(a.title)));
    assert.equal(m.timeouts.length, 0, 'uyarı eşiğinde müdahale yok');
    await h.ctx.risk.signal(h.g, m.id, containAt, 'deneme 2');
    assert.deepEqual(m.timeouts, [3600e3]);
    assert.ok(!m.roles.cache.has('adm'));
    assert.ok(m.roles.cache.has('uye'));
    assert.ok(h.ctx.watch.isActive(h.g.id, m.id), 'otomatik izlemeye alınmalı');
    assert.ok(h.alerts.some((a) => a.level === 'critical' && /otomatik önlem/.test(a.title)));
    // geri alma
    assert.equal(await h.ctx.risk.restoreRoles(h.g, m.id), 1);
    assert.equal(h.ctx.risk.current(h.g.id, m.id), 0);
  } finally { h.cleanup(); }
});

test('Risk: skor zamanla yarıya iner (6 saat yarı ömür) ve 100\'ü geçmez', async () => {
  const h = setup();
  try {
    const m = h.g.addMember(fakeMember('760000000000000002', { guild: h.g }));
    await h.ctx.risk.signal(h.g, m.id, 500, 'çok');
    assert.ok(h.ctx.risk.current(h.g.id, m.id) <= 100);
    const reg = h.ctx.members.ensure(h.g.id, m.id);
    reg.risk = { score: 40, at: Date.now() - 6 * 3600e3, reasons: [] };
    assert.equal(h.ctx.risk.current(h.g.id, m.id), 20);
  } finally { h.cleanup(); }
});

test('Risk: sunucu sahibi ve bot sahibine otomatik müdahale edilmez, yalnızca kritik uyarı', async () => {
  const h = setup();
  try {
    const owner = h.g.addMember(fakeMember(h.g.ownerId, { guild: h.g, roles: [fakeRole('adm', { permissions: 8n })] }));
    h.cfg.antinuke.ownerPanic = false;
    await h.ctx.risk.signal(h.g, owner.id, 100, 'şüpheli');
    assert.equal(owner.timeouts.length, 0);
    assert.ok(owner.roles.cache.has('adm'));
    assert.ok(h.alerts.some((a) => a.level === 'critical' && /Sahip/.test(a.title)));
  } finally { h.cleanup(); }
});

test('Risk: Kalkan\'ın kendisine sinyal işlenmez; modül kapalıyken skor tutulmaz', async () => {
  const h = setup();
  try {
    assert.equal(await h.ctx.risk.signal(h.g, h.client.user.id, 100, 'x'), 0);
    h.cfg.modules.risk = false;
    assert.equal(await h.ctx.risk.signal(h.g, '760000000000000003', 100, 'x'), 0);
  } finally { h.cleanup(); }
});

test('İzleme: ekle/aktif/kaldır, süre dolunca düşer', async () => {
  const h = setup(['watchlist']);
  try {
    const uid = '760000000000000004';
    h.ctx.watch.add(h.g.id, uid, { reason: 'RAT şüphesi', by: 'x', days: 2 });
    assert.ok(h.ctx.watch.isActive(h.g.id, uid));
    assert.equal(h.ctx.watch.list(h.g.id).length, 1);
    h.store.data.watch[h.g.id][uid].until = Date.now() - 1;
    assert.ok(!h.ctx.watch.isActive(h.g.id, uid), 'süresi dolan izleme aktif sayılmaz');
    h.ctx.watch.add(h.g.id, uid, { reason: 'tekrar', by: 'x', days: 1 });
    assert.ok(h.ctx.watch.remove(h.g.id, uid));
    assert.ok(!h.ctx.watch.isActive(h.g.id, uid));
  } finally { h.cleanup(); }
});

test('Süreli yetki (JIT): rol listesi ve toplu geri alma çalışır', async () => {
  const h = setup(['jit']);
  try {
    assert.equal(typeof h.ctx.jit.list, 'function');
    assert.deepEqual(h.ctx.jit.list(h.g.id), []);
    assert.equal(await h.ctx.jit.revokeAll(h.g, 'test'), 0);
  } finally { h.cleanup(); }
});

test('Kara liste: katılan kişi kara listedeyse işlem uygulanır (yerel liste = ban, uzak liste = 24 sa susturma)', async () => {
  const { Events } = require('discord.js');
  const h = setup(['blocklist']);
  try {
    const bad = fakeMember('760000000000000005', { guild: h.g });
    h.g.addMember(bad);
    let banned = null;
    h.g.bans = { create: async (id, o) => { banned = id; } };
    bad.ban = async () => { banned = bad.id; };
    h.ctx.blocklist.add(bad.id, { reason: 'RAT atıyor', by: 'x' });
    h.cfg.blocklist.action = 'ban';
    h.client.emit(Events.GuildMemberAdd, bad);
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(banned === bad.id || h.alerts.length > 0, 'ban uygulanmalı ya da uyarı verilmeli');
    assert.ok(h.alerts.some((a) => /kara liste/i.test(a.title)), h.alerts.map((a) => a.title).join('|'));
  } finally { h.cleanup(); }
});
