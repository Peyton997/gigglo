import 'discord.js';
import '@napi-rs/canvas';
import '@discordjs/voice';
import 'play-dl';
import 'opusscript';
import 'libsodium-wrappers';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

try { process.env.PATH = ffmpegInstaller.path.replace(/\/ffmpeg$/, '') + ':' + process.env.PATH; } catch {}
process.on('unhandledRejection', (e: any) => console.error('[unhandledRejection]', e?.message || e));
process.on('uncaughtException', (e: any) => console.error('[uncaughtException]', e?.message || e));

// Extra bot owners (comma-separated Discord IDs) are merged into OWNER_IDS, which both Gigglo and Kalkan read.
if (Bun.env.EXTRA_OWNER_IDS) {
  const ids = [...(Bun.env.OWNER_IDS || '').split(','), ...Bun.env.EXTRA_OWNER_IDS.split(',')].map((x) => x.trim()).filter(Boolean);
  process.env.OWNER_IDS = [...new Set(ids)].join(',');
}

const dir = import.meta.dir;
(globalThis as any).__loadMusic = () => import(dir + '/music.mjs');
// Kalkan security module: only when KALKAN=1 (needs the Server Members intent enabled in the Discord Developer Portal).
if (Bun.env.KALKAN === '1') {
  (globalThis as any).__loadKalkan = async () => { const m = await import(dir + '/kalkan-adapter.mjs'); await m.load(); };
}
try {
  await import(dir + '/bot.tsx');
} catch (e) {
  console.error('Bot code failed to load:', e);
}

// Keep Render's free tier awake: ping our own public URL every 10 minutes.
const selfUrl = Bun.env.RENDER_EXTERNAL_URL;
if (selfUrl) setInterval(() => { fetch(selfUrl).catch(() => {}); }, 10 * 60 * 1000);
