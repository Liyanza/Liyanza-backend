import { IsOptional, IsString, IsNotEmpty, MaxLength } from 'class-validator';

/**
 * Corps optionnel de `POST /auth/logout`.
 *
 * Fournir `refreshToken` ferme uniquement la session correspondante ;
 * l'omettre révoque toutes les sessions actives de l'utilisateur.
 *
 * NOTE : ce DTO doit exister même « vide » car la `ValidationPipe` globale
 * est configurée avec `forbidNonWhitelisted: true` — sans DTO déclarant
 * `refreshToken`, l'envoi de ce champ provoquerait un 400.
 */
export class LogoutDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  refreshToken?: string;
}
