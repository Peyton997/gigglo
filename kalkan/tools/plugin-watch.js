#!/usr/bin/env node
'use strict';
// Minecraft sunucu klasöründeki (plugins/mods) yeni veya değişen .jar dosyalarını izler, statik olarak tarar ve Discord webhook'una bildirir.
// Hiçbir dosya ÇALIŞTIRILMAZ; yalnızca arşivin içindeki adlara ve ham baytlara bakılır.
//
// Kullanım:
//   node tools/plugin-watch.js --dir /sunucu/plugins --webhook "https://discord.com/api/webhooks/..." [--interval 30] [--once] [--scan-existing]
// Webhook'u .env içinde PLUGIN_WATCH_WEBHOOK olarak da verebilirsin.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { env } = require('../src/env');
const { scanJar, modrinthLookup, verdict } = require('../src/modules/modcheck');
const { vtLookup } = require('../src/modules/files');

const MAX_BYTES = 100 * 1024 * 1024;

function parseArgs(argv) {
  const a = { dir: './plugins', webhook: process.env.PLUGIN_WATCH_WEBHOOK || '', interval: 30, once: false, scanExisting: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dir') a.dir = argv[++i];
    else if (k === '--webhook') a.webhook = argv[++i];
    else if (k === '--interval') a.interval = Math.max(5, parseInt(argv[++i], 10) || 30);
    else if (k === '--once') a.once = true;
    else if (k === '--scan-existing') a.scanExisting = true;
    else if (k === '-h' || k === '--help') a.help = true;
  }
  return a;
}

function listJars(dir, depth = 2, out = []) {
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory() && depth > 0) listJars(p, depth - 1, out);
    else if (it.isFile() && /\.jar$/i.test(it.name)) out.push(p);
  }
  return out;
}

const hex = (alg, buf) => crypto.createHash(alg).update(buf).digest('hex');

async function analyze(file) {
  const st = fs.statSync(file);
  const res = { file, name: path.basename(file), size: st.size };
  if (st.size > MAX_BYTES) { res.note = 'Dosya 100 MB üzeri: tarama atlandı'; return res; }
  const buf = fs.readFileSync(file);
  res.sha256 = hex('sha256', buf);
  res.scan = scanJar(buf);
  const sha1 = hex('sha1', buf);
  res.modrinth = await modrinthLookup(sha1).catch(() => null);
  res.vt = await vtLookup(env, res.sha256).catch(() => null);
  let score = res.scan.score;
  if (res.modrinth && res.modrinth.found) score = Math.max(0, score - 2); // bilinen, yayımlanmış proje
  if (res.vt && res.vt.found) score += res.vt.malicious >= 3 ? 8 : res.vt.malicious ? 3 : 0;
  res.score = score;
  res.verdict = verdict(score);
  return res;
}

function describe(r) {
  const L = [`**${r.verdict ? r.verdict.label : 'İncelenemedi'}** — \`${r.name}\` (${(r.size / 1024).toFixed(0)} KB)`];
  if (r.sha256) L.push(`SHA-256: \`${r.sha256}\``);
  if (r.note) L.push(r.note);
  if (r.scan) {
    if (r.scan.loaders.length) L.push(`Tanım dosyası: ${r.scan.loaders.join(', ')}`);
    if (r.scan.indicators.length) L.push(`Şüpheli belirtiler: ${r.scan.indicators.join('; ')}`);
    if (r.scan.embedded.length) L.push(`Gömülü çalıştırılabilir: ${r.scan.embedded.join(', ')}`);
    for (const n of r.scan.notes) L.push(`Not: ${n}`);
  }
  if (r.modrinth) L.push(r.modrinth.found ? `Modrinth'te bilinen proje: ${r.modrinth.project} ${r.modrinth.version || ''}` : "Modrinth'te bu dosya bulunamadı (resmi olmayan/özel derleme olabilir)");
  if (r.vt) L.push(r.vt.found ? `VirusTotal: ${r.vt.malicious} zararlı / ${r.vt.suspicious} şüpheli motor` : 'VirusTotal: bu dosya daha önce taranmamış');
  return L.join('\n');
}

async function notify(webhook, results) {
  const worst = results.reduce((a, r) => Math.max(a, r.score || 0), 0);
  const color = worst >= 6 ? 0xe74c3c : worst >= 3 ? 0xe67e22 : 0x2ecc71;
  const text = results.map(describe).join('\n\n─────\n\n').slice(0, 3900);
  console.log(`\n${text.replace(/\*\*/g, '')}\n`);
  if (!webhook) return;
  try {
    const res = await fetch(webhook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        username: `${env.botName} • plugin izleyici`, allowed_mentions: { parse: [] },
        embeds: [{ title: worst >= 3 ? '⚠️ Yeni/değişen plugin dosyası şüpheli' : '🧩 Yeni/değişen plugin dosyası', description: text, color, timestamp: new Date().toISOString() }],
      }),
    });
    if (!res.ok) console.error(`Webhook ${res.status} döndü`);
  } catch (e) { console.error('Webhook gönderilemedi:', e.message); }
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) {
    console.log('Kullanım: node tools/plugin-watch.js --dir <plugins klasörü> [--webhook <url>] [--interval 30] [--once] [--scan-existing]');
    return;
  }
  const dir = path.resolve(a.dir);
  if (!fs.existsSync(dir)) { console.error(`Klasör yok: ${dir}`); process.exit(1); }
  const stateFile = path.join(process.cwd(), 'plugin-watch-state.json');
  let state = {};
  const first = !fs.existsSync(stateFile);
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = {}; }
  const pending = new Map(); // dosya yazımı bitsin diye iki ölçümde aynı boyutu bekle
  let stop = false;
  process.on('SIGINT', () => { stop = true; });
  process.on('SIGTERM', () => { stop = true; });

  const sig = (st) => `${st.size}:${Math.floor(st.mtimeMs)}`;
  console.log(`İzleniyor: ${dir} (her ${a.interval} sn)`);

  do {
    const found = [];
    for (const f of listJars(dir)) {
      let st;
      try { st = fs.statSync(f); } catch { continue; }
      const key = path.relative(dir, f);
      if (state[key] === sig(st)) { pending.delete(key); continue; }
      if (first && !a.scanExisting && !Object.keys(state).length && !pending.has('__seeded')) { state[key] = sig(st); continue; }
      const prev = pending.get(key);
      if (!prev || prev !== sig(st)) { pending.set(key, sig(st)); continue; } // henüz yazılıyor olabilir
      found.push([key, f, sig(st)]);
    }
    if (first && !a.scanExisting && !pending.has('__seeded')) {
      pending.set('__seeded', '1');
      fs.writeFileSync(stateFile, JSON.stringify(state));
      console.log(`İlk çalıştırma: ${Object.keys(state).length} mevcut dosya referans alındı (bildirim yok). Bundan sonra yalnızca yeni/değişen dosyalar taranır.`);
    }
    if (found.length) {
      const results = [];
      for (const [key, f, s] of found) {
        try { results.push(await analyze(f)); } catch (e) { results.push({ name: path.basename(f), size: 0, note: `Taranamadı: ${e.message}` }); }
        state[key] = s;
        pending.delete(key);
      }
      await notify(a.webhook, results);
      fs.writeFileSync(stateFile, JSON.stringify(state));
    }
    if (a.once) {
      // --once: iki ölçüm gerektiren kararlılık bekleyişini atla
      if (!found.length && pending.size && ![...pending.keys()].every((k) => k === '__seeded')) { await new Promise((r) => setTimeout(r, 3000)); continue; }
      break;
    }
    await new Promise((r) => setTimeout(r, a.interval * 1000));
  } while (!stop);
}

main().catch((e) => { console.error(e); process.exit(1); });
