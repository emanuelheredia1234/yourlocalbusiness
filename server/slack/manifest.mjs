// The small Slack app the owner creates in their own workspace so this app can talk to Viktor (viktor.com's
// AI employee) as them: user scopes only (no bot user), token rotation off. Settings → AI → Viktor (Slack)
// shows it with a Copy button and a "Create it from the manifest" link (Slack's share-link pattern:
// https://api.slack.com/apps?new_app=1&manifest_yaml=<URL-encoded YAML>).
//
// The channel permissions are optional scopes (user_optional, Slack's March 2026 manifest field): the owner
// can leave them out at install when they'll only talk to Viktor in their DM. "Optional scopes must also be
// listed in the corresponding user fields."

/** What the DM with Viktor needs (posting as the owner, reading the threads, the owner's images and Viktor's files). */
export const DM_SCOPES = ['chat:write', 'im:write', 'im:history', 'users:read', 'files:write', 'files:read'];
/** A public channel Viktor is in. */
export const CHANNEL_SCOPES = ['chat:write', 'users:read', 'files:write', 'files:read', 'channels:history', 'channels:read'];
/** …and a private one. */
export const PRIVATE_SCOPES = ['groups:history', 'groups:read'];
export const OPTIONAL_SCOPES = ['channels:history', 'groups:history', 'channels:read', 'groups:read'];
export const ALL_SCOPES = [...DM_SCOPES, ...OPTIONAL_SCOPES];

export const MANIFEST = {
  _metadata: { major_version: 1, minor_version: 1 },
  display_information: {
    name: 'Yourlocalbusiness for Viktor',
    description: "Lets my Yourlocalbusiness app send my requests to Viktor in Slack and bring Viktor's replies back.",
  },
  settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
  oauth_config: { scopes: { user: ALL_SCOPES, user_optional: OPTIONAL_SCOPES } },
};

const yamlList = (items, indent) => items.map((s) => `${' '.repeat(indent)}- ${s}`).join('\n');

export const MANIFEST_YAML = [
  '_metadata:',
  '  major_version: 1',
  '  minor_version: 1',
  'display_information:',
  `  name: ${MANIFEST.display_information.name}`,
  `  description: ${MANIFEST.display_information.description}`,
  'settings:',
  '  org_deploy_enabled: false',
  '  socket_mode_enabled: false',
  '  token_rotation_enabled: false',
  'oauth_config:',
  '  scopes:',
  '    user:',
  yamlList(ALL_SCOPES, 6),
  '    user_optional:',
  yamlList(OPTIONAL_SCOPES, 6),
  '',
].join('\n');

export const MANIFEST_JSON = JSON.stringify(MANIFEST, null, 2);

/** Slack's "create an app from this manifest" link. */
export const CREATE_URL = `https://api.slack.com/apps?new_app=1&manifest_yaml=${encodeURIComponent(MANIFEST_YAML)}`;

/** What GET /api/ai/slack sends with the connection. */
export const manifestInfo = () => ({ yaml: MANIFEST_YAML, json: MANIFEST_JSON, createUrl: CREATE_URL });

/** Scopes the place needs that the token wasn't granted (dm, channel, or a private channel). */
export function missingFor(granted, place = 'dm', isPrivate = false) {
  const have = new Set(granted ?? []);
  const need = place === 'channel' ? [...CHANNEL_SCOPES, ...(isPrivate ? PRIVATE_SCOPES : [])] : DM_SCOPES;
  return need.filter((s) => !have.has(s));
}

/** Whether the channel permissions were granted at install (public channels at least). */
export const hasChannelScopes = (granted) => missingFor(granted, 'channel').length === 0;
