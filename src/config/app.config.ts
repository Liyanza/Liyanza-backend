import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV,
  port: parseInt(process.env.PORT ?? '3000', 10),
  /**
   * Nombre de proxys de confiance devant l'application (`app.set('trust proxy', n)`).
   *
   * Détermine à quelle profondeur Express remonte l'en-tête `X-Forwarded-For`
   * pour résoudre `req.ip` — la clé de comptage du rate limiting. Valeur par
   * défaut : 1 (un unique ALB). À augmenter uniquement si une couche
   * supplémentaire que NOUS opérons s'intercale (ex: CloudFront + ALB = 2).
   *
   * ⚠️ Ne jamais configurer `true` : tout client pourrait alors usurper son
   * IP via `X-Forwarded-For` et contourner le throttler.
   */
  trustProxyHops: parseInt(process.env.TRUST_PROXY_HOPS ?? '1', 10),
}));
