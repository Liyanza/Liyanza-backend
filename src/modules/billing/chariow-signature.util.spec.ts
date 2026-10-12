import { createHmac } from 'crypto';
import { verifyChariowSignature } from './chariow-signature.util';

describe('verifyChariowSignature', () => {
  const secret = 'whsec_test_secret_123456';
  // Espaces et ordre des clés volontairement « non canoniques » : c'est ce
  // corps-là, octet pour octet, que Chariow a signé.
  const rawBody = Buffer.from(
    '{"event":"successful.sale",  "sale":{"id":"sal_1","amount":{"value":20000}}}',
  );
  const sign = (body: Buffer | string, key = secret) =>
    `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;

  it('should accept a valid signature of the raw body', () => {
    expect(verifyChariowSignature(rawBody, sign(rawBody), secret)).toBe(true);
  });

  it('should reject a signature computed on the re-serialized JSON', () => {
    const reserialized = JSON.stringify(JSON.parse(rawBody.toString('utf8')));
    expect(reserialized).not.toEqual(rawBody.toString('utf8'));
    expect(verifyChariowSignature(rawBody, sign(reserialized), secret)).toBe(
      false,
    );
  });

  it('should reject a tampered body', () => {
    const tampered = Buffer.from(
      rawBody.toString('utf8').replace('sal_1', 'sal_2'),
    );
    expect(verifyChariowSignature(tampered, sign(rawBody), secret)).toBe(false);
  });

  it('should reject a signature made with another secret', () => {
    expect(
      verifyChariowSignature(rawBody, sign(rawBody, 'whsec_other'), secret),
    ).toBe(false);
  });

  it('should reject (not throw) on a length mismatch', () => {
    expect(verifyChariowSignature(rawBody, 'sha256=abc', secret)).toBe(false);
    expect(
      verifyChariowSignature(rawBody, sign(rawBody).slice(7), secret),
    ).toBe(false);
  });

  it('should reject a missing header, body or secret', () => {
    expect(verifyChariowSignature(rawBody, undefined, secret)).toBe(false);
    expect(verifyChariowSignature(undefined, sign(rawBody), secret)).toBe(
      false,
    );
    expect(verifyChariowSignature(rawBody, sign(rawBody), undefined)).toBe(
      false,
    );
  });
});
