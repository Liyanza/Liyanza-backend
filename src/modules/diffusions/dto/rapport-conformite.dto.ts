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
  /** Diffusions annulées, exclues du calcul de conformité. */
  diffusionsAnnulees: number;
  /**
   * Ratio diffusées / (diffusées + manquées), arrondi à 4 décimales.
   * `null` lorsqu'aucune diffusion n'est encore échue — distinguer
   * « aucune donnée » de « 0 % de conformité » est essentiel pour ne pas
   * afficher un taux catastrophique sur une campagne qui n'a pas démarré.
   */
  tauxConformite: number | null;
}
