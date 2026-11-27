'use strict';
// Üye kaydı: katılma tarihi, roller, davet eden, davranış temeli (saatlik aktivite), risk skoru.
const { Events } = require('discord.js');

function init(ctx) {
  const { client, store, log } = ctx;
  const reg = (gid) => (store.data.members[gid] ||= {});

  const api = {
    get(gid, uid) { return reg(gid)[uid] || null; },

    ensure(gid, uid, seed = {}) {
      const r = reg(gid);
      if (!r[uid]) r[uid] = { firstSeen: Date.now(), msgs: 0, links: 0, files: 0, n: 0, left: null };
      const m = r[uid];
      if (!Array.isArray(m.hours) || m.hours.length !== 24) m.hours = new Array(24).fill(0);
      Object.assign(m, seed);
      return m;
    },

    upsert(member) {
      const m = api.ensure(member.guild.id, member.id, {
        tag: member.user.username,
        name: member.displayName,
        createdAt: member.user.createdTimestamp,
        joinedAt: member.joinedTimestamp || Date.now(),
        bot: !!member.user.bot,
        left: null,
        roles: [...member.roles.cache.keys()].filter((id) => id !== member.guild.id),
      });
      store.save();
      return m;
    },

    async sync(guild) {
      try {
        const all = await guild.members.fetch();
        for (const mem of all.values()) api.upsert(mem);
        const r = reg(guild.id);
        for (const uid of Object.keys(r)) if (!all.has(uid) && !r[uid].left) r[uid].left = Date.now();
        store.save();
        return all.size;
      } catch (e) {
        log.error(`üye senkronu başarısız (${guild.name}): ${e.message} — "Server Members Intent" açık mı?`);
        return 0;
      }
    },

    count(gid) { return Object.keys(reg(gid)).length; },

    // Her mesajda temel davranış sayaçlarını günceller.
    activity(gid, uid, { link = false, file = false } = {}) {
      const m = api.ensure(gid, uid);
      m.msgs += 1;
      m.n += 1;
      m.hours[new Date().getUTCHours()] += 1;
      if (link) m.links += 1;
      if (file) m.files += 1;
      m.lastSeen = Date.now();
      store.save();
      return m;
    },

    remove(gid, uid) {
      delete reg(gid)[uid];
      store.save();
    },

    // Sunucudan ayrılanların kaydını gizlilik için 30 gün sonra siler.
    purgeLeft(days = 30) {
      const cutoff = Date.now() - days * 864e5;
      let n = 0;
      for (const gid of Object.keys(store.data.members)) {
        const r = store.data.members[gid];
        for (const uid of Object.keys(r)) {
          if (r[uid].left && r[uid].left < cutoff) { delete r[uid]; n++; }
        }
      }
      if (n) store.save();
      return n;
    },
  };

  ctx.members = api;

  client.on(Events.GuildMemberRemove, (member) => {
    const m = api.get(member.guild.id, member.id);
    if (m) { m.left = Date.now(); store.save(); }
  });

  client.on(Events.GuildMemberUpdate, (_old, member) => {
    try { api.upsert(member); } catch { /* yoksay */ }
  });
}

module.exports = { name: 'members', init };
