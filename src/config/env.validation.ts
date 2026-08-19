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
