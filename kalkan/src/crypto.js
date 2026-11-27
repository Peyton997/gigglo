'use strict';
// AES-256-GCM ile token/yedek şifreleme (Node'un yerleşik crypto modülü; kendi algoritmamız yok).
//
// Anahtar kaynağı (öncelik sırasıyla): DATA_KEY (parola ya da 64 hex karakter) → data/.key dosyası → otomatik üretilen anahtar.
// Parola scrypt ile türetilir (hızlı bir SHA-256 değil: çalınan yedekte parola denemesi pahalı olsun).
// Anahtar rotasyonu: eski anahtar(lar) DATA_KEY_OLD içinde durur (yalnızca çözmek için); şifreleme hep güncel anahtarla yapılır.
//
// Biçim (v2): "KLK2" | anahtar kimliği (4 bayt) | IV (12) | etiket (16) | şifreli veri. Başlık GCM'e ek doğrulanan veri (AAD) olarak bağlanır.
// Eski biçim (v1: IV | etiket | veri) hâlâ çözülür; böylece güncelleme mevcut verileri bozmaz.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAGIC = Buffer.from('KLK2');
const HEADER = MAGIC.length + 4;
const MIN_PASSPHRASE = 12;

let KEYS = []; // [{ id: Buffer(4), key: Buffer(32) }]; ilk eleman güncel anahtar, diğerleri yalnızca çözme içindir

class DecryptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DecryptError';
    this.code = code; // KEY_MISSING | BAD_DATA | NOT_READY
  }
}

const idOf = (key) => crypto.createHash('sha256').update(key).digest().subarray(0, 4);
const HEX64 = /^[0-9a-f]{64}$/i;

// Bir DATA_KEY değerinden aday anahtarları üretir. [güncel, ...eski v1 türetmesi]
function candidatesFrom(secret) {
  const s = String(secret || '').trim();
  if (!s) return [];
  if (HEX64.test(s)) return [Buffer.from(s, 'hex')];
  if (s.length < MIN_PASSPHRASE) throw new Error(`DATA_KEY en az ${MIN_PASSPHRASE} karakter olmalı (ya da 64 haneli hex anahtar). Rastgele üret: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`);
  return [
    crypto.scryptSync(s, 'kalkan.v2.data-key', 32, { N: 16384, r: 8, p: 1 }),
    crypto.createHash('sha256').update(s).digest(), // v1 uyumluluğu: yalnızca çözmek için
  ];
}

function add(list, key) {
  if (key.length !== 32) throw new Error('Şifreleme anahtarı 32 bayt olmalı');
  if (!list.some((k) => k.key.equals(key))) list.push({ id: idOf(key), key });
}

function initKey(env) {
  const list = [];
  let source;
  if (env.dataKey) {
    const [current, ...legacy] = candidatesFrom(env.dataKey);
    add(list, current);
    for (const k of legacy) add(list, k);
    source = 'env';
  } else {
    fs.mkdirSync(env.dataDir, { recursive: true });
    const f = path.join(env.dataDir, '.key');
    if (fs.existsSync(f)) {
      const k = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
      if (k.length !== 32) throw new Error('data/.key bozuk (64 hex karakter / 32 bayt olmalı)');
      add(list, k);
      source = 'file';
    } else {
      add(list, crypto.randomBytes(32));
      fs.writeFileSync(f, list[0].key.toString('hex'), { mode: 0o600 });
      source = 'generated';
    }
  }
  for (const old of String(env.dataKeyOld || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    for (const k of candidatesFrom(old)) add(list, k);
  }
  KEYS = list;
  return source;
}

function needKey() {
  if (!KEYS.length) throw new DecryptError('NOT_READY', 'Şifreleme anahtarı başlatılmadı (initKey)');
}

function encryptBuffer(buf) {
  needKey();
  const { id, key } = KEYS[0];
  const iv = crypto.randomBytes(12);
  const header = Buffer.concat([MAGIC, id]);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(header);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([header, iv, c.getAuthTag(), enc]);
}

function openV2(key, data) {
  const iv = data.subarray(HEADER, HEADER + 12);
  const tag = data.subarray(HEADER + 12, HEADER + 28);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(data.subarray(0, HEADER));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data.subarray(HEADER + 28)), d.final()]);
}

function openV1(key, data) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  d.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([d.update(data.subarray(28)), d.final()]);
}

function decryptBuffer(data) {
  needKey();
  if (!Buffer.isBuffer(data)) data = Buffer.from(data);
  if (data.length < 28) throw new DecryptError('BAD_DATA', 'Şifreli veri bozuk (çok kısa)');
  if (data.length >= HEADER + 28 && data.subarray(0, 4).equals(MAGIC)) {
    const id = data.subarray(4, HEADER);
    const k = KEYS.find((x) => x.id.equals(id));
    if (k) {
      try { return openV2(k.key, data); } catch { throw new DecryptError('BAD_DATA', 'Veri bozulmuş ya da değiştirilmiş (GCM doğrulaması başarısız)'); }
    }
    // Eski biçimli bir veri tesadüfen "KLK2" ile başlıyor olabilir (≈ 2^-32); aşağıda denenir.
  }
  for (const { key } of KEYS) {
    try { return openV1(key, data); } catch { /* sıradaki anahtar */ }
  }
  throw new DecryptError('KEY_MISSING', 'Bu veri başka bir anahtarla şifrelenmiş. Doğru DATA_KEY / data/.key gerekli (eski anahtarı DATA_KEY_OLD içine yaz).');
}

const encrypt = (text) => encryptBuffer(Buffer.from(String(text), 'utf8')).toString('base64');
const decrypt = (b64) => decryptBuffer(Buffer.from(String(b64), 'base64')).toString('utf8');

// Veriyi güncel anahtarla yeniden şifreler (rotasyon aracı için).
const rewrap = (buf) => encryptBuffer(decryptBuffer(buf));
const rewrapText = (b64) => encrypt(decrypt(b64));
// Veri zaten güncel anahtarla mı şifreli?
function isCurrent(data) {
  needKey();
  return data.length >= HEADER + 28 && data.subarray(0, HEADER).equals(Buffer.concat([MAGIC, KEYS[0].id]));
}

function hmac(data) {
  needKey();
  return crypto.createHmac('sha256', KEYS[0].key).update(String(data)).digest('hex');
}

// Anahtarın kendisini değil, yalnızca kısa parmak izini gösterir (hangi anahtarın yüklü olduğunu anlamak için).
const fingerprint = () => (KEYS.length ? KEYS[0].id.toString('hex') : null);
const keyCount = () => KEYS.length;

const randomId = (n = 8) => crypto.randomBytes(n).toString('hex');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

module.exports = {
  initKey, encrypt, decrypt, encryptBuffer, decryptBuffer, rewrap, rewrapText, isCurrent, hmac,
  fingerprint, keyCount, DecryptError, randomId, sha256, sha1, MIN_PASSPHRASE,
};
