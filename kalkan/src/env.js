'use strict';
// .env dosyasını okur (ek bağımlılık yok) ve ayarları tek yerde toplar.
const fs = require('fs');
const path = require('path');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

loadDotEnv(path.join(process.cwd(), '.env'));

const csv = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);

const env = {
  token: process.env.DISCORD_TOKEN || '',
  clientSecret: process.env.CLIENT_SECRET || '',
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  oauthRedirect: (process.env.OAUTH_REDIRECT_URI || '').trim(),
  port: parseInt(process.env.PORT || '3000', 10),
  bindHost: process.env.BIND_HOST || '127.0.0.1',
  ownerIds: csv(process.env.OWNER_IDS),
  backupOwnerIds: csv(process.env.BACKUP_OWNER_IDS),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data')),
  dataKey: process.env.DATA_KEY || '',
  dataKeyOld: process.env.DATA_KEY_OLD || '',
  maxRssMb: parseInt(process.env.MAX_RSS_MB || '700', 10) || 0,
  logToFile: !/^(0|false|no|kapali)$/i.test(process.env.LOG_TO_FILE || '1'),
  vtKey: process.env.VIRUSTOTAL_API_KEY || '',
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChat: process.env.TELEGRAM_CHAT_ID || '',
  ntfyTopic: process.env.NTFY_TOPIC || '',
  ntfyServer: (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, ''),
  alertWebhook: process.env.ALERT_WEBHOOK_URL || '',
  mirrorWebhook: process.env.MIRROR_WEBHOOK_URL || '',
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
  blocklistUrl: process.env.BLOCKLIST_URL || '',
  scamListUrl: process.env.SCAM_LIST_URL || '',
  botName: process.env.BOT_NAME || 'Kalkan',
  guildIds: csv(process.env.GUILD_IDS),
};

module.exports = { env, loadDotEnv };
