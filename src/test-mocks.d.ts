// Test-only stand-ins written in plain JS under server/test.
declare module '*/server/test/mock-supabase.mjs' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function createMockSupabase(opts?: { confirmEmail?: boolean; tokenTtl?: number; projectSlots?: boolean }): Promise<any>;
}
declare module '*/server/test/mock-providers.mjs' {
  /** The stand-in Manus's report for a brand-voice read. */
  export function mockVoiceReply(prompt: string): string;
  /** The marker an assistant prompt starts with. */
  export const ASSISTANT_MARKER: string;
  /** The stand-in AI's scripted step for an assistant prompt (JSON text). */
  export function mockAssistantReply(prompt: string): string;
}
declare module '*/server/ads/build.mjs' {
  /** the planner's buttons → Meta's callToAction values (src/lib/ads.ts META_CTA keeps the same map) */
  export const CTA_MAP: Readonly<Record<string, string>>;
  /** the fewest days a Meta daily budget runs more than 24 hours from this start (src/lib/ads/launchFormat.ts metaMinDays) */
  export function metaMinDays(o: { startDay: string; time?: string | null; asap?: boolean; tz: string; builtAt: number }): number;
}
declare module '*/server/morning/rules.mjs' {
  /** the server's candidate key (src/lib/morning/contract.ts morningKey makes the same) */
  export function keyOf(c: { kind: string; title?: string; target?: Record<string, unknown> }, facts: unknown): string;
}
declare module '*/server/localTime.mjs' {
  export function actionDayOf(now: number, tz: string): string;
  export function nextMorningAt(now: number, tz: string): number;
  export function isLate(now: number, tz: string): boolean;
  export function localToUtc(ymd: string, hh: number, mm: number, tz: string): number;
}
