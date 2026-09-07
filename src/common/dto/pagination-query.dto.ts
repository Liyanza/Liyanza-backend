import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * DTO de pagination réutilisable.
 *
 * SÉCURITÉ (correctif audit — majeur) : `limit` est désormais borné
 * (`@Max(100)`) partout où cette classe est utilisée. Auparavant, plusieurs
 * endpoints (`GET /campagnes`, `GET /entreprises`) acceptaient un `limit`
 * arbitrairement grand (`?limit=1000000`), permettant un déni de service
 * applicatif via une requête `findMany` massive.
 */
export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;
}
