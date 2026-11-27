'use strict';
// Sağlık izleme: bellek, CPU, olay döngüsü gecikmesi, bağlantı, kuyruklar. Her 15 sn'de data/health.json'a yazılır;
// tools/healthcheck.js (Docker HEALTHCHECK / cron / Termux) bu dosyayı okuyup çıkış koduyla durumu bildirir.
const fs = require('fs');
const path = require('path');
const { monitorEventLoopDelay } = require('perf_hooks');

const FRESH_MS = 60 * 1000;

function start(ctx, { everyMs = 15000, file = path.join(ctx.env.dataDir, 'health.json'), maxRssMb = ctx.env.maxRssMb || 0, onRestart = null } = {}) {
  const { client, store } = ctx;
  const hist = monitorEventLoopDelay({ resolution: 20 });
  hist.enable();
  let lastCpu = process.cpuUsage();
  let lastAt = Date.now();
  let overMem = 0;
  let last = null;

  function snapshot() {
    const now = Date.now();
    const cpu = process.cpuUsage();
    const used = (cpu.user - lastCpu.user + cpu.system - lastCpu.system) / 1000; // ms
    const cpuPct = Math.min(100, Math.round((used / Math.max(1, now - lastAt)) * 1000) / 10);
    lastCpu = cpu;
    lastAt = now;
    const mem = process.memoryUsage();
    const lagP99 = Math.round(hist.percentile(99) / 1e4) / 100; // ms (2 ondalık)
    const lagMax = Math.round(hist.max / 1e4) / 100;
    hist.reset();
    const timers = Object.entries(ctx.metrics.timers).map(([name, m]) => ({ name, ...m }));
    last = {
      ts: now,
      pid: process.pid,
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      ready: !!(client.isReady && client.isReady()),
      wsStatus: client.ws ? client.ws.status : null,
      pingMs: client.ws ? client.ws.ping : null,
      guilds: client.guilds ? client.guilds.cache.size : 0,
      rssMb: Math.round(mem.rss / 1048576),
      heapMb: Math.round(mem.heapUsed / 1048576),
      cpuPct,
      loopLagP99Ms: lagP99,
      loopLagMaxMs: lagMax,
      store: { status: store.loadStatus, lastError: store.lastError },
      queues: { dm: ctx.queues.dm.size, dmBulk: ctx.queues.dmBulk.size },
      router: ctx.router.stats(),
      timers: timers.map((t) => ({ name: t.name, runs: t.runs, errors: t.errors, skipped: t.skipped, lastMs: t.lastMs, maxMs: t.maxMs })),
    };
    return last;
  }

  function write() {
    const snap = snapshot();
    try {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(snap));
      fs.renameSync(`${file}.tmp`, file);
    } catch { /* disk dolu vb.: izleme yüzünden bot durmasın */ }
    if (maxRssMb > 0 && snap.rssMb > maxRssMb) {
      overMem++;
      if (overMem >= 3) {
        ctx.log.error(`Bellek sınırı aşıldı (${snap.rssMb} MB > ${maxRssMb} MB); temiz yeniden başlatma isteniyor.`);
        if (onRestart) onRestart();
      }
    } else overMem = 0;
  }

  const timer = setInterval(write, everyMs);
  if (timer.unref) timer.unref();
  write();
  return { snapshot: () => last || snapshot(), stop() { clearInterval(timer); hist.disable(); }, file };
}

// Dosyadan okunan anlık görüntü sağlıklı mı? (tools/healthcheck.js ve testler kullanır)
function evaluate(snap, now = Date.now()) {
  if (!snap || typeof snap !== 'object') return { ok: false, reason: 'sağlık dosyası okunamadı' };
  if (now - snap.ts > FRESH_MS) return { ok: false, reason: `kalp atışı ${Math.round((now - snap.ts) / 1000)} sn eski (süreç donmuş ya da kapanmış)` };
  if (!snap.ready) return { ok: false, reason: 'Discord bağlantısı hazır değil' };
  if (snap.loopLagP99Ms > 3000) return { ok: false, reason: `olay döngüsü çok yavaş (p99 ${snap.loopLagP99Ms} ms)` };
  if (snap.store && snap.store.lastError) return { ok: false, reason: `veri yazılamıyor: ${snap.store.lastError}` };
  return { ok: true, reason: 'sağlıklı' };
}

module.exports = { start, evaluate, FRESH_MS };
