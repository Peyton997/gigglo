'use strict';
// Ek dosya denetimi: tehlikeli uzantılar, çift uzantı, sağdan-sola karakter hilesi, karantina kaydı.
const { EmbedBuilder } = require('discord.js');
const { downloadLimited, truncate, code } = require('../util');
const { sha256 } = require('../crypto');

const BAD_CONTENT_TYPES = [
  'application/x-msdownload', 'application/x-dosexec', 'application/java-archive', 'application/x-msdos-program',
  'application/vnd.microsoft.portable-executable', 'application/x-sh', 'application/x-bat', 'application/x-msi',
];
const DOUBLE_EXT_RE = /\.(exe|scr|bat|cmd|com|pif|msi|jar|vbs|js|ps1)\.[a-z0-9]{2,4}$/i;
const RTL_RE = /[‪-‮⁦-⁩]/;
const CDN_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'];

function extOf(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

// Mesajdaki eklerden bulgu listesi üretir.
function inspect(message, cfg, { memberAgeHours = Infinity } = {}) {
  const out = [];
  const blocked = new Set(cfg.files.blockedExt);
  const warn = new Set(cfg.files.warnExt);
  for (const a of message.attachments.values()) {
    const name = a.name || '';
    const ext = extOf(name);
    const ct = String(a.contentType || '').toLowerCase().split(';')[0];
    let reason = null;
    if (RTL_RE.test(name)) reason = 'Dosya adında sağdan-sola karakter hilesi';
    else if (blocked.has(ext)) reason = `Engellenen dosya türü (.${ext})`;
    else if (DOUBLE_EXT_RE.test(name)) reason = 'Çift uzantı hilesi';
    else if (BAD_CONTENT_TYPES.includes(ct)) reason = `Tehlikeli içerik türü (${ct})`;
    if (reason) {
      out.push({
        rule: ext === 'jar' ? 'jar' : 'file', severity: 'high', del: true, points: 1,
        detail: reason, minStep: 'warn', file: { name, ext, size: a.size, url: a.url },
      });
    } else if (warn.has(ext) && memberAgeHours < cfg.files.newMemberArchiveHours) {
      out.push({
        rule: 'file', severity: 'low', del: true, points: 1,
        detail: `Yeni üyeden arşiv dosyası (.${ext})`, file: { name, ext, size: a.size, url: a.url },
      });
    }
  }
  return out;
}

async function vtLookup(env, hash) {
  if (!env.vtKey) return null;
  try {
    const res = await fetch(`https://www.virustotal.com/api/v3/files/${hash}`, {
      headers: { 'x-apikey': env.vtKey }, signal: AbortSignal.timeout(10000),
    });
    if (res.status === 404) return { found: false };
    if (!res.ok) return null;
    const j = await res.json();
    const s = j.data?.attributes?.last_analysis_stats || {};
    return { found: true, malicious: s.malicious || 0, suspicious: s.suspicious || 0, harmless: s.harmless || 0, undetected: s.undetected || 0 };
  } catch {
    return null;
  }
}

// Engellenen dosyayı çalıştırmadan indirir (yalnızca Discord CDN), hash'ler ve karantina kanalına yazar.
async function quarantine(ctx, message, findings) {
  const guild = message.guild;
  const cfg = ctx.gcfg(guild.id);
  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle('🧪 Dosya karantinaya alındı')
    .setDescription(`Gönderen: <@${message.author.id}> (${code(message.author.id)})\nKanal: <#${message.channelId}>`)
    .setTimestamp();
  for (const f of findings.slice(0, 5)) {
    let hash = null;
    let vt = null;
    if (cfg.files.hashBlocked && f.file.size && f.file.size <= 10 * 1024 * 1024) {
      try {
        const buf = await downloadLimited(f.file.url, 10 * 1024 * 1024, { allowHosts: CDN_HOSTS });
        hash = sha256(buf);
        vt = await vtLookup(ctx.env, hash);
        // VirusTotal'de birden çok motor zararlı buluyorsa aynı dosyayı bir daha hiçbir yerde kabul etme.
        if (vt && vt.found && vt.malicious >= 3 && ctx.blocklist) ctx.blocklist.addHash(hash, { reason: `VirusTotal ${vt.malicious} zararlı`, by: 'auto', file: truncate(f.file.name, 60) });
      } catch { /* indirilemedi */ }
    }
    let val = `Neden: ${f.detail}\nBoyut: ${f.file.size || '?'} bayt`;
    if (hash) val += `\nSHA-256: ${code(hash)}\n[VirusTotal](https://www.virustotal.com/gui/file/${hash})`;
    if (vt) val += vt.found ? `\nVT: ${vt.malicious} zararlı / ${vt.suspicious} şüpheli` : '\nVT: kayıt yok';
    embed.addFields({ name: truncate(f.file.name, 200) || 'dosya', value: truncate(val, 1000) });
  }
  await ctx.logEmbed(guild, embed, 'quarantine');
}

module.exports = { inspect, quarantine, vtLookup, extOf, CDN_HOSTS };
