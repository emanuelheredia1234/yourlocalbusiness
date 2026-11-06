// Where a published page's forms send. Widgets, imported Manus/Viktor pages and the SEO page write the token
// {{lead-action}} where the address goes; publishing turns it into /<slug>/lead (server/leads.mjs keeps what's
// sent for the owner, in Email → Leads). Before publishing (the preview, a copy of an unpublished asset) a form's
// action attribute becomes "#", and a widget's script still sees the token, so it says it's a preview and sends
// nothing.

import { escapeHtml } from './utils';
import { LEAD_FILE_ID } from './leadFields';

export const LEAD_ACTION = '{{lead-action}}';

/**
 * Where a widget's form names the lead magnet it hands out: its hidden magnet field's value. Publishing writes the
 * business's current download id there (or nothing), so a widget made before the download, or a download published
 * again with a new id, still offers the right one once the asset is published again. Left as it is (a copy, the
 * preview) the server ignores it.
 */
export const LEAD_MAGNET = '{{lead-magnet}}';

/** Every {{lead-magnet}} becomes the download's id (22 URL-safe characters), or '' when there's none. */
export function resolveLeadMagnet(text: string, fileId: string | undefined): string {
  if (!text.includes(LEAD_MAGNET)) return text;
  return text.split(LEAD_MAGNET).join(fileId && LEAD_FILE_ID.test(fileId) ? fileId : '');
}

/** Whether a text has the token anywhere. */
export const hasLeadAction = (text: string): boolean => text.includes(LEAD_ACTION);

/** Every {{lead-action}} becomes `action` (an address: /<slug>/lead, or the full https://<app>/<slug>/lead). */
export function resolveLeadAction(text: string, action: string): string {
  return hasLeadAction(text) ? text.split(LEAD_ACTION).join(escapeHtml(action)) : text;
}

/** The address a published page's forms send to, on whichever host serves it. */
export const leadActionFor = (slug: string): string => `/${slug}/lead`;

/**
 * For the preview and a copy of an unpublished page: an action="{{lead-action}}" attribute becomes action="#"
 * (the form stays in place, sending nowhere). The token anywhere else stays, so a widget's script knows.
 */
export function previewLeadAction(html: string): string {
  return hasLeadAction(html) ? html.replace(/(\saction\s*=\s*)(["'])\{\{lead-action\}\}\2/gi, '$1$2#$2') : html;
}
