import { IsEmail, IsNotEmpty, MinLength, IsString } from 'class-validator';

/**
 * DTO d'inscription publique (`POST /auth/register`).
 *
 * SÉCURITÉ (correctif audit — faille critique) : `role` et `companyId` ont
 * été volontairement retirés de ce DTO. Les laisser fournis par le client
 * permettait à n'importe quel visiteur non authentifié de s'auto-promouvoir
 * `ADMIN` et de rejoindre l'entreprise de son choix (`companyId` arbitraire),
 * brisant totalement l'isolation multi-tenant.
 *
 * Le rôle et le rattachement à une entreprise sont désormais TOUJOURS décidés
 * côté serveur (voir `AuthService.register()`), jamais par le payload client.
 * Pour rejoindre une entreprise, les seuls chemins valides sont :
 *  - `POST /entreprises` (création d'une nouvelle entreprise, l'utilisateur
 *    en devient automatiquement ADMIN) ;
 *  - `POST /users` (invitation d'un sous-compte par un ADMIN déjà légitime
 *    de l'entreprise, via `UsersService.createSubAccount`).
 */
export class RegisterDto {
  @IsEmail()
  @IsNotEmpty()
  email!: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  password!: string;

  @IsString()
  @IsNotEmpty()
  firstName!: string;

  @IsString()
  @IsNotEmpty()
  lastName!: string;

  @IsString()
  @IsNotEmpty()
  phone!: string;
}
