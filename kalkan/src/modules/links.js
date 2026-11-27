'use strict';
// Akıllı bağlantı sınıflandırma: GIF'ler link sayılmaz, davet/scam/çalıştırılabilir/bilinmeyen bağlantılar engellenir.
const net = require('net');

// Tam IANA uzantı listesi (src/data/tlds.js). Şemasız ("ornek.xyz") yazılmış adresler iki kademede aranır:
//  • güçlü kanıt (yol/port içeriyorsa: "ornek.xyz/abc"): tüm IANA uzantıları
//  • zayıf kanıt (yalnızca "ornek.xyz"): 3+ harfli tüm uzantılar + aşağıdaki seçili 2 harfli uzantılar.
//    Dosya adlarıyla karışan uzantılar (Main.java, start.sh, video.mov) zayıf kademede yok sayılır; yanlış alarm olmasın.
const IANA = new Set(require('../data/tlds'));
const SHORT_TLDS = new Set([
  'gg', 'io', 'tk', 'ml', 'ga', 'cf', 'gq', 'me', 'co', 'ru', 'tr', 'az', 'us', 'uk', 'de', 'fr', 'cc', 'to', 'ly', 'ws',
  'im', 'in', 'ai', 'eu', 'ua', 'kz', 'ge', 'nl', 'pl', 'br', 'jp', 'kr', 'cn', 'tv', 'fm', 'pw', 'su', 'vc', 'nu', 'bz',
  'li', 'gl', 'la', 'cx', 'tf', 'gs', 'ms', 'st', 'tw', 'vn', 'mx', 'ca', 'au', 'nz', 'za', 'es', 'se', 'fi', 'dk', 'cz',
  'sk', 'hu', 'ro', 'bg', 'hr', 'si', 'lt', 'lv', 'ee', 'gr', 'pt', 'ie', 'ir', 'il', 'by', 'md', 'is',
]);
const FILE_LIKE_TLDS = new Set(['java', 'mov', 'sh', 'py', 'rs', 'md', 'cs', 'kt', 'rb', 'pm', 'js', 'ts', 'cpp', 'exe', 'bat', 'dll', 'jar', 'pdf', 'doc', 'docx', 'txt', 'log']);

function tldOk(tld, strong) {
  if (!IANA.has(tld)) return false;
  if (strong) return true;
  if (FILE_LIKE_TLDS.has(tld)) return false;
  return tld.length >= 3 || SHORT_TLDS.has(tld);
}

const URL_RE = new RegExp(
  String.raw`(?<![@\w.-])(?:https?:\/\/|www\.)[^\s<>"']+|(?<![@\w./-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?<tld>[a-z]{2,24})(?![a-z0-9-])(?<port>:\d{2,5})?(?<path>\/[^\s<>"']*)?`,
  'gi',
);

const INVITE_RE = /(?:discord(?:app)?\s*\.\s*(?:gg|com\s*\/\s*invite)|dsc\s*\.\s*gg|invite\s*\.\s*gg|discord\s*\.\s*me|discord\s*\.\s*io|disboard\s*\.\s*org\s*\/\s*server\s*\/\s*join)\s*\/\s*([a-z0-9-]{2,32})/gi;

const SHORTENERS = new Set([
  'bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'is.gd', 'cutt.ly', 'rb.gy', 'shorturl.at', 'ow.ly', 'buff.ly',
  'tiny.cc', 'v.gd', 's.id', 't.ly', 'rebrand.ly', 'shorte.st', 'adf.ly', 'bc.vc', 'ouo.io', 'lnkd.in',
  'soo.gd', 'clck.ru', 'vk.cc', 'bit.do', 'qr.ae', 'urlz.fr', 'x.co',
]);

const GIF_HOSTS = ['tenor.com', 'tenor.co', 'giphy.com', 'gph.is'];
const DISCORD_CDN = ['cdn.discordapp.com', 'media.discordapp.net', 'images-ext-1.discordapp.net', 'images-ext-2.discordapp.net', 'cdn.discord.com'];
const DISCORD_HOSTS = ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'];
const REAL_HOSTS = [
  'discord.com', 'discordapp.com', 'discord.gg', 'discord.media', 'discordapp.net', 'discordstatus.com',
  'steamcommunity.com', 'steampowered.com', 'epicgames.com', 'roblox.com',
];
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'mp4', 'mov', 'webm', 'mp3', 'ogg', 'wav']);

const DEFAULT_BLOCKED_EXT = new Set(require('../defaults').DEFAULTS.files.blockedExt);

const hostMatches = (host, list) => (list || []).some((d) => {
  d = String(d).toLowerCase().replace(/^www\./, '');
  return host === d || host.endsWith('.' + d);
});

function decodeSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function normalizeText(s) {
  return String(s || '')
    .replace(/[​-‏⁠﻿­]/g, '')
    .replace(/\s*(?:\[\.\]|\(\.\)|\{\.\}|\[dot\]|\(dot\))\s*/gi, '.')
    .replace(/\bhxxp(s?):\/\//gi, 'http$1://');
}

function parse(raw) {
  let s = String(raw || '').trim().replace(/[)\]}>.,;:!?'"`*_~|]+$/, '');
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    const path = decodeSafe(u.pathname);
    const m = /\.([a-z0-9]{1,8})$/i.exec(path);
    return { raw, url: u.toString(), host, hostBare: host.replace(/^www\./, ''), path, ext: m ? m[1].toLowerCase() : '', port: u.port };
  } catch {
    return null;
  }
}

function extract(text, max = 15) {
  const t = normalizeText(String(text || '').slice(0, 4000));
  const seen = new Set();
  const out = [];
  for (const m of t.matchAll(URL_RE)) {
    if (!/^(?:https?:\/\/|www\.)/i.test(m[0]) && !tldOk(String(m.groups.tld || '').toLowerCase(), !!(m.groups.path || m.groups.port))) continue;
    let info = parse(m[0]);
    // Biçimi bozuk ama link gibi görünen adresi (örn. geçersiz punycode) yok sayma: engellenecek şüpheli bağlantı say.
    if (!info && /^(?:https?:\/\/|www\.)/i.test(m[0])) {
      const hostGuess = m[0].replace(/^(?:https?:\/\/)/i, '').split(/[/?#]/)[0].toLowerCase().slice(0, 60);
      info = { raw: m[0], url: m[0].slice(0, 200), host: hostGuess, hostBare: hostGuess.replace(/^www\./, ''), path: '', ext: '', port: '', invalid: true };
    }
    if (!info || seen.has(info.url)) continue;
    seen.add(info.url);
    out.push(info);
    if (out.length >= max) break;
  }
  return out;
}

function inviteCodes(text) {
  const t = normalizeText(String(text || '').slice(0, 4000));
  const out = [];
  for (const m of t.matchAll(INVITE_RE)) out.push(m[1].toLowerCase());
  return [...new Set(out)];
}

function isScamHost(host, extra = [], big = null) {
  if (hostMatches(host, extra)) return true;
  if (big && big.size) {
    const parts = host.split('.');
    for (let i = 0; i < parts.length - 1; i++) if (big.has(parts.slice(i).join('.'))) return true;
  }
  if (hostMatches(host, REAL_HOSTS)) return false;
  const h = host.replace(/[-.]/g, '');
  if (/dlscord|disc0rd|discorcl|discrod|dicsord|discorrd|disscord|discordd|dlscrod|discordapp(?!\.)/.test(h) && !hostMatches(host, REAL_HOSTS)) return true;
  if (/nitro/.test(h) && /(discord|free|gift|steam|claim|drop)/.test(h)) return true;
  if (/steam/.test(h) && /(gift|free|nitro|trade|commun|power|promo)/.test(h)) return true;
  if (/(airdrop|claimreward|giveaway)/.test(h) && /(discord|nitro|steam|crypto)/.test(h)) return true;
  return false;
}

const block = (type, detail, severity = 'low') => ({ action: 'block', type, detail, severity });
const allow = (type) => ({ action: 'allow', type });

/**
 * info: parse() çıktısı.
 * opts: { allowDomains, blockInvites, allowInviteCodes, scamHosts, blockedExt(Set) }
 * dönüş: { action: 'allow'|'block'|'resolve', type, detail?, severity? }
 */
function classify(info, opts = {}) {
  const blockedExt = opts.blockedExt || DEFAULT_BLOCKED_EXT;
  const { host, hostBare, path, ext } = info;
  if (info.invalid) return block('unknown', 'Geçersiz biçimli bağlantı', 'high');

  if (net.isIP(host.replace(/^\[|\]$/g, '')) !== 0) return block('ip', 'IP adresi bağlantısı', 'high');
  if (host.startsWith('xn--') || host.includes('.xn--')) return block('punycode', 'Taklit (punycode) alan adı', 'high');

  // Davet bağlantıları
  const inv = inviteCodes(`${hostBare}${path}`);
  if (inv.length || /^(discord\.gg|dsc\.gg|invite\.gg)$/.test(hostBare)) {
    const code = (inv[0] || path.replace(/^\/+/, '').split('/')[0] || '').toLowerCase();
    if ((opts.allowInviteCodes || []).map((c) => c.toLowerCase()).includes(code)) return allow('own-invite');
    return opts.blockInvites === false ? allow('invite') : block('invite', 'Discord daveti / reklam');
  }
  if (hostMatches(hostBare, ['discord.com', 'discordapp.com']) && /^\/invite\//i.test(path)) {
    const code = path.split('/')[2]?.toLowerCase();
    if ((opts.allowInviteCodes || []).map((c) => c.toLowerCase()).includes(code)) return allow('own-invite');
    return opts.blockInvites === false ? allow('invite') : block('invite', 'Discord daveti / reklam');
  }

  if (isScamHost(hostBare, opts.scamHosts, opts.scamSet)) return block('scam', 'Sahte / dolandırıcılık alan adı', 'high');

  // Çalıştırılabilir uzantı: izinli alan adında bile engellenir
  if (ext && blockedExt.has(ext)) return block('executable', `Çalıştırılabilir dosya bağlantısı (.${ext})`, 'high');

  if (hostMatches(hostBare, GIF_HOSTS)) return allow('gif');
  if (hostMatches(host, DISCORD_CDN)) {
    // Discord CDN'deki arşiv/belge/çalıştırılabilir dosya bağlantıları zararlı yazılım dağıtımında sık kullanılır: yalnızca medya serbest.
    if (!ext || IMAGE_EXT.has(ext)) return allow('discord-media');
    return block('cdn-file', `Discord CDN üzerinde dosya bağlantısı (.${ext}); dosyaları bağlantı yerine ek olarak yükle`, 'medium');
  }
  if (hostMatches(hostBare, DISCORD_HOSTS) && /^\/channels\//i.test(path)) return allow('discord-message');
  if (SHORTENERS.has(hostBare)) return { action: 'resolve', type: 'shortener' };
  if (hostMatches(hostBare, opts.allowDomains)) return allow('allowed-domain');

  if (ext && IMAGE_EXT.has(ext)) return block('unknown-media', 'Tanınmayan sitede medya bağlantısı (resim kaydedici olabilir)');
  return block('unknown', 'İzin verilmeyen bağlantı');
}

// Yalnızca bilinen kısaltıcıları açar; başka siteye asla bağlanmaz (bot IP'si sızmasın).
async function resolveShortener(urlStr, hops = 3) {
  let cur = urlStr;
  for (let i = 0; i < hops; i++) {
    const info = parse(cur);
    if (!info) return null;
    if (!SHORTENERS.has(info.hostBare)) return cur;
    let res;
    try {
      res = await fetch(info.url, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(4000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkCheck/1.0)' },
      });
    } catch {
      return null;
    }
    try { if (res.body) await res.body.cancel(); } catch { /* yoksay */ }
    const loc = res.headers.get('location');
    if (!loc || res.status < 300 || res.status > 399) return i === 0 ? null : cur;
    try { cur = new URL(loc, info.url).toString(); } catch { return null; }
  }
  return cur;
}

module.exports = {
  tldOk, extract, parse, classify, inviteCodes, isScamHost, resolveShortener, hostMatches, normalizeText,
  SHORTENERS, GIF_HOSTS, DISCORD_CDN, DEFAULT_BLOCKED_EXT,
};
