// Manus and Viktor (viktor.com, through Slack) as builders and chat partners: the shapes the server
// routes, the build window and the assistant chat share. Types only (no code). Created byte-identical
// by the three builders from the spec; SERVER's copy wins at merge.

import type { PromptImage } from './types';

export type AgentId = 'manus' | 'viktor';
/** what a build makes: a Code & assets asset, or the SEO page */
export type BuildTarget = 'asset' | 'seo';

/** A fact the owner lets the agent use: one line, as entered in the workspace. */
export type BuildFactId = 'name' | 'what' | 'place' | 'offer' | 'booking' | 'payment' | 'email' | 'phone' | 'hours';
export interface BuildFact {
  id: BuildFactId;
  value: string;
}

/** An image a request sends: its key (the page shows it as {{img-N}}) and the owner's note. */
export interface ImageNote {
  key: string;
  note: string;
}

/** What the build window sends; the server writes the fixed template around it. */
export interface BuildRequest {
  target: BuildTarget;
  /** asset: a CodeKind id; seo: a PageType id */
  kind: string;
  facts: BuildFact[];
  /** the owner's website as a style reference: https, a public host ('' for none) */
  website: string;
  /** "What to build and the features you want": the owner's words */
  request: string;
  images: ImageNote[];
}

/** A chat message to Manus or Viktor: the owner's words, sent as typed. */
export interface ChatRequest {
  text: string;
  /** the owner's website, when they added it to this message ('' for none) */
  website: string;
  images: ImageNote[];
  /** Manus's first message only: the business name, one line */
  brand?: string;
}

/** A file already handed to the agent's service (Manus file.upload, or Slack's upload), sent with the next message. */
export interface AgentFileRef {
  id: string;
  filename: string;
}

/** A file in an agent's reply. No address: the server fetches it. */
export interface AgentFileMeta {
  /** Manus: "<event id>:<index>" ("<event id>:code" for a page in the text); Slack: "<ts>:<file id>" ("<ts>" for a page in a code block) */
  id: string;
  name: string;
  kind: 'image' | 'html' | 'other';
  bytes?: number;
  mime?: string;
}

/** An HTML page from an agent, as the server hands it over (JSON, never served as a page). */
export interface AgentHtml {
  html: string;
  filename: string;
  bytes: number;
  /** an attached .html file, or a code block in the message */
  source: 'file' | 'code';
}

/** The exact message a send would post (a dry run), for the confirm step. */
export interface AgentPreview {
  /** readable text (Slack's escaping undone) */
  text: string;
  chars: number;
  limit: number;
}

// ───────────── a build (kept in the project, synced) ─────────────

export type BuildState =
  /** the request is on its way (only while this tab sends it) */
  | 'sending'
  /** sending failed in a way that may have delivered it: check before sending again */
  | 'unknown_start'
  /** the agent is working */
  | 'working'
  /** the agent asked something, sent no page, or waits for an approval */
  | 'needs_you'
  /** a page came back and hasn't been used yet */
  | 'built'
  /** the page was used (an asset, or the SEO page) */
  | 'imported'
  | 'failed'
  /** the owner pressed Stop (Manus) or Stop waiting (Viktor) */
  | 'stopped';

export interface AgentBuild {
  id: string;
  via: AgentId;
  target: BuildTarget;
  /** CodeKind (asset) or PageType (seo) */
  kind: string;
  /** what was sent, so Ask for changes and Use this know it */
  request: string;
  website: string;
  /** every image sent in this build's rounds, with its key (thumbnails left out to keep the project small) */
  images: PromptImage[];
  state: BuildState;
  /** one line for the owner: why it failed, what the agent waits for */
  message?: string;
  /** the agent's latest words, cut to 600 characters: untrusted, shown as text only */
  said?: string;
  requestedAt: number;
  /** when the latest request in this build (the first, a change, an answer, a follow-up) was sent */
  lastSentAt: number;
  /** the latest request's Ref (Viktor: its last line; Manus: the end of the task title) */
  ref: string;
  /** requests sent in this build (1 = the first) */
  rounds: number;
  /** Manus */
  taskId?: string;
  taskUrl?: string;
  profile?: string;
  credits?: number;
  /** Viktor */
  threadId?: string;
  permalink?: string;
  /** where the latest round's page is: Manus "<event id>:<index>" or "<event id>:code"; Slack "<ts>" or "<ts>:<file id>" */
  result?: { at: string; filename: string; bytes: number; source: 'file' | 'code' };
  /** what the owner did with a page */
  imported?: { at: number; result: string; assetId?: string; seo?: boolean };
}

// ───────────── reading replies ─────────────

/** One event of a Manus task, as the server hands it over. */
export interface ManusEvent {
  id: string;
  type: 'user' | 'assistant' | 'error';
  at: number;
  /** cut to 8,000 characters; links to Manus's own files and sites removed (their names stay) */
  text: string;
  /** Manus's display hint: opening and progress messages can be collapsed once a result arrives */
  deliveryKind?: 'opening' | 'progress' | 'result';
  files: AgentFileMeta[];
  /** a question with choices (the owner may answer in their own words too) */
  options?: string[];
}

export interface ManusRead {
  status: string;
  /** waiting for the owner: answer in the chat (a question), or approve something in Manus */
  waiting: null | { type: string; text: string; answerHere: boolean };
  /** still working in the background after stopping: don't use a page yet */
  background: boolean;
  credits: number;
  taskUrl: string;
  /** newest first; only the ones after `after`, when it was given */
  events: ManusEvent[];
  truncated: boolean;
  /** Manus made a website in its own account instead of a file */
  webdev: boolean;
  /** build tasks: the latest round, worked out by the server */
  build?: { state: 'working' | 'needs_you' | 'built' | 'failed' | 'no_file'; reason: string; result: null | { at: string; filename: string; bytes: number; source: 'file' | 'code' } };
}

/** A message in a thread with Viktor, as the server hands it over. */
export interface ViktorMessage {
  ts: string;
  /** 'other': someone else in the thread (only a notice, never their words) */
  from: 'viktor' | 'you' | 'other';
  /** 'app': this app sent it; 'slack': typed in Slack */
  via: 'app' | 'slack';
  where: 'thread' | 'top';
  /** readable text; code blocks become [HTML page · 9.4 KB] or [code · 23 lines]; '' for 'other' */
  text: string;
  /** the edit's ts when it was edited in Slack */
  edited: string | null;
  /** deleted in Slack since an earlier read */
  deleted?: boolean;
  files: AgentFileMeta[];
  /** a page in it: a code block or an attached .html file; complete = it has its </html> */
  html: null | { at: string; source: 'code' | 'file'; bytes: number; complete: boolean };
}

export type ViktorThreadState = 'sent_unlocated' | 'waiting' | 'replied' | 'partial' | 'link_only' | 'built' | 'gone';

export interface ViktorRead {
  threadId: string;
  state: ViktorThreadState;
  /** oldest first */
  messages: ViktorMessage[];
  /** the newest complete page after the latest request */
  latestHtml: null | { at: string; bytes: number; source: 'code' | 'file'; filename: string };
  permalink: string;
  /** the latest request's ts (null until it's found in Slack) */
  sinceTs: string | null;
  checkedAt: number;
}

export interface ViktorSent {
  threadId: string;
  permalink: string;
  ts: string | null;
  located: boolean;
  sentAt: number;
}

// ───────────── readiness (/api/health → ai.agents) ─────────────

export interface AgentReady {
  ready: boolean;
  /** manus: ok | no_key | not_ticked | own_key_needed; viktor: ok | no_token | bad_token | missing_scopes | no_viktor | no_place | owner_only */
  reason: string;
}

export interface AgentsHealth {
  manus: { build: AgentReady; chat: AgentReady; own: boolean; profile: string };
  viktor: AgentReady & { where: 'dm' | 'channel' | ''; place: string };
}
