/// <reference lib="webworker" />
import { bakedName, decodeTile, type BakedIndex, type BakedTile } from '../geo/BakedTiles';
import { LocalProjection } from '../geo/Coordinates';
import { generateDemoFeatures } from '../geo/DemoProvider';
import { cacheGet, cachePut } from '../geo/GeoCache';
import { parseOsm } from '../geo/OSMParser';
import { fetchOsm } from '../geo/OSMProvider';
import { tileBounds, tileKey } from '../geo/TileAddress';
import { buildTile, tileTransferables } from '../geo/TileBuilder';
import { buildChunkGeometry } from './ChunkBuilder';
import { meshTransferables } from './MeshWriter';
import type { TileRequest, TileResponse, WorkerEnvelope, WorkerRequest } from './protocol';

/**
 * Generation worker. Everything expensive happens here, off the render
 * thread: network, JSON parsing, projection, triangulation and mesh assembly.
 * The worker is stateless between messages apart from the IndexedDB cache.
 */

/** Which tiles each district has baked, fetched once per worker. */
const bakedIndexes = new Map<string, Promise<Set<string>>>();

function bakedIndex(url: string): Promise<Set<string>> {
  let p = bakedIndexes.get(url);
  if (!p) {
    p = fetch(url + 'index.json')
      .then((r) => (r.ok ? (r.json() as Promise<BakedIndex>) : null))
      .then((index) => new Set(index?.tiles ?? []))
      .catch(() => new Set<string>());
    bakedIndexes.set(url, p);
  }
  return p;
}

async function loadBaked(req: TileRequest): Promise<TileResponse | null> {
  const name = bakedName(req.tx, req.tz);
  if (!(await bakedIndex(req.bakedUrl)).has(name)) return null;
  try {
    const res = await fetch(`${req.bakedUrl}${name}.json`);
    if (!res.ok) return null;
    return { tile: decodeTile((await res.json()) as BakedTile) };
  } catch {
    return null;
  }
}

async function loadTile(req: TileRequest): Promise<TileResponse> {
  const { frameId, tx, tz } = req;
  if (req.mode === 'demo') {
    return { tile: buildTile(frameId, tx, tz, generateDemoFeatures(frameId, tx, tz), 'demo') };
  }
  const cached = await cacheGet(tileKey(frameId, tx, tz));
  if (cached) {
    cached.source = 'cache';
    return { tile: cached };
  }
  // Tiles shipped with the app come first: same host, no rate limits, no waiting.
  const baked = await loadBaked(req);
  if (baked) return baked;
  const proj = new LocalProjection(req.origin);
  const tb = tileBounds(tx, tz);
  try {
    const osm = await fetchOsm(proj.boundsOf(tb.minX, tb.minZ, tb.maxX, tb.maxZ));
    const tile = buildTile(frameId, tx, tz, parseOsm(osm, proj), 'osm');
    await cachePut(tile);
    return { tile };
  } catch (err) {
    // Never leave a hole: substitute procedural data and report why. Not cached,
    // so the real tile is requested again on the next visit.
    const tile = buildTile(frameId, tx, tz, generateDemoFeatures(frameId, tx, tz), 'fallback');
    return { tile, error: err instanceof Error ? err.message : String(err) };
  }
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (e: MessageEvent<{ id: number; req: WorkerRequest }>) => {
  const { id, req } = e.data;
  try {
    if (req.type === 'tile') {
      const result = await loadTile(req);
      const msg: WorkerEnvelope = { id, ok: true, result };
      scope.postMessage(msg, tileTransferables(result.tile));
    } else {
      const result = buildChunkGeometry(req.chunk, req.style, req.opts);
      const msg: WorkerEnvelope = { id, ok: true, result };
      scope.postMessage(msg, [
        ...meshTransferables(result.buildings),
        ...meshTransferables(result.ground),
        result.trees.buffer as ArrayBuffer,
        result.lamps.buffer as ArrayBuffer,
        result.cars.buffer as ArrayBuffer,
      ]);
    }
  } catch (err) {
    const msg: WorkerEnvelope = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
    scope.postMessage(msg);
  }
};
