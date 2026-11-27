'use strict';
// Yüklenecek modüllerin TEK listesi (index.js ve tools/check.js bunu kullanır). Sıra önemlidir:
// bir modül yalnızca kendinden ÖNCE yüklenen modüllerin ctx üyelerine (ctx.privacy, ctx.members …) başlangıçta erişebilir.
module.exports = [
  'members', 'privacy', 'risk', 'automod', 'modcheck', 'honeypot', 'antinuke', 'panic', 'raid',
  'backup', 'oauth', 'recovery', 'jit', 'watchlist', 'blocklist', 'incident', 'status', 'quiz', 'settings',
];
