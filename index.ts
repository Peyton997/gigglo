// Launcher. Bun's HTTP parser rejects YouTube's large response headers ("Parse Error: Header overflow")
// at the default 16 KiB, and the flag can only be set on the command line (not via env or code).
// Render's start command is fixed to `bun run index.ts`, so re-run ourselves once with the flag.
import http from 'node:http';

const WANT = 65536;
const dir = import.meta.dir;

if (http.maxHeaderSize >= WANT || Bun.env.GIGGLO_CHILD === '1') {
  await import(dir + '/app.ts');
} else {
  let child: ReturnType<typeof Bun.spawn> | null = null;
  try {
    child = Bun.spawn([process.execPath, `--max-http-header-size=${WANT}`, 'run', dir + '/app.ts'], {
      stdio: ['inherit', 'inherit', 'inherit'],
      env: { ...process.env, GIGGLO_CHILD: '1' },
    });
  } catch (e: any) {
    console.error('[launcher] could not re-run with larger header size, continuing without it:', e?.message || e);
  }
  if (child) {
    for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { try { child!.kill(sig); } catch {} });
    process.exit(await child.exited);
  } else {
    await import(dir + '/app.ts');
  }
}
