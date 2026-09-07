import {
  Injectable,
  OnModuleDestroy,
  InternalServerErrorException,
} from '@nestjs/common';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly client: Redis;

  constructor(private configService: ConfigService) {
    const redisUrl = this.configService.get<string>('REDIS_URL');
    if (!redisUrl) {
      throw new InternalServerErrorException('REDIS_URL is not defined');
    }
    this.client = new Redis(redisUrl);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, value);
    }
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
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

  async onModuleDestroy() {
    await this.client.quit();
  }
}
