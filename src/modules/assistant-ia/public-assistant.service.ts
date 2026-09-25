import { createHash, timingSafeEqual } from 'crypto';
import { isIP } from 'net';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { RedisService } from '../redis/redis.service';
import { IA_ENGINE_TOKEN } from './clients/ia-engine.interface';
import type { IAEngineInterface } from './clients/ia-engine.interface';
import { PublicAskDto } from './dto/public-ask.dto';

/** Questions autorisées par visiteur (IP) : rafale courte, puis par jour. */
export const PUBLIC_LIMIT_PER_MINUTE = 3;
export const PUBLIC_LIMIT_PER_DAY = 10;
/** Plafond global par jour (tous visiteurs), protège le quota Gemini. */
const DEFAULT_PUBLIC_DAILY_LIMIT = 300;

const VISITOR_IP_HEADER = 'x-visitor-ip';
const WEB_PROXY_SECRET_HEADER = 'x-web-proxy-secret';
const HISTORY_MESSAGE_MAX_LENGTH = 1_500;

/**
 * Assistant vitrine du site public (visiteurs anonymes). Rien n'est
 * enregistré en base ; la protection repose entièrement sur les quotas
 * Redis ci-dessous, d'où leur rigueur : sans eux, n'importe quel robot
 * pourrait épuiser le quota Gemini partagé avec les clients connectés.
 */
@Injectable()
export class PublicAssistantService {
  private readonly logger = new Logger(PublicAssistantService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly configService: ConfigService,
    @Inject(IA_ENGINE_TOKEN) private readonly iaEngine: IAEngineInterface,
  ) {}

  async ask(dto: PublicAskDto, visitorIp: string): Promise<{ answer: string }> {
    await this.consumeQuota(visitorIp);

    try {
      const { answer } = await this.iaEngine.askPublicQuestion({
        userMessage: dto.message,
        recentMessages: (dto.history ?? []).map((m) => ({
          sender: m.sender,
          content: m.content.slice(0, HISTORY_MESSAGE_MAX_LENGTH),
        })),
      });
      return { answer };
    } catch (error) {
      this.logger.error(
        `Public assistant failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new ServiceUnavailableException(
        'The assistant is temporarily unavailable.',
      );
    }
  }

  /**
   * IP réelle du visiteur. Le site (Next.js sur Vercel) relaie les requêtes
   * côté serveur : `req.ip` y serait l'IP de Vercel, commune à TOUS les
   * visiteurs. Le site transmet donc l'IP du visiteur dans `X-Visitor-IP`,
   * crue UNIQUEMENT si elle est accompagnée du secret partagé
   * `WEB_PROXY_SECRET` — sinon n'importe qui pourrait choisir « son » IP et
   * contourner les quotas. Sans secret valide : `req.ip`.
   */
  resolveVisitorIp(request: Request): string {
    const expected = this.configService.get<string>('WEB_PROXY_SECRET');
    const provided = request.headers[WEB_PROXY_SECRET_HEADER];
    const visitorIp = request.headers[VISITOR_IP_HEADER];

    if (
      expected &&
      typeof provided === 'string' &&
      typeof visitorIp === 'string' &&
      isIP(visitorIp) !== 0 &&
      this.safeCompare(provided, expected)
    ) {
      return visitorIp;
    }
    return request.ip ?? 'unknown';
  }

  private async consumeQuota(visitorIp: string): Promise<void> {
    // L'IP n'est jamais stockée en clair dans Redis.
    const visitor = createHash('sha256')
      .update(visitorIp)
      .digest('hex')
      .slice(0, 32);

    const [perMinute] = await this.redis.incrementWithTtl(
      `assistant:public:visitor:${visitor}:minute`,
      60,
    );
    const [perDay] = await this.redis.incrementWithTtl(
      `assistant:public:visitor:${visitor}:day`,
      86_400,
    );
    if (perMinute > PUBLIC_LIMIT_PER_MINUTE || perDay > PUBLIC_LIMIT_PER_DAY) {
      throw new HttpException(
        'Too many questions. Create a free account to keep chatting.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const today = new Date().toISOString().slice(0, 10);
    const [global] = await this.redis.incrementWithTtl(
      `assistant:public:global:${today}`,
      90_000,
    );
    const globalLimit =
      this.configService.get<number>('PUBLIC_ASSISTANT_DAILY_LIMIT') ??
      DEFAULT_PUBLIC_DAILY_LIMIT;
    if (global > globalLimit) {
      this.logger.warn(`Public assistant daily limit reached (${globalLimit})`);
      throw new ServiceUnavailableException(
        'The demo assistant has reached its daily limit.',
      );
    }
  }

  private safeCompare(a: string, b: string): boolean {
    const hashA = createHash('sha256').update(a).digest();
    const hashB = createHash('sha256').update(b).digest();
    return timingSafeEqual(hashA, hashB);
  }
}
