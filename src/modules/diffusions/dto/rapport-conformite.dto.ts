export interface RapportConformiteItemDto {
  diffusionId: string;
  scheduledAt: Date;
  actualBroadcastAt?: Date | null;
  status: string;
  ecartMinutes?: number | null;
}

export interface RapportConformiteDto {
  campagneId: string;
  campagneNom: string;
  diffusions: RapportConformiteItemDto[];
  totalDiffusions: number;
  diffusionsDiffusees: number;
  diffusionsManquees: number;
  diffusionsEnAttente: number;
}
