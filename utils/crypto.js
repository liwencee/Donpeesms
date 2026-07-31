/**
 * AES-256-GCM encryption for secrets stored at rest (e.g. admin-entered
 * API provider keys). Key comes from ENCRYPTION_KEY (32-byte hex).
 */
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

function _key() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('ENCRYPTION_KEY env var must be set to a 32-byte hex string (64 chars)');
  }
  return Buffer.from(hex, 'hex');
}

// Returns "iv:authTag:ciphertext" (all hex), or null if given a falsy value.
function encrypt(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, _key(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), enc.toString('hex')].join(':');
}

function decrypt(packed) {
  if (!packed) return null;
  const [ivHex, tagHex, dataHex] = String(packed).split(':');
  if (!ivHex || !tagHex || !dataHex) return null;
  const decipher = crypto.createDecipheriv(ALGO, _key(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return dec.toString('utf8');
}

// Show only the last 4 characters for display, e.g. "••••••ab12".
function maskSecret(plaintext) {
  if (!plaintext) return null;
  const s = String(plaintext);
  return s.length <= 4 ? '••••' : '••••••' + s.slice(-4);
}

module.exports = { encrypt, decrypt, maskSecret };
