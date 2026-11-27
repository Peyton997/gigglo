'use strict';
// Güvenli dış istek katmanı (SSRF koruması).
//  • Yalnızca HTTPS (varsayılan); kullanıcı/parola içeren URL reddedilir.
//  • Özel / yerel / link-local / metadata adresleri (IPv4, IPv6, IPv4-mapped) engellenir.
//  • DNS rebinding: adres, bağlantı kurulurken (lookup anında) doğrulanır; yalnızca ad kontrolüyle yetinilmez.
//  • Yönlendirmeler elle izlenir: her adımda şema + izin listesi + adres yeniden doğrulanır, adım sayısı sınırlıdır.
//  • İndirme akış olarak sayılır ve sınırı aşınca kesilir (bellek şişmez); Content-Length yalan söylese de sınır geçerlidir.
const dns = require('dns');
const https = require('https');
const net = require('net');

const PRIVATE = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) PRIVATE.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64]]) PRIVATE.addSubnet(a, p, 'ipv6');

const stripBrackets = (h) => String(h || '').replace(/^\[|\]$/g, '');

// IP adresi özel/yerel mi? IPv4-mapped (::ffff:127.0.0.1) ve NAT64 (64:ff9b::/96) içindeki IPv4 de denetlenir.
function isPrivateIp(ip) {
  const a = stripBrackets(ip).toLowerCase();
  const fam = net.isIP(a);
  if (!fam) return false;
  if (fam === 4) return PRIVATE.check(a, 'ipv4');
  if (PRIVATE.check(a, 'ipv6')) return true;
  const m = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (m && PRIVATE.check(m[1], 'ipv4')) return true;
  // ::ffff:7f00:1 gibi onaltılık yazım
  const h = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (h) {
    const hi = parseInt(h[1], 16);
    const lo = parseInt(h[2], 16);
    return PRIVATE.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4');
  }
  return false;
}

// Ad olarak yazılmış yerel hedefler (localhost, *.local, *.internal …) ya da özel IP sabiti mi?
function isPrivateHost(hostname) {
  const h = stripBrackets(hostname).toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (net.isIP(h)) return isPrivateIp(h);
  return h === 'localhost' || /\.(localhost|local|internal|lan|home|corp|intranet)$/.test(h) || !h.includes('.');
}

// dns.lookup yerine geçer: çözülen HER adres kamusal olmalı (rebinding'e karşı bağlantı anında denetim).
function makeGuardedLookup(resolve = dns.lookup) {
  return function guardedLookup(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    resolve(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      if (!addrs || !addrs.length) return cb(new Error('Alan adı çözülemedi'));
      const bad = addrs.find((x) => isPrivateIp(x.address));
      if (bad) return cb(Object.assign(new Error('Özel/yerel adrese erişim engellendi'), { code: 'EBLOCKED' }));
      if (options && options.all) return cb(null, addrs);
      return cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

const hostAllowed = (hostname, list) => !list || list.some((h) => hostname === h || hostname.endsWith(`.${h}`));

const REDIRECT = new Set([301, 302, 303, 307, 308]);

/**
 * Güvenli GET. Dönüş: { status, headers, body: Buffer, truncated }
 * opts: allowHosts, timeoutMs, maxBytes, truncate (sınıra gelince hata vermeden kes), maxHops, headers,
 *       transport: { request, schemes, allowPrivate, lookup }  (testler için; varsayılan HTTPS + korumalı lookup)
 */
async function safeGet(url, opts = {}) {
  const {
    allowHosts = null, timeoutMs = 20000, maxBytes = 5 * 1024 * 1024, truncate = false, maxHops = 3, headers = {},
    transport = {},
  } = opts;
  const request = transport.request || https.request;
  const schemes = transport.schemes || ['https:'];
  const allowPrivate = !!transport.allowPrivate;
  const lookup = transport.lookup || (allowPrivate ? undefined : makeGuardedLookup());
  const deadline = Date.now() + timeoutMs;

  let u = new URL(url);
  for (let hop = 0; hop <= maxHops; hop++) {
    if (!schemes.includes(u.protocol)) throw new Error('Yalnızca HTTPS desteklenir');
    if (u.username || u.password) throw new Error('Kimlik bilgisi içeren adres reddedildi');
    if (!hostAllowed(u.hostname.toLowerCase(), allowHosts)) throw new Error('İzin verilmeyen kaynak');
    if (!allowPrivate && isPrivateHost(u.hostname)) throw new Error('Özel/yerel adrese erişim engellendi');
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('Zaman aşımı');

    const res = await new Promise((resolve, reject) => {
      const req = request(u, { method: 'GET', headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'Kalkan/1.1', ...headers }, lookup, timeout: left }, resolve);
      req.on('timeout', () => req.destroy(new Error('Zaman aşımı')));
      req.on('error', reject);
      req.end();
    });

    if (REDIRECT.has(res.statusCode) && res.headers.location) {
      res.resume();
      res.destroy();
      try { u = new URL(res.headers.location, u); } catch { throw new Error('Geçersiz yönlendirme'); }
      continue;
    }

    const enc = String(res.headers['content-encoding'] || '').toLowerCase();
    if (enc && enc !== 'identity') { res.destroy(); throw new Error('Sıkıştırılmış yanıt desteklenmiyor'); }
    const len = Number(res.headers['content-length'] || 0);
    if (len && len > maxBytes && !truncate) { res.destroy(); throw new Error('Dosya çok büyük'); }

    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let done = false;
      const timer = setTimeout(() => finish(new Error('Zaman aşımı')), Math.max(1, deadline - Date.now()));
      function finish(err, truncated = false) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) { res.destroy(); return reject(err); }
        if (truncated) res.destroy();
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: truncated ? body.subarray(0, maxBytes) : body, truncated });
      }
      res.on('data', (c) => {
        total += c.length;
        chunks.push(c);
        if (total > maxBytes) finish(truncate ? null : new Error('Dosya çok büyük'), true);
      });
      res.on('end', () => finish(null));
      res.on('error', (e) => finish(e));
      res.on('aborted', () => finish(new Error('Bağlantı kesildi')));
    });
  }
  throw new Error('Çok fazla yönlendirme');
}

async function download(url, maxBytes, { timeoutMs = 20000, allowHosts = null, transport } = {}) {
  const r = await safeGet(url, { maxBytes, timeoutMs, allowHosts, transport });
  if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
  return r.body;
}

// Dosyanın yalnızca ilk n baytını okur (dosya türü imzası için). Tamamını indirmez.
async function peek(url, n = 512, { timeoutMs = 8000, allowHosts = null, transport } = {}) {
  const r = await safeGet(url, { maxBytes: n, truncate: true, timeoutMs, allowHosts, transport, headers: { Range: `bytes=0-${n - 1}` } });
  if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
  return r.body.subarray(0, n);
}

module.exports = { isPrivateIp, isPrivateHost, makeGuardedLookup, safeGet, download, peek, hostAllowed };
