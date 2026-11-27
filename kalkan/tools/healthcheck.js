#!/usr/bin/env node
'use strict';
// Sağlık kontrolü: bot çalışırken data/health.json dosyasını yazar. Bu araç dosyayı okuyup çıkış koduyla durumu bildirir
// (0 = sağlıklı, 1 = sorun). Docker HEALTHCHECK, cron ve Termux betikleri için uygundur.
//   node tools/healthcheck.js            → data/health.json
//   DATA_DIR=/yol node tools/healthcheck.js
const fs = require('fs');
const path = require('path');
const { evaluate } = require('../src/health');

const dir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
let snap = null;
try { snap = JSON.parse(fs.readFileSync(path.join(dir, 'health.json'), 'utf8')); } catch { /* yok */ }
const r = evaluate(snap);
console.log(`${r.ok ? 'SAĞLIKLI' : 'SORUN'}: ${r.reason}`);
if (snap && r.ok) console.log(`bellek ${snap.rssMb} MB • CPU %${snap.cpuPct} • gecikme p99 ${snap.loopLagP99Ms} ms • ${snap.guilds} sunucu • ping ${snap.pingMs} ms`);
process.exit(r.ok ? 0 : 1);
