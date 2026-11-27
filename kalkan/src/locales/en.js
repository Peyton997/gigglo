'use strict';
// English catalog (partial): missing keys fall back to Turkish. Add translations here over time.
module.exports = {
  'err.generic': '⚠️ Something went wrong (code: `{id}`). Please try again later; if it persists, give this code to the staff.',
  'err.noPerm': '🔒 You are not allowed to use this command.',
  'err.needTrusted': '🔒 This command is for trusted users only.',
  'err.needOwner': '🔒 This command is for the bot owners only.',
  'err.guildOnly': 'ℹ️ This command can only be used inside a server.',
  'err.botPerm': '❌ The bot is missing the permission: **{perm}**. Grant it to the bot\'s role in Server Settings → Roles.',
  'err.hierarchy': '❌ Could not do that: the target has a role equal to or higher than yours or the bot\'s. Move the bot\'s role above the target\'s role.',
  'err.self': '❌ You cannot do this to yourself.',
  'err.notFound': '❌ Not found.',
  'err.expired': '⌛ This interaction has expired. Run the command again.',
  'err.notYours': '🔒 This button/menu is not yours.',
  'ok.done': '✅ Done.',
  'priv.consentOn': '✅ You are registered. If access to the server is lost, I will DM you the backup-server announcement. You can opt out any time with `/izni-iptal`.',
  'priv.consentOff': '✅ Consent withdrawn. You will no longer receive recovery DMs.',
};
