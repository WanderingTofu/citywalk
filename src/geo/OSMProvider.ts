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

const REQUEST_HEADERS: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
// Outside a browser (the bake script) there is no default identity, and Overpass asks clients for one.
if (typeof navigator === 'undefined' || !('userAgent' in navigator) || /node/i.test(navigator.userAgent)) {
  REQUEST_HEADERS['User-Agent'] = 'citywalk-bake/0.1';
}

/** Mirrors that failed recently are skipped until this time (ms since epoch), per mirror. */
const benched = new Map<string, number>();
const BENCH_MS = 90_000;
/** Mirror that answered last; tried first next time. */
let preferred = 0;

async function requestOnce(endpoint: string, query: string, timeoutMs: number, outer: AbortSignal): Promise<OsmResponse> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onOuter = () => ctl.abort();
  outer.addEventListener('abort', onOuter);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(query),
      headers: REQUEST_HEADERS,
      signal: ctl.signal,
    });
    if (res.status === 429 || res.status >= 500) throw new OverpassError(`Overpass ${res.status}`, true);
    if (!res.ok) throw new OverpassError(`Overpass ${res.status}`, false);
    const text = await res.text();
    // Overpass reports some overload conditions as an HTML/XML page with status 200.
    if (text.charCodeAt(0) !== 123 /* { */) throw new OverpassError('Overpass returned a non-JSON body', true);
    const json = JSON.parse(text) as OsmResponse & { remark?: string };
    if (json.remark && /timed out|out of memory/i.test(json.remark)) throw new OverpassError('Overpass query ' + json.remark, true);
    if (!Array.isArray(json.elements)) throw new OverpassError('Overpass response has no elements', true);
    return json;
  } catch (err) {
    if (err instanceof OverpassError) throw err;
    const aborted = ctl.signal.aborted;
    throw new OverpassError(aborted ? 'no answer in time' : err instanceof Error ? err.message : String(err), true);
  } finally {
    clearTimeout(timer);
    outer.removeEventListener('abort', onOuter);
  }
}

export interface FetchOptions {
  /** Give up on a single mirror after this long. */
  timeoutMs?: number;
  /** If a mirror has not answered after this long, ask the next one as well. */
  hedgeMs?: number;
  /** How long a mirror that failed is left alone. 0 = always ask every mirror (for batch jobs that pace themselves). */
  benchMs?: number;
}

/**
 * Fetch OSM data for a bounding box.
 *
 * Requests are hedged: the preferred mirror is asked first; if it is slow, the
 * next mirror is asked too and whichever answers first wins (the other is
 * cancelled). A mirror that fails is benched for a couple of minutes, so one
 * dead server costs a single short wait, not one per tile. Throws
 * OverpassError when every mirror has failed; callers fall back to
 * procedural data rather than blocking the world.
 */
export async function fetchOsm(bounds: GeoBounds, options: FetchOptions = {}): Promise<OsmResponse> {
  const timeoutMs = options.timeoutMs ?? 12_000;
  const hedgeMs = options.hedgeMs ?? 3_000;
  const benchMs = options.benchMs ?? BENCH_MS;
  const query = buildQuery(bounds);
  const now = Date.now();
  // Mirrors that failed in the last couple of minutes are not asked again yet. If that
  // leaves none, fail at once: the caller falls back, and nobody waits on dead servers.
  const order = OVERPASS_ENDPOINTS.map((_, i) => (preferred + i) % OVERPASS_ENDPOINTS.length).filter(
    (i) => (benched.get(OVERPASS_ENDPOINTS[i]) ?? 0) <= now,
  );
  if (order.length === 0) throw new OverpassError('map servers are not responding', true);

  const all = new AbortController();
  return new Promise<OsmResponse>((resolve, reject) => {
    let next = 0;
    let pending = 0;
    let settled = false;
    let lastError: Error = new OverpassError('Overpass request failed', true);
    let hedge: ReturnType<typeof setTimeout> | undefined;

    const launch = () => {
      if (settled || next >= order.length) return;
      const index = order[next++];
      const endpoint = OVERPASS_ENDPOINTS[index];
      pending++;
      clearTimeout(hedge);
      if (next < order.length) hedge = setTimeout(launch, hedgeMs);
      requestOnce(endpoint, query, timeoutMs, all.signal).then(
        (result) => {
          if (settled) return;
          settled = true;
          preferred = index;
          benched.delete(endpoint);
          clearTimeout(hedge);
          all.abort();
          resolve(result);
        },
        (err: Error) => {
          pending--;
          if (settled) return;
          lastError = err;
          if (benchMs > 0) benched.set(endpoint, Date.now() + benchMs);
          if (err instanceof OverpassError && !err.retryable) next = order.length;
          if (next < order.length) launch();
          else if (pending === 0) {
            settled = true;
            clearTimeout(hedge);
            reject(lastError);
          }
        },
      );
    };
    launch();
  });
}
