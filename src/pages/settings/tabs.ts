// Which Settings sections a person sees (pure: Settings.tsx and its tests use it).
//   Account     signed in
//   Plan        signed in, with plans shown (never in the artifact build)
//   Payments    where the app's server is (never in the artifact build)
//   Owner       the app's owner only, as the server says (every owner page checks again); never in the artifact build

export interface SettingsTabContext {
  signedIn: boolean;
  /** plans are shown (useBillingOn) */
  billing: boolean;
  /** the server says this person is the app's owner */
  owner: boolean;
  artifact: boolean;
}

export function settingsTabAllowed(id: string, ctx: SettingsTabContext): boolean {
  if (id === 'account') return ctx.signedIn;
  if (id === 'plan') return ctx.signedIn && ctx.billing;
  if (id === 'payments') return !ctx.artifact;
  if (id === 'owner') return ctx.owner && !ctx.artifact;
  return true;
}
