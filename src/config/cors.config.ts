import { registerAs } from '@nestjs/config';

/**
 * Origines autorisées à appeler l'API, sous forme de whitelist explicite.
 * Chargée depuis la variable d'environnement `CORS_ORIGINS`
 * (liste d'URLs séparées par des virgules, ex:
 * "https://app.liyanza.com,https://admin.liyanza.com").
 *
 * Aucun wildcard "*" ne doit être présent en production — vérifié au
 * démarrage dans `main.ts`.
 */
export default registerAs('cors', () => ({
  origins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
}));
