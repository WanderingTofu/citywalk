import type { GeoBounds } from './Coordinates';

/**
 * OpenStreetMap access through the public Overpass API.
 *
 * Overpass instances are shared community infrastructure with rate limits, so
 * this module is deliberately polite: requests are spread across mirrors,
 * failures back off, and callers are expected to cache every result
 * (see GeoCache) so a tile is only ever downloaded once per browser.
 *
 * Data © OpenStreetMap contributors, ODbL 1.0.
 */

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export interface OsmGeomPoint {
  lat: number;
  lon: number;
}

export interface OsmMember {
  type: string;
  role: string;
  geometry?: OsmGeomPoint[];
}

export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: OsmGeomPoint[];
  members?: OsmMember[];
}

export interface OsmResponse {
  elements: OsmElement[];
}

/** Overpass QL for everything a tile needs, with inline geometry. */
export function buildQuery(b: GeoBounds): string {
  const bbox = `${b.south.toFixed(6)},${b.west.toFixed(6)},${b.north.toFixed(6)},${b.east.toFixed(6)}`;
  return `[out:json][timeout:25][bbox:${bbox}];
(
  way["building"];
  relation["building"]["type"="multipolygon"];
  way["highway"];
  way["railway"~"^(rail|light_rail|tram|subway)$"];
  way["waterway"~"^(river|canal|stream)$"];
  way["natural"~"^(water|wood|scrub|grassland)$"];
  way["leisure"~"^(park|garden|pitch|playground)$"];
  relation["leisure"~"^(park|garden)$"]["type"="multipolygon"];
  way["landuse"~"^(grass|forest|meadow|cemetery|recreation_ground|village_green|basin|reservoir)$"];
  node["natural"="tree"];
);
out geom qt;`;
}

export class OverpassError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Mirror rotation is shared by all requests from this worker so a failing mirror is skipped. */
let preferred = 0;

async function requestOnce(endpoint: string, query: string, timeoutMs: number): Promise<OsmResponse> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: ctl.signal,
    });
    if (res.status === 429 || res.status >= 500) {
      throw new OverpassError(`Overpass ${res.status}`, true);
    }
    if (!res.ok) throw new OverpassError(`Overpass ${res.status}`, false);
    const text = await res.text();
    // Overpass reports some overload conditions as an HTML/XML page with status 200.
    if (text.charCodeAt(0) !== 123 /* { */) throw new OverpassError('Overpass returned a non-JSON body', true);
    const json = JSON.parse(text) as OsmResponse & { remark?: string };
    if (json.remark && /timed out|out of memory/i.test(json.remark)) {
      throw new OverpassError('Overpass query ' + json.remark, true);
    }
    if (!Array.isArray(json.elements)) throw new OverpassError('Overpass response has no elements', true);
    return json;
  } catch (err) {
    if (err instanceof OverpassError) throw err;
    throw new OverpassError(err instanceof Error ? err.message : String(err), true);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch OSM data for a bounding box. Tries each mirror with backoff and throws
 * OverpassError once the attempts are exhausted; callers fall back to
 * procedural data rather than blocking the world.
 */
export async function fetchOsm(bounds: GeoBounds, attempts = 3, timeoutMs = 30000): Promise<OsmResponse> {
  const query = buildQuery(bounds);
  let lastError: unknown = null;
  for (let i = 0; i < attempts; i++) {
    const endpoint = OVERPASS_ENDPOINTS[(preferred + i) % OVERPASS_ENDPOINTS.length];
    try {
      const result = await requestOnce(endpoint, query, timeoutMs);
      preferred = (preferred + i) % OVERPASS_ENDPOINTS.length;
      return result;
    } catch (err) {
      lastError = err;
      if (err instanceof OverpassError && !err.retryable) break;
      await sleep(600 * 2 ** i + Math.random() * 400);
    }
  }
  preferred = (preferred + 1) % OVERPASS_ENDPOINTS.length;
  throw lastError instanceof Error ? lastError : new OverpassError('Overpass request failed', true);
}
