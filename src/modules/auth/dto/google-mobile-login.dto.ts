import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * BACK-507 — Corps de `POST /auth/google/mobile`, appelé par l'app Flutter
 * juste après `GoogleSignIn.authentication` (pas de `redirect_uri`/`state`
 * ici, contrairement au flow navigateur BACK-505 : le SDK natif a déjà résolu
 * l'identité sur l'appareil, il ne reste qu'à vérifier ce JWT côté serveur).
 */
export class GoogleMobileLoginDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  idToken!: string;
}
