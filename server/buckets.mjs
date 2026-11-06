// The Storage buckets that hold a user's files, each under a folder named after the user's id (<bucket>/<user id>/…).
// Deleting an account clears that folder in every one (server/auth.mjs deleteUser).
//
//   media         private: uploads, AI images and videos, published pages' images   (20261102000000_accounts.sql)
//   lead-files    private: lead-magnet downloads, served through short signed links  (20261112000000_leads_p2.sql)
//   public-files  public, images only (no SVG): lead-magnet covers, email images     (20261112000000_leads_p2.sql)

export const LEAD_FILES_BUCKET = 'lead-files';
export const PUBLIC_FILES_BUCKET = 'public-files';
export const USER_BUCKETS = Object.freeze(['media', LEAD_FILES_BUCKET, PUBLIC_FILES_BUCKET]);

/**
 * Whether a Storage answer means the bucket isn't there (its migration wasn't run yet): Supabase answers 400 (or 404)
 * with "Bucket not found". Such a bucket holds nothing.
 */
export function bucketMissing(status, body) {
  if (status !== 400 && status !== 404) return false;
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  return /bucket not found/i.test(text.slice(0, 2000));
}
