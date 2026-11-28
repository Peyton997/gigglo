// Gigglo ⇄ Kalkan adapter.
//
// Kalkan (./kalkan/src) is a standalone security / moderation / recovery bot written for Node + a data
// folder. This file embeds it into the Gigglo process:
//   * shares Gigglo's Discord client (through a guild-gating proxy),
//   * keeps Kalkan's data folder in Postgres (Render's disk is wiped on every restart),
//   * only acts in servers listed in the owner setting `security_guilds` (or env SECURITY_GUILD_IDS),
//   * contributes its slash commands to Gigglo's global command registration (globalThis.__extraCmds).
//
// Loaded by index.ts (only when env KALKAN=1) after bot.tsx has set globalThis.__G and BEFORE commands are registered.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);

/* ------------------------------------------------------------------ persistence (data folder <-> Postgres) */
const SKIP = (rel) => /(^|\/)(logs|\.lock|health\.json)(\/|$)/.test(rel) || /\.(tmp|bak|bak2)$/.test(rel) || /(^|\/)db\.corrupt-/.test(rel);

export function createPersist({ dir, db, log = console, intervalMs = 45000 }) {
  const seen = new Map(); // rel path -> sha1 of what is in the database
  const hash = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
  let timer = null;
  let busy = null;

  function walk(base, rel = '') {
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync(path.join(base, rel), { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (SKIP(r)) continue;
      if (e.isDirectory()) out.push(...walk(base, r));
      else if (e.isFile()) out.push(r);
    }
    return out;
  }

  const safeJoin = (rel) => {
    const full = path.resolve(dir, rel);
    if (!full.startsWith(path.resolve(dir) + path.sep)) throw new Error(`unsafe path from database: ${rel}`);
    return full;
  };

  async function restore() {
    await db.init();
    fs.mkdirSync(dir, { recursive: true });
    let n = 0;
    for (const row of await db.all()) {
      try {
        const full = safeJoin(row.path);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        const buf = Buffer.from(row.content);
        fs.writeFileSync(full, buf);
        seen.set(row.path, hash(buf));
        n++;
      } catch (e) { log.error('[kalkan] restore failed for', row.path, e.message); }
    }
    return n;
  }

  async function syncOnce() {
    const now = new Set(walk(dir));
    let up = 0;
    for (const rel of now) {
      let buf;
      try { buf = fs.readFileSync(path.join(dir, rel)); } catch { continue; }
      const h = hash(buf);
      if (seen.get(rel) === h) continue;
      await db.put(rel, buf);
      seen.set(rel, h);
      up++;
    }
    for (const rel of [...seen.keys()]) {
      if (now.has(rel)) continue;
      await db.del(rel);
      seen.delete(rel);
    }
    return up;
  }

  // One sync at a time; a second caller waits for (and then reuses) the running one.
  function sync() {
    if (busy) return busy;
    busy = syncOnce().catch((e) => { log.error('[kalkan] sync failed:', e && e.message); return 0; }).finally(() => { busy = null; });
    return busy;
  }

  return {
    restore, sync,
    start() { if (!timer) { timer = setInterval(sync, intervalMs); timer.unref?.(); } },
    stop() { if (timer) clearInterval(timer); timer = null; },
    seen,
  };
}

export function pgBackend(sql) {
  return {
    async init() {
      await sql`CREATE TABLE IF NOT EXISTS kalkan_files (path TEXT PRIMARY KEY, content BYTEA NOT NULL, updated BIGINT NOT NULL)`;
    },
    async all() { return sql`SELECT path, content FROM kalkan_files`; },
    async put(p, buf) {
      await sql`INSERT INTO kalkan_files (path, content, updated) VALUES (${p}, ${buf}, ${Date.now()})
        ON CONFLICT (path) DO UPDATE SET content = EXCLUDED.content, updated = EXCLUDED.updated`;
    },
    async del(p) { await sql`DELETE FROM kalkan_files WHERE path = ${p}`; },
  };
}

/* ------------------------------------------------------------------ guild gate */
export function guildIdOf(args) {
  for (const a of args) {
    if (!a || typeof a !== 'object') continue;
    if (a.guildId) return a.guildId;
    if (a.guild && a.guild.id) return a.guild.id;
    if (a.message && a.message.guildId) return a.message.guildId;
    if (a.constructor && a.constructor.name === 'Guild' && a.id) return a.id;
  }
  return null;
}

const parseIds = (raw) => new Set(String(raw || '').split(/[\s,;]+/).filter((x) => /^\d{15,25}$/.test(x)));

// Wraps the shared client: event handlers registered by Kalkan modules only run for enabled servers, and
// "iterate all servers" loops (auto backup, weekly report …) only see enabled servers. Direct lookups
// (guilds.cache.get / has) stay unfiltered because Kalkan also needs its backup server.
export function gatedClient(real, isOn) {
  const ITER = new Set(['values', 'keys', 'entries', 'forEach', 'map', 'filter', 'find', 'some', 'every', 'reduce', 'first', 'random', 'size', Symbol.iterator]);
  const view = () => real.guilds.cache.filter((g) => isOn(g.id));
  const cacheProxy = new Proxy(real.guilds.cache, {
    get(t, p) {
      if (ITER.has(p)) {
        const v = view();
        const x = v[p];
        return typeof x === 'function' ? x.bind(v) : x;
      }
      const x = t[p];
      return typeof x === 'function' ? x.bind(t) : x;
    },
  });
  const guildsProxy = new Proxy(real.guilds, {
    get(t, p) {
      if (p === 'cache') return cacheProxy;
      const x = t[p];
      return typeof x === 'function' ? x.bind(t) : x;
    },
  });
  const wrap = (fn) => (...args) => {
    const gid = guildIdOf(args);
    if (gid && !isOn(gid)) return undefined;
    return fn(...args);
  };
  return new Proxy(real, {
    get(t, p) {
      if (p === 'on' || p === 'once' || p === 'addListener' || p === 'prependListener') return (ev, fn) => { t[p](ev, wrap(fn)); return t; };
      if (p === 'guilds') return guildsProxy;
      const x = t[p];
      return typeof x === 'function' ? x.bind(t) : x;
    },
  });
}

/* ------------------------------------------------------------------ settings (owner panel) */
function addSettings(G) {
  const { SETTINGS, byKey, CATEGORIES, tup } = G;
  CATEGORIES.security = {
    label: tup('Security', 'Güvenlik'), emoji: '🛡️',
    description: tup('Choose which servers get Gigglo Security (Kalkan)', 'Hangi sunucularda Gigglo Güvenlik (Kalkan) çalışsın'),
  };
  const s = {
    key: 'security_guilds', category: 'security', label: 'Security servers',
    description: 'Server IDs (comma separated) where Gigglo Security is active. Everyone else sees it as off.',
    type: 'text', default: '', max: 400, scope: 'global',
  };
  if (!byKey[s.key]) { SETTINGS.push(s); byKey[s.key] = s; }
}

/* ------------------------------------------------------------------ main entry */
export async function load() {
  const G = globalThis.__G;
  if (!G) throw new Error('Kalkan: globalThis.__G is missing');
  const backend = globalThis.__KALKAN_DB || pgBackend((await import('bun')).sql); // __KALKAN_DB: test hook
  const realClient = G.client;
  addSettings(G);

  // Environment for Kalkan (env.js reads process.env when first required).
  process.env.DATA_DIR ||= path.join(os.tmpdir(), 'gigglo-kalkan');
  process.env.LOG_TO_FILE = '0';
  process.env.BOT_NAME ||= 'Gigglo';
  process.env.MAX_RSS_MB = '0';
  delete process.env.PUBLIC_URL; // Gigglo owns the HTTP port; Kalkan runs in manual-code OAuth mode.

  const K = (p) => require(path.join(import.meta.dir, 'kalkan', 'src', p));
  const { env } = K('env.js');
  const log = K('logger.js');
  for (const v of [env.token, env.clientSecret, env.vtKey, env.telegramToken, env.alertWebhook, env.mirrorWebhook, env.anthropicKey, env.dataKey, env.dataKeyOld]) log.addSecret?.(v);

  // 1) restore the data folder from Postgres
  const persist = createPersist({ dir: env.dataDir, db: backend, log });
  const restored = await persist.restore();
  const keySrc = K('crypto.js').initKey(env);
  if (keySrc !== 'env') log.warn('[kalkan] DATA_KEY is not set; using a key stored next to the data (set DATA_KEY in the host environment for real protection).');

  const { Store } = K('store.js');
  const { EventLog } = K('eventlog.js');
  const { createContext } = K('ctx.js');
  const { Events } = require('discord.js');

  const store = new Store(env.dataDir).load();
  const events = new EventLog(env.dataDir, { mirrorWebhook: env.mirrorWebhook, botName: env.botName, log });

  // 2) gate: which servers is Kalkan active in?
  let enabled = new Set();
  const langs = new Map();
  const isOn = (gid) => enabled.has(gid);
  const client = gatedClient(realClient, isOn);

  const ctx = createContext({ client, env, store, events, log });
  ctx.shutdown = () => {};
  ctx.health = K('health.js').start(ctx, { maxRssMb: 0, onRestart: null });

  const MODULES = K('module-list.js');
  const failed = [];
  for (const name of MODULES) {
    try { K(`modules/${name}.js`).init(ctx); } catch (e) { failed.push(name); log.error(`[kalkan] module failed to start: ${name}`, e); }
  }
  console.log(`[kalkan] ${MODULES.length - failed.length}/${MODULES.length} modules ready (restored ${restored} file(s))${failed.length ? ` — FAILED: ${failed.join(', ')}` : ''}`);

  // 3) commands: Gigglo's registration (fa) appends these to its global command list
  const cmds = ctx.router.json();
  globalThis.__extraCmds = cmds;
  globalThis.__extraHelp = (gid) => {
    if (!gid || !isOn(gid)) return [];
    const lines = ['', '**🛡️ Gigglo Security**'];
    for (const c of cmds) if (c.description) lines.push(`**/${c.name}**: ${String(c.description).slice(0, 48)}`);
    return lines;
  };

  // Runs once per server per process (the member list request is rate limited by Discord: ~1 per 30 s per server).
  const activated = new Set();
  async function onEnable(guild, attempt = 1) {
    if (attempt === 1) { if (activated.has(guild.id)) return; activated.add(guild.id); }
    try {
      if (ctx.members) await ctx.members.sync(guild);
      if (ctx.recovery) ctx.recovery.touch(guild);
      if (ctx.raid) await ctx.raid.refreshInvites(guild);
      console.log(`[kalkan] active in ${guild.name} (${guild.id})`);
    } catch (e) {
      log.error(`[kalkan] enable failed (${guild.name}):`, e);
      if (attempt < 3) { const t = setTimeout(() => onEnable(guild, attempt + 1), 35000); t.unref?.(); }
    }
  }

  async function refreshGate() {
    let raw = '';
    try { raw = await G.get(null, 'security_guilds'); } catch { /* keep previous */ return; }
    const next = parseIds(raw);
    for (const id of parseIds(process.env.SECURITY_GUILD_IDS)) next.add(id);
    const added = [...next].filter((id) => !enabled.has(id));
    enabled = next;
    for (const g of realClient.guilds.cache.values()) {
      let lang = 'en';
      try { const l = await G.get(g.id, 'language'); lang = l === 'tr' || l === 'az' ? l : 'en'; } catch { /* default */ }
      langs.set(g.id, lang);
      if (enabled.has(g.id)) { try { ctx.gcfg(g.id).locale = lang; } catch { /* ignore */ } }
    }
    if (realClient.isReady?.()) for (const id of added) { const g = realClient.guilds.cache.get(id); if (g) await onEnable(g); }
  }

  const OFF = {
    tr: '🛡️ Gigglo Güvenlik bu sunucuda kapalı. Açtırmak için bot sahibine ulaş.',
    az: '🛡️ Gigglo Təhlükəsizlik bu serverdə bağlıdır. Açdırmaq üçün bot sahibinə müraciət et.',
    en: '🛡️ Gigglo Security is not enabled on this server. Ask the bot owner to turn it on.',
  };
  const offText = (gid) => OFF[langs.get(gid)] || OFF.en;

  const owns = (i) => {
    if (i.isChatInputCommand?.() || i.isContextMenuCommand?.() || i.isAutocomplete?.()) return ctx.router.names().includes(i.commandName);
    const id = i.customId || '';
    const pf = ctx.router.prefixes();
    return [...pf.button, ...pf.select, ...pf.modal].some((p) => id.startsWith(p));
  };

  realClient.on(Events.InteractionCreate, (i) => {
    if (i.user && i.user.bot) return;
    if (i.guildId && !isOn(i.guildId)) {
      if (!owns(i)) return;
      if (i.isAutocomplete?.()) { i.respond([]).catch(() => {}); return; }
      i.reply({ content: offText(i.guildId), flags: 64 }).catch(() => {});
      return;
    }
    ctx.router.dispatch(ctx, i).catch((e) => log.error('dispatch error:', e));
  });

  realClient.on(Events.GuildCreate, async (guild) => {
    await refreshGate().catch(() => {});
    if (isOn(guild.id)) await onEnable(guild);
  });

  realClient.once(Events.ClientReady, async () => {
    try {
      await refreshGate();
      for (const g of realClient.guilds.cache.values()) if (isOn(g.id)) await onEnable(g);
      for (const [label, fn] of [
        ['timelock', () => ctx.timelock && ctx.timelock.restore()],
        ['jit', () => ctx.jit && ctx.jit.restore()],
        ['recovery', () => ctx.recovery && ctx.recovery.resume()],
        ['oauth', () => ctx.oauth && ctx.oauth.start()],
        ['backup', () => ctx.backup && ctx.backup.autoTick()],
        ['blocklist', () => ctx.blocklist && Promise.all([ctx.blocklist.syncRemote(), ctx.blocklist.syncScam()])],
      ]) {
        try { await fn(); } catch (e) { log.error(`[kalkan] startup task (${label}):`, e); }
      }
      ctx.every(24 * 3600e3, () => {
        const n = ctx.members.purgeLeft(30);
        if (n) console.log(`[kalkan] purged ${n} old member record(s)`);
        if (ctx.privacy) ctx.privacy.purgeExpired();
      }, 'privacy-cleanup');
    } catch (e) { log.error('[kalkan] ready tasks failed:', e); }
  });
  const gateTimer = setInterval(() => refreshGate().catch(() => {}), 20000);
  gateTimer.unref?.();

  // 4) keep the data folder in Postgres; flush on shutdown (Render sends SIGTERM on every deploy)
  persist.start();
  let closing = false;
  const finish = async (code) => {
    if (closing) return;
    closing = true;
    try { store.flush(); } catch { /* ignore */ }
    try { await Promise.race([persist.sync(), new Promise((r) => setTimeout(r, 6000))]); } catch { /* ignore */ }
    process.exit(code);
  };
  process.once('SIGTERM', () => finish(0));
  process.once('SIGINT', () => finish(0));

  return { ctx, persist, refreshGate, isOn };
}
