'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Events, ChannelType } = require('discord.js');
const { makeCtx, fakeRole, fakeChannel, fakeBuildableGuild, fakeMember } = require('./helpers');

function setup() {
  const h = makeCtx({ modules: ['members', 'backup', 'panic'] });
  const g = fakeBuildableGuild();
  h.client.guilds.cache.set(g.id, g);
  h.g = g;
  const add = (c) => { g.channels.cache.set(c.id, c); return c; };
  g.roles.cache.set('r-mod', fakeRole('r-mod', { name: 'Moderatör', permissions: 1n << 13n, position: 5 }));
  g.roles.cache.set('r-uye', fakeRole('r-uye', { name: 'Üye', position: 2 }));
  add(fakeChannel('cat1', 'GENEL', { type: ChannelType.GuildCategory, position: 0 }));
  add(fakeChannel('c-sohbet', 'sohbet', { parentId: 'cat1', position: 1, overwrites: [{ id: g.id, type: 0, deny: 1n << 11n }] }));
  add(fakeChannel('c-duyuru', 'duyurular', { parentId: 'cat1', position: 2 }));
  return h;
}

test('Yedek: şifreli diske yazılır, düz metin içermez, geri okunur', async () => {
  const h = setup();
  try {
    const meta = await h.ctx.backup.snapshot(h.g, { by: 'test' });
    assert.equal(meta.channels, 3);
    assert.equal(meta.roles, 2);
    const raw = fs.readFileSync(path.join(h.dir, 'backups', h.g.id, meta.file));
    assert.ok(!raw.includes(Buffer.from('Moderatör')), 'şifreli olmalı');
    assert.ok(!raw.includes(Buffer.from('sohbet')));
    const snap = h.ctx.backup.latest(h.g.id);
    assert.equal(snap.roles.find((r) => r.id === 'r-mod').name, 'Moderatör');
    assert.equal(snap.channels.find((c) => c.id === 'c-sohbet').parentId, 'cat1');
    assert.equal(snap.channels.find((c) => c.id === 'c-sohbet').overwrites[0].deny, String(1n << 11n));
  } finally { h.cleanup(); }
});

test('Yedek: eski yedekler anahtar sayısına göre silinir', async () => {
  const h = setup();
  try {
    h.ctx.gcfg(h.g.id).backup.keep = 2;
    for (let i = 0; i < 4; i++) { await h.ctx.backup.snapshot(h.g, { by: 'x' }); await new Promise((r) => setTimeout(r, 3)); }
    assert.equal(h.ctx.backup.list(h.g.id).length, 2);
    assert.equal(fs.readdirSync(path.join(h.dir, 'backups', h.g.id)).filter((f) => f.endsWith('.bin')).length, 2);
  } finally { h.cleanup(); }
});

test('Otomatik yedek: kanal sayısı ani düşerse atlanır, eski yedek korunur', async () => {
  const h = setup();
  try {
    await h.ctx.backup.snapshot(h.g, { by: 'x' });
    for (const id of ['c-sohbet', 'c-duyuru']) h.g.channels.cache.delete(id); // 3 -> 1 (>%30 düşüş)
    const r = await h.ctx.backup.snapshot(h.g, { auto: true });
    assert.equal(r, null);
    assert.equal(h.ctx.backup.list(h.g.id).length, 1);
    assert.ok(h.alerts.some((a) => /atlandı/.test(a.title)));
    // elle alınan yedek yine de kaydedilir
    assert.ok(await h.ctx.backup.snapshot(h.g, { by: 'x' }));
  } finally { h.cleanup(); }
});

test('Anti-nuke geri yükleme: silinen kanal canlı kopyadan yeniden açılır, hiçbir şey silinmez', async () => {
  const h = setup();
  try {
    const ch = h.g.channels.cache.get('c-sohbet');
    h.client.emit(Events.ChannelDelete, Object.assign(ch, { guild: h.g }));
    h.g.channels.cache.delete('c-sohbet');
    const res = await h.ctx.backup.restoreDeleted(h.g, { channels: ['c-sohbet'] });
    assert.equal(res.channels, 1);
    assert.equal(h.g.created.channels.length, 1);
    assert.equal(h.g.created.channels[0].name, 'sohbet');
    assert.equal(h.g.created.channels[0].parent, 'cat1', 'kategori korunmalı');
    assert.ok(h.g.created.channels[0].permissionOverwrites.some((o) => o.deny === 1n << 11n), 'izinler korunmalı');
  } finally { h.cleanup(); }
});

test('Geri yükleme: yedekten silinen rol, üyelerine yeniden verilir; yetkisiz botta yetki yükseltilmez', async () => {
  const h = setup();
  try {
    const u = h.g.addMember(fakeMember('720000000000000001', { guild: h.g }));
    h.ctx.members.ensure(h.g.id, u.id).roles = ['r-mod'];
    await h.ctx.backup.snapshot(h.g, { by: 'x' });
    h.g.roles.cache.delete('r-mod');
    const given = [];
    u.roles.add = async (ids) => { given.push(...[].concat(ids)); };
    // bot yönetici DEĞİL ve yalnızca "kanalları yönet" yetkisine sahip: verilen izin bununla sınırlanmalı
    h.g.members.me.permissions = 1n << 4n;
    const res = await h.ctx.backup.restoreDeleted(h.g, { roles: ['r-mod'] });
    assert.equal(res.roles, 1);
    assert.equal(h.g.created.roles[0].permissions & (1n << 13n), 0n, 'botun sahip olmadığı yetki verilmemeli');
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(given.length, 1, 'üyeye rol geri verilmeli');
  } finally { h.cleanup(); }
});

test('Panik: kanalları kilitler, davetleri kapatır; kapatınca eski izinlere döner', async () => {
  const h = setup();
  try {
    const sohbet = h.g.channels.cache.get('c-sohbet');
    const duyuru = h.g.channels.cache.get('c-duyuru');
    const r = await h.ctx.panic.activate(h.g, { by: 'test', reason: 'deneme' });
    assert.ok(r.locked >= 2);
    assert.equal(h.ctx.gcfg(h.g.id).panic.active, true);
    assert.equal(h.g.invitesDisabled, true);
    assert.equal(h.g.verificationLevel, 4);
    assert.equal(sohbet.calls.edit[0].SendMessages, false);
    assert.equal((await h.ctx.panic.activate(h.g, {})).already, true, 'ikinci kez açılmaz');
    await h.ctx.panic.deactivate(h.g, 'test');
    assert.equal(h.ctx.gcfg(h.g.id).panic.active, false);
    assert.equal(h.g.invitesDisabled, false);
    assert.equal(h.g.verificationLevel, 1, 'doğrulama seviyesi eski haline dönmeli');
    assert.deepEqual(duyuru.calls.delete.length, 1, 'izni olmayan kanalda yazılan kural silinmeli');
    assert.equal(sohbet.calls.edit.at(-1).SendMessages, false, 'önceden yasak olan izin yasak kalmalı');
  } finally { h.cleanup(); }
});
