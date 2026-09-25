import { createHash, timingSafeEqual } from 'crypto';
import { isIP } from 'net';

export const VISITOR_IP_HEADER = 'x-visitor-ip';
export const WEB_PROXY_SECRET_HEADER = 'x-web-proxy-secret';

export interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
}

/**
 * IP réelle du client, pour tout ce qui compte « par IP » (limiteur global
 * de `ThrottlerModule`, quotas de l'assistant vitrine).
 *
 * Le site (Next.js sur Vercel) relaie les requêtes du navigateur côté
 * serveur : `req.ip` y est l'IP de Vercel, COMMUNE à tous ses visiteurs —
 * 5 tentatives de connexion par minute pour tout le site, par exemple. Le
 * site transmet donc l'IP du visiteur dans `X-Visitor-IP`, crue UNIQUEMENT
 * accompagnée du secret partagé `WEB_PROXY_SECRET` : sans lui, n'importe
 * qui choisirait « son » IP et contournerait les limites. Sinon (appel
 * direct, app mobile, secret absent ou faux) : `req.ip`, qui tient déjà
 * compte du proxy Render (`trust proxy`).
 */
export function resolveClientIp(
  request: RequestLike,
  expectedSecret: string | undefined,
): string {
  const provided = request.headers[WEB_PROXY_SECRET_HEADER];
  const visitorIp = request.headers[VISITOR_IP_HEADER];

  if (
    expectedSecret &&
    typeof provided === 'string' &&
    typeof visitorIp === 'string' &&
    isIP(visitorIp) !== 0 &&
    safeCompare(provided, expectedSecret)
  ) {
    return visitorIp;
  }
  return request.ip ?? 'unknown';
}

function safeCompare(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}
