import { plainToInstance } from 'class-transformer';
import {
  IsDefined,
  IsEmail,
  IsIn,
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

  /**
   * SMTP (BACK-302 — worker de notifications async, canal email). Aucune
   * valeur par défaut : un secret/hôte manquant doit faire échouer le
   * démarrage plutôt que d'envoyer silencieusement des emails vers un
   * relais mal configuré. `SMTP_USER`/`SMTP_PASSWORD` peuvent être une
   * chaîne vide en développement local (ex: Mailhog, qui n'exige pas
   * d'authentification) — seule leur absence est rejetée.
   */
  @IsDefined()
  @IsString()
  SMTP_HOST!: string;

  @IsDefined()
  @IsNumber()
  @Min(1)
  SMTP_PORT!: number;

  @IsDefined()
  @IsString()
  SMTP_USER!: string;

  @IsDefined()
  @IsString()
  SMTP_PASSWORD!: string;

  @IsDefined()
  @IsEmail()
  SMTP_FROM!: string;

  /**
   * Stockage médias S3-compatible (BACK-307). Générique par conception
   * (`S3MediaStorageProvider` parle le protocole S3, pas une API propriétaire
   * AWS) : fonctionne à l'identique avec AWS S3, Cloudflare R2, Backblaze B2
   * ou MinIO (dev local) selon la valeur de `S3_ENDPOINT`.
   *
   * `S3_ENDPOINT` reste optionnel : laissé vide, le SDK AWS résout
   * l'endpoint standard `s3.<region>.amazonaws.com` (cas AWS S3 réel) ; toute
   * autre valeur (MinIO, R2, B2) doit fournir son endpoint explicitement.
   *
   * `S3_FORCE_PATH_STYLE` : `'true'` obligatoire pour MinIO (et souvent pour
   * les setups S3-compatibles auto-hébergés) — le style "virtual-hosted"
   * (bucket en sous-domaine) par défaut du SDK AWS n'y fonctionne pas.
   * Volontairement une chaîne `'true'|'false'` plutôt qu'un booléen : évite
   * toute ambiguïté sur la conversion implicite d'une variable d'env
   * (toujours une chaîne au niveau OS) vers `boolean`.
   */
  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  S3_ENDPOINT?: string;

  @IsDefined()
  @IsString()
  S3_REGION!: string;

  @IsDefined()
  @IsString()
  S3_BUCKET!: string;

  @IsDefined()
  @IsString()
  S3_ACCESS_KEY_ID!: string;

  @IsDefined()
  @IsString()
  S3_SECRET_ACCESS_KEY!: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  S3_FORCE_PATH_STYLE?: string;

  /**
   * Secret partagé protégeant `POST /internal/monitoring/detections`
   * (BACK-304) — remplace le mécanisme VPC prévu par la roadmap d'origine,
   * inapplicable sur Render. Même rigueur que `JWT_SECRET` : ce token
   * autorise l'écriture de constats de diffusion sans utilisateur
   * authentifié, un secret faible serait bruteforçable.
   */
  @IsDefined()
  @IsString()
  @MinLength(32, {
    message: 'INTERNAL_MONITORING_TOKEN must be at least 32 characters long.',
  })
  @NotEquals('changeme')
  INTERNAL_MONITORING_TOKEN!: string;
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
