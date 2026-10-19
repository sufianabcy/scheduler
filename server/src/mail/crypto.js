import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Refresh tokens are the one real secret in Mail: whoever has one can read that mailbox. They are stored
// encrypted with AES-256-GCM. The key (MAIL_TOKEN_KEY, 32 bytes, base64) comes from the environment, never the
// database, so a copy of the database or a backup is useless without it.
// Stored format: v1.<iv>.<auth tag>.<ciphertext>, each part base64url.

/** Reads MAIL_TOKEN_KEY; returns null when it isn't set (Mail is then switched off). */
export function loadKey(value) {
  if (!value) return null;
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('MAIL_TOKEN_KEY must be 32 bytes, base64 encoded');
  return key;
}

export function createTokenBox(key) {
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return ['v1', iv, cipher.getAuthTag(), data].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
    },

    /** Throws if the value was changed or sealed with another key. */
    open(sealed) {
      const [version, iv, tag, data] = String(sealed).split('.');
      if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Not a sealed token');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
    },
  };
}
