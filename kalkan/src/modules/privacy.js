'use strict';
// Gizlilik katmanı: gönüllü kayıt (kurtarma bildirimi izni), veri dökümü, indirme, silme, saklama süresi ve yetkili erişim kaydı.
//
// İlke: Kalkan kullanıcıları gizlice izlemez; hangi verinin neden saklandığı /privacy ile açıklanır, her üye kendi verisini
// /verilerim ile görür, /veri-indir ile indirir, /verilerimi-sil ile siler, /izni-iptal ile izinlerini geri çeker.
// Diğer modüller kendi verilerini ctx.privacy.provider(...) ile buraya tanıtır; böylece döküm/indirme/silme tek yerden yürür.
const { SlashCommandBuilder, AttachmentBuilder, InteractionContextType, PermissionFlagsBits } = require('discord.js');
const { respond, truncate, unixFull } = require('../util');
const { hmac } = require('../crypto');
const ui = require('../ui');

const ACCESS_CAP = 500;

function init(ctx) {
  const { store, client, events, log } = ctx;
  ui.ensure(ctx);
  const consent = () => store.data.consent;
  const providers = new Map();
  const aliasOf = (uid) => `silindi-${hmac(`erase:${uid}`).slice(0, 8)}`;

  const api = {
    /* ------------------------------------------------------------ gönüllü kayıt (opt-in) */
    consentGrant(gid, uid, via = 'komut') {
      const g = (consent()[gid] ||= {});
      if (g[uid]) return false;
      g[uid] = { at: Date.now(), via };
      ctx.save();
      return true;
    },
    // gid verilmezse tüm sunucular için geri çeker. Silinen kayıt sayısını döndürür.
    consentRevoke(uid, gid = null) {
      let n = 0;
      for (const g of Object.keys(consent())) {
        if (gid && g !== gid) continue;
        if (consent()[g][uid]) { delete consent()[g][uid]; n++; }
        if (!Object.keys(consent()[g]).length) delete consent()[g];
      }
      if (n) ctx.save();
      return n;
    },
    consentHas: (gid, uid) => !!(consent()[gid] && consent()[gid][uid]),
    consentCount: (gid) => Object.keys(consent()[gid] || {}).length,
    // Kurtarma DM'i alacak kişiler: YALNIZCA gönüllü kayıt olanlar (bot ve sunucudan ayrılanlar hariç).
    audience(gid) {
      const reg = store.data.members[gid] || {};
      return Object.keys(consent()[gid] || {}).filter((uid) => !(reg[uid] && (reg[uid].bot || reg[uid].left)));
    },

    /* ------------------------------------------------------------ yetkili erişim kaydı */
    // Bir yetkili, kullanıcıya ait kişisel/güvenlik verisine baktığında çağrılır.
    logAccess(gid, by, kind, target = null, note = '') {
      const list = (store.data.access[gid] ||= []);
      list.push({ t: Date.now(), by, kind, target, note: truncate(note, 120) });
      while (list.length > ACCESS_CAP) list.shift();
      ctx.save();
    },
    accessLog(gid, { target = null, limit = 100 } = {}) {
      const list = store.data.access[gid] || [];
      return (target ? list.filter((a) => a.target === target) : list).slice(-limit).reverse();
    },

    /* ------------------------------------------------------------ veri sağlayıcıları */
    // { title, describe, summary(uid)→string|null, export(uid)→object|null, erase(uid)→number|string|null }
    provider(name, p) { providers.set(name, p); },
    providers: () => [...providers.entries()],

    exportUser(uid) {
      const out = { olusturulma: new Date().toISOString(), kullaniciId: uid, kaynaklar: {} };
      for (const [name, p] of providers) {
        if (!p.export) continue;
        try { const d = p.export(uid); if (d !== null && d !== undefined) out.kaynaklar[name] = d; } catch (e) { log.warn(`veri dökümü (${name}):`, e.message); }
      }
      out.not = 'Güvenlik soruşturması kayıtları (izleme listesi, risk puanı, olay analizi) ve moderasyon vakaları bu dökümde yoktur; bunların varlığı /privacy içinde açıklanır.';
      return out;
    },

    async eraseUser(uid) {
      const result = {};
      for (const [name, p] of providers) {
        if (!p.erase) continue;
        try { result[name] = await p.erase(uid); } catch (e) { log.warn(`veri silme (${name}):`, e.message); result[name] = 'hata'; }
      }
      result.olayKayitlari = events.anonymizeUser(uid, aliasOf(uid));
      return result;
    },

    // Saklama süresi dolan verileri siler (günlük çalışır).
    purgeExpired() {
      let ev = 0;
      let acc = 0;
      let cs = 0;
      const now = Date.now();
      const days = Object.keys(store.data.guilds).map((g) => ctx.gcfg(g).privacy);
      const maxOf = (k, d) => Math.max(d, ...days.map((p) => (p && p[k]) || d));
      ev = events.purgeOlderThan(maxOf('eventDays', 90));
      for (const [gid, list] of Object.entries(store.data.access)) {
        const cut = now - ((ctx.gcfg(gid).privacy.accessDays || 180) * 864e5);
        const kept = list.filter((a) => a.t >= cut);
        acc += list.length - kept.length;
        if (kept.length) store.data.access[gid] = kept; else delete store.data.access[gid];
      }
      for (const [gid, list] of Object.entries(store.data.cases)) {
        if (!Array.isArray(list)) continue;
        const cut = now - ((ctx.gcfg(gid).privacy.caseDays || 365) * 864e5);
        const kept = list.filter((c) => c.at >= cut);
        cs += list.length - kept.length;
        store.data.cases[gid] = kept;
      }
      for (const [, p] of providers) { try { if (p.purge) p.purge(); } catch (e) { log.warn('saklama temizliği:', e.message); } }
      if (ev || acc || cs) { ctx.save(); log.info(`Saklama süresi temizliği: ${ev} olay, ${acc} erişim kaydı, ${cs} vaka silindi.`); }
      return { ev, acc, cs };
    },
  };
  ctx.privacy = api;

  /* ---------------------------------------------------------------- yerleşik sağlayıcılar */
  api.provider('uyelik', {
    title: 'Üye kaydı',
    describe: 'Kullanıcı ID, kullanıcı adı, sunucudaki ad, hesap/katılma tarihi, roller, mesaj/link/dosya SAYAÇLARI ve saatlik etkinlik dağılımı. Mesaj içerikleri saklanmaz. Amaç: baskın/hesap ele geçirme tespiti ve olay incelemesi. Sunucudan ayrılanların kaydı 30 gün sonra silinir.',
    summary(uid) {
      const n = Object.values(store.data.members).filter((r) => r[uid]).length;
      return n ? `${n} sunucuda üye kaydın var (kimlik, roller, etkinlik sayaçları)` : null;
    },
    export(uid) {
      const out = {};
      for (const [gid, reg] of Object.entries(store.data.members)) if (reg[uid]) out[gid] = reg[uid];
      return Object.keys(out).length ? out : null;
    },
    erase(uid) {
      let n = 0;
      for (const gid of Object.keys(store.data.members)) if (store.data.members[gid][uid]) { ctx.members.remove(gid, uid); n++; }
      return n;
    },
  });

  api.provider('izin', {
    title: 'Kurtarma bildirimi izni',
    describe: 'Gönüllü olarak verdiğin izin kaydı (hangi sunucu, ne zaman, hangi yolla). Yalnızca sunucuya erişim kaybolursa yedek sunucu duyurusunu DM ile göndermek için kullanılır. Kaydolmadıysan sana toplu DM gönderilmez.',
    summary(uid) {
      const n = Object.values(consent()).filter((g) => g[uid]).length;
      return n ? `${n} sunucuda kurtarma bildirimi izni verdin` : null;
    },
    export(uid) {
      const out = {};
      for (const [gid, g] of Object.entries(consent())) if (g[uid]) out[gid] = g[uid];
      return Object.keys(out).length ? out : null;
    },
    erase(uid) { return api.consentRevoke(uid); },
  });

  api.provider('hesapBaglantisi', {
    title: 'Hesap bağlantısı (OAuth)',
    describe: 'İsteğe bağlı hesap bağlama: yalnızca "identify" ve gerekirse "guilds"/"guilds.join" kapsamları. Erişim anahtarın AES-256-GCM ile şifrelenir; şifren hiçbir zaman istenmez. İstediğin an iptal edilir.',
    summary(uid) { return store.data.oauth[uid] ? 'Hesabın bağlı (kapsamlar: ' + String(store.data.oauth[uid].scope || '').split(' ').join(', ') + ')' : null; },
    export(uid) {
      const r = store.data.oauth[uid];
      return r ? { baglandi: r.at || null, kapsam: r.scope || null, sunucular: r.gids || [] } : null; // anahtarlar asla dışarı verilmez
    },
    erase: async (uid) => { const had = ctx.oauth ? ctx.oauth.has(uid) : false; if (had) await ctx.oauth.remove(uid); return had ? 1 : 0; },
  });

  api.provider('olayKayitlari', {
    title: 'Güvenlik olay günlüğü',
    describe: 'Sunucudaki yönetim olayları (kanal/rol değişikliği, ban/kick, bot ekleme…) kullanıcı ID\'leriyle birlikte tutulur; güvenlik incelemesi içindir. Saklama süresi dolunca otomatik silinir. Silme isteğinde kimliğin kayıtlarda takma adla değiştirilir.',
  });

  api.provider('moderasyon', {
    title: 'Moderasyon vakaları',
    describe: 'Uyarı, susturma, atma, yasaklama kayıtları (vaka no, sebep, yetkili, tarih). Hesap verebilirlik için saklama süresi (varsayılan 365 gün) dolana kadar tutulur ve silme isteğiyle kaldırılmaz.',
    summary(uid) {
      let n = 0;
      for (const list of Object.values(store.data.cases)) if (Array.isArray(list)) n += list.filter((c) => c.uid === uid).length;
      return n ? `${n} moderasyon vakası` : null;
    },
    export(uid) {
      const out = [];
      for (const [gid, list] of Object.entries(store.data.cases)) {
        if (!Array.isArray(list)) continue;
        for (const c of list) if (c.uid === uid) out.push({ sunucu: gid, vaka: c.n, tur: c.type, sebep: c.reason, tarih: new Date(c.at).toISOString() });
      }
      return out.length ? out : null;
    },
  });

  api.provider('guvenlikKayitlari', {
    title: 'Güvenlik soruşturma kayıtları',
    describe: 'Risk puanı, izleme listesi ve ihbar kayıtları yalnızca şüpheli davranış (ör. kötü amaçlı dosya) görüldüğünde oluşur; mesaj içeriği değil, kanıt özeti (hash, bağlantı) tutulur. Bu kayıtlara yalnızca güvenilir yetkililer erişir ve her erişim denetim kaydına yazılır.',
  });

  /* ---------------------------------------------------------------- komutlar */
  const gcfgOf = (i) => (i.guildId ? ctx.gcfg(i.guildId) : null);

  ctx.router.add(
    new SlashCommandBuilder().setName('privacy').setDescription('Hangi verilerin neden saklandığını ve haklarını öğren').setContexts(InteractionContextType.Guild),
    async (i) => {
      const pv = gcfgOf(i).privacy;
      const e = ui.embed('info', '🔒 Gizlilik ve veri koruma', [
        'Kalkan sunucuyu **korumak** için çalışır; kimseyi gizlice izlemez. Mesaj içerikleri arşivlenmez. Aşağıda neyin saklandığı ve nedeni yazıyor.',
      ].join('\n'));
      for (const [, p] of providers) e.addFields({ name: p.title, value: truncate(p.describe, 1000) });
      e.addFields(
        { name: 'Saklama süreleri', value: `Olay günlüğü: ${pv.eventDays} gün • Moderasyon vakası: ${pv.caseDays} gün • Yetkili erişim kaydı: ${pv.accessDays} gün • Ticket: ${pv.ticketDays} gün. Süresi dolanlar otomatik silinir.` },
        { name: 'Verilerine kim erişebilir?', value: 'Yalnızca yetkililer, güvenlik/moderasyon amacıyla. Kişisel veriye her bakış **erişim kaydına** yazılır (yöneticiler `/erisim-kaydi` ile denetleyebilir).' },
        { name: 'Haklarını kullan', value: '`/verilerim` — neler saklanıyor\n`/veri-indir` — hepsini JSON olarak indir\n`/verilerimi-sil` — silinebilenleri sil\n`/izin-ver` • `/izni-iptal` — kurtarma bildirimi izni\nKalkan senden **Discord şifreni ya da kullanıcı tokenını asla istemez.**' },
      );
      return respond(i, { embeds: [e] });
    },
  );

  ctx.router.add(
    new SlashCommandBuilder().setName('verilerim').setDescription('Bende senin hakkında neler saklanıyor?').setContexts(InteractionContextType.Guild),
    async (i) => {
      const lines = [];
      for (const [, p] of providers) {
        if (!p.summary) continue;
        const s = p.summary(i.user.id);
        if (s) lines.push(`• **${p.title}:** ${s}`);
      }
      const e = ui.embed('info', '📂 Senin verilerin', lines.length ? lines.join('\n') : 'Bende senin adına kayıtlı bir veri görünmüyor.');
      e.addFields({ name: 'Devamı', value: '`/veri-indir` hepsini dosya olarak verir. `/verilerimi-sil` silinebilenleri siler.' });
      return respond(i, { embeds: [e] });
    },
  );

  ctx.router.add(
    new SlashCommandBuilder().setName('veri-indir').setDescription('Hakkında saklanan verileri JSON dosyası olarak indir').setContexts(InteractionContextType.Guild),
    async (i) => {
      const data = api.exportUser(i.user.id);
      const file = new AttachmentBuilder(Buffer.from(JSON.stringify(data, null, 2), 'utf8'), { name: `kalkan-verilerim-${i.user.id}.json` });
      return respond(i, { content: '📥 Verilerin ekte. Erişim anahtarların (token) güvenlik için dökümde yer almaz.', files: [file] });
    },
  );

  ctx.router.add(
    new SlashCommandBuilder().setName('verilerimi-sil').setDescription('Bende saklanan verilerini sil (onay ister)').setContexts(InteractionContextType.Guild),
    async (i) => ui.confirm(ctx, i, {
      text: [
        '⚠️ **Verilerini silmek üzeresin.** Silinecekler: üye kaydın, kurtarma bildirimi iznin, hesap bağlantın (Discord tarafında da iptal edilir), topluluk verilerin (seviye, doğum günü vb.) ve olay günlüklerindeki kimliğin (takma adla değişir).',
        'Silinmeyecekler: moderasyon vakaları (saklama süresi dolana kadar) ve açık güvenlik soruşturması varsa ilgili kayıtlar.',
        'Devam edilsin mi?',
      ].join('\n'),
      yes: 'Evet, sil',
      onYes: async (b) => {
        await b.deferUpdate();
        const r = await api.eraseUser(i.user.id);
        const parts = Object.entries(r).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
        return b.editReply({ content: `✅ Silindi.${parts.length ? `\n${parts.map((x) => `• ${x}`).join('\n')}` : '\nSilinecek kayıt bulunamadı.'}`, components: [] });
      },
    }),
  );

  ctx.router.add(
    new SlashCommandBuilder().setName('izin-ver').setDescription('Sunucu kaybolursa yedek sunucu duyurusunu DM ile almayı kabul et (isteğe bağlı)').setContexts(InteractionContextType.Guild),
    async (i) => {
      api.consentGrant(i.guildId, i.user.id, 'komut');
      return respond(i, ctx.t(i.guildId, 'priv.consentOn'));
    },
  );

  ctx.router.add(
    new SlashCommandBuilder().setName('izni-iptal').setDescription('Verdiğin kurtarma bildirimi iznini ve hesap bağlantını geri çek').setContexts(InteractionContextType.Guild),
    async (i) => {
      const n = api.consentRevoke(i.user.id);
      const had = ctx.oauth && ctx.oauth.has(i.user.id);
      if (had) await ctx.oauth.remove(i.user.id);
      return respond(i, `${ctx.t(i.guildId, 'priv.consentOff')}${had ? '\n🔌 Hesap bağlantın da kaldırıldı (Discord tarafında iptal edildi).' : ''}${!n && !had ? '\nZaten kayıtlı bir iznin yoktu.' : ''}`);
    },
  );

  ctx.router.add(
    new SlashCommandBuilder().setName('erisim-kaydi').setDescription('Yetkililerin kişisel verilere erişim kayıtları (denetim)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setContexts(InteractionContextType.Guild)
      .addUserOption((o) => o.setName('kisi').setDescription('Yalnızca bu kişiye bakılan kayıtlar')),
    async (i) => {
      const target = i.options.getUser('kisi');
      api.logAccess(i.guildId, i.user.id, 'erisim-kaydi', target ? target.id : null, 'erişim kaydı görüntülendi');
      const rows = api.accessLog(i.guildId, { target: target ? target.id : null, limit: 200 });
      const lines = rows.map((a) => `${unixFull(a.t)} • <@${a.by}> → ${a.target ? `<@${a.target}>` : '—'} • \`${a.kind}\`${a.note ? ` • ${truncate(a.note, 60)}` : ''}`);
      return ui.paginate(ctx, i, ui.pagesFromLines(lines, { title: '🕵️ Veri erişim kayıtları', perPage: 8, empty: 'Kayıt yok.' }));
    },
    { access: 'trusted' },
  );

  // Herhangi bir panelden kullanılabilen gönüllü kayıt düğmeleri.
  ctx.router.button('priv:', async (i) => {
    const act = i.customId.split(':')[1];
    if (!i.guildId) return;
    if (act === 'optin') { api.consentGrant(i.guildId, i.user.id, 'buton'); return respond(i, ctx.t(i.guildId, 'priv.consentOn')); }
    if (act === 'optout') { api.consentRevoke(i.user.id); return respond(i, ctx.t(i.guildId, 'priv.consentOff')); }
  });

  // Sunucudan ayrılan üyenin izni de geçersiz sayılır (audience zaten 'left' olanları dışlar); kayıt kalırsa geri dönüşte yeniden geçerli olur.
}

module.exports = { name: 'privacy', init };
