'use strict';
// Küfür kalıpları. Varyantlar:
//   r = ham küçük harf (aksan korunur)         f = aksanlar katlanmış, ı korunur
//   c = f + tekrar eden harfler tek harfe inmiş   (siiiktir -> siktir)
// l: 1 = güçlü (hafif filtre dahil), 2 = orta, 3 = hafif hakaret (yalnızca sert filtre)
// Sunucuya özel kelimeler /ayar kufur ekle ile eklenir.

const P = (v, l, src, mode = 'tail') => ({
  v,
  l,
  re: new RegExp(mode === 'tail' ? `^(?:${src})\\p{L}*$` : mode === 'exact' ? `^(?:${src})$` : `(?:${src})`, 'u'),
});

const PATTERNS = [
  // --- Türkçe / Azerbaycan Türkçesi, güçlü ---
  P('c', 1, 'or[uo]?s[pb]u'),
  P('c', 1, 'amk|aq|amq', 'exact'),
  P('c', 1, 'amc[iı]k'),
  P('c', 1, 'sik(?:tir|dir|eyim|erim|ecem|ecegim|ik|im)'),
  P('c', 1, 'yarak'),
  P('c', 1, 'pezevenk'),
  P('c', 1, 'gavat'),
  P('c', 1, 'kahpe'),
  P('c', 1, 'ibne'),
  P('c', 1, 'yavsak'),
  P('c', 1, 'amin[ai]ko'),
  P('c', 1, 'q[ae]hb[ae]'),
  P('c', 1, 'peys[ae]r'),
  P('c', 1, 'qanc[iı]q'),
  P('c', 1, 'amc[iı]q'),
  P('r', 1, 'puşt'),
  P('r', 1, 'piç'),
  P('r', 1, 'amına'),
  // --- İngilizce, güçlü ---
  P('c', 1, 'fuck', 'contains'),
  P('c', 1, 'shit(?:s|ty|head|face)?', 'exact'),
  P('c', 1, 'bitch'),
  P('c', 1, 'cunt'),
  P('c', 1, 'ashole'),
  P('c', 1, 'fagot'),
  P('r', 1, 'nigg(?:a|er)s?', 'exact'),
  // --- orta ---
  P('r', 2, 'göt(?:ü|ün|ünü|ten|lek|veren|oş|oşu)?', 'exact'),
  P('c', 2, 'serefsiz'),
  P('c', 2, 'haysiyetsiz'),
  P('c', 2, 'ahlaksiz'),
  P('c', 2, 'gerizekal[iı]'),
  P('c', 2, 'dangalak'),
  P('c', 2, 'embesil'),
  // --- hafif hakaretler (sert filtre) ---
  P('c', 3, 'salak|aptal|ahmak|budala|gerzek|moron|idiot|stupid|dumbass'),
];

// Masum ama yanlış alarm verebilecek kelimeler (token eşleşmesi).
const BUILTIN_ALLOW = [
  'sikke', 'sikkeler', 'amca', 'amcam', 'amcalar', 'amir', 'amiral', 'analiz', 'assassin',
  'shiitake', 'shitake', 'pic', 'classic', 'klasik', 'sikkim',
];

module.exports = { PATTERNS, BUILTIN_ALLOW };
