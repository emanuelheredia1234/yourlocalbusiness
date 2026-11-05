// Server modules (plain JS under server/) that client tests read, to check the app and the server agree.
declare module '*/server/providers/registry.mjs' {
  /** Settings › AI keys's catalog: per provider and kind, the effort options with their labels and notes. */
  export function describeProviders(): { id: string; kinds: Record<string, { efforts: { id: string; label: string; note: string }[] } | undefined> }[];
}
declare module '*/server/agents/templates.mjs' {
  /** What each kind of asset (CODE_KINDS) or page (PAGE_TYPES) is, in the words Manus and Viktor get. */
  export const AGENT_TARGETS: { asset: Record<string, string>; seo: Record<string, string> };
  /** The kinds' names in the Manus task title. */
  export const KIND_LABELS: { asset: Record<string, string>; seo: Record<string, string> };
  /** The owner's words: a build request (and its changes), and a chat message, per agent. */
  export const CAPS: { manus: { build: number; chat: number }; viktor: { build: number; chat: number } };
  export const MANUS_LIMIT: number;
  export const SLACK_LIMIT: number;
}
