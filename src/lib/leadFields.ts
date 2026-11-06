// What a published form may send to Email → Leads (server/leads.mjs LEAD_MAX, LEAD_PAYLOAD_MAX and LEAD_KINDS;
// a test keeps them equal). Over a limit the server refuses the whole form, so forms carry these as maxlength.

/** The contact fields, with their limits in characters. */
export const LEAD_FIELDS: Readonly<Record<string, number>> = { name: 120, email: 254, phone: 40, message: 2000, time: 120 };
/** A result or request sent with the form (hidden inputs a widget fills in), with their limits. */
export const LEAD_PAYLOAD_MAX: Readonly<Record<string, number>> = { request: 200, service: 200, result: 200, score: 16, answers: 1500, inputs: 1500, outputs: 1500 };
/** What a form is; a visitor can't send 'magnet' (only the lead-magnet gate is that). */
export const LEAD_KINDS = ['form', 'lead', 'booking', 'quiz', 'calculator', 'roi', 'checklist', 'magnet'] as const;
export type LeadKind = (typeof LEAD_KINDS)[number];
export const LEAD_SOURCES = ['page', 'asset', 'magnet'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];
/** The other names a form may have: the consent box, its kind, a lead magnet's id, and the hidden field bots fill in. */
export const LEAD_EXTRA_NAMES: readonly string[] = ['consent', 'kind', 'magnet'];
export const HONEYPOT = 'website';
/** A lead_files id. */
export const LEAD_FILE_ID = /^[A-Za-z0-9_-]{22}$/;

/** Text cut to a field's limit (whole characters), for what a widget fills in. A field without a limit stays as it is. */
export function fitField(key: string, text: string): string {
  const max = LEAD_FIELDS[key] ?? LEAD_PAYLOAD_MAX[key];
  if (!max) return text;
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join('')}…` : text;
}
