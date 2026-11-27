'use strict';
// Türkçe (varsayılan) metin kataloğu. Anahtarlar: kategori.ad
module.exports = {
  // --- ortak hatalar
  'err.generic': '⚠️ Bir hata oluştu (kod: `{id}`). Lütfen biraz sonra tekrar dene; sürerse yetkililere bu kodu ilet.',
  'err.noPerm': '🔒 Bu komutu kullanma yetkin yok.',
  'err.needTrusted': '🔒 Bu komut yalnızca güvenilir kişiler içindir.',
  'err.needOwner': '🔒 Bu komut yalnızca bot sahipleri içindir.',
  'err.guildOnly': 'ℹ️ Bu komut yalnızca sunucu içinde kullanılabilir.',
  'err.botPerm': '❌ Botun şu izni eksik: **{perm}**. Sunucu Ayarları → Roller bölümünden botun rolüne bu izni ver.',
  'err.hierarchy': '❌ Bu işlem yapılamadı: hedef kişi sende ya da botta olandan yüksek/eşit bir role sahip. Botun rolünü hedefin rolünün üstüne taşı.',
  'err.self': '❌ Bu işlemi kendine uygulayamazsın.',
  'err.targetOwner': '❌ Sunucu sahibine bu işlem uygulanamaz.',
  'err.targetBot': '❌ Bu işlem botun kendisine uygulanamaz.',
  'err.notFound': '❌ Bulunamadı.',
  'err.expired': '⌛ Bu etkileşimin süresi doldu. Komutu yeniden çalıştır.',
  'err.notYours': '🔒 Bu düğme/menü sana ait değil.',
  'err.disabled': 'ℹ️ Bu özellik bu sunucuda kapalı. Yöneticiler `/ayar modul` ile açabilir.',
  'err.panicGate': '🛑 Panik modu açık: bu işlem şu an yalnızca bot sahipleri tarafından yapılabilir.',
  // --- ortak başarı / bilgi
  'ok.done': '✅ Tamam.',
  'info.working': '⏳ Çalışıyorum…',
  'info.noData': 'Gösterilecek kayıt yok.',
  // --- moderasyon
  'mod.case': 'Vaka #{n}',
  'mod.noReason': 'Sebep belirtilmedi',
  'mod.dmFail': 'Kullanıcıya DM gönderilemedi (DM\'leri kapalı olabilir).',
  // --- gizlilik
  'priv.consentOn': '✅ Kaydın alındı. Sunucuya erişim kaybolursa sana yedek sunucu duyurusunu DM ile göndereceğim. İstediğin an `/izni-iptal` ile vazgeçebilirsin.',
  'priv.consentOff': '✅ İznin geri çekildi. Sana artık kurtarma duyurusu DM\'i gönderilmeyecek.',
};
