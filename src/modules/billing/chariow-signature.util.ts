import { createHmac, timingSafeEqual } from 'crypto';

export const CHARIOW_SIGNATURE_HEADER = 'x-chariow-signature';
export const PULSE_DELIVERY_ID_HEADER = 'x-pulse-delivery-id';

/**
 * Vérifie la signature d'une Pulse Chariow :
 * `x-chariow-signature: sha256=<hex HMAC-SHA256(corps brut, secret)>`.
 *
 * Le HMAC porte sur les OCTETS reçus, jamais sur un JSON re-sérialisé
 * (ordre des clés, espaces, échappements : la moindre différence casse la
 * signature — ou pire, en ferait accepter une autre). Comparaison en temps
 * constant, après un contrôle de longueur (`timingSafeEqual` lève sinon).
 */
export function verifyChariowSignature(
  rawBody: Buffer | undefined,
  signature: string | undefined,
  secret: string | undefined,
): boolean {
  if (!rawBody || !secret || typeof signature !== 'string') return false;
  const expected = Buffer.from(
    `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`,
  );
  const provided = Buffer.from(signature.trim());
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
