import { registerAs } from '@nestjs/config';

export default registerAs('jwt', () => ({
  secret: process.env.JWT_SECRET,
  accessExpiration: process.env.JWT_ACCESS_EXPIRATION ?? '15m',
  refreshExpiration: process.env.JWT_REFRESH_EXPIRATION ?? '7d',
  validationSecret: process.env.JWT_VALIDATION_SECRET,
  validationExpiration: process.env.JWT_VALIDATION_EXPIRATION ?? '7d',
}));
