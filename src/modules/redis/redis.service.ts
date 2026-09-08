import {
  Injectable,
  Logger,
  OnModuleDestroy,
  InternalServerErrorException,
} from '@nestjs/common';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: Redis;
  private readonly logger = new Logger(RedisService.name);

  constructor(private configService: ConfigService) {
    const redisUrl = this.configService.get<string>('REDIS_URL');
    if (!redisUrl) {
      throw new InternalServerErrorException('REDIS_URL is not defined');
    }

    this.client = new Redis(redisUrl, {
      // Évite qu'une commande reste bloquée indéfiniment si Redis est
      // injoignable : au-delà de 3 tentatives la promesse est rejetée et
      // l'erreur remonte proprement à l'appelant.
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      retryStrategy: (times: number) => Math.min(times * 200, 5000),
    });

    // CORRECTIF AUDIT (majeur — disponibilité) : un client ioredis sans
    // écouteur `error` fait émettre un événement 'error' non géré par Node,
    // ce qui termine le processus (`Unhandled 'error' event`). Une simple
    // coupure réseau vers Redis suffisait donc à faire tomber toute l'API.
    this.client.on('error', (err: Error) => {
      this.logger.error(`Redis connection error: ${err.message}`, err.stack);
    });
  }

  /**
   * Écrit une clé avec un TTL optionnel.
   *
   * CORRECTIF AUDIT (mineur) : `if (ttlSeconds)` traitait 0 et les valeurs
   * négatives comme « pas de TTL », créant des clés **permanentes** — une
   * fuite mémoire Redis silencieuse pour des données de session censées
   * expirer. Un TTL non strictement positif est désormais une erreur.
   */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds === undefined) {
      await this.client.set(key, value);
      return;
    }
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new InternalServerErrorException(
        `Invalid Redis TTL for key "${key}": ${ttlSeconds}`,
      );
    }
    await this.client.set(key, value, 'EX', Math.floor(ttlSeconds));
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  /**
   * Supprime toutes les clés correspondant à un motif.
   *
   * Utilise `SCAN` (curseur, non bloquant) et jamais `KEYS`, qui verrouille
   * le serveur Redis mono-thread le temps de parcourir l'intégralité de
   * l'espace de clés — inacceptable en production.
   */
  async delByPattern(pattern: string): Promise<number> {
    let cursor = '0';
    let deleted = 0;

    do {
      const [nextCursor, keys] = await this.client.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        deleted += await this.client.del(...keys);
      }
    } while (cursor !== '0');

    return deleted;
  }

  /**
   * Récupère puis supprime atomiquement une clé (commande Redis `GETDEL`,
   * disponible depuis Redis 6.2).
   *
   * CORRECTIF AUDIT (complément) : nécessaire pour implémenter un
   * mécanisme "single-use" réellement sans race condition. Un `get()` suivi
   * d'un `del()` séparés laisse une fenêtre entre les deux appels pendant
   * laquelle deux requêtes concurrentes peuvent toutes deux lire la valeur
   * avant qu'aucune n'ait supprimé la clé — exactement le type de TOCTOU
   * déjà corrigé ailleurs (verrous optimistes sur les campagnes). `GETDEL`
   * est atomique côté serveur Redis : au plus un appelant concurrent peut
   * recevoir la valeur, tous les autres reçoivent `null`.
   */
  async getDel(key: string): Promise<string | null> {
    return this.client.getdel(key);
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.client.exists(key);
    return result === 1;
  }

  /** TTL restant d'une clé, en secondes. Renvoie -2 si absente, -1 si sans expiration. */
  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  /**
   * Incrémente un compteur et garantit qu'il porte une expiration, en une
   * seule aller-retour atomique. Renvoie `[valeur, ttlRestantEnSecondes]`.
   *
   * Utilisé par `RedisThrottlerStorage`. `MULTI` garantit qu'aucune requête
   * concurrente ne peut s'intercaler entre l'INCR et la pose du TTL — sans
   * quoi un compteur pourrait rester sans expiration et bloquer un client
   * définitivement.
   */
  async incrementWithTtl(
    key: string,
    ttlSeconds: number,
  ): Promise<[number, number]> {
    const results = await this.client
      .multi()
      .incr(key)
      // NX : ne pose l'expiration que si la clé n'en a pas déjà une, afin de
      // ne pas prolonger la fenêtre glissante à chaque requête.
      .expire(key, ttlSeconds, 'NX')
      .ttl(key)
      .exec();

    if (!results) {
      throw new InternalServerErrorException(
        `Redis transaction failed for key "${key}"`,
      );
    }

    const total = Number(results[0]?.[1] ?? 0);
    const remaining = Number(results[2]?.[1] ?? ttlSeconds);
    return [total, remaining > 0 ? remaining : ttlSeconds];
  }

  async onModuleDestroy() {
    await this.client.quit();
  }
}
