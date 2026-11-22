/// <reference lib="webworker" />
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
      ]);
    }
  } catch (err) {
    const msg: WorkerEnvelope = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
    scope.postMessage(msg);
  }
};
