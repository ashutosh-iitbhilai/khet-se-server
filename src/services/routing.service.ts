import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Road distances from one origin to many destinations via the OSRM "table" service.
 * Returns km per destination (null when unroutable). Never throws — road distance
 * is an enhancement; callers fall back to straight-line distance.
 */
export async function roadDistancesKm(
  origin: { lng: number; lat: number },
  destinations: { lng: number; lat: number }[],
): Promise<(number | null)[]> {
  if (!env.ROAD_DISTANCE_ENABLED || destinations.length === 0) return destinations.map(() => null);

  const coords = [origin, ...destinations].map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const url = `${env.OSRM_URL}/table/v1/driving/${coords}?sources=0&annotations=distance`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000), headers: { 'User-Agent': env.NOMINATIM_USER_AGENT } });
    if (!res.ok) throw new Error(`OSRM ${res.status}`);
    const json = (await res.json()) as { code: string; distances?: (number | null)[][] };
    if (json.code !== 'Ok' || !json.distances) throw new Error(`OSRM ${json.code}`);
    // Row 0 = from origin; column 0 is the origin itself.
    return json.distances[0].slice(1).map((m) => (m == null ? null : Math.round(m / 100) / 10));
  } catch (err) {
    logger.warn(`Road distance unavailable: ${(err as Error).message}`);
    return destinations.map(() => null);
  }
}
