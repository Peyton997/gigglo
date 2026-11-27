'use strict';
// Hesap bağlama (OAuth2: identify + guilds + guilds.join). Tokenlar AES-256-GCM ile şifreli saklanır.
// İki kip:
//   server : PUBLIC_URL tanımlıysa bot küçük bir web sunucusu açar (/verify, /callback, /gizlilik, /health).
//   manual : yalnızca OAUTH_REDIRECT_URI (ör. GitHub Pages'teki statik sayfa) varsa kod /hesap kod ile girilir; telefona gelen bağlantı gerekmez.
const http = require('http');
const crypto = require('crypto');
const { SlashCommandBuilder, InteractionContextType, MessageFlags, Routes } = require('discord.js');
const { encrypt, decrypt, hmac, randomId } = require('../crypto');
const { respond, sleep } = require('../util');

const API = 'https://discord.com/api/v10';
const SCOPES = 'identify guilds guilds.join';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(title, body) {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>`
    + '<style>body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;max-width:640px;margin:8vh auto;padding:0 18px;line-height:1.65}'
    + '.card{background:#1e293b;border-radius:14px;padding:22px 24px}h1{font-size:1.45rem;margin-top:0}a{color:#7dd3fc}li{margin:.3rem 0}code{background:#0f172a;padding:2px 6px;border-radius:6px}</style></head>'
    + `<body><div class="card"><h1>${esc(title)}</h1>${body}</div></body></html>`;
}

const safeEq = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function friendly(e) {
  const c = e && (e.code || e.message);
  if (c === 'invalid_grant') return 'Kod geçersiz ya da süresi dolmuş. Lütfen bağlantıyı yeniden başlat.';
  if (e && e.message === 'MISMATCH') return 'Bu kod başka bir Discord hesabına ait. Doğru hesapla giriş yaptığından emin ol.';
  return 'Doğrulama tamamlanamadı. Biraz sonra tekrar dene.';
}

function init(ctx) {
  const { client, env, store, log } = ctx;
  const states = new Map();
  const ipHits = new Map();
  const inflight = new Map();
  let server = null;

  const own = () => (env.publicUrl ? `${env.publicUrl}/callback` : '');
  const mode = () => {
    if (!env.clientSecret) return 'off';
    if (env.oauthRedirect && env.oauthRedirect !== own()) return 'manual';
    return own() ? 'server' : 'off';
  };
  const redirectUri = () => (mode() === 'manual' ? env.oauthRedirect : own());
  const enabledFor = (gid) => mode() !== 'off' && !!client.user && (!gid || ctx.gcfg(gid).oauth.enabled);

  /* ------------------------------------------------------------ Discord API */
  async function tokenRequest(params) {
    const body = new URLSearchParams({ client_id: client.user.id, client_secret: env.clientSecret, ...params });
    const res = await fetch(`${API}/oauth2/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(j.error_description || j.error || `HTTP ${res.status}`);
      e.status = res.status;
      e.code = j.error;
      throw e;
    }
    return j;
  }

  async function discordGet(pathname, accessToken) {
    const res = await fetch(`${API}${pathname}`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
    return res.json();
  }

  /* ------------------------------------------------------------ token saklama */
  function saveTokens(user, tok, gid) {
    const rec = (store.data.oauth[user.id] ||= { gids: [] });
    rec.enc = encrypt(JSON.stringify({ a: tok.access_token, r: tok.refresh_token }));
    rec.exp = Date.now() + (tok.expires_in || 604800) * 1000;
    rec.scope = tok.scope || SCOPES;
    rec.name = user.username;
    rec.at = Date.now();
    if (gid && !rec.gids.includes(gid)) rec.gids.push(gid);
    store.save();
  }

  function readTokens(uid) {
    const rec = store.data.oauth[uid];
    if (!rec || !rec.enc) return null;
    try { return JSON.parse(decrypt(rec.enc)); } catch { return null; }
  }

  function getAccessToken(uid, { force = false } = {}) {
    if (inflight.has(uid)) return inflight.get(uid);
    const p = (async () => {
      const rec = store.data.oauth[uid];
      const t = readTokens(uid);
      if (!rec || !t) return null;
      if (!force && rec.exp - Date.now() > 10 * 60e3) return t.a;
      try {
        const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.r });
        rec.enc = encrypt(JSON.stringify({ a: tok.access_token, r: tok.refresh_token || t.r }));
        rec.exp = Date.now() + (tok.expires_in || 604800) * 1000;
        rec.scope = tok.scope || rec.scope;
        store.save();
        return tok.access_token;
      } catch (e) {
        // Kullanıcı yetkiyi Discord'dan kaldırmışsa kaydı sil.
        if (e.status === 400 || e.status === 401 || e.code === 'invalid_grant') { delete store.data.oauth[uid]; store.save(); }
        return null;
      }
    })().finally(() => inflight.delete(uid));
    inflight.set(uid, p);
    return p;
  }

  /* ------------------------------------------------------------ durum imzası */
  function signState(gid, uid) {
    const body = `u.${gid}.${uid}.${(Date.now() + 30 * 60e3).toString(36)}`;
    return `${body}.${hmac(body).slice(0, 20)}`;
  }

  function parseSigned(state) {
    const p = String(state).split('.');
    if (p.length !== 5 || p[0] !== 'u') return null;
    if (!safeEq(hmac(p.slice(0, 4).join('.')).slice(0, 20), p[4])) return null;
    if (!(parseInt(p[3], 36) > Date.now())) return null;
    return { gid: p[1], uid: p[2] };
  }

  function authorizeUrl(state) {
    const q = new URLSearchParams({
      client_id: client.user.id, response_type: 'code', redirect_uri: redirectUri(), scope: SCOPES, state, prompt: 'none',
    });
    return `https://discord.com/oauth2/authorize?${q}`;
  }

  // Kodu token'a çevirir, kimliği doğrular ve kaydeder.
  async function completeLink({ code, gid, expectUid }) {
    const tok = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
    const user = await discordGet('/users/@me', tok.access_token);
    if (expectUid && user.id !== expectUid) {
      fetch(`${API}/oauth2/token/revoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: client.user.id, client_secret: env.clientSecret, token: tok.refresh_token || tok.access_token }),
      }).catch(() => {});
      throw new Error('MISMATCH');
    }
    saveTokens(user, tok, gid);
    // Hesabını bağlayan kişi, sunucuya erişim kaybolursa DM ile bilgilendirilmeyi kabul etmiş olur (istediği an /izni-iptal).
    if (gid && ctx.privacy) ctx.privacy.consentGrant(gid, user.id, 'oauth');
    return user;
  }

  /* ------------------------------------------------------------ genel API */
  const api = {
    mode,
    enabled: enabledFor,
    verifyUrl: (gid) => (mode() === 'server' && client.user ? `${env.publicUrl}/verify?g=${gid}` : null),
    personalLink: (gid, uid) => (enabledFor(gid) ? authorizeUrl(signState(gid, uid)) : null),
    has: (uid) => !!store.data.oauth[uid],
    count: (gid) => Object.values(store.data.oauth).filter((r) => !gid || (r.gids || []).includes(gid)).length,
    getAccessToken,

    async remove(uid) {
      const t = readTokens(uid);
      delete store.data.oauth[uid];
      store.save();
      if (t && env.clientSecret && client.user) {
        for (const [tk, hint] of [[t.r, 'refresh_token'], [t.a, 'access_token']]) {
          fetch(`${API}/oauth2/token/revoke`, {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: client.user.id, client_secret: env.clientSecret, token: tk, token_type_hint: hint }),
            signal: AbortSignal.timeout(10000),
          }).catch(() => {});
        }
      }
    },

    // Kullanıcıyı (yedek) sunucuya ekler. Token'ında guilds.join olmalı; bot hedef sunucuda olmalı.
    async addToGuild(uid, gid, roles) {
      const rec = store.data.oauth[uid];
      if (!rec || !String(rec.scope || '').split(' ').includes('guilds.join')) return { ok: false, reason: 'no-token' };
      const token = await getAccessToken(uid);
      if (!token) return { ok: false, reason: 'no-token' };
      try {
        const body = { access_token: token };
        if (roles && roles.length) body.roles = roles;
        const r = await client.rest.put(Routes.guildMember(gid, uid), { body });
        return { ok: true, already: !r };
      } catch (e) {
        return { ok: false, reason: e.message, code: e.code };
      }
    },

    async userGuilds(uid) {
      const rec = store.data.oauth[uid];
      if (!rec || !String(rec.scope || '').split(' ').includes('guilds')) return null;
      const token = await getAccessToken(uid);
      if (!token) return null;
      try {
        const list = await discordGet('/users/@me/guilds?limit=200', token);
        return { ids: list.map((g) => g.id), partial: list.length >= 200 };
      } catch { return null; }
    },

    // Sunucu silindi mi, yoksa bot mu atıldı? Doğrulanmış üyelerin sunucu listelerine bakarak anlar.
    async checkGuildGone(gid, { sample = 12 } = {}) {
      const reg = store.data.members[gid] || {};
      const cands = Object.keys(store.data.oauth).filter((uid) => reg[uid] && !reg[uid].left);
      for (let i = cands.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [cands[i], cands[j]] = [cands[j], cands[i]]; }
      let tried = 0;
      let notIncluded = 0;
      for (const uid of cands) {
        if (tried >= sample) break;
        const r = await api.userGuilds(uid);
        if (!r) continue;
        tried++;
        if (r.ids.includes(gid)) return { verdict: 'exists', checked: tried };
        if (!r.partial) notIncluded++;
      }
      return { verdict: notIncluded >= 3 ? 'gone' : 'unknown', checked: tried, notIncluded };
    },

    async refreshAll() {
      const due = Object.keys(store.data.oauth).filter((uid) => store.data.oauth[uid].exp - Date.now() < 36 * 3600e3).slice(0, 200);
      for (const uid of due) { await getAccessToken(uid, { force: true }); await sleep(400); }
      return due.length;
    },

    start() {
      if (mode() !== 'server' || server) {
        if (mode() === 'off') log.info('OAuth kapalı (CLIENT_SECRET ve PUBLIC_URL / OAUTH_REDIRECT_URI tanımlı değil).');
        else if (mode() === 'manual') log.info(`OAuth "manual" kipte: ${env.oauthRedirect}`);
        return;
      }
      server = http.createServer((req, res) => {
        handle(req, res).catch((e) => {
          log.error('web hatası:', e);
          try { if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('Hata'); } catch { /* yoksay */ }
        });
      });
      server.headersTimeout = 10000;
      server.requestTimeout = 15000;
      server.keepAliveTimeout = 5000;
      server.on('clientError', (_e, socket) => { try { socket.destroy(); } catch { /* yoksay */ } });
      server.on('error', (e) => { log.error(`OAuth web sunucusu hatası (${env.bindHost}:${env.port}):`, e.message); server = null; });
      server.listen(env.port, env.bindHost, () => log.info(`OAuth web sunucusu: http://${env.bindHost}:${env.port}  (herkese açık adres: ${env.publicUrl})`));
    },

    stop() { try { if (server) server.close(); } catch { /* yoksay */ } server = null; },
    _test: { signState, parseSigned, page, esc },
  };
  ctx.oauth = api;

  /* ------------------------------------------------------------ web */
  const clientIp = (req) => String(req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?');
  const limited = (ip) => {
    const now = Date.now();
    const h = ipHits.get(ip) || { n: 0, t: now };
    if (now - h.t > 60e3) { h.n = 0; h.t = now; }
    h.n++;
    ipHits.set(ip, h);
    return h.n > 30;
  };

  async function handle(req, res) {
    const send = (status, html, headers = {}) => {
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", ...headers,
      });
      res.end(req.method === 'HEAD' ? undefined : html);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, page('İzin verilmiyor', '<p>Yalnızca GET.</p>'));
    if (limited(clientIp(req))) return send(429, page('Çok fazla istek', '<p>Biraz bekleyip tekrar dene.</p>'));
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return send(400, page('Hatalı istek', '<p>Adres okunamadı.</p>')); }
    const secure = env.publicUrl.startsWith('https');

    if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (url.pathname === '/') return send(200, page(env.botName, '<p>Güvenlik botu çalışıyor.</p><p><a href="/gizlilik">Gizlilik ve veri bilgisi</a></p>'));
    if (url.pathname === '/gizlilik') {
      return send(200, page(`${env.botName} — Gizlilik`, `
        <p>Hesabını bağlarsan <b>${esc(env.botName)}</b> şunları saklar:</p>
        <ul><li>Discord kullanıcı kimliğin ve kullanıcı adın</li><li>Hangi sunucuda doğrulandığın ve kurtarma bildirimi izni verdiğin</li><li>Discord'un verdiği erişim anahtarı (<b>şifreli</b> saklanır)</li></ul>
        <p><b>İstenen izinler ve amaçları</b></p>
        <ul><li><code>identify</code>: hesabının sana ait olduğunu doğrulamak</li>
        <li><code>guilds</code>: yalnızca sunucunun silinip silinmediğini anlamak için sunucu listene bakmak</li>
        <li><code>guilds.join</code>: sunucu silinirse seni yöneticilerin belirlediği yedek sunucuya ekleyebilmek</li></ul>
        <p><b>Yapılmayanlar:</b> şifren, e-postan, özel mesajların ve sunucu mesajların okunmaz; bu anahtarla senin adına mesaj yazılamaz.</p>
        <p><b>Silmek için:</b> Discord'da <code>/hesap sil</code> (veya <code>/verilerimi-sil</code>) yaz ya da Discord → Ayarlar → Yetkili Uygulamalar bölümünden uygulamayı kaldır.</p>`));
    }
    if (url.pathname === '/verify') {
      const gid = (url.searchParams.get('g') || '').replace(/\D/g, '');
      if (!gid || !client.guilds.cache.has(gid) || !enabledFor(gid)) return send(404, page('Bulunamadı', '<p>Bu doğrulama bağlantısı geçerli değil.</p>'));
      const nonce = randomId(12);
      states.set(nonce, { gid, at: Date.now() });
      return send(302, '', { Location: authorizeUrl(`n.${nonce}.${gid}`), 'Set-Cookie': `ks=${nonce}; Max-Age=600; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}` });
    }
    if (url.pathname === '/callback') {
      if (url.searchParams.get('error')) return send(200, page('İptal edildi', '<p>Yetkilendirmeyi iptal ettin. Sorun değil; istersen tekrar deneyebilirsin.</p>'));
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state') || '';
      if (!code || code.length > 200) return send(400, page('Hatalı istek', '<p>Kod eksik.</p>'));
      let gid = null;
      let expectUid = null;
      if (state.startsWith('u.')) {
        const p = parseSigned(state);
        if (!p) return send(400, page('Süre doldu', '<p>Bağlantının süresi dolmuş ya da geçersiz. Discord’dan yeniden başlat.</p>'));
        gid = p.gid; expectUid = p.uid;
      } else if (state.startsWith('n.')) {
        const [, nonce, g] = state.split('.');
        const st = states.get(nonce);
        if (!st || st.gid !== g || !safeEq(parseCookies(req.headers.cookie).ks || '', nonce) || Date.now() - st.at > 10 * 60e3) {
          return send(400, page('Doğrulanamadı', '<p>Oturum eşleşmedi. Doğrulama bağlantısına aynı tarayıcıdan yeniden tıkla.</p>'));
        }
        states.delete(nonce);
        gid = st.gid;
      } else {
        return send(400, page('Hatalı istek', '<p>Geçersiz durum bilgisi.</p>'));
      }
      try {
        const user = await completeLink({ code, gid, expectUid });
        const guild = client.guilds.cache.get(gid);
        const member = guild ? await guild.members.fetch(user.id).catch(() => null) : null;
        const clear = { 'Set-Cookie': 'ks=; Max-Age=0; Path=/' };
        if (!member) return send(200, page('Bağlandı', '<p>Hesabın bağlandı fakat bu sunucuda üye görünmüyorsun. Önce sunucuya katıl, sonra yeniden doğrula.</p>'), clear);
        await ctx.raid.markVerified(guild, user.id, 'oauth');
        return send(200, page('✅ Doğrulandın', `<p>Merhaba <b>${esc(user.username)}</b>, <b>${esc(guild.name)}</b> sunucusunda doğrulandın. Bu sekmeyi kapatabilirsin.</p><p><a href="/gizlilik">Hangi veriler saklanıyor?</a></p>`), clear);
      } catch (e) {
        log.warn('OAuth callback hatası:', e.message);
        return send(400, page('Doğrulanamadı', `<p>${esc(friendly(e))}</p>`));
      }
    }
    return send(404, page('Bulunamadı', '<p>Böyle bir sayfa yok.</p>'));
  }

  /* ------------------------------------------------------------ komutlar */
  async function wipeUser(uid) {
    if (ctx.privacy) {
      const r = await ctx.privacy.eraseUser(uid);
      return { had: !!r.hesapBaglantisi, rows: r.uyelik || 0, consent: r.izin || 0 };
    }
    const had = api.has(uid);
    await api.remove(uid);
    let rows = 0;
    for (const gid of Object.keys(store.data.members)) {
      if (store.data.members[gid][uid]) { ctx.members.remove(gid, uid); rows++; }
    }
    return { had, rows, consent: 0 };
  }

  const wipeText = ({ had, rows }) => [
    had ? '✅ Hesap bağlantın ve şifreli erişim anahtarın silindi (Discord tarafında da iptal edildi).' : 'ℹ️ Kayıtlı bir hesap bağlantın yoktu.',
    rows ? `✅ ${rows} sunucudaki üye kaydın (roller, aktivite sayaçları) silindi. Sunucuda kalmaya devam edersen temel kayıt yeniden oluşabilir.` : null,
    'Kurtarma bildirimi iznin de geri çekildi; olay günlüklerindeki kimliğin takma adla değiştirildi.',
    'Not: moderasyon vakaları saklama süresi dolana kadar tutulur; açık bir güvenlik soruşturması varsa ilgili kayıtlar incelemenin sonuna dek saklanabilir.',
  ].filter(Boolean).join('\n');

  ctx.router.add(
    new SlashCommandBuilder()
      .setName('hesap')
      .setDescription('Hesap bağlantısı ve kayıtlı verilerin')
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((s) => s.setName('baglan').setDescription('Hesabını güvenlik için bağla (isteğe bağlı)'))
      .addSubcommand((s) => s.setName('kod').setDescription('Yetkilendirme sonrası sayfada gösterilen kodu gir')
        .addStringOption((o) => o.setName('kod').setDescription('Sayfada gösterilen kod').setRequired(true).setMaxLength(120)))
      .addSubcommand((s) => s.setName('durum').setDescription('Neler saklanıyor?'))
      .addSubcommand((s) => s.setName('sil').setDescription('Bağlantını ve kayıtlı verilerini sil')),
    async (i) => {
      const sub = i.options.getSubcommand();
      if (sub === 'sil') return respond(i, wipeText(await wipeUser(i.user.id)));
      if (sub === 'durum') {
        const rec = store.data.oauth[i.user.id];
        const regs = Object.values(store.data.members).filter((r) => r[i.user.id]).length;
        return respond(i, [
          `**Hesap bağlantısı:** ${rec ? `var (${(rec.scope || '').split(' ').join(', ')})` : 'yok'}`,
          `**Üye kaydı:** ${regs} sunucuda (kimlik, roller, aktivite sayaçları — mesaj içeriği saklanmaz)`,
          'Silmek için `/hesap sil`.',
        ].join('\n'));
      }
      if (!enabledFor(i.guildId)) return respond(i, 'ℹ️ Hesap bağlama bu sunucuda kapalı.');
      if (sub === 'baglan') {
        const link = api.personalLink(i.guildId, i.user.id);
        const manual = mode() === 'manual';
        return respond(i, [
          '🔐 **Hesabını bağla (isteğe bağlı)**',
          `1) Şu bağlantıyı aç ve izin ver: ${link}`,
          manual ? '2) Sayfada görünen **kodu** kopyala ve buraya `/hesap kod` ile yapıştır.' : '2) İşlem bitince otomatik doğrulanırsın.',
          'Bağlarsan, sunucuya erişim kaybolursa sana yedek sunucu duyurusunun DM ile gönderilmesini kabul etmiş olursun (isteğe bağlı; `/izni-iptal` ile geri çekersin).',
          'Şifren istenmez; mesajların okunmaz. Neler saklandığı: `/privacy`. İstediğin an `/hesap sil`.',
        ].join('\n'));
      }
      // kod
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const code = i.options.getString('kod', true).trim().replace(/^.*[?&]code=/, '').split('&')[0];
      try {
        const user = await completeLink({ code, gid: i.guildId, expectUid: i.user.id });
        await ctx.raid.markVerified(i.guild, user.id, 'oauth');
        return respond(i, '✅ Hesabın bağlandı ve doğrulandın. Teşekkürler! Verilerini istediğin an `/hesap sil` ile silebilirsin.');
      } catch (e) {
        return respond(i, `❌ ${friendly(e)}`);
      }
    },
  );

  ctx.every(60 * 60e3, async () => {
    const n = await api.refreshAll();
    if (n) log.info(`OAuth: ${n} token yenilendi`);
  }, 'oauth-yenile');
  ctx.every(5 * 60e3, () => {
    const now = Date.now();
    for (const [k, v] of states) if (now - v.at > 10 * 60e3) states.delete(k);
    for (const [k, v] of ipHits) if (now - v.t > 120e3) ipHits.delete(k);
  }, 'oauth-gc');
}

module.exports = { name: 'oauth', init, esc, page };
