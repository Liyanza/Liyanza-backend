import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12; // taille standard recommandée pour GCM (96 bits)
const KEY_LENGTH_BYTES = 32; // AES-256

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  tag: string;
}

/**
 * Chiffrement/déchiffrement des tokens OAuth (`SocialAccount.accessToken*`)
 * — AES-256-GCM via le module `crypto` natif de Node, aucune dépendance npm
 * supplémentaire. La clé (`SOCIAL_TOKEN_ENCRYPTION_KEY`) est une chaîne
 * base64 de 32 octets, validée au démarrage (voir `env.validation.ts`) — un
 * mauvais format échoue ici avec un message explicite plutôt que de
 * corrompre silencieusement des tokens déjà chiffrés.
 */
function decodeKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `SOCIAL_TOKEN_ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH_BYTES} bytes (got ${key.length}).`,
    );
  }
  return key;
}

export function encryptToken(
  plaintext: string,
  base64Key: string,
): EncryptedPayload {
  const key = decodeKey(base64Key);
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

export function decryptToken(
  payload: EncryptedPayload,
  base64Key: string,
): string {
  const key = decodeKey(base64Key);
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(payload.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
