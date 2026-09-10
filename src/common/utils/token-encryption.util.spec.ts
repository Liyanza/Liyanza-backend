import { randomBytes } from 'crypto';
import { encryptToken, decryptToken } from './token-encryption.util';

describe('token-encryption.util', () => {
  const key = randomBytes(32).toString('base64');

  it('should round-trip encrypt/decrypt', () => {
    const plaintext = 'EAAG_meta_access_token_value_1234567890';
    const encrypted = encryptToken(plaintext, key);

    expect(encrypted.ciphertext).not.toContain(plaintext);
    expect(decryptToken(encrypted, key)).toBe(plaintext);
  });

  it('should use a fresh IV on every call (never reused for the same key)', () => {
    const a = encryptToken('same-plaintext', key);
    const b = encryptToken('same-plaintext', key);

    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('should reject a tampered ciphertext (GCM auth tag mismatch)', () => {
    const encrypted = encryptToken('secret-token', key);
    const tampered = {
      ...encrypted,
      ciphertext: Buffer.from('tampered-payload').toString('base64'),
    };

    expect(() => decryptToken(tampered, key)).toThrow();
  });

  it('should reject a key that does not decode to exactly 32 bytes', () => {
    const shortKey = Buffer.from('too-short').toString('base64');
    expect(() => encryptToken('value', shortKey)).toThrow(/32 bytes/);
  });
});
