/**
 * Contrat de stockage de fichiers, découplé du fournisseur concret (BACK-307).
 * Toute implémentation doit parler le protocole S3 (AWS S3, Cloudflare R2,
 * Backblaze B2, MinIO...) — voir `S3MediaStorageProvider`. Permet de changer
 * de fournisseur en ne changeant que la config, jamais le code appelant
 * (`MediaService`).
 */
export interface PresignedUploadUrl {
  url: string;
  expiresAt: Date;
}

export interface PresignedDownloadUrl {
  url: string;
  expiresAt: Date;
}

export interface ObjectMetadata {
  contentType: string;
  sizeBytes: number;
}

export interface MediaStorageProvider {
  getPresignedUploadUrl(
    key: string,
    contentType: string,
  ): Promise<PresignedUploadUrl>;

  getPresignedDownloadUrl(key: string): Promise<PresignedDownloadUrl>;

  /**
   * Retourne `null` si l'objet n'existe pas (upload jamais effectué ou
   * échoué) plutôt que de lever — c'est un cas nominal pour
   * `MediaService.confirmUpload`, pas une erreur de transport.
   */
  headObject(key: string): Promise<ObjectMetadata | null>;

  deleteObject(key: string): Promise<void>;
}

export const MEDIA_STORAGE_PROVIDER_TOKEN = 'MEDIA_STORAGE_PROVIDER_TOKEN';
