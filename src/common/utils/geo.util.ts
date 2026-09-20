const EARTH_RADIUS_METERS = 6_371_000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Distance en mètres entre deux points GPS (formule de Haversine) — utilisée
 * pour comparer l'emplacement prévu d'une installation
 * (`Installation.plannedLatitude/plannedLongitude`) à l'emplacement constaté
 * sur la preuve envoyée par le prestataire (`PublicationProof.latitude/
 * longitude`).
 */
export function haversineDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(EARTH_RADIUS_METERS * c);
}

/**
 * Tolérance GPS pour considérer qu'une preuve correspond à l'emplacement
 * demandé — au-delà, la preuve est signalée pour revue humaine plutôt que
 * validée automatiquement. 100 m : ordre de grandeur de la précision GPS
 * d'un smartphone en extérieur en zone urbaine, pas une mesure calibrée.
 */
export const LOCATION_MATCH_THRESHOLD_METERS = 100;

export function isLocationMatch(distanceMeters: number): boolean {
  return distanceMeters <= LOCATION_MATCH_THRESHOLD_METERS;
}
