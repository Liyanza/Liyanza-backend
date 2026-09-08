import { Injectable } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { RedisService } from '../../modules/redis/redis.service';

/**
 * Backend Redis pour `@nestjs/throttler`.
 *
 * CORRECTIF AUDIT (majeur — rate limiting inopérant en production) :
 * `ThrottlerModule.forRoot()` utilise par défaut un stockage EN MÉMOIRE,
 * local au processus. Le README prévoit un déploiement sur AWS ECS Fargate,
 * donc plusieurs tâches derrière un load balancer : avec N instances, un
 * attaquant obtient mécaniquement N × la limite annoncée (5 tentatives/min
 * sur `/auth/login` deviennent 5 × N), et le compteur est remis à zéro à
 * chaque redéploiement ou recyclage de tâche. La protection anti
 * brute-force / credential stuffing était donc essentiellement décorative.
 *
 * Cette implémentation partage l'état entre toutes les instances via Redis,
 * qui est déjà une dépendance de l'application (sessions, files BullMQ).
 *
 * L'incrément et la pose du TTL sont réalisés dans une transaction Redis
 * (`MULTI`) : l'opération est atomique côté serveur, donc immune aux
 * conditions de course entre requêtes concurrentes — y compris entre
 * instances distinctes.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const hitsKey = `throttle:${throttlerName}:${key}`;
    const blockKey = `throttle-block:${throttlerName}:${key}`;

    // `ttl` et `blockDuration` sont exprimés en millisecondes par @nestjs/throttler.
    const ttlSeconds = Math.max(1, Math.ceil(ttl / 1000));
    const blockSeconds = Math.max(1, Math.ceil(blockDuration / 1000));

    // Un blocage en cours court-circuite tout : on ne réincrémente pas, sinon
    // un attaquant prolongerait indéfiniment sa propre pénalité sans jamais
    // laisser la fenêtre se réinitialiser pour les requêtes légitimes.
    const blockTtl = await this.redis.ttl(blockKey);
    if (blockTtl > 0) {
      return {
        totalHits: limit + 1,
        timeToExpire: blockTtl,
        isBlocked: true,
        timeToBlockExpire: blockTtl,
      };
    }

    const [totalHits, currentTtl] = await this.redis.incrementWithTtl(
      hitsKey,
      ttlSeconds,
    );

    if (totalHits > limit) {
      await this.redis.set(blockKey, '1', blockSeconds);
      return {
        totalHits,
        timeToExpire: currentTtl,
        isBlocked: true,
        timeToBlockExpire: blockSeconds,
      };
    }

    return {
      totalHits,
      timeToExpire: currentTtl,
      isBlocked: false,
      timeToBlockExpire: 0,
    };
  }
}
