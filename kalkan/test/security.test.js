'use strict';
// Güvenlik testleri: şifreleme, SSRF/ağ katmanı, günlük maskeleme, depo dayanıklılığı, yönlendirici yetkisi, gizlilik, arayüz.
// NOT: Bunlar yerel/sahte (mock) testlerdir; gerçek Discord ya da internet bağlantısı gerektirmez ve gerçek Discord davranışını KANITLAMAZ.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { SlashCommandBuilder } = require('discord.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kalkan-sec-'));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

/* ------------------------------------------------------------------ şifreleme */
test('crypto: gidiş-dönüş, yanlış anahtar, kurcalama ve kısa parola', () => {
  const C = require('../src/crypto');
  const d1 = tmp();
  try {
    C.initKey({ dataKey: 'birinci-uzun-parola-123', dataDir: d1 });
    const enc = C.encrypt('gizli-metin');
    assert.equal(C.decrypt(enc), 'gizli-metin');
    assert.notEqual(C.encrypt('gizli-metin'), enc, 'her şifrelemede IV farklı olmalı');

    // Kurcalanmış veri → BAD_DATA
    const buf = Buffer.from(enc, 'base64');
    buf[buf.length - 1] ^= 1;
    assert.throws(() => C.decryptBuffer(buf), (e) => e instanceof C.DecryptError && e.code === 'BAD_DATA');

    // Başlık (AAD) kurcalanırsa da reddedilir
    const buf2 = Buffer.from(enc, 'base64');
    buf2[5] ^= 1; // anahtar kimliği bayrağı → anahtar bulunamaz → eski biçim denenir → KEY_MISSING
    assert.throws(() => C.decryptBuffer(buf2), (e) => e instanceof C.DecryptError);

    // Başka anahtar → KEY_MISSING
    C.initKey({ dataKey: 'tamamen-baska-parola-456', dataDir: d1 });
    assert.throws(() => C.decrypt(enc), (e) => e instanceof C.DecryptError && e.code === 'KEY_MISSING');

    // Çok kısa parola reddedilir
    assert.throws(() => C.initKey({ dataKey: 'kisa', dataDir: d1 }), /en az 12/);
  } finally { rm(d1); }
});

test('crypto: anahtar rotasyonu (DATA_KEY_OLD) eski veriyi çözer, yeniden sarma güncel anahtara geçirir', () => {
  const C = require('../src/crypto');
  const d = tmp();
  try {
    C.initKey({ dataKey: 'eski-anahtar-parolasi-1', dataDir: d });
    const eski = C.encryptBuffer(Buffer.from('veri-A'));
    C.initKey({ dataKey: 'yeni-anahtar-parolasi-2', dataKey_: 1, dataKeyOld: 'eski-anahtar-parolasi-1', dataDir: d });
    assert.equal(C.decryptBuffer(eski).toString(), 'veri-A', 'eski anahtarla şifrelenmiş veri hâlâ açılmalı');
    assert.equal(C.isCurrent(eski), false);
    const yeni = C.rewrap(eski);
    assert.equal(C.isCurrent(yeni), true);
    assert.equal(C.decryptBuffer(yeni).toString(), 'veri-A');
    // Eski anahtar tamamen kaldırılırsa eski veri açılmaz, yeniden sarılmış veri açılır
    C.initKey({ dataKey: 'yeni-anahtar-parolasi-2', dataDir: d });
    assert.throws(() => C.decryptBuffer(eski), (e) => e.code === 'KEY_MISSING');
    assert.equal(C.decryptBuffer(yeni).toString(), 'veri-A');
  } finally { rm(d); }
});

test('crypto: eski v1 biçimi (sha256 türevli anahtar) hâlâ çözülür', () => {
  const C = require('../src/crypto');
  const d = tmp();
  try {
    const pass = 'eski-surum-parolasi-xyz';
    C.initKey({ dataKey: pass, dataDir: d });
    const key = crypto.createHash('sha256').update(pass).digest();
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([c.update('v1-veri'), c.final()]);
    const v1 = Buffer.concat([iv, c.getAuthTag(), enc]);
    assert.equal(C.decryptBuffer(v1).toString(), 'v1-veri');
  } finally { rm(d); }
});

test('crypto: DATA_KEY yoksa data/.key üretilir ve yeniden başlatmada aynı anahtar kullanılır', () => {
  const C = require('../src/crypto');
  const d = tmp();
  try {
    assert.equal(C.initKey({ dataDir: d }), 'generated');
    const enc = C.encrypt('x');
    assert.equal(C.initKey({ dataDir: d }), 'file');
    assert.equal(C.decrypt(enc), 'x');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(d, '.key')).mode & 0o077, 0, '.key yalnızca sahibine açık olmalı');
  } finally { rm(d); }
});

/* ------------------------------------------------------------------ ağ / SSRF */
test('net: özel ve yerel adresler engellenir (IPv4, IPv6, IPv4-mapped, NAT64)', () => {
  const { isPrivateIp, isPrivateHost } = require('../src/net');
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.5', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '[::1]', '64:ff9b::7f00:1']) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
  for (const h of ['localhost', 'printer.local', 'db.internal', 'intranet', '127.0.0.1', '', 'a.localhost']) assert.equal(isPrivateHost(h), true, h);
  assert.equal(isPrivateHost('example.com'), false);
});

test('net: korumalı DNS çözümleyici (rebinding) herhangi bir özel adres dönerse reddeder', async () => {
  const { makeGuardedLookup } = require('../src/net');
  const call = (resolve) => new Promise((res) => makeGuardedLookup(resolve)('x.test', {}, (err, a) => res({ err, a })));
  const ok = await call((h, o, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]));
  assert.equal(ok.err, null);
  const mixed = await call((h, o, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]));
  assert.equal(mixed.err && mixed.err.code, 'EBLOCKED', 'karışık yanıttaki tek bir özel adres bile engellenmeli');
  const meta = await call((h, o, cb) => cb(null, [{ address: '169.254.169.254', family: 4 }]));
  assert.equal(meta.err && meta.err.code, 'EBLOCKED');
  const fail = await call((h, o, cb) => cb(new Error('ENOTFOUND')));
  assert.match(fail.err.message, /ENOTFOUND/);
});

// Sahte taşıma: kuyruktaki yanıtları sırayla verir; istenen adresleri kaydeder.
function fakeTransport(responses) {
  const seen = [];
  const request = (u, opts, cb) => {
    seen.push(String(u));
    const spec = responses.shift();
    const res = Readable.from(spec.chunks || []);
    res.statusCode = spec.status || 200;
    res.headers = spec.headers || {};
    const req = new (require('events').EventEmitter)();
    req.destroy = () => {};
    req.end = () => setImmediate(() => cb(res));
    return req;
  };
  return { seen, transport: { request } };
}

test('net.safeGet: HTTP, kimlik bilgili URL, özel adres ve izin dışı sunucu reddedilir', async () => {
  const { safeGet } = require('../src/net');
  const t = fakeTransport([]).transport;
  await assert.rejects(safeGet('http://example.com/a', { transport: t }), /HTTPS/);
  await assert.rejects(safeGet('https://user:pw@example.com/a', { transport: t }), /Kimlik/);
  await assert.rejects(safeGet('https://127.0.0.1/a', { transport: t }), /engellendi/);
  await assert.rejects(safeGet('https://localhost/a', { transport: t }), /engellendi/);
  await assert.rejects(safeGet('https://evil.example/a', { allowHosts: ['discord.com'], transport: t }), /İzin verilmeyen/);
});

test('net.safeGet: yönlendirme özel adrese ya da HTTP\'ye çıkarsa durdurulur; zincir sınırlıdır', async () => {
  const { safeGet } = require('../src/net');
  const a = fakeTransport([{ status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data' } }]);
  await assert.rejects(safeGet('https://example.com/r', { transport: a.transport }), /engellendi/);
  assert.equal(a.seen.length, 1, 'özel adrese hiç istek atılmamalı');

  const b = fakeTransport([{ status: 301, headers: { location: 'http://example.org/x' } }]);
  await assert.rejects(safeGet('https://example.com/r', { transport: b.transport }), /HTTPS/);

  const loop = fakeTransport(Array.from({ length: 6 }, () => ({ status: 302, headers: { location: 'https://example.com/r' } })));
  await assert.rejects(safeGet('https://example.com/r', { transport: loop.transport, maxHops: 3 }), /Çok fazla yönlendirme/);

  const ok = fakeTransport([{ status: 302, headers: { location: '/son' } }, { status: 200, chunks: [Buffer.from('tamam')] }]);
  const r = await safeGet('https://example.com/r', { transport: ok.transport });
  assert.equal(r.body.toString(), 'tamam');
  assert.equal(ok.seen[1], 'https://example.com/son');
});

test('net.safeGet: boyut sınırı akışta uygulanır (Content-Length yalan söylese de); truncate ve sıkıştırma', async () => {
  const { safeGet, peek } = require('../src/net');
  const big = fakeTransport([{ status: 200, headers: { 'content-length': '10' }, chunks: [Buffer.alloc(600, 1), Buffer.alloc(600, 1)] }]);
  await assert.rejects(safeGet('https://example.com/b', { maxBytes: 1000, transport: big.transport }), /çok büyük/);

  const declared = fakeTransport([{ status: 200, headers: { 'content-length': '99999999' }, chunks: [] }]);
  await assert.rejects(safeGet('https://example.com/b', { maxBytes: 1000, transport: declared.transport }), /çok büyük/);

  const pk = fakeTransport([{ status: 206, chunks: [Buffer.from('MZ'), Buffer.alloc(5000, 7)] }]);
  const head = await peek('https://example.com/f.exe', 16, { transport: pk.transport });
  assert.equal(head.length, 16);
  assert.equal(head.subarray(0, 2).toString(), 'MZ');

  const gz = fakeTransport([{ status: 200, headers: { 'content-encoding': 'gzip' }, chunks: [Buffer.from('x')] }]);
  await assert.rejects(safeGet('https://example.com/z', { transport: gz.transport }), /Sıkıştırılmış/);
});

/* ------------------------------------------------------------------ günlük maskeleme */
test('logger: token, webhook adresi, Authorization başlığı ve bilinen sırlar maskelenir', () => {
  const { redact, addSecret } = require('../src/logger');
  const token = `${'A'.repeat(24)}.${'B'.repeat(6)}.${'C'.repeat(30)}`;
  assert.ok(!redact(`giriş ${token} başarılı`).includes(token));
  const hook = 'https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-JKL0123456789';
  assert.ok(!redact(`webhook=${hook}`).includes('abcDEF'));
  assert.ok(!redact('authorization: Bearer abcdefghijklmnop1234').includes('abcdefghijklmnop1234'));
  assert.ok(!redact('{"client_secret":"s3cr3t-deger-uzun-12345"}').includes('s3cr3t-deger'));
  addSecret('benim-ozel-sifrem-9999');
  assert.equal(redact('kayit benim-ozel-sifrem-9999 bitti'), 'kayit *** bitti');
  assert.equal(redact('normal bir satır'), 'normal bir satır', 'sıradan metin değişmemeli');
  // Regresyon: yakalama grubu olmayan desenlerde eskiden satırın tamamı (konum + metin) tekrar yazılıyordu.
  assert.equal(redact(`giriş ${token} bitti`), 'giriş *** bitti');
  assert.equal(redact(`url=${hook}!`), 'url=***!');
});

/* ------------------------------------------------------------------ depo */
test('store: ilk kurulum, yeniden okuma, bozuk dosyada .bak kurtarması ve tam bozulmada güvenli sıfırlama', () => {
  const { Store } = require('../src/store');
  const d = tmp();
  try {
    const a = new Store(d).load();
    assert.equal(a.loadStatus, 'new');
    a.data.guilds.g1 = { x: 1 };
    a.save();
    a.flush();
    a.data.guilds.g1 = { x: 2 };
    a.save();
    a.flush(); // ikinci yazma: .bak ilk sürümü tutar

    const b = new Store(d).load();
    assert.equal(b.loadStatus, 'ok');
    assert.deepEqual(b.data.guilds.g1, { x: 2 });
    assert.ok(fs.existsSync(path.join(d, 'db.json.bak')));
    assert.ok(!fs.existsSync(path.join(d, 'db.json.tmp')), 'geçici dosya kalmamalı');

    fs.writeFileSync(path.join(d, 'db.json'), '{ bozuk json');
    const c = new Store(d).load();
    assert.equal(c.loadStatus, 'recovered');
    assert.deepEqual(c.data.guilds.g1, { x: 1 }, '.bak sürümünden açılmalı');
    assert.ok(fs.readdirSync(d).some((f) => f.startsWith('db.corrupt-')), 'bozuk dosya silinmeden saklanmalı');

    fs.writeFileSync(path.join(d, 'db.json'), 'çöp');
    fs.rmSync(path.join(d, 'db.json.bak'));
    fs.rmSync(path.join(d, 'db.json.bak2'), { force: true });
    const e = new Store(d).load();
    assert.equal(e.loadStatus, 'reset');
    for (const k of ['consent', 'cases', 'sched', 'access']) assert.deepEqual(e.data[k], {}, `${k} bölümü hazır olmalı`);
  } finally { rm(d); }
});

/* ------------------------------------------------------------------ bağlantı tespiti */
test('links: dosya adları bağlantı sanılmaz; şüpheli alan adları ve CDN\'deki çalıştırılabilir dosyalar engellenir', () => {
  const L = require('../src/modules/links');
  const hosts = (t) => L.extract(t).map((i) => i.hostBare);
  for (const t of ['start.sh çalıştır', 'Main.java hata veriyor', 'config.yml düzenle', 'index.js ve app.py', 'sürüm 1.20.4 çıktı']) assert.deepEqual(hosts(t), [], t);
  const ev = L.extract('evil.pw/x')[0];
  assert.equal(L.classify(ev, {}).action, 'block');
  const exe = L.extract('https://cdn.discordapp.com/attachments/1/2/a.exe')[0];
  assert.equal(L.classify(exe, {}).action, 'block', 'CDN üzerindeki .exe serbest bırakılmamalı');
  const png = L.extract('https://cdn.discordapp.com/attachments/1/2/a.png')[0];
  assert.equal(L.classify(png, {}).action, 'allow');
  for (const gif of ['https://tenor.com/view/x-1', 'https://media.giphy.com/media/a/giphy.gif']) assert.equal(L.classify(L.extract(gif)[0], {}).action, 'allow', gif);
});

/* ------------------------------------------------------------------ yönlendirici (yetki + hata) */
function fakeInteraction({ cmd = 'deneme', uid = '1', guildOwner = '2', perms = [], guild = true } = {}) {
  const out = [];
  const i = {
    commandName: cmd, guildId: guild ? 'g1' : null, user: { id: uid }, deferred: false, replied: false,
    guild: guild ? { id: 'g1', ownerId: guildOwner } : null,
    memberPermissions: { has: (b) => perms.includes(b) },
    isAutocomplete: () => false, isChatInputCommand: () => true, isUserContextMenuCommand: () => false, isMessageContextMenuCommand: () => false,
    isButton: () => false, isAnySelectMenu: () => false, isStringSelectMenu: () => false, isModalSubmit: () => false,
    inGuild: () => guild,
    reply: async (p) => { out.push(p); i.replied = true; },
    followUp: async (p) => { out.push(p); },
  };
  return { i, out };
}

test('router: yetki seviyeleri uygulama tarafında da denetlenir; hata kullanıcıya iç ayrıntı sızdırmaz', async () => {
  const { createRouter } = require('../src/router');
  const { PermissionFlagsBits: P } = require('discord.js');
  const { makeCtx } = require('./helpers');
  const h = makeCtx();
  try {
    const r = createRouter();
    const ran = [];
    const mk = (n) => new SlashCommandBuilder().setName(n).setDescription('açıklama');
    r.add(mk('yonetici'), async () => { ran.push('yonetici'); }, { access: 'admin' });
    r.add(mk('mod'), async () => { ran.push('mod'); }, { access: 'mod' });
    r.add(mk('herkes'), async () => { ran.push('herkes'); });
    r.add(mk('patlak'), async () => { throw new Error('GİZLİ-İÇ-AYRINTI /home/x/db.json'); });
    r.add(mk('suresi'), async () => { throw Object.assign(new Error('Unknown interaction'), { code: 10062 }); });

    // admin: OWNER_IDS dolu → yalnızca bot sahibi
    let x = fakeInteraction({ cmd: 'yonetici', uid: '123' });
    await r.dispatch(h.ctx, x.i);
    assert.equal(ran.length, 0);
    assert.equal(x.out.length, 1, 'reddedilince açıklama gönderilmeli');
    x = fakeInteraction({ cmd: 'yonetici', uid: h.env.ownerIds[0] });
    await r.dispatch(h.ctx, x.i);
    assert.deepEqual(ran, ['yonetici']);

    // mod: yetkisiz → red; Discord izni (ModerateMembers) olan → geçer
    ran.length = 0;
    x = fakeInteraction({ cmd: 'mod', uid: '5' });
    await r.dispatch(h.ctx, x.i);
    assert.equal(ran.length, 0);
    x = fakeInteraction({ cmd: 'mod', uid: '5', perms: [P.ModerateMembers] });
    await r.dispatch(h.ctx, x.i);
    assert.deepEqual(ran, ['mod']);

    // DM'de sunucu komutu çalışmaz
    ran.length = 0;
    x = fakeInteraction({ cmd: 'herkes', guild: false });
    await r.dispatch(h.ctx, x.i);
    assert.equal(ran.length, 0);

    // hata: kullanıcıya yalnızca hata kimliği gider
    x = fakeInteraction({ cmd: 'patlak' });
    await r.dispatch(h.ctx, x.i);
    assert.equal(x.out.length, 1);
    assert.ok(!/GİZLİ|home/.test(JSON.stringify(x.out[0])), 'iç ayrıntı kullanıcıya sızmamalı');
    assert.match(x.out[0].content, /[0-9a-f]{6}/);

    // süresi dolmuş etkileşim: kullanıcıya hata yanıtı denenmez
    x = fakeInteraction({ cmd: 'suresi' });
    await r.dispatch(h.ctx, x.i);
    assert.equal(x.out.length, 0);

    assert.throws(() => r.add(mk('herkes'), async () => {}), /Yinelenen komut/);
    r.button('abc:', async () => {});
    assert.throws(() => r.button('abc:', async () => {}), /Yinelenen/);
    assert.throws(() => r.select('', async () => {}), /boş/);
    const st = r.stats();
    assert.ok(st.denied >= 3 && st.errors >= 2);
  } finally { h.cleanup(); }
});

/* ------------------------------------------------------------------ gizlilik */
test('privacy: gönüllü kayıt, kitle, veri dökümü ve silme (olay günlüğü takma ada çevrilir)', async () => {
  const { makeCtx } = require('./helpers');
  const h = makeCtx({ modules: ['members', 'privacy'] });
  try {
    const { ctx, store } = h;
    const G = '800000000000000009';
    const U = '760000000000000001';
    const V = '760000000000000002';
    store.data.members[G] = { [U]: { msgs: 5, joinedAt: 1 }, [V]: { msgs: 1, joinedAt: 1 } };
    assert.deepEqual(ctx.privacy.audience(G), [], 'kayıt olmayan kimse kitleye girmez');
    assert.equal(ctx.privacy.consentGrant(G, U, 'komut'), true);
    assert.equal(ctx.privacy.consentGrant(G, U, 'komut'), false, 'ikinci kez eklenmez');
    assert.deepEqual(ctx.privacy.audience(G), [U]);

    store.data.members[G][U].left = Date.now();
    assert.deepEqual(ctx.privacy.audience(G), [], 'ayrılan üye kitleden çıkar');
    delete store.data.members[G][U].left;

    ctx.events.append(G, { type: 'test', actor: U, target: V });
    const dump = ctx.privacy.exportUser(U);
    assert.equal(dump.kullaniciId, U);
    assert.ok(dump.kaynaklar.uyelik && dump.kaynaklar.izin, 'üyelik ve izin kaynakları dökümde olmalı');
    assert.ok(!JSON.stringify(dump).includes(V), 'başka kullanıcının verisi dökümde olmamalı');

    const res = await ctx.privacy.eraseUser(U);
    assert.equal(res.uyelik, 1);
    assert.equal(res.izin, 1);
    assert.equal(store.data.members[G][U], undefined);
    assert.equal(res.olayKayitlari, 1, 'olay kaydındaki kimlik takma adla değişmeli');
    const after = ctx.events.read(G);
    assert.ok(!JSON.stringify(after).includes(U), 'olay günlüğünde silinen kullanıcının kimliği kalmamalı');
    assert.equal(after[0].target, V, 'diğer kişinin kimliği korunmalı');
    assert.equal(ctx.privacy.consentHas(G, U), false);
    assert.ok(store.data.members[G][V], 'başkasının kaydı silinmemeli');

    // sır sızıntısı: döküm ve erişim kaydı gizli veri içermemeli
    ctx.privacy.logAccess(G, 'mod1', 'uye-bilgi', V, 'inceleme');
    assert.equal(ctx.privacy.accessLog(G, { target: V }).length, 1);
    assert.equal(ctx.privacy.accessLog(G, { target: U }).length, 0);
  } finally { h.cleanup(); }
});

/* ------------------------------------------------------------------ arayüz */
test('ui: sayfalama yalnızca komutu çalıştıran kişiye yanıt verir; onay düğmesi başkasının tıklamasını reddeder', async () => {
  const { makeCtx } = require('./helpers');
  const ui = require('../src/ui');
  const h = makeCtx();
  try {
    const mkI = (uid) => {
      const out = [];
      return { user: { id: uid }, guildId: 'g1', deferred: false, replied: false, out, reply: async (p) => out.push(p) };
    };
    const lines = Array.from({ length: 25 }, (_, n) => `satır ${n}`);
    const pages = ui.pagesFromLines(lines, { title: 'T', perPage: 10 });
    assert.equal(pages.length, 3);
    const i = mkI('u1');
    await ui.paginate(h.ctx, i, pages);
    assert.equal(i.out.length, 1);
    assert.equal(i.out[0].components.length, 1, 'çok sayfalı yanıtta düğme satırı olmalı');
    assert.ok(i.out[0].flags, 'varsayılan ephemeral');

    let yes = 0;
    const c = mkI('u1');
    await ui.confirm(h.ctx, c, { text: 'emin misin?', onYes: async () => { yes++; } });
    const cid = c.out[0].components[0].components[0].data.custom_id;
    const press = (uid, id) => {
      const o = [];
      return { customId: id, user: { id: uid }, guildId: 'g1', replied: false, deferred: false, out: o, update: async (p) => o.push(p), reply: async (p) => o.push(p), followUp: async (p) => o.push(p),
        isButton: () => true, isChatInputCommand: () => false, isAutocomplete: () => false, isUserContextMenuCommand: () => false, isMessageContextMenuCommand: () => false,
        isAnySelectMenu: () => false, isStringSelectMenu: () => false, isModalSubmit: () => false };
    };
    const intruder = press('u2', cid);
    await h.ctx.router.dispatch(h.ctx, intruder);
    assert.equal(yes, 0, 'başka kullanıcının tıklaması onay sayılmamalı');
    const owner = press('u1', cid);
    await h.ctx.router.dispatch(h.ctx, owner);
    assert.equal(yes, 1);
    const again = press('u1', cid);
    await h.ctx.router.dispatch(h.ctx, again);
    assert.equal(yes, 1, 'onay yalnızca bir kez kullanılabilir');
  } finally { h.cleanup(); }
});
