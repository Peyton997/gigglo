'use strict';
// /modkontrol: dosyayı ÇALIŞTIRMADAN hash'ler, Modrinth + VirusTotal'e sorar, jar içini statik tarar.
const { SlashCommandBuilder, EmbedBuilder, InteractionContextType, MessageFlags } = require('discord.js');
const AdmZip = require('adm-zip');
const L = require('./links');
const { sha256, sha1 } = require('../crypto');
const { downloadLimited, truncate, code, respond } = require('../util');
const { JAR_INDICATORS, LOADER_FILES, EMBEDDED_EXEC_RE } = require('../data/patterns');
const { vtLookup, CDN_HOSTS } = require('./files');

const MAX_BYTES = 25 * 1024 * 1024;
const UA = { 'User-Agent': 'kalkan-bot/1.0 (discord security bot)' };

// Statik tarama: yalnızca dosya adları ve ham bayt içinde metin arar; hiçbir şey çalıştırılmaz.
function scanJar(buf) {
  const out = { isZip: false, entries: 0, loaders: [], embedded: [], indicators: [], score: 0, notes: [] };
  let zip;
  try { zip = new AdmZip(buf); } catch { out.notes.push('ZIP/JAR olarak açılamadı'); return out; }
  out.isZip = true;
  let entries;
  try { entries = zip.getEntries(); } catch { out.notes.push('Arşiv okunamadı'); return out; }
  out.entries = entries.length;
  if (entries.length > 20000) { out.notes.push('Çok fazla dosya içeriyor, tarama atlandı'); out.score += 2; return out; }

  const names = entries.map((e) => e.entryName);
  out.loaders = LOADER_FILES.filter((f) => names.includes(f));
  if (!out.loaders.length) { out.score += 1; out.notes.push('Bilinen bir mod/plugin tanım dosyası yok'); }
  out.embedded = names.filter((n) => EMBEDDED_EXEC_RE.test(n)).slice(0, 10);
  if (out.embedded.length) out.score += 4;

  const found = new Map();
  let total = 0;
  for (const e of entries) {
    if (e.isDirectory) continue;
    if (!/\.(class|json|yml|toml|properties|txt|xml|cfg)$/i.test(e.entryName)) continue;
    const size = e.header.size;
    if (size > 5 * 1024 * 1024) continue;
    if (e.header.compressedSize > 0 && size / e.header.compressedSize > 300) { out.notes.push('Aşırı sıkıştırılmış bir dosya atlandı'); continue; }
    total += size;
    if (total > 60 * 1024 * 1024) { out.notes.push('Tarama boyut sınırında durdu'); break; }
    let data;
    try { data = e.getData(); } catch { continue; }
    for (const ind of JAR_INDICATORS) {
      if (!found.has(ind.name) && data.includes(ind.needle)) found.set(ind.name, ind);
    }
  }
  for (const ind of found.values()) { out.indicators.push(ind.name); out.score += ind.w; }
  return out;
}

const verdict = (score) => (score >= 6 ? { label: 'YÜKSEK RİSK', color: 0xe74c3c } : score >= 3 ? { label: 'ORTA RİSK', color: 0xe67e22 } : { label: 'Düşük belirti', color: 0x2ecc71 });

async function modrinthLookup(sha1hex) {
  try {
    const res = await fetch(`https://api.modrinth.com/v2/version_file/${sha1hex}?algorithm=sha1`, { headers: UA, signal: AbortSignal.timeout(8000) });
    if (res.status === 404) return { found: false };
    if (!res.ok) return null;
    const v = await res.json();
    let title = v.project_id;
    let downloads = null;
    try {
      const pr = await fetch(`https://api.modrinth.com/v2/project/${v.project_id}`, { headers: UA, signal: AbortSignal.timeout(8000) });
      if (pr.ok) { const p = await pr.json(); title = p.title || title; downloads = p.downloads; }
    } catch { /* proje adı alınamadı */ }
    return { found: true, project: title, version: v.version_number, downloads, url: `https://modrinth.com/project/${v.project_id}` };
  } catch {
    return null;
  }
}

async function vtUrlLookup(env, url) {
  if (!env.vtKey) return null;
  try {
    const id = Buffer.from(url).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const res = await fetch(`https://www.virustotal.com/api/v3/urls/${id}`, { headers: { 'x-apikey': env.vtKey }, signal: AbortSignal.timeout(10000) });
    if (res.status === 404) return { found: false };
    if (!res.ok) return null;
    const j = await res.json();
    const s = j.data?.attributes?.last_analysis_stats || {};
    return { found: true, malicious: s.malicious || 0, suspicious: s.suspicious || 0 };
  } catch {
    return null;
  }
}

function init(ctx) {
  const last = new Map();
  const tooFast = (uid) => {
    const now = Date.now();
    if (now - (last.get(uid) || 0) < 10000) return true;
    last.set(uid, now);
    return false;
  };

  ctx.router.add(
    new SlashCommandBuilder()
      .setName('modkontrol')
      .setDescription('Mod/plugin dosyasını çalıştırmadan güvenlik kontrolünden geçir')
      .addAttachmentOption((o) => o.setName('dosya').setDescription('Kontrol edilecek .jar / .zip dosyası').setRequired(true))
      .setContexts(InteractionContextType.Guild),
    async (i) => {
      if (tooFast(i.user.id)) return respond(i, '⏳ Lütfen birkaç saniye bekleyip tekrar dene.');
      const att = i.options.getAttachment('dosya', true);
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      if (att.size > MAX_BYTES) return respond(i, '❌ Dosya çok büyük (en fazla 25 MB).');
      let buf;
      try { buf = await downloadLimited(att.url, MAX_BYTES, { allowHosts: CDN_HOSTS }); } catch (e) { return respond(i, `❌ Dosya indirilemedi: ${e.message}`); }

      const h256 = sha256(buf);
      const h1 = sha1(buf);
      const [mr, vt] = await Promise.all([modrinthLookup(h1), vtLookup(ctx.env, h256)]);
      const scan = scanJar(buf);
      let score = scan.score;
      const notes = [];
      if (mr && mr.found) { notes.push('Modrinth\'te kayıtlı resmi dosya ile birebir aynı'); score = Math.max(0, score - 3); }
      else if (mr && !mr.found) { notes.push('Modrinth\'te kayıtlı DEĞİL'); score += 1; }
      if (vt && vt.found && (vt.malicious >= 3)) { score += 8; notes.push(`VirusTotal: ${vt.malicious} motor zararlı buldu`); }
      else if (vt && vt.found && vt.malicious + vt.suspicious > 0) { score += 3; }
      const known = ctx.blocklist && ctx.blocklist.hasHash(h256);
      if (known) { score += 10; notes.push(`Bu dosyanın hash'i kara listede (${known.reason || 'neden yok'})`); }
      const v = verdict(score);

      const embed = new EmbedBuilder()
        .setColor(v.color)
        .setTitle(`🔎 Dosya kontrolü: ${v.label}`)
        .setDescription(`**${truncate(att.name, 100)}** — ${(att.size / 1024).toFixed(1)} KB`)
        .addFields(
          { name: 'SHA-256', value: code(h256) },
          { name: 'Modrinth', value: mr == null ? 'Sorgulanamadı' : mr.found ? `✅ ${mr.project} ${mr.version || ''}\n${mr.url}` : '❌ Kayıtlı değil (resmi kaynaktan indirilmemiş olabilir)', inline: false },
          { name: 'VirusTotal', value: !ctx.env.vtKey ? 'API anahtarı tanımlı değil' : vt == null ? 'Sorgulanamadı' : vt.found ? `${vt.malicious} zararlı / ${vt.suspicious} şüpheli\nhttps://www.virustotal.com/gui/file/${h256}` : 'Kayıt yok (dosya hiç taranmamış)', inline: false },
          {
            name: 'Statik tarama',
            value: scan.isZip
              ? truncate([
                `Dosya sayısı: ${scan.entries}`,
                `Tanım dosyası: ${scan.loaders.length ? scan.loaders.join(', ') : 'yok'}`,
                scan.embedded.length ? `⚠️ İçinde çalıştırılabilir dosya: ${scan.embedded.join(', ')}` : null,
                scan.indicators.length ? `⚠️ Göstergeler:\n${scan.indicators.map((x) => `• ${x}`).join('\n')}` : 'Bilinen zararlı göstergesi bulunmadı',
                ...scan.notes.map((n) => `ℹ️ ${n}`),
              ].filter(Boolean).join('\n'), 1000)
              : `ZIP/JAR değil. ${scan.notes.join(' ')}`,
          },
        )
        .setFooter({ text: '“Düşük belirti” güvenli demek DEĞİLDİR. Emin değilsen çalıştırma; resmi kaynaktan (Modrinth/CurseForge) indir.' });
      if (notes.length) embed.addFields({ name: 'Notlar', value: notes.map((n) => `• ${n}`).join('\n') });
      return respond(i, { embeds: [embed] });
    },
  );

  ctx.router.add(
    new SlashCommandBuilder()
      .setName('linkkontrol')
      .setDescription('Bir bağlantıyı AÇMADAN kontrol et')
      .addStringOption((o) => o.setName('url').setDescription('Kontrol edilecek bağlantı').setRequired(true).setMaxLength(500))
      .setContexts(InteractionContextType.Guild),
    async (i) => {
      if (tooFast(i.user.id)) return respond(i, '⏳ Lütfen birkaç saniye bekleyip tekrar dene.');
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const info = L.parse(i.options.getString('url', true));
      if (!info) return respond(i, '❌ Geçerli bir bağlantı değil.');
      const cfg = ctx.gcfg(i.guildId);
      const opts = {
        allowDomains: cfg.automod.links.allowDomains, blockInvites: cfg.automod.links.blockInvites,
        allowInviteCodes: cfg.automod.links.allowInviteCodes, scamHosts: cfg.automod.links.scamHosts, scamSet: ctx.scamSet || null,
        blockedExt: new Set(cfg.files.blockedExt),
      };
      let c = L.classify(info, opts);
      let final = null;
      if (c.action === 'resolve') {
        final = await L.resolveShortener(info.url);
        const fi = final ? L.parse(final) : null;
        c = fi ? L.classify(fi, opts) : { action: 'block', type: 'shortener', detail: 'Kısaltılmış bağlantı çözülemedi' };
      }
      const vt = await vtUrlLookup(ctx.env, final || info.url);
      const ok = c.action === 'allow';
      const embed = new EmbedBuilder()
        .setColor(ok ? 0x2ecc71 : 0xe74c3c)
        .setTitle(ok ? '✅ Bu sunucuda izinli bağlantı türü' : '🚫 Bu sunucuda engellenecek bağlantı')
        .addFields(
          { name: 'Alan adı', value: code(info.hostBare) },
          { name: 'Tür', value: `${c.type}${c.detail ? ` — ${c.detail}` : ''}` },
        );
      if (final) embed.addFields({ name: 'Kısaltılmış bağlantının hedefi', value: code(truncate(final, 200).replace(/^http/, 'hxxp')) });
      if (vt) embed.addFields({ name: 'VirusTotal', value: vt.found ? `${vt.malicious} zararlı / ${vt.suspicious} şüpheli` : 'Kayıt yok' });
      embed.setFooter({ text: 'Bağlantı açılmadı. “İzinli” = sunucu kuralına uygun; güvenli olduğunu garanti etmez.' });
      return respond(i, { embeds: [embed] });
    },
  );
}

module.exports = { name: 'modcheck', init, scanJar, modrinthLookup, verdict };
