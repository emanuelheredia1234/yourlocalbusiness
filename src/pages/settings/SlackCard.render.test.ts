// Settings → AI → Viktor (Slack), drawn once per state (as on the server: no effects run). The token is never
// on the page: the server sends only its last 4 characters.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SlackCardView, type SlackInfo, type SlackPublic } from './SlackCard';

const MANIFEST = { yaml: '_metadata:\n  major_version: 1\n', json: '{}', createUrl: 'https://api.slack.com/apps?new_app=1&manifest_yaml=_metadata' };
const BASE: SlackPublic = {
  configured: false,
  source: '',
  envKey: 'SLACK_USER_TOKEN',
  tokenHint: '',
  team: '',
  teamId: '',
  user: '',
  userId: '',
  url: '',
  scopes: [],
  missingScopes: [],
  channelScopes: false,
  viktor: null,
  where: null,
  problem: null,
  ready: false,
  reason: 'no_token',
  checkedAt: 0,
};
const ALL = ['chat:write', 'im:write', 'im:history', 'users:read', 'files:write', 'files:read', 'channels:history', 'groups:history', 'channels:read', 'groups:read'];
const render = (slack: Partial<SlackPublic>, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(SlackCardView, { info: { slack: { ...BASE, ...slack }, manifest: MANIFEST } as SlackInfo, ...extra }));

describe('the Viktor (Slack) card', () => {
  it('not connected: what it is, the five steps, the manifest to copy, and the fine print', () => {
    const html = render({});
    expect(html).toContain('Viktor (Slack)');
    expect(html).toContain('Not connected');
    expect(html).toContain('The Slack connection you set up in Claude belongs to Claude, not to this app.');
    for (const step of ['Create the Slack app', 'Install it', 'Paste the token', 'Find Viktor', 'Where to talk to Viktor']) expect(html).toContain(step);
    expect(html).toContain('href="https://api.slack.com/apps?new_app=1&amp;manifest_yaml=_metadata"');
    expect(html).toContain('Copy the manifest');
    expect(html).toContain('_metadata:');
    expect(html).toContain('type="password"');
    expect(html).toMatch(/id="slack-token" type="password" autocomplete="off"/i);
    expect(html).toContain('What the token can do: it acts as you in Slack');
    expect(html).toContain('the app can’t see how many');
    // nothing to test or remove yet
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Test connection/);
    expect(html).not.toContain('Also revoke the token in Slack');
  });

  it('with the token from Replit Secrets: no Remove, where to remove it instead', () => {
    const html = render({ configured: true, source: 'secrets', tokenHint: '••••0001', team: 'QA Workspace', user: 'owner', scopes: ALL, channelScopes: true, reason: 'no_viktor' });
    expect(html).toContain('From Replit Secrets (SLACK_USER_TOKEN)');
    expect(html).toContain('••••0001');
    expect(html).toContain('Replit → Secrets');
    expect(html).not.toContain('Also revoke the token in Slack');
    expect(html).not.toContain('id="slack-token"');
    expect(html).toContain('Needs attention');
    expect(html).toContain('Choose Viktor in Settings → AI → Viktor (Slack).');
  });

  it('ready: connected, Viktor chosen, the DM chosen; Remove with revoke', () => {
    const html = render({ configured: true, source: 'app', tokenHint: '••••0001', team: 'QA Workspace', user: 'owner', scopes: ALL, channelScopes: true, viktor: { userId: 'UQAVIKTOR', botId: 'BQAVIKTOR', name: 'Viktor' }, where: { kind: 'dm', channelId: 'DQAVIKTOR1' }, ready: true, reason: 'ok' });
    expect(html).toContain('>Ready<');
    expect(html).toContain('Connected to <strong class="text-ink-2">QA Workspace</strong> as <strong class="text-ink-2">owner</strong>');
    expect(html).toContain('(saved here)');
    expect(html).toContain('(UQAVIKTOR)');
    expect(html).toMatch(/<input type="radio" name="slack-where"[^>]*checked=""/);
    expect(html).toContain('Also revoke the token in Slack');
    expect(html).toContain('Step 5, done');
  });

  it('needs attention: a token Slack refused, or missing permissions named', () => {
    expect(render({ configured: true, source: 'app', tokenHint: '••••0001', reason: 'bad_token', problem: { code: 'bad_token' } })).toContain('Slack didn’t accept the saved token: connect again in Settings → AI → Viktor (Slack).');
    const html = render({ configured: true, source: 'app', tokenHint: '••••0003', scopes: ALL.filter((x) => x !== 'files:read'), missingScopes: ['files:read'], channelScopes: true, reason: 'missing_scopes' });
    expect(html).toContain('Needs attention');
    expect(html).toContain('Missing permissions: files:read.');
  });

  it('without the channel permissions, the channel option is off and says why', () => {
    const html = render({ configured: true, source: 'app', tokenHint: '••••0002', scopes: ALL.slice(0, 6), channelScopes: false, viktor: { userId: 'UQAVIKTOR', botId: '', name: 'Viktor' }, reason: 'no_place' });
    expect(html).toContain('Install the app again and allow the channel permissions to use a channel.');
    expect(html).toMatch(/<input type="radio" name="slack-where"[^>]*disabled=""[^>]*>[^]*A channel Viktor is in/);
  });

  it('lists the bots found, Viktor first, and the checks of Test connection', () => {
    const html = render(
      { configured: true, source: 'app', tokenHint: '••••0001', scopes: ALL, channelScopes: true, reason: 'no_viktor' },
      {
        bots: { bots: [{ userId: 'UQAVIKTOR', name: 'viktor', realName: 'Viktor', displayName: 'Viktor', suggested: true }, { userId: 'UQAOTHER1', name: 'otherbot', realName: 'Other Bot', displayName: '', suggested: false }], truncated: false },
        checks: [
          { id: 'token', ok: true, text: 'Connected to QA Workspace as owner.' },
          { id: 'place', ok: false, text: 'Choose where to talk to Viktor: your DM, or a channel Viktor is in.' },
        ],
      },
    );
    expect(html.indexOf('UQAVIKTOR')).toBeLessThan(html.indexOf('UQAOTHER1'));
    expect(html).toContain('Looks like Viktor');
    expect(html).toContain('Connected to QA Workspace as owner.');
    expect(html).toContain('Choose where to talk to Viktor: your DM, or a channel Viktor is in.');
  });

  it('never shows a token', () => {
    const states = [render({}), render({ configured: true, source: 'app', tokenHint: '••••0001', reason: 'no_viktor' }), render({ configured: true, source: 'secrets', tokenHint: '••••0001', reason: 'ok', ready: true })];
    // (the instructions say the token starts with xoxp-; no token itself is ever on the page)
    for (const html of states) expect(html).not.toMatch(/xox[abpe]-[A-Za-z0-9-]{10,}/);
  });
});
