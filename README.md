# Gigglo

Gigglo is a trilingual (EN/TR/AZ) Discord bot: **games** (57 fun/casino/social commands with a shared economy), **music** (YouTube / SoundCloud / Spotify-link search) and **protection** (Kalkan, an opt-in security module).

| File | What it is |
| --- | --- |
| `index.ts` | Launcher (Render start command: `bun run index.ts`). Re-runs itself with a larger HTTP header limit, then loads `app.ts`. |
| `app.ts` | The real entry point. Keep-alive ping, loads the modules below. |
| `bot.tsx` | Games, economy, profile card, `/owner` and `/admin` panels, help. |
| `music.mjs` | Music module. |
| `kalkan-adapter.mjs` + `kalkan/` | Kalkan security module (anti-nuke, auto-moderation, raid shield, backups, recovery…). |

## Environment variables
`DISCORD_TOKEN`, `CLIENT_ID`, `OWNER_IDS`, `DATABASE_URL` (Postgres, e.g. Neon) — required.
`SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`, `YT_COOKIE` — optional (music).

### Security module (Kalkan)
1. Enable **Server Members Intent** (and Message Content Intent) for the bot in the Discord Developer Portal.
2. Set `KALKAN=1` (and a random `DATA_KEY`, at least 12 characters) and redeploy.
3. In `/owner` → **Security**, put the IDs of the servers where protection should run (comma separated). Other servers see the commands as "not enabled".

Kalkan keeps its data folder in the Postgres table `kalkan_files`, so it survives restarts on hosts with an ephemeral disk.
