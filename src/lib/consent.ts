// The words every public form uses about what happens to what a visitor sends, and the one box that asks
// for marketing emails. The server's lead-magnet gate uses the same strings (shared/leadConsent.json). The box
// is unticked by default and never needed to send: only consent=yes counts as agreeing to emails.

import words from '../../shared/leadConsent.json';

const brandOf = (brand: string) => brand.trim() || words.fallbackBrand;
const fill = (text: string, brand: string) => text.split('{Brand}').join(brandOf(brand));

/** "Email me tips and offers from {Brand}. I can unsubscribe at any time." */
export const consentLabel = (brand: string): string => fill(words.checkbox, brand);
/** "{Brand} receives what you send here." (small text under every public form) */
export const receivesNote = (brand: string): string => fill(words.receives, brand);
/** The lead-magnet gate's line. */
export const magnetReceivesNote = (brand: string): string => fill(words.magnetReceives, brand);
