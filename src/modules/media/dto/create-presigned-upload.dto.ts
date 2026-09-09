import { IsIn } from 'class-validator';

// Whitelist volontairement restrictive : ce sont les seuls types de fichiers
// utiles au cadrage actuel (preuve d'installation photographiée, document
// justificatif). Étendre cette liste est une décision produit, pas une
// simplification technique à faire à la légère (voir §10 du skill sécurité —
// tout type accepté élargit la surface d'attaque du provider de stockage).
export const ALLOWED_MEDIA_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

export type AllowedMediaContentType =
  (typeof ALLOWED_MEDIA_CONTENT_TYPES)[number];

export class CreatePresignedUploadDto {
  @IsIn(ALLOWED_MEDIA_CONTENT_TYPES)
  contentType!: AllowedMediaContentType;
}
