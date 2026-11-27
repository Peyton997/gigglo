'use strict';
// Kendi kendine kontrol: söz dizimi, modül yükleme, sahte istemciyle başlatma ve komut şeması doğrulama.
// Kullanım: node tools/check.js   (ağ/Discord bağlantısı gerekmez)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Collection } = require('discord.js');

const root = path.join(__dirname, '..');
let problems = 0;
const bad = (m) => { problems++; console.log(`  ✗ ${m}`); };
const good = (m) => console.log(`  ✓ ${m}`);

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.name === 'node_modules' || f.name === 'data' && dir === root) continue;
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, out); else if (f.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Komut şeması: Discord sınırlarını yerel olarak doğrula (ağa çıkmadan).
function validateCommands(json) {
  const names = new Set();
  const strLen = (c) => {
    let n = (c.name || '').length + (c.description || '').length;
    for (const o of c.options || []) {
      n += strLen(o);
      for (const ch of o.choices || []) n += String(ch.name).length + String(ch.value).length;
    }
    return n;
  };
  for (const c of json) {
    const isChat = !c.type || c.type === 1;
    if (names.has(c.name)) bad(`yinelenen komut adı: ${c.name}`);
    names.add(c.name);
    if (isChat && !/^[\w-]{1,32}$/u.test(c.name)) bad(`geçersiz komut adı: ${c.name}`);
    if (isChat && c.name !== c.name.toLowerCase()) bad(`komut adı küçük harf olmalı: ${c.name}`);
    if (c.name.length > 32) bad(`komut adı >32: ${c.name}`);
    if (isChat && (!c.description || c.description.length > 100)) bad(`/${c.name} açıklaması 1-100 olmalı`);
    if (strLen(c) > 6000) bad(`/${c.name} toplam boyutu ${strLen(c)} (>6000)`);
    const check = (list, where) => {
      if ((list || []).length > 25) bad(`${where}: 25'ten fazla seçenek/alt komut`);
      const seen = new Set();
      for (const o of list || []) {
        if (!/^[\w-]{1,32}$/u.test(o.name) || o.name !== o.name.toLowerCase()) bad(`${where}: geçersiz ad "${o.name}"`);
        if (!o.description || o.description.length > 100) bad(`${where}/${o.name}: açıklama 1-100 olmalı`);
        if (seen.has(o.name)) bad(`${where}: yinelenen ad ${o.name}`);
        seen.add(o.name);
        if (o.choices && o.choices.length > 25) bad(`${where}/${o.name}: >25 seçenek`);
        for (const ch of o.choices || []) { if (String(ch.name).length > 100 || (typeof ch.value === 'string' && ch.value.length > 100)) bad(`${where}/${o.name}: seçenek çok uzun`); }
        if (o.options) check(o.options, `${where}/${o.name}`);
      }
      // zorunlu seçenekler isteğe bağlılardan önce gelmeli
      let optionalSeen = false;
      for (const o of list || []) {
        if (o.type > 2) {
          if (!o.required) optionalSeen = true;
          else if (optionalSeen) bad(`${where}: zorunlu seçenek "${o.name}" isteğe bağlıdan sonra geliyor`);
        }
      }
    };
    check(c.options, `/${c.name}`);
  }
}

async function main() {
  console.log('1) Söz dizimi');
  const files = walk(root);
  const { spawnSync } = require('child_process');
  let syn = 0;
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) { syn++; bad(`${path.relative(root, f)}\n${r.stderr}`); }
  }
  if (!syn) good(`${files.length} dosya sorunsuz`);

  console.log('2) Modül yükleme + sahte istemci ile başlatma');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kalkan-check-'));
  process.env.DATA_DIR = tmp;
  process.env.DISCORD_TOKEN = 'x';
  const { env } = require('../src/env');
  const { initKey } = require('../src/crypto');
  const { Store } = require('../src/store');
  const { EventLog } = require('../src/eventlog');
  const { createContext } = require('../src/ctx');
  const log = { debug() {}, info() {}, warn() {}, error: (...a) => bad(`log.error: ${a.map(String).join(' ')}`) };
  initKey({ ...env, dataDir: tmp, dataKey: 'test-anahtar' });
  const client = new EventEmitter();
  Object.assign(client, {
    user: { id: '111111111111111111', tag: 'Kalkan#0001' }, guilds: { cache: new Collection() }, users: { fetch: async () => null, cache: new Collection() },
    channels: { cache: new Collection() }, ws: { ping: 0, status: 0 }, application: { commands: { set: async () => [] } },
    fetchInvite: async () => null, isReady: () => true, options: {},
  });
  const store = new Store(tmp).load();
  const events = new EventLog(tmp, { log });
  const ctx = createContext({ client, env: { ...env, dataDir: tmp }, store, events, log });
  const MODULES = require('../src/module-list');
  for (const name of MODULES) {
    try { require(`../src/modules/${name}`).init(ctx); good(name); } catch (e) { bad(`${name}: ${e.stack || e}`); }
  }
  const mods = fs.readdirSync(path.join(root, 'src/modules')).map((f) => f.replace(/\.js$/, ''));
  for (const m of mods) if (!MODULES.includes(m) && typeof require(`../src/modules/${m}`).init === 'function') bad(`${m} init içeriyor ama index.js listesinde yok`);

  console.log('3) Komut şeması');
  const json = ctx.router.json();
  validateCommands(json);
  if (json.length > 100) bad('100\'den fazla komut');
  good(`${json.length} komut: ${ctx.router.names().map((n) => `/${n}`).join(' ')}`);

  console.log(problems ? `\n❌ ${problems} sorun bulundu` : '\n✅ Her şey yolunda');
  try { events.flushMirror && events.timer && clearInterval(events.timer); } catch { /* yoksay */ }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(problems ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
