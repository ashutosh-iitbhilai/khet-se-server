import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';

/**
 * Geocoding via OpenStreetMap Nominatim, proxied through the API so we can
 * send a proper User-Agent, restrict to India, and cache (Nominatim asks for ≤1 req/s).
 */

export interface GeoPlace {
  label: string;
  lat: number;
  lng: number;
  city?: string;
  district?: string;
  state?: string;
  pincode?: string;
  village?: string;
  line1?: string;
}

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 1000;
const cache = new Map<string, { at: number; value: unknown }>();

function cached<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
  if (hit) cache.delete(key);
  return undefined;
}
function store(key: string, value: unknown) {
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), value });
}

// Simple serial queue to respect Nominatim's 1 request/second policy per instance.
let last = 0;
async function throttle() {
  const wait = last + 1100 - Date.now();
  last = Math.max(Date.now(), last + 1100);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
  address?: Record<string, string>;
}

function toPlace(r: NominatimResult): GeoPlace {
  const a = r.address ?? {};
  return {
    label: r.display_name,
    lat: Number(r.lat),
    lng: Number(r.lon),
    // Villages and tahsils roll up to their district (e.g. "Raipur") for the city partition.
    city: a.city ?? a.state_district ?? a.town ?? a.county,
    district: a.state_district ?? a.county,
    state: a.state,
    pincode: a.postcode?.replace(/\s/g, '').slice(0, 6),
    village: a.village ?? a.hamlet ?? a.suburb,
    line1: [a.road, a.neighbourhood ?? a.suburb].filter(Boolean).join(', ') || undefined,
  };
}

async function nominatim(path: string, params: Record<string, string>) {
  const url = new URL(path, env.NOMINATIM_URL);
  for (const [k, v] of Object.entries({ format: 'jsonv2', addressdetails: '1', 'accept-language': 'en', ...params })) {
    url.searchParams.set(k, v);
  }
  await throttle();
  const res = await fetch(url, {
    headers: { 'User-Agent': env.NOMINATIM_USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  }).catch((err) => {
    logger.warn('Nominatim request failed', err);
    throw new ApiError(503, 'GEOCODER_UNAVAILABLE', 'Location search is unavailable right now. Drop the pin on the map instead.');
  });
  if (!res.ok) {
    throw new ApiError(503, 'GEOCODER_UNAVAILABLE', 'Location search is unavailable right now. Drop the pin on the map instead.');
  }
  return res.json();
}

export async function search(q: string): Promise<GeoPlace[]> {
  const key = `s:${q.toLowerCase()}`;
  const hit = cached<GeoPlace[]>(key);
  if (hit) return hit;
  const results = (await nominatim('/search', { q, countrycodes: 'in', limit: '6' })) as NominatimResult[];
  const places = results.map(toPlace);
  store(key, places);
  return places;
}

export async function reverse(lat: number, lng: number): Promise<GeoPlace | null> {
  // ~11 m precision is plenty for caching.
  const key = `r:${lat.toFixed(4)},${lng.toFixed(4)}`;
  const hit = cached<GeoPlace | null>(key);
  if (hit !== undefined) return hit;
  const result = (await nominatim('/reverse', { lat: String(lat), lon: String(lng), zoom: '16' })) as
    | NominatimResult
    | { error: string };
  const place = 'error' in result ? null : toPlace(result);
  store(key, place);
  return place;
}
