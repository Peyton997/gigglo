'use strict';
// Telefonda (Termux) yerel derleme gerektirmesin diye düz JSON dosyası + atomik yazma.
// Yazma: geçici dosyaya yaz → fsync → .bak dosyalarını döndür → rename. Elektrik/pil kesintisinde yarım dosya kalmaz.
const fs = require('fs');
const path = require('path');

const SECTIONS = [
  'guilds', 'members', 'watch', 'reports', 'oauth', 'jit', 'timelock',
  'blocklist', 'quiz', 'stats', 'meta', 'backupsMeta',
  // v1.1
  'consent', 'cases', 'sched', 'access', 'tickets', 'polls', 'events', 'community', 'suggest',
];

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    this.data = {};
    this._timer = null;
    this._retry = null;
    this._dirty = false;
    this._lastBak = 0;
    // 'new' = ilk kurulum, 'ok' = normal, 'recovered' = .bak'tan açıldı, 'reset' = okunamadı, boş başladı
    this.loadStatus = 'new';
    this.lastError = null;
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tryRead = (f) => {
      try {
        const v = JSON.parse(fs.readFileSync(f, 'utf8'));
        return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
      } catch { return null; }
    };
    let d = {};
    if (fs.existsSync(this.file)) {
      d = tryRead(this.file);
      if (d !== null) this.loadStatus = 'ok';
      else {
        try { fs.copyFileSync(this.file, path.join(this.dir, `db.corrupt-${Date.now()}.json`)); } catch { /* yoksay */ }
        d = tryRead(`${this.file}.bak`) || tryRead(`${this.file}.bak2`);
        this.loadStatus = d ? 'recovered' : 'reset';
        d = d || {};
      }
    }
    this.data = d;
    for (const k of SECTIONS) if (!this.data[k] || typeof this.data[k] !== 'object') this.data[k] = {};
    return this;
  }

  save() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.flush(); }, 1500);
    if (this._timer.unref) this._timer.unref();
  }

  flush() {
    if (!this._dirty) return;
    this._dirty = false;
    const tmp = `${this.file}.tmp`;
    let fd = null;
    try {
      const json = JSON.stringify(this.data);
      fd = fs.openSync(tmp, 'w');
      fs.writeSync(fd, json);
      fs.fsyncSync(fd); // veri gerçekten diske inmeden rename yapma (güç kesintisinde boş dosya kalmasın)
      fs.closeSync(fd);
      fd = null;
      if (Date.now() - this._lastBak > 3600e3 && fs.existsSync(this.file)) {
        try { if (fs.existsSync(`${this.file}.bak`)) fs.copyFileSync(`${this.file}.bak`, `${this.file}.bak2`); } catch { /* yoksay */ }
        fs.copyFileSync(this.file, `${this.file}.bak`);
        this._lastBak = Date.now();
      }
      fs.renameSync(tmp, this.file);
      this.lastError = null;
    } catch (e) {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* yoksay */ } }
      this._dirty = true;
      this.lastError = e.message;
      console.error('[store] yazma hatası:', e.message);
      // Başka save() çağrısı gelmeyebilir (disk dolu vb.): kendiliğinden yeniden dene.
      if (!this._retry) {
        this._retry = setTimeout(() => { this._retry = null; this.flush(); }, 15000);
        if (this._retry.unref) this._retry.unref();
      }
    }
  }
}

module.exports = { Store, SECTIONS };
