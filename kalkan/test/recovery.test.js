'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Events } = require('discord.js');
const { makeCtx } = require('./helpers');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const GID = '800000000000000001';

function setup(verdict) {
  const h = makeCtx({ modules: ['members', 'privacy', 'recovery'] });
  h.ctx.oauth = { checkGuildGone: async () => verdict, has: () => false, count: () => 0 };
  const dms = [];
  h.ctx.dm = async (id, payload, opts) => { dms.push({ id, payload, opts }); return true; };
  h.dms = dms;
  const reg = h.store.data.members[GID] = {};
  for (let i = 1; i <= 4; i++) reg[`75000000000000000${i}`] = { msgs: 1, joinedAt: 1 };
  reg['750000000000000005'] = { left: Date.now() };          // ayrılmış: DM yok
  reg['750000000000000006'] = { bot: true };                   // bot: DM yok
  // Yalnızca gönüllü kayıt (opt-in) olanlara DM gider: 1-3 onaylı; 4 onaysız; 5 ayrılmış ve 6 bot (onaylı görünse bile atlanır).
  for (const n of [1, 2, 3, 5, 6]) h.ctx.privacy.consentGrant(GID, `75000000000000000${n}`, 'komut');
  h.cfg = h.ctx.gcfg(GID);
  h.cfg.recovery.autoBroadcast = true;
  h.del = async () => { h.client.emit(Events.GuildDelete, { id: GID, name: 'Klan Sunucusu', ownerId: '900000000000000001', available: true }); await wait(120); };
  return h;
}

test('Sunucu silindi (doğrulandı): YALNIZCA gönüllü kayıtlı üyelere açıklama DM\'i gider (onaysız, ayrılmış ve bot atlanır)', async () => {
  const h = setup({ verdict: 'gone', checked: 6 });
  try {
    await h.del();
    const to = h.dms.filter((d) => d.opts && d.opts.bulk).map((d) => d.id).sort();
    assert.deepEqual(to, ['750000000000000001', '750000000000000002', '750000000000000003']);
    const emb = h.dms.find((d) => d.opts && d.opts.bulk).payload.embeds[0].data;
    assert.match(emb.title, /Klan Sunucusu/);
    assert.ok(emb.description.length > 20);
    assert.ok(h.alerts.some((a) => /SİLİNDİĞİ doğrulandı/.test(a.title)));
    assert.equal(h.cfg.recovery.lastBroadcast.sent, 3);
  } finally { h.cleanup(); }
});

test('Sunucu hâlâ var (bot atıldı): duyuru GÖNDERİLMEZ, kritik uyarı gelir', async () => {
  const h = setup({ verdict: 'exists', checked: 6 });
  try {
    await h.del();
    assert.equal(h.dms.filter((d) => d.opts && d.opts.bulk).length, 0);
    assert.ok(h.alerts.some((a) => /Bot sunucudan atıldı/.test(a.title)));
  } finally { h.cleanup(); }
});

test('Belirsiz durum: sahiplere onay sorulur (butonlu), kullanıcılara DM gitmez', async () => {
  const h = setup({ verdict: 'unknown', checked: 0 });
  try {
    await h.del();
    assert.equal(h.dms.filter((d) => d.opts && d.opts.bulk).length, 0);
    const asks = h.dms.filter((d) => d.payload.components && d.payload.components.length);
    assert.ok(asks.length >= 1);
    const ids = asks[0].payload.components[0].components.map((c) => c.data.custom_id);
    assert.deepEqual(ids, [`rec:send:${GID}`, `rec:skip:${GID}`]);
  } finally { h.cleanup(); }
});

test('Otomatik gönderim kapalıysa doğrulanmış silinme bile onay ister', async () => {
  const h = setup({ verdict: 'gone', checked: 6 });
  try {
    h.cfg.recovery.autoBroadcast = false;
    await h.del();
    assert.equal(h.dms.filter((d) => d.opts && d.opts.bulk).length, 0);
    assert.ok(h.dms.some((d) => d.payload.components && d.payload.components.length));
  } finally { h.cleanup(); }
});

test('İki kez GuildDelete gelirse duyuru iki kez gönderilmez', async () => {
  const h = setup({ verdict: 'gone', checked: 6 });
  try {
    await h.del();
    const first = h.dms.filter((d) => d.opts && d.opts.bulk).length;
    assert.equal(first, 3);
    await h.del();
    assert.equal(h.dms.filter((d) => d.opts && d.opts.bulk).length, first, 'ikinci olayda yeniden DM gitmemeli');
    assert.ok(h.alerts.some((a) => /yeniden gönderilmedi/.test(a.title)));
  } finally { h.cleanup(); }
});

test('Geçici kesinti (guild.available=false) sunucu silinmesi sayılmaz', async () => {
  const h = setup({ verdict: 'gone', checked: 6 });
  try {
    h.client.emit(Events.GuildDelete, { id: GID, name: 'x', available: false });
    await wait(80);
    assert.equal(h.dms.length, 0);
    assert.equal(h.alerts.length, 0);
  } finally { h.cleanup(); }
});

test('Duyuruya link içeren özel metin kabul edilmez; sunucu adı yerleştirilir', () => {
  const rec = require('../src/modules/recovery');
  assert.equal(rec.hasLink('Merhaba! {sunucu} silindi. Yeni adresimiz için bekleyin.'), false);
  assert.equal(rec.hasLink('Yeni sunucu: discord.gg/xyz'), true);
});

test('Hiç gönüllü kayıt yoksa kimseye DM gitmez; yönetime uyarı gider', async () => {
  const h = setup({ verdict: 'gone', checked: 6 });
  try {
    for (const n of [1, 2, 3, 5, 6]) h.ctx.privacy.consentRevoke(`75000000000000000${n}`, GID);
    await h.del();
    assert.equal(h.dms.filter((d) => d.opts && d.opts.bulk).length, 0);
    assert.ok(h.alerts.some((a) => /gönüllü kayıt yok/.test(a.title)));
  } finally { h.cleanup(); }
});

test('İzni geri çeken üye duyuru listesinden çıkar; onaysız üye eklenmez', async () => {
  const h = setup({ verdict: 'gone', checked: 6 });
  try {
    h.ctx.privacy.consentRevoke('750000000000000002', GID);
    assert.deepEqual(h.ctx.privacy.audience(GID).sort(), ['750000000000000001', '750000000000000003']);
    await h.del();
    const to = h.dms.filter((d) => d.opts && d.opts.bulk).map((d) => d.id).sort();
    assert.deepEqual(to, ['750000000000000001', '750000000000000003']);
    assert.ok(!to.includes('750000000000000004'), 'izin vermeyen üyeye DM gitmemeli');
  } finally { h.cleanup(); }
});
