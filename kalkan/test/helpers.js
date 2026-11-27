'use strict';
// Test yardımcıları: ağ/Discord gerektirmeyen sahte bağlam, sunucu, üye ve mesaj üreticileri.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Collection } = require('discord.js');

const noop = () => {};
const log = { debug: noop, info: noop, warn: noop, error: (...a) => { if (process.env.TEST_VERBOSE) console.error(...a); } };

function makeCtx({ modules = [], env: over = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kalkan-test-'));
  const { env: base } = require('../src/env');
  const env = { ...base, dataDir: dir, ownerIds: ['900000000000000001'], backupOwnerIds: ['900000000000000002'], botName: 'Kalkan', guildIds: [], ...over };
  require('../src/crypto').initKey({ ...env, dataKey: 'test-anahtar' });
  const { Store } = require('../src/store');
  const { EventLog } = require('../src/eventlog');
  const { createContext } = require('../src/ctx');

  const client = new EventEmitter();
  Object.assign(client, {
    user: { id: '111111111111111111', tag: 'Kalkan#0001', username: 'Kalkan' },
    guilds: { cache: new Collection() }, users: { fetch: async (id) => ({ id, send: async () => ({}) }), cache: new Collection() },
    channels: { cache: new Collection() }, ws: { ping: 12, status: 0 }, application: { commands: { set: async () => [] } },
    fetchInvite: async () => null, isReady: () => true,
  });
  const store = new Store(dir).load();
  const events = new EventLog(dir, { log });
  const ctx = createContext({ client, env, store, events, log });
  const alerts = [];
  const logs = [];
  ctx.alert = async (a) => { alerts.push(a); };
  ctx.logEmbed = async (g, e, kind) => { logs.push({ g, e, kind }); return true; };
  ctx.dmSent = [];
  ctx.dm = async (id, p) => { ctx.dmSent.push({ id, p }); return true; };
  for (const m of modules) require(`../src/modules/${m}`).init(ctx);
  const cleanup = () => { try { store.flush(); } catch { /* yoksay */ } fs.rmSync(dir, { recursive: true, force: true }); };
  return { ctx, client, store, env, dir, alerts, logs, cleanup };
}

// Sahte rol / üye / sunucu / mesaj
function fakeRole(id, { name = `rol-${id}`, permissions = 0n, position = 1, managed = false } = {}) {
  return { id, name, permissions: BigInt(permissions), position, managed, editable: true, toString: () => `<@&${id}>` };
}

function fakeMember(id, { guild, bot = false, joinedDaysAgo = 30, createdDaysAgo = 400, roles = [] } = {}) {
  const roleCol = new Collection(roles.map((r) => [r.id, r]));
  const m = {
    id, guild, displayName: `u${id.slice(-4)}`,
    user: { id, username: `u${id.slice(-4)}`, bot, createdTimestamp: Date.now() - createdDaysAgo * 864e5 },
    joinedTimestamp: Date.now() - joinedDaysAgo * 864e5,
    roles: { cache: roleCol, remove: async (ids) => { for (const i of [].concat(ids)) roleCol.delete(i.id || i); }, add: async () => {} },
    permissions: { has: () => false },
    moderatable: true, kickable: true, timeouts: [], kicked: false,
    timeout: async (ms) => { m.timeouts.push(ms); },
    kick: async () => { m.kicked = true; },
  };
  return m;
}

function fakeGuild(id = '800000000000000001', { ownerId = '900000000000000001' } = {}) {
  const members = new Collection();
  const g = {
    id, name: 'Test Sunucusu', ownerId,
    members: { cache: members, fetch: async (x) => (typeof x === 'string' ? members.get(x) || null : members), me: null, fetchMe: async () => g.members.me },
    roles: { cache: new Collection(), everyone: fakeRole(id, { name: '@everyone' }) },
    channels: { cache: new Collection(), fetch: async () => null },
    addMember(m) { m.guild = g; members.set(m.id, m); return m; },
  };
  g.roles.cache.set(id, g.roles.everyone);
  return g;
}

function fakeMessage({ guild, member, content = '', channelId = 'c1', attachments = [], mentions = {} } = {}) {
  return {
    guild, member, content, channelId, id: String(Math.random()).slice(2),
    author: { id: member.id, bot: false },
    attachments: new Collection(attachments.map((a, i) => [String(i), a])),
    mentions: { users: new Collection(), roles: new Collection(), everyone: false, ...mentions },
    delete: async () => {},
  };
}

module.exports = { makeCtx, fakeRole, fakeMember, fakeGuild, fakeMessage, log };

// Kanal / kategori sahteleri (yedek ve panik testleri için)
function fakeChannel(id, name, { type = 0, parentId = null, position = 0, overwrites = [] } = {}) {
  const { Collection: C } = require('discord.js');
  const cache = new C(overwrites.map((o) => [o.id, { id: o.id, type: o.type ?? 0, allow: { bitfield: BigInt(o.allow || 0) }, deny: { bitfield: BigInt(o.deny || 0) } }]));
  const calls = { edit: [], delete: [] };
  return {
    id, name, type, parentId, rawPosition: position, position, calls,
    permissionOverwrites: { cache, edit: async (t, flags) => { calls.edit.push(flags); }, delete: async (t) => { calls.delete.push(t.id || t); } },
  };
}

// Oluşturma çağrılarını kaydeden sunucu: yedek geri yükleme testleri için.
function fakeBuildableGuild(id = '800000000000000001') {
  const g = fakeGuild(id);
  g.created = { roles: [], channels: [] };
  g.members.me = { id: '111111111111111111', permissions: 8n, roles: { highest: { position: 50 } } };
  g.maximumBitrate = 96000;
  g.roles.create = async (o) => { const r = fakeRole(String(9e17 + g.created.roles.length), { name: o.name, permissions: o.permissions }); g.created.roles.push(o); g.roles.cache.set(r.id, r); return r; };
  g.roles.setPositions = async () => {};
  g.channels.create = async (o) => { const c = fakeChannel(String(8e17 + g.created.channels.length), o.name, { type: o.type }); g.created.channels.push(o); g.channels.cache.set(c.id, c); return c; };
  g.channels.setPositions = async () => {};
  g.verificationLevel = 1;
  g.features = [];
  g.invitesDisabled = false;
  g.disableInvites = async (v) => { g.invitesDisabled = v; };
  g.setVerificationLevel = async (v) => { g.verificationLevel = v; };
  return g;
}

Object.assign(module.exports, { fakeChannel, fakeBuildableGuild });
