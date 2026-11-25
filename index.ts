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

const dir = import.meta.dir;
(globalThis as any).__loadMusic = () => import(dir + '/music.mjs');
try {
  await import(dir + '/bot.tsx');
} catch (e) {
  console.error('Bot code failed to load:', e);
}

// Keep Render's free tier awake: ping our own public URL every 10 minutes.
const selfUrl = Bun.env.RENDER_EXTERNAL_URL;
if (selfUrl) setInterval(() => { fetch(selfUrl).catch(() => {}); }, 10 * 60 * 1000);
