'use strict';
const { RateQueue, weekKey, inNightWindow } = require('./util');
const { getGuildConfig } = require('./defaults');
const { createRouter } = require('./router');
const { createAlerts } = require('./alerts');
const { t: i18n, DEFAULT_LOCALE } = require('./i18n');

function createContext({ client, env, store, events, log }) {
  const metrics = { timers: {}, startedAt: Date.now() };
  const dmQueue = new RateQueue(700, 300);
  const dmBulkQueue = new RateQueue(1200, 500);
  const msgbufMap = new Map();

  const msgbuf = {
    push(gid, uid, entry) {
      const k = `${gid}:${uid}`;
      const arr = msgbufMap.get(k) || [];
      arr.push({ ...entry, t: Date.now() });
      while (arr.length > 60) arr.shift();
      msgbufMap.set(k, arr);
    },
    recent(gid, uid, ms) {
      const now = Date.now();
      return (msgbufMap.get(`${gid}:${uid}`) || []).filter((e) => now - e.t < ms);
    },
    // Kullanıcının son mesajlarını (varsayılan 15 dk) tüm kanallardan siler.
    async deleteRecent(guild, uid, ms = 15 * 60 * 1000) {
      const items = msgbuf.recent(guild.id, uid, ms);
      const byCh = new Map();
      for (const it of items) {
        if (!byCh.has(it.channelId)) byCh.set(it.channelId, []);
        byCh.get(it.channelId).push(it.id);
      }
      let n = 0;
      for (const [chId, ids] of byCh) {
        const ch = guild.channels.cache.get(chId);
        if (!ch || !ch.bulkDelete) continue;
        try {
          if (ids.length === 1) {
            await ch.messages.delete(ids[0]);
            n += 1;
          } else {
            const r = await ch.bulkDelete(ids, true);
            n += r.size;
          }
        } catch { /* mesaj zaten silinmiş olabilir */ }
      }
      msgbufMap.delete(`${guild.id}:${uid}`);
      return n;
    },
    gc() {
      const now = Date.now();
      for (const [k, arr] of msgbufMap) {
        const kept = arr.filter((e) => now - e.t < 20 * 60 * 1000);
        if (kept.length) msgbufMap.set(k, kept); else msgbufMap.delete(k);
      }
    },
  };

  const ctx = {
    client, env, store, events, log, msgbuf, metrics,
    router: createRouter(),
    queues: { dm: dmQueue, dmBulk: dmBulkQueue },
    gcfg: (gid) => getGuildConfig(store, gid),
    save: () => store.save(),

    isBotOwner: (id) => !!id && env.ownerIds.includes(id),
    isBackupOwner: (id) => !!id && env.backupOwnerIds.includes(id),

    // Güvenilir: bot sahibi, sunucu sahibi, botun kendisi ya da /ayar ile eklenmiş kişi.
    isTrusted(guild, id) {
      if (!id) return false;
      if (client.user && client.user.id === id) return true;
      if (ctx.isBotOwner(id)) return true;
      if (guild && guild.ownerId === id) return true;
      return !!guild && ctx.gcfg(guild.id).trusted.includes(id);
    },

    // Hassas ayarları değiştirebilen kişi: OWNER_IDS doluysa yalnızca onlar, boşsa sunucu sahibi.
    canAdmin(guild, id) {
      if (env.ownerIds.length) return ctx.isBotOwner(id);
      return !!guild && guild.ownerId === id;
    },

    isExempt(guild, member) {
      if (!member) return false;
      if (ctx.isTrusted(guild, member.id)) return true;
      const cfg = ctx.gcfg(guild.id);
      return cfg.exemptRoles.some((r) => member.roles && member.roles.cache && member.roles.cache.has(r));
    },

    isNight: (gid) => inNightWindow(ctx.gcfg(gid).night),

    stat(gid, key, n = 1) {
      const all = (store.data.stats[gid] ||= {});
      const wk = weekKey();
      const w = (all[wk] ||= {});
      w[key] = (w[key] || 0) + n;
      const keys = Object.keys(all).sort();
      while (keys.length > 8) delete all[keys.shift()];
      store.save();
    },

    // Kuyruklu DM: Discord hız sınırlarına takılmamak için. bulk=true toplu duyuru kuyruğunu kullanır.
    async dm(userId, payload, { bulk = false } = {}) {
      const q = bulk ? dmBulkQueue : dmQueue;
      try {
        return await q.add(async () => {
          const user = await client.users.fetch(userId);
          const p = typeof payload === 'string' ? { content: payload } : payload;
          await user.send({ allowedMentions: { parse: [] }, ...p });
          return true;
        });
      } catch (e) {
        if (e && e.code !== 50007 && log.debug) log.debug('DM gönderilemedi:', userId, e.message);
        return false;
      }
    },

    // Periyodik görev. Önceki tur bitmeden yenisi başlamaz (aynı görev iki kez çalışmasın); süre ve hata sayacı tutulur.
    every(ms, fn, name = 'görev') {
      const m = (metrics.timers[name] ||= { runs: 0, errors: 0, skipped: 0, lastMs: 0, maxMs: 0, last: 0 });
      let running = false;
      const t = setInterval(() => {
        if (running) { m.skipped++; return; }
        running = true;
        const t0 = Date.now();
        Promise.resolve().then(fn)
          .catch((e) => { m.errors++; log.error(`zamanlayıcı (${name}):`, e); })
          .finally(() => {
            running = false;
            m.runs++;
            m.last = Date.now();
            m.lastMs = m.last - t0;
            if (m.lastMs > m.maxMs) m.maxMs = m.lastMs;
          });
      }, ms);
      if (t.unref) t.unref();
      return t;
    },

    // Çok dilli metin: ctx.t(guildId, 'anahtar', { değişken }). Dil sunucu ayarından (locale) gelir; varsayılan Türkçe.
    t(gid, key, vars) {
      let locale = DEFAULT_LOCALE;
      try { if (gid) locale = ctx.gcfg(gid).locale || DEFAULT_LOCALE; } catch { /* yoksay */ }
      return i18n(locale, key, vars);
    },
  };

  Object.assign(ctx, createAlerts(ctx));
  return ctx;
}

module.exports = { createContext };
