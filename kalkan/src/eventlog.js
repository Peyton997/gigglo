'use strict';
// Denetim günlüğü yedeği: olayları diske (NDJSON) yazar, istenirse ayrı bir webhook'a da yansıtır.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 8 * 1024 * 1024;

class EventLog {
  constructor(dataDir, { mirrorWebhook = '', botName = 'Kalkan', log = console } = {}) {
    this.dir = path.join(dataDir, 'events');
    fs.mkdirSync(this.dir, { recursive: true });
    this.mirrorWebhook = mirrorWebhook;
    this.botName = botName;
    this.log = log;
    this.buf = [];
    this.timer = null;
    if (mirrorWebhook) {
      this.timer = setInterval(() => this.flushMirror().catch(() => {}), 8000);
      if (this.timer.unref) this.timer.unref();
    }
  }

  // Dosya adı yalnızca güvenli karakterlerden oluşur (yol enjeksiyonuna karşı).
  file(gid) { return path.join(this.dir, `${String(gid).replace(/[^\w-]/g, '_').slice(0, 40) || 'x'}.ndjson`); }

  _files() {
    try { return fs.readdirSync(this.dir).filter((f) => /\.ndjson(\.1)?$/.test(f)).map((f) => path.join(this.dir, f)); } catch { return []; }
  }

  // Satırları süzerek dosyayı yeniden yazar (atomik). fn(satırNesnesi) → yeni nesne | null (sil) | aynısı.
  _rewrite(file, fn) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return 0; }
    const out = [];
    let changed = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { changed++; continue; }
      const r = fn(e);
      if (r === null) { changed++; continue; }
      if (r !== e) changed++;
      out.push(JSON.stringify(r));
    }
    if (!changed) return 0;
    if (!out.length) { try { fs.unlinkSync(file); } catch { /* yoksay */ } return changed; }
    fs.writeFileSync(`${file}.tmp`, out.join('\n') + '\n');
    fs.renameSync(`${file}.tmp`, file);
    return changed;
  }

  // Saklama süresi: belirtilen günden eski kayıtları siler. Silinen satır sayısını döndürür.
  purgeOlderThan(days) {
    const cutoff = Date.now() - days * 864e5;
    let n = 0;
    for (const f of this._files()) n += this._rewrite(f, (e) => (e.t < cutoff ? null : e));
    return n;
  }

  // /verilerimi-sil: kullanıcının kimliğini olay kayıtlarında takma adla değiştirir (olay yapısı bozulmaz, kişi tanınamaz).
  anonymizeUser(uid, alias) {
    const id = String(uid);
    let n = 0;
    for (const f of this._files()) {
      n += this._rewrite(f, (e) => {
        let hit = false;
        const c = { ...e };
        for (const k of ['actor', 'target']) if (c[k] === id) { c[k] = alias; hit = true; }
        for (const k of ['add', 'rem']) if (Array.isArray(c[k]) && c[k].includes(id)) { c[k] = c[k].map((x) => (x === id ? alias : x)); hit = true; }
        return hit ? c : e;
      });
    }
    return n;
  }


  append(gid, evt) {
    const e = { t: Date.now(), ...evt };
    try {
      const f = this.file(gid);
      fs.appendFileSync(f, JSON.stringify(e) + '\n');
      if (fs.statSync(f).size > MAX_BYTES) fs.renameSync(f, f + '.1');
    } catch (err) {
      this.log.warn?.('eventlog yazılamadı:', err.message);
    }
    if (this.mirrorWebhook) {
      const when = new Date(e.t).toISOString().slice(11, 19);
      this.buf.push(`[${when}] ${e.type || '?'} aktör=${e.actor || '-'} hedef=${e.target || '-'} ${e.name || ''}`.trim());
    }
    return e;
  }

  read(gid, { since = 0, until = Infinity, limit = 5000 } = {}) {
    const out = [];
    for (const f of [this.file(gid) + '.1', this.file(gid)]) {
      let text = '';
      try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const e = JSON.parse(line);
          if (e.t >= since && e.t <= until) out.push(e);
        } catch { /* bozuk satırı atla */ }
      }
    }
    return out.slice(-limit);
  }

  async flushMirror() {
    if (!this.mirrorWebhook || !this.buf.length) return;
    const lines = this.buf.splice(0, this.buf.length);
    let text = '';
    for (const l of lines) {
      if ((text + l).length > 1800) {
        await this._send(text);
        text = '';
      }
      text += l + '\n';
    }
    if (text) await this._send(text);
  }

  async _send(text) {
    try {
      await fetch(this.mirrorWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: this.botName, content: '```\n' + text + '```', allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(8000),
      });
    } catch { /* ağ hatası: sessizce geç */ }
  }
}

module.exports = { EventLog };
