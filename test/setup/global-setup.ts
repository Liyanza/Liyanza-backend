import { config } from 'dotenv';
import { resolve } from 'path';

/**
 * `globalSetup` Jest (BACK-402) : exécuté une seule fois, dans le process
 * parent, AVANT que Jest ne forke les workers qui chargent réellement
 * `AppModule`. `process.env` muté ici est hérité par ces workers (héritage
 * standard `child_process.fork`) — c'est le seul point fiable pour basculer
 * `AppModule` sur la base de données/Redis dédiées aux tests E2E plutôt que
 * sur celles du poste de dev (`.env`), sans dépendre d'un package
 * supplémentaire (`cross-env`/`dotenv-cli`) ni d'un script différent par OS.
 *
 * `override: true` : si `.env` a déjà été chargé pour une autre raison dans
 * ce process, `.env.test` doit rester prioritaire pour la suite E2E.
 */
export default function globalSetup(): void {
  process.env.NODE_ENV = 'test';
  config({ path: resolve(__dirname, '../../.env.test'), override: true });
}
