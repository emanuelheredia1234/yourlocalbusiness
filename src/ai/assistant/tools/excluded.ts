// What the assistant never does itself, as tools of class X: asked for one, the app says why and opens
// the page where the owner does it. Listing them gives the model a clear way to answer such requests
// instead of improvising.

import { arg, defineTool, type AnyTool } from '../registry';

const why = { what: arg.string({ optional: true, max: 200, desc: 'what the owner asked for' }) };

export const excludedTools: AnyTool[] = [
  defineTool({
    name: 'change_ai_settings',
    class: 'X',
    summary: 'Change API keys, what each key powers, models, effort, priority or daily limits.',
    args: why,
    refusal: { text: 'API keys and AI settings are only changed by you, in Settings → AI, so a key is never typed into or read out of a chat. I opened it for you.', route: 'workspace-settings', tab: 'ai' },
  }),
  defineTool({
    name: 'manage_own_keys',
    class: 'X',
    summary: 'Add, replace or remove the person’s own API keys (including their own Manus key).',
    args: why,
    refusal: { text: 'Your own API keys are added or removed only by you, in Settings → AI, so they never pass through a chat. I opened it for you.', route: 'workspace-settings', tab: 'ai' },
  }),
  defineTool({
    name: 'compare_efforts',
    class: 'X',
    summary: 'Run the paid effort comparison on a key.',
    args: why,
    refusal: { text: 'The effort comparison spends money on a key, so it runs only when you press Compare efforts on that key in Settings → AI. I opened it for you.', route: 'workspace-settings', tab: 'ai' },
  }),
  defineTool({
    name: 'reset_workspace',
    class: 'X',
    summary: 'Erase the whole workspace.',
    args: why,
    refusal: { text: 'Resetting erases everything, so only you can do it, in Settings → Projects & data. I opened it for you.', route: 'workspace-settings', tab: 'projects' },
  }),
  defineTool({
    name: 'import_backup',
    class: 'X',
    summary: 'Import a JSON backup over the workspace.',
    args: why,
    refusal: { text: 'Importing a backup replaces your workspace, so only you can do it, in Settings → Projects & data. I opened it for you.', route: 'workspace-settings', tab: 'projects' },
  }),
  defineTool({
    name: 'sign_out',
    class: 'X',
    summary: 'Log out of the account.',
    args: why,
    refusal: { text: 'I don’t log you out. Use Log out in the account menu, or in Settings → Account. I opened it for you.', route: 'workspace-settings', tab: 'account' },
  }),
  defineTool({
    name: 'change_password',
    class: 'X',
    summary: 'Change the account password.',
    args: why,
    refusal: { text: 'Passwords never go through the chat. Change yours in Settings → Account. I opened it for you.', route: 'workspace-settings', tab: 'account' },
  }),
  defineTool({
    name: 'delete_account',
    class: 'X',
    summary: 'Delete the account and everything in it.',
    args: why,
    refusal: { text: 'Deleting your account can’t be undone, so only you can do it, in Settings → Account. I opened it for you.', route: 'workspace-settings', tab: 'account' },
  }),
  defineTool({
    name: 'manus_task',
    class: 'X',
    summary: 'Give Manus any other task, or a task written in the chat.',
    args: why,
    refusal: { text: 'Manus works in a browser signed in to your accounts, so it only gets the app’s own fixed instructions: posting a post or sharing it in Facebook groups (from a post’s Manus buttons), making a photo, or learning your brand voice. It never gets a task written in the chat. Your posts are on the calendar.', route: 'calendar' },
  }),
];
