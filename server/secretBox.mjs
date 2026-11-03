// AES-256-GCM sealing for secrets the server keeps in Supabase (API keys, settings).
// The key is derived from a server-only secret plus a label, so different uses never share a key;
// the AAD binds each ciphertext to where it belongs (a row can't be copied to another row).

import crypto from 'node:crypto';

export function createSecretBox(secret, label) {
  const key = crypto.createHash('sha256').update(`${label}:${secret}`).digest();
  return {
    seal(plain, aad) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      c.setAAD(Buffer.from(aad));
      const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
    },
    open(b64, aad) {
      const raw = Buffer.from(b64, 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    },
  };
}

/** Headers for Supabase's REST API with the secret key (new sb_secret_ keys go in apikey only). */
export const serviceHeaders = (secretKey) => ({ apikey: secretKey, 'content-type': 'application/json', ...(secretKey.startsWith('sb_secret_') ? {} : { authorization: `Bearer ${secretKey}` }) });
