// Test-only stand-ins written in plain JS under server/test.
declare module '*/server/test/mock-supabase.mjs' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function createMockSupabase(opts?: { confirmEmail?: boolean; tokenTtl?: number }): Promise<any>;
}
declare module '*/server/test/mock-providers.mjs' {
  /** The stand-in Manus's report for a brand-voice read. */
  export function mockVoiceReply(prompt: string): string;
  /** The marker an assistant prompt starts with. */
  export const ASSISTANT_MARKER: string;
  /** The stand-in AI's scripted step for an assistant prompt (JSON text). */
  export function mockAssistantReply(prompt: string): string;
}
