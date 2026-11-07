// What the assistant never does itself, as tools of class X: asked for one, the app says why and opens
// the page where the owner does it. Listing them gives the model a clear way to answer such requests
// instead of improvising.

import { arg, defineTool, type AnyTool } from '../registry';

const why = { what: arg.string({ optional: true, max: 200, desc: 'what the owner asked for' }) };

/** The claude.ai build: A/B tests and Instagram Trial Reels aren't here (their tools aren't registered). */
export const abTestsHere = defineTool({
  name: 'ab_tests',
  class: 'X',
  summary: 'A/B tests (Make variations, results, Use the winner) and Instagram Trial Reels.',
  args: why,
  refusal: { text: 'A/B tests and Instagram Trial Reels need the app’s own server, so they aren’t available here. In the self-hosted app, they’re under Social › A/B tests.' },
});

/** The claude.ai build: payments (Stripe, sales) aren't here (their tools aren't registered). */
export const paymentsHere = defineTool({
  name: 'payments',
  class: 'X',
  summary: 'Selling with Stripe, sales, buy links’ payments.',
  args: why,
  refusal: { text: 'Payments need the app’s own server, so they aren’t available here. In the self-hosted app, they’re in Settings › Payments.' },
});

/** Money that only the owner moves (P6): never done by the assistant. Not in the claude.ai build (paymentsHere instead). */
export const paymentExclusions: AnyTool[] = [
  defineTool({
    name: 'stripe_money',
    class: 'X',
    summary: 'Refunds, disputes, payouts, Stripe Tax.',
    args: why,
    refusal: { text: 'Refunds and disputes are done in your Stripe Dashboard (or Whop’s), and payouts, the bank, Stripe Tax and disconnecting are a payout or Stripe Connect detail: only you change them. I opened Settings › Payments (Open Stripe Dashboard is there).', route: 'workspace-settings', tab: 'payments' },
  }),
];

export const excludedTools: AnyTool[] = [
  defineTool({
    name: 'change_ai_settings',
    class: 'X',
    summary: 'Change API keys, what each key powers, models, effort, priority or daily limits.',
    args: why,
    refusal: { text: 'API keys and AI settings are only changed by you, in Settings › AI keys, so a key is never typed into or read out of a chat. I opened it for you.', route: 'workspace-settings', tab: 'ai' },
  }),
  defineTool({
    name: 'manage_own_keys',
    class: 'X',
    summary: 'Add, replace or remove the person’s own API keys (including their own Manus key).',
    args: why,
    refusal: { text: 'Your own API keys are added or removed only by you, in Settings › AI keys, so they never pass through a chat. I opened it for you.', route: 'workspace-settings', tab: 'ai' },
  }),
  defineTool({
    name: 'compare_efforts',
    class: 'X',
    summary: 'Run the paid effort comparison on a key.',
    args: why,
    refusal: { text: 'The effort comparison spends money on a key, so it runs only when you press Compare efforts on that key in Settings › AI keys. I opened it for you.', route: 'workspace-settings', tab: 'ai' },
  }),
  defineTool({
    name: 'reset_workspace',
    class: 'X',
    summary: 'Erase the whole workspace.',
    args: why,
    refusal: { text: 'Resetting erases everything, so only you can do it, in Settings › Projects & data. I opened it for you.', route: 'workspace-settings', tab: 'projects' },
  }),
  defineTool({
    name: 'import_backup',
    class: 'X',
    summary: 'Import a JSON backup over the workspace.',
    args: why,
    refusal: { text: 'Importing a backup replaces your workspace, so only you can do it, in Settings › Projects & data. I opened it for you.', route: 'workspace-settings', tab: 'projects' },
  }),
  defineTool({
    name: 'sign_out',
    class: 'X',
    summary: 'Log out of the account.',
    args: why,
    refusal: { text: 'I don’t log you out. Use Log out in the account menu, or in Settings › Account. I opened it for you.', route: 'workspace-settings', tab: 'account' },
  }),
  defineTool({
    name: 'change_password',
    class: 'X',
    summary: 'Change the account password.',
    args: why,
    refusal: { text: 'Passwords never go through the chat. Change yours in Settings › Account. I opened it for you.', route: 'workspace-settings', tab: 'account' },
  }),
  defineTool({
    name: 'delete_account',
    class: 'X',
    summary: 'Delete the account and everything in it.',
    args: why,
    refusal: { text: 'Deleting your account can’t be undone, so only you can do it, in Settings › Account. I opened it for you.', route: 'workspace-settings', tab: 'account' },
  }),
  defineTool({
    name: 'manus_task',
    class: 'X',
    summary: 'Start a Manus task yourself, with your own words (to write a message the owner asked for, use draft_agent_message: they confirm it first).',
    args: why,
    refusal: {
      text: __ARTIFACT_BUILD__
        ? 'Manus only gets the app’s own fixed instructions: Facebook groups, photos and brand voice, from their buttons. I don’t start Manus tasks myself. Talking to Manus and Build with Manus work in the self-hosted app.'
        : 'Manus only gets the app’s fixed instructions or your own words: Facebook groups, photos and brand voice from their buttons, pages and assets from Build with Manus, and anything else from you, with the chat’s To: Manus switch. I don’t start Manus tasks myself, but I can draft a message for you to send.',
    },
  }),
  // A/B tests and Trial Reels (P4b) need the app's server: in the claude.ai build the assistant only says so
  ...(__ARTIFACT_BUILD__ ? [abTestsHere] : []),
  // payments (P6) need the app's server too
  ...(__ARTIFACT_BUILD__ ? [paymentsHere] : paymentExclusions),
];
