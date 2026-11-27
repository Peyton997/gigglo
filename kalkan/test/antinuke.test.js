'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Events, AuditLogEvent: A } = require('discord.js');
const { makeCtx, fakeGuild, fakeMember, fakeRole } = require('./helpers');

const ADMIN = 8n;
const tick = () => new Promise((r) => setTimeout(r, 15));

function setup() {
  const h = makeCtx({ modules: ['members', 'risk', 'antinuke'] });
  const guild = fakeGuild();
  h.client.guilds.cache.set(guild.id, guild);
  h.guild = guild;
  h.cfg = h.ctx.gcfg(guild.id);
  h.cfg.antinuke.autoRestore = false;
  h.emit = async (entry) => { h.client.emit(Events.GuildAuditLogEntryCreate, entry, guild); await tick(); await tick(); };
  h.del = (exec, n = 1) => ({ action: A.ChannelDelete, executorId: exec, targetId: `ch${n}${Math.random()}`, changes: [{ key: 'name', old: `kanal-${n}` }] });
  h.alertTitles = () => h.alerts.map((a) => a.title);
  return h;
}

test('Eşik altında işlem alarm üretmez, ama denetim kaydı tutulur', async () => {
  const h = setup();
  try {
    const admin = h.guild.addMember(fakeMember('710000000000000001', { guild: h.guild, roles: [fakeRole('adm', { permissions: ADMIN })] }));
    const th = h.cfg.antinuke.thresholds.channelDelete;
    for (let i = 0; i < th - 1; i++) await h.emit(h.del(admin.id, i));
    assert.equal(h.alerts.filter((a) => a.level === 'critical').length, 0);
    assert.equal(h.ctx.events.read(h.guild.id).filter((e) => e.type === 'ChannelDelete').length, th - 1);
  } finally { h.cleanup(); }
});

test('Toplu kanal silme: kritik roller alınır, 1 saat susturulur, kritik uyarı gelir', async () => {
  const h = setup();
  try {
    const admin = h.guild.addMember(fakeMember('710000000000000002', { guild: h.guild, roles: [fakeRole('adm', { permissions: ADMIN, name: 'Yönetici' }), fakeRole('uye', { permissions: 0n })] }));
    const th = h.cfg.antinuke.thresholds.channelDelete;
    for (let i = 0; i < th; i++) await h.emit(h.del(admin.id, i));
    const crit = h.alerts.filter((a) => a.level === 'critical');
    assert.equal(crit.length, 1, h.alertTitles().join(' | '));
    assert.ok(!admin.roles.cache.has('adm'), 'kritik rol alınmalı');
    assert.ok(admin.roles.cache.has('uye'), 'sıradan rol korunmalı');
    assert.deepEqual(admin.timeouts, [3600e3]);
    assert.deepEqual(h.ctx.members.ensure(h.guild.id, admin.id).stripped, ['adm'], 'geri alma için saklanmalı');
    // 10 dk içinde ikinci tetikleme yok
    for (let i = 0; i < th; i++) await h.emit(h.del(admin.id, 50 + i));
    assert.equal(h.alerts.filter((a) => a.level === 'critical').length, 1, 'aynı kişi için tekrar alarm yağmuru olmamalı');
  } finally { h.cleanup(); }
});

test('Güvenilir/sahip hesapta eşik iki katı; hesaba müdahale edilmez', async () => {
  const h = setup();
  try {
    h.cfg.antinuke.ownerPanic = false;
    const boss = h.guild.addMember(fakeMember(h.guild.ownerId, { guild: h.guild, roles: [fakeRole('adm', { permissions: ADMIN })] }));
    const th = h.cfg.antinuke.thresholds.channelDelete;
    for (let i = 0; i < th; i++) await h.emit(h.del(boss.id, i));
    assert.equal(h.alerts.filter((a) => a.level === 'critical').length, 0, 'tek eşikte tetiklenmemeli');
    for (let i = th; i < th * 2; i++) await h.emit(h.del(boss.id, i));
    const crit = h.alerts.filter((a) => a.level === 'critical');
    assert.equal(crit.length, 1);
    assert.ok(boss.roles.cache.has('adm'), 'sahibin rolleri alınmamalı');
    assert.equal(boss.timeouts.length, 0);
  } finally { h.cleanup(); }
});

test('Bot hesabı toplu silerse sunucudan atılır', async () => {
  const h = setup();
  try {
    const bot = h.guild.addMember(fakeMember('710000000000000003', { guild: h.guild, bot: true }));
    for (let i = 0; i < h.cfg.antinuke.thresholds.channelDelete; i++) await h.emit(h.del(bot.id, i));
    assert.equal(bot.kicked, true);
  } finally { h.cleanup(); }
});

test('Kalkan\'ın kendi işlemleri sayılmaz', async () => {
  const h = setup();
  try {
    for (let i = 0; i < 30; i++) await h.emit(h.del(h.client.user.id, i));
    assert.equal(h.alerts.length, 0);
  } finally { h.cleanup(); }
});

test('Yetkisiz bot ekleme: bot atılır, yetkili ekleyen riske işlenir', async () => {
  const h = setup();
  try {
    const adder = h.guild.addMember(fakeMember('710000000000000004', { guild: h.guild }));
    const bot = h.guild.addMember(fakeMember('710000000000000005', { guild: h.guild, bot: true }));
    await h.emit({ action: A.BotAdd, executorId: adder.id, targetId: bot.id, changes: [] });
    assert.equal(bot.kicked, true);
    assert.ok(h.alerts.some((a) => /Yetkisiz bot/.test(a.title)));
  } finally { h.cleanup(); }
});

test('Rol koruması: güvenilmeyen kişi kritik rol verirse geri alınır', async () => {
  const h = setup();
  try {
    const adminRole = fakeRole('adm', { permissions: ADMIN, name: 'Yönetici' });
    h.guild.roles.cache.set('adm', adminRole);
    const giver = h.guild.addMember(fakeMember('710000000000000006', { guild: h.guild }));
    const target = h.guild.addMember(fakeMember('710000000000000007', { guild: h.guild, roles: [adminRole] }));
    await h.emit({ action: A.MemberRoleUpdate, executorId: giver.id, targetId: target.id, changes: [{ key: '$add', new: [{ id: 'adm' }] }] });
    assert.ok(!target.roles.cache.has('adm'), 'rol geri alınmalı');
    assert.ok(h.alerts.some((a) => /geri alındı/.test(a.title)));
  } finally { h.cleanup(); }
});

test('Rol koruması: güvenilir kişi verirse izin verilir ve yalnızca bilgi düşer', async () => {
  const h = setup();
  try {
    const adminRole = fakeRole('adm', { permissions: ADMIN });
    h.guild.roles.cache.set('adm', adminRole);
    const giver = h.guild.addMember(fakeMember('710000000000000008', { guild: h.guild }));
    h.cfg.trusted.push(giver.id);
    h.cfg.roleGuard.timeLockHours = 0;
    const target = h.guild.addMember(fakeMember('710000000000000009', { guild: h.guild, roles: [adminRole] }));
    await h.emit({ action: A.MemberRoleUpdate, executorId: giver.id, targetId: target.id, changes: [{ key: '$add', new: [{ id: 'adm' }] }] });
    assert.ok(target.roles.cache.has('adm'));
    assert.ok(h.alerts.every((a) => a.level === 'info'));
  } finally { h.cleanup(); }
});

test('Zaman kilidi: güvenilir kişi verse bile rol bekletilir; iptal edilebilir', async () => {
  const h = setup();
  try {
    const adminRole = fakeRole('adm', { permissions: ADMIN });
    h.guild.roles.cache.set('adm', adminRole);
    const giver = h.guild.addMember(fakeMember('710000000000000010', { guild: h.guild }));
    h.cfg.trusted.push(giver.id);
    h.cfg.roleGuard.timeLockHours = 24;
    const target = h.guild.addMember(fakeMember('710000000000000011', { guild: h.guild, roles: [adminRole] }));
    await h.emit({ action: A.MemberRoleUpdate, executorId: giver.id, targetId: target.id, changes: [{ key: '$add', new: [{ id: 'adm' }] }] });
    assert.ok(!target.roles.cache.has('adm'), 'rol geçici olarak alınmalı');
    const list = h.ctx.timelock.list(h.guild.id);
    assert.equal(list.length, 1);
    assert.ok(list[0].at > Date.now() + 23 * 3600e3);
    assert.equal(h.ctx.timelock.cancel(list[0].id), true);
    assert.equal(h.ctx.timelock.list(h.guild.id).length, 0);
  } finally { h.cleanup(); }
});

test('Rol yetkisi yükseltme geri alınır', async () => {
  const h = setup();
  try {
    let restored = null;
    const role = { ...fakeRole('r9', { permissions: ADMIN, name: 'Üye' }), setPermissions: async (p) => { restored = p; } };
    h.guild.roles.cache.set('r9', role);
    const x = h.guild.addMember(fakeMember('710000000000000012', { guild: h.guild }));
    await h.emit({ action: A.RoleUpdate, executorId: x.id, targetId: 'r9', changes: [{ key: 'permissions', old: '0', new: '8' }] });
    assert.equal(restored, 0n);
    assert.ok(h.alerts.some((a) => /yetki yükseltme/i.test(a.title)));
  } finally { h.cleanup(); }
});

test('Modül kapalıyken sayaç çalışmaz', async () => {
  const h = setup();
  try {
    h.cfg.modules.antinuke = false;
    const x = h.guild.addMember(fakeMember('710000000000000013', { guild: h.guild }));
    for (let i = 0; i < 20; i++) await h.emit(h.del(x.id, i));
    assert.equal(h.alerts.length, 0);
  } finally { h.cleanup(); }
});
