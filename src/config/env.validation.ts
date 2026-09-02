import { plainToInstance } from 'class-transformer';
import {
  IsDefined,
  IsNumber,
  IsString,
  IsUrl,
  Min,
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
  @IsDefined()
  @IsString()
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
  JWT_VALIDATION_SECRET!: string;

  @IsOptional()
  @IsString()
  JWT_VALIDATION_EXPIRATION?: string;

  @IsDefined()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  VALIDATION_BASE_URL!: string;
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
