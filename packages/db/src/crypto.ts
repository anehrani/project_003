/**
 * Token encryption at rest — AES-256-GCM (spec §8 Security).
 *
 * Format: v1:<iv-b64>:<authTag-b64>:<ciphertext-b64>
 *
 * Set APP_ENCRYPTION_KEY in the environment:
 *   - a 64-char hex string (32 bytes), OR
 *   - any long random string (hashed to 32 bytes with SHA-256).
 *
 * NEVER log tokens. NEVER store them unencrypted. NEVER put them in URLs.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function keyFromSecret(secret: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(secret)) {
    return Buffer.from(secret, 'hex');
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function encryptToken(plaintext: string, secret: string): string {
  const key = keyFromSecret(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decryptToken(payload: string, secret: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Invalid encrypted payload format');
  }
  const key = keyFromSecret(secret);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

/** Safe representation for logs and error messages. */
export function maskToken(token: string): string {
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

/** Strips anything token-shaped out of strings before they reach a log file. */
export function redact(text: string): string {
  return text
    .replace(/access_token=[^&"\s]+/gi, 'access_token=[REDACTED]')
    .replace(/EA[A-Za-z0-9_-]{10,}/g, 'EA…[REDACTED]');
}
