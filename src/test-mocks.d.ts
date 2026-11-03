// Test-only stand-ins written in plain JS under server/test.
declare module '*/server/test/mock-supabase.mjs' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function createMockSupabase(opts?: { confirmEmail?: boolean; tokenTtl?: number }): Promise<any>;
}
declare module '*/server/test/mock-providers.mjs' {
  /** The stand-in Manus's report for a brand-voice read. */
  export function mockVoiceReply(prompt: string): string;
}
