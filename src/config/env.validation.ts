import { plainToInstance } from 'class-transformer';
import {
  IsDefined,
  IsNumber,
  IsString,
  IsUrl,
  Min,
  MinLength,
  NotEquals,
  IsOptional,
  validateSync,
} from 'class-validator';

export class EnvironmentVariables {
  // Application
  @IsDefined()
  @IsString()
  NODE_ENV!: string;

  @IsDefined()
  @IsNumber()
  @Min(1)
  PORT!: number;

  // Database
  @IsDefined()
  @IsUrl({ protocols: ['postgresql'], require_tld: false })
  DATABASE_URL!: string;

  // Redis
  @IsDefined()
  @IsUrl({ protocols: ['redis'], require_tld: false })
  REDIS_URL!: string;

  // Security (JWT)
  //
  // CORRECTIF AUDIT (majeur) : `@IsString()` seul acceptait `JWT_SECRET=x`.
  // Un secret court est bruteforçable hors ligne à partir d'un unique token
  // capturé ; l'attaquant peut alors forger un JWT arbitraire — `{"role":
  // "ADMIN", "companyId": "<tenant cible>"}` — et compromettre l'intégralité
  // de la plateforme. HS256 exige une clé d'au moins 256 bits (32 octets) ;
  // on impose 32 caractères, et on refuse explicitement les valeurs
  // d'exemple qui traînent dans les `.env` de développement.
  @IsDefined()
  @IsString()
  @MinLength(32, {
    message:
      'JWT_SECRET must be at least 32 characters long (HS256 requires a 256-bit key).',
  })
  @NotEquals('supersecretkey')
  @NotEquals('changeme')
  JWT_SECRET!: string;

  @IsOptional()
  @IsString()
  JWT_ACCESS_EXPIRATION?: string;

  @IsOptional()
  @IsString()
  JWT_REFRESH_EXPIRATION?: string;

  // Security (CORS)
  /**
   * Whitelist d'origines autorisées, séparées par des virgules
   * (ex: "https://app.liyanza.com,https://admin.liyanza.com").
   * Le contrôle "pas de wildcard '*' en production" est fait au runtime
   * dans main.ts (dépend de NODE_ENV, difficile à exprimer proprement en
   * validateur déclaratif class-validator).
   */
  @IsDefined()
  @IsString()
  CORS_ORIGINS!: string;

  @IsDefined()
  @IsString()
  @MinLength(32, {
    message: 'JWT_VALIDATION_SECRET must be at least 32 characters long.',
  })
  JWT_VALIDATION_SECRET!: string;

  @IsOptional()
  @IsString()
  JWT_VALIDATION_EXPIRATION?: string;

  @IsDefined()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  VALIDATION_BASE_URL!: string;

  /**
   * URL publique de CETTE API (pas du frontend web), utilisée pour encoder
   * la cible réelle de `GET /qr/:code` dans l'image du QR code généré
   * (BACK-305) — contrairement à `VALIDATION_BASE_URL` qui pointe vers une
   * page du frontend `Liyanza` (Next.js).
   */
  @IsDefined()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  QR_CODE_BASE_URL!: string;
}

export function validate(config: Record<string, unknown>) {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(
      `❌ Invalid environment:\n${errors
        .map(
          (err) =>
            `  - ${err.property}: ${Object.values(err.constraints ?? {}).join(', ')}`,
        )
        .join('\n')}`,
    );
  }

  return validatedConfig;
}
