'use strict';
// Güvenlik farkındalık sınavı: 6 rastgele soru, geçenlere rol verilir. Mod/dosya tuzaklarına karşı en etkili önlem: bilinç.
const crypto = require('crypto');
const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, InteractionContextType } = require('discord.js');
const { respond, truncate, fmtDuration } = require('../util');

const PASS = 5;
const PER_QUIZ = 6;
const COOLDOWN_MS = 30 * 60e3;
const SESSION_TTL = 15 * 60e3;

// Her soru: q, doğru cevap (ok), yanlışlar (bad), açıklama (why)
const POOL = [
  { q: 'Bir "yönetici" sana özelden "sunucuyu kurtarmak için bu .jar dosyasını çalıştır" diyor. Ne yaparsın?',
    ok: 'Çalıştırmam; yetkiliyi başka bir yoldan (sesli ya da sunucu içinden) doğrularım.',
    bad: ['Hemen çalıştırırım, acil durum.', 'Önce çalıştırırım, olmazsa silerim.'],
    why: 'Zararlı mod/dosyalar hesabını ve bilgisayarını ele geçirir. "Acele ettirme" klasik bir dolandırıcılık tekniğidir.' },
  { q: 'Bir mesaj "Nitro hediye! QR kodu telefonundan tara" diyor. Doğru olan hangisi?',
    ok: 'Taramam; QR ile giriş, hesabı karşı tarafa vermek demektir.',
    bad: ['Tararım, bedava Nitro kaçmaz.', 'Arkadaşımın telefonundan taratırım.'],
    why: 'QR kod girişi saldırgana hesabına oturum açma yetkisi verir. Hediyeler hiçbir zaman QR taratarak verilmez.' },
  { q: 'Discord "token"ı nedir?',
    ok: 'Şifresiz ve 2FA\'sız hesabına tam erişim veren gizli anahtar; kimseyle paylaşılmaz.',
    bad: ['Sunucuya giriş için gereken davet kodu.', 'Botların kullandığı herkese açık kimlik numarası.'],
    why: 'Token çalınırsa saldırgan şifre ve 2FA\'yı atlayarak hesabına girer. Birçok zararlı yazılımın tek hedefi budur.' },
  { q: 'Bir Minecraft modunu nereden indirmek en güvenlidir?',
    ok: 'Modrinth ya da CurseForge\'daki resmi proje sayfasından.',
    bad: ['Sohbette biri attıysa oradan.', 'Reklamlı rastgele "ücretsiz mod" sitelerinden.'],
    why: 'Klan sunucusunun kaybı da kötü niyetli bir moddan başladı. Resmi platformlar dosyaları tarar ve yayıncıları takip eder.' },
  { q: 'Hesabında iki aşamalı doğrulamayı (2FA) neden açmalısın?',
    ok: 'Şifren çalınsa bile saldırgan tek başına giriş yapamaz.',
    bad: ['Hesabım daha hızlı açılsın diye.', 'Botlar ancak böyle çalışır.'],
    why: '2FA ikinci bir kilittir. Özellikle yönetici hesaplarında zorunlu olmalıdır.' },
  { q: 'Arkadaşın birden "yeni oyun/mod test eder misin?" diye dosya yolladı, normalde böyle yapmaz. Büyük ihtimalle ne olmuştur?',
    ok: 'Hesabı ele geçirilmiş olabilir; dosyayı açmadan ona başka yoldan haber veririm.',
    bad: ['Şaka yapıyordur, açarım.', 'Dosya küçükse sorun olmaz, açarım.'],
    why: 'Ele geçirilen hesaplar, arkadaş listesine zararlı dosya yaymak için kullanılır. Güvendiğin kişiden gelse bile şüpheli davranışı doğrula.' },
  { q: 'Sunucuda herkese "Yönetici" rolü vermek hakkında ne düşünürsün?',
    ok: 'Yanlış; herkese yalnızca işi için gereken en az yetki verilmeli.',
    bad: ['Güven göstergesi, iyi fikir.', 'Sorun değil, zaten bot var.'],
    why: 'Bir hesap çalındığında zarar, o hesabın yetkisi kadar büyür. "En az yetki" ilkesi sunucuları kurtarır.' },
  { q: 'Bir bot ekleme bağlantısı "Yönetici" yetkisi istiyor. Ne yaparsın?',
    ok: 'Neden gerektiğini sorgularım, mümkünse yalnızca gerekli yetkilerle eklerim.',
    bad: ['Yetki verir, eklerim; sonuçta bot.', 'Sunucu sahibine sormadan eklerim.'],
    why: 'Yönetici yetkili bir bot ele geçirilirse tüm sunucu gider. Bot eklemeyi yetkililer kontrollü yapmalıdır.' },
  { q: 'bit.ly gibi kısaltılmış linkler neden riskli olabilir?',
    ok: 'Gerçek hedef adres gizlenir; tıklayana kadar nereye gittiğini bilemezsin.',
    bad: ['Çünkü daha yavaş açılırlar.', 'Risk yok, hepsi güvenli.'],
    why: 'Kısaltıcılar sahte giriş sayfalarını ya da zararlı indirmeleri gizlemek için sık kullanılır.' },
  { q: 'Hesap parolası için en doğru yaklaşım hangisi?',
    ok: 'Her hesap için ayrı ve uzun parola; bir parola yöneticisiyle.',
    bad: ['Hep aynı kolay parola, hatırlamak kolay olsun.', 'Doğum tarihim + adım.'],
    why: 'Aynı parola bir yerde sızarsa tüm hesapların birlikte düşer.' },
  { q: 'Discord giriş sayfası gibi görünen bir sayfa açıldı. Önce neye bakmalısın?',
    ok: 'Adres çubuğundaki alan adının tam olarak discord.com olduğuna.',
    bad: ['Sayfanın tasarımının güzel olmasına.', 'Sayfada kilit simgesi olup olmadığına.'],
    why: 'Tasarım ve kilit simgesi kopyalanabilir. Sahte siteler adresi "discorcl.com" gibi taklit eder.' },
  { q: 'Biri "sorununa bakayım, ekran paylaş" diyor ve Discord\'dan ekranını açmanı istiyor. Ne yaparsın?',
    ok: 'Yabancıyla ekran paylaşmam; yardım gerekiyorsa resmi destek kanalını kullanırım.',
    bad: ['Paylaşırım, yardım etmek istiyor.', 'Paylaşırım ama sunucu ayarlarını gösteririm.'],
    why: 'Ekranda kodlar, tokenlar ya da kişisel veriler görünebilir. Gerçek yardım istemekle başlar, ekran istemekle değil.' },
  { q: 'Dosya adı "oyun.png.exe" olan bir dosya nedir?',
    ok: 'Resim gibi gösterilen çalıştırılabilir bir programdır; açılmamalıdır.',
    bad: ['Bir resim dosyası.', 'Güvenli bir oyun kurulumu.'],
    why: 'Saldırganlar son uzantıyı gizleyerek program dosyasını görsel gibi gösterir. Windows\'ta uzantıları görünür yap.' },
  { q: 'Bir yetkilinin hesabının çalındığından şüpheleniyorsun. İlk adım ne olmalı?',
    ok: 'Sunucu sahibine/yetkililere hemen haber vermek; hesap sahibi şifresini değiştirip oturumları kapatmalı.',
    bad: ['Beklemek, belki kendiliğinden geçer.', 'Sunucuda herkese duyurmadan önce kimseye söylememek.'],
    why: 'İlk dakikalar belirleyicidir; hızlı bildirim büyük zararı önler. Kalkan\'ın alarmı da bunun için vardır.' },
  { q: 'Telefonuna "bilinmeyen kaynaktan" APK kurman isteniyor. Ne yaparsın?',
    ok: 'Kurmam; yalnızca resmi mağaza ya da yayıncının resmi sitesinden indiririm.',
    bad: ['Kurarım, uygulama bedava.', 'Kurarım ama virüs tarayıcıyı kapatırım.'],
    why: 'Kötü amaçlı uygulamalar tokenları ve oturum çerezlerini telefondan çalabilir.' },
];

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeSession(uid, gid) {
  const qs = shuffle([...POOL]).slice(0, PER_QUIZ).map((p) => ({
    q: p.q, why: p.why,
    opts: shuffle([{ t: p.ok, ok: true }, ...p.bad.map((t) => ({ t, ok: false }))]),
  }));
  return { id: crypto.randomBytes(4).toString('hex'), uid, gid, qs, idx: 0, score: 0, answered: false, at: Date.now() };
}

const LETTERS = ['A', 'B', 'C'];

function questionView(s) {
  const q = s.qs[s.idx];
  const embed = new EmbedBuilder().setColor(0x3498db)
    .setTitle(`🛡️ Güvenlik sınavı — Soru ${s.idx + 1}/${s.qs.length}`)
    .setDescription(`**${q.q}**\n\n${q.opts.map((o, n) => `**${LETTERS[n]})** ${o.t}`).join('\n\n')}`)
    .setFooter({ text: `Geçmek için ${PASS}/${s.qs.length} doğru gerekir` });
  const row = new ActionRowBuilder().addComponents(q.opts.map((_, n) => new ButtonBuilder().setCustomId(`quiz:a:${s.id}:${n}`).setLabel(LETTERS[n]).setStyle(ButtonStyle.Primary)));
  return { embeds: [embed], components: [row] };
}

function init(ctx) {
  const { store } = ctx;
  const sessions = new Map();
  const db = (gid) => (store.data.quiz[gid] ||= {});

  ctx.every(5 * 60e3, () => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.at > SESSION_TTL) sessions.delete(id);
  }, 'sınav temizliği');

  async function finish(i, s) {
    sessions.delete(s.id);
    const guild = i.guild;
    const cfg = ctx.gcfg(guild.id);
    const rec = (db(guild.id)[s.uid] ||= { attempts: 0, best: 0, passedAt: null, lastAt: 0 });
    rec.attempts += 1;
    rec.best = Math.max(rec.best, s.score);
    rec.lastAt = Date.now();
    const passed = s.score >= PASS;
    let roleNote = '';
    if (passed) {
      if (!rec.passedAt) rec.passedAt = Date.now();
      if (cfg.quiz.roleId) {
        const role = guild.roles.cache.get(cfg.quiz.roleId);
        const member = await guild.members.fetch(s.uid).catch(() => null);
        if (role && member && role.editable) {
          try { await member.roles.add(role, 'Kalkan: güvenlik sınavını geçti'); roleNote = `\nRolün verildi: <@&${role.id}>`; } catch { roleNote = '\n(Rol verilemedi, yetkililere haber ver.)'; }
        } else roleNote = '\n(Rol verilemedi, yetkililere haber ver.)';
      }
      ctx.stat(guild.id, 'quizPassed');
    }
    ctx.save();
    const embed = new EmbedBuilder().setColor(passed ? 0x2ecc71 : 0xe67e22)
      .setTitle(passed ? '✅ Sınavı geçtin!' : '❌ Bu sefer olmadı')
      .setDescription(`Skorun: **${s.score}/${s.qs.length}**${roleNote}\n\n${passed
        ? 'Teşekkürler! Şüpheli bir dosya, link ya da DM gördüğünde yetkililere haber vermeyi unutma.'
        : `Geçmek için ${PASS} doğru gerekir. ${fmtDuration(COOLDOWN_MS)} sonra yeniden deneyebilirsin; sorular her seferinde değişir.`}`);
    return i.update({ embeds: [embed], components: [] });
  }

  ctx.router.add(
    new SlashCommandBuilder().setName('sinav').setDescription('Güvenlik farkındalık sınavı')
      .setContexts(InteractionContextType.Guild)
      .addSubcommand((s) => s.setName('basla').setDescription('Sınavı başlat'))
      .addSubcommand((s) => s.setName('durum').setDescription('Sınav durumun'))
      .addSubcommand((s) => s.setName('liste').setDescription('Sınavı geçenlerin listesi (yetkililer)')),
    async (i) => {
      const guild = i.guild;
      const sub = i.options.getSubcommand();
      const rec = db(guild.id)[i.user.id];
      if (sub === 'durum') {
        if (!rec) return respond(i, 'ℹ️ Henüz sınava girmedin. `/sinav basla` ile başlayabilirsin.');
        return respond(i, `${rec.passedAt ? '✅ Sınavı geçtin' : '❌ Henüz geçmedin'} • En iyi skor: **${rec.best}/${PER_QUIZ}** • Deneme: ${rec.attempts}`);
      }
      if (sub === 'liste') {
        if (!i.memberPermissions.has(PermissionFlagsBits.ManageGuild) && !ctx.isTrusted(guild, i.user.id)) return respond(i, '🔒 Bu komut yetkililer içindir.');
        const rows = Object.entries(db(guild.id));
        const passed = rows.filter(([, r]) => r.passedAt);
        return respond(i, `**Sınavı geçen:** ${passed.length} • **Deneyen toplam:** ${rows.length}\n${truncate(passed.slice(-25).map(([id, r]) => `<@${id}> — ${r.best}/${PER_QUIZ}`).join('\n') || '-', 1700)}`);
      }
      // başla
      if (rec && rec.passedAt) return respond(i, '✅ Sınavı zaten geçtin, tekrar girmene gerek yok.');
      if (rec && Date.now() - rec.lastAt < COOLDOWN_MS) return respond(i, `⏳ Yeniden denemek için ${fmtDuration(COOLDOWN_MS - (Date.now() - rec.lastAt))} bekle.`);
      for (const [id, s] of sessions) if (s.uid === i.user.id) sessions.delete(id);
      const s = makeSession(i.user.id, guild.id);
      sessions.set(s.id, s);
      return respond(i, questionView(s));
    },
  );

  ctx.router.button('quiz:', async (i) => {
    const [, act, sid, n] = i.customId.split(':');
    const s = sessions.get(sid);
    if (!s) return i.update({ content: '⌛ Bu sınavın süresi doldu. `/sinav basla` ile yeniden başlat.', embeds: [], components: [] });
    if (s.uid !== i.user.id) return respond(i, '🔒 Bu sınav sana ait değil.');
    s.at = Date.now();
    if (act === 'n') {
      if (!s.answered) return i.deferUpdate();
      s.idx += 1;
      s.answered = false;
      if (s.idx >= s.qs.length) return finish(i, s);
      return i.update(questionView(s));
    }
    if (act === 'a') {
      if (s.answered) return i.deferUpdate();
      const q = s.qs[s.idx];
      const pick = q.opts[Number(n)];
      if (!pick) return i.deferUpdate();
      s.answered = true;
      if (pick.ok) s.score += 1;
      const right = q.opts.findIndex((o) => o.ok);
      const embed = new EmbedBuilder().setColor(pick.ok ? 0x2ecc71 : 0xe74c3c)
        .setTitle(`${pick.ok ? '✅ Doğru' : '❌ Yanlış'} — Soru ${s.idx + 1}/${s.qs.length}`)
        .setDescription(`${pick.ok ? '' : `Doğru cevap: **${LETTERS[right]})** ${q.opts[right].t}\n\n`}${q.why}`)
        .setFooter({ text: `Şimdiye kadar: ${s.score} doğru` });
      const last = s.idx + 1 >= s.qs.length;
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`quiz:n:${s.id}`).setLabel(last ? 'Sonucu gör' : 'Sonraki soru').setStyle(ButtonStyle.Success));
      return i.update({ embeds: [embed], components: [row] });
    }
    return i.deferUpdate();
  });
}

module.exports = { name: 'quiz', init, POOL, PASS, PER_QUIZ, makeSession };
