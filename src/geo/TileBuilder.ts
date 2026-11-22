import { centroid, clipToRect, ringBounds, signedArea } from './polygon';
import type { RawFeatures } from './OSMParser';
import { CHUNKS_PER_TILE, CHUNK_SIZE, chunkBounds, chunkKey, tileBounds, tileKey } from './TileAddress';
import type { ChunkData, RoadFeature, TileData, TileSource } from '../world/types';

/**
 * Distribute a tile's features into its chunks.
 *
 * Neighbouring tile queries overlap (Overpass returns whole ways), so
 * ownership is decided geometrically and identically on both sides:
 *   - a building belongs to the chunk containing its centroid,
 *   - a road segment belongs to the chunk containing its midpoint,
 *   - areas are clipped to each chunk's rectangle,
 *   - a tree belongs to the chunk containing it.
 * Anything owned by a chunk outside this tile is dropped here and picked up by
 * the tile that does own it, so nothing is duplicated or lost across seams.
 */
export function buildTile(
  cityId: string,
  tx: number,
  tz: number,
  raw: RawFeatures,
  source: TileSource,
): TileData {
  const chunks: Record<string, ChunkData> = {};
  const cx0 = tx * CHUNKS_PER_TILE;
  const cz0 = tz * CHUNKS_PER_TILE;
  for (let dz = 0; dz < CHUNKS_PER_TILE; dz++) {
    for (let dx = 0; dx < CHUNKS_PER_TILE; dx++) {
      const cx = cx0 + dx;
      const cz = cz0 + dz;
      chunks[chunkKey(cx, cz)] = { cx, cz, buildings: [], roads: [], areas: [], trees: new Float32Array(0) };
    }
  }
  const owner = (x: number, z: number): ChunkData | undefined =>
    chunks[chunkKey(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE))];

  for (const b of raw.buildings) {
    const [x, z] = centroid(b.rings[0]);
    const c = owner(x, z);
    if (!c) continue;
    c.buildings.push({
      id: b.id,
      rings: b.rings.map((r) => new Float32Array(r)),
      height: b.height,
      levels: b.levels,
      minHeight: b.minHeight,
      kind: b.kind,
      area: b.area,
    });
  }

  for (const r of raw.roads) {
    // Walk the polyline, cutting it into runs of consecutive segments with the same owner.
    let run: number[] = [];
    let runOwner: ChunkData | undefined;
    const flush = () => {
      if (runOwner && run.length >= 4) {
        const piece: RoadFeature = { id: r.id, pts: new Float32Array(run), width: r.width, kind: r.kind };
        runOwner.roads.push(piece);
      }
      run = [];
    };
    for (let i = 0; i + 3 < r.pts.length; i += 2) {
      const ax = r.pts[i];
      const az = r.pts[i + 1];
      const bx = r.pts[i + 2];
      const bz = r.pts[i + 3];
      // Long segments are subdivided so each piece has a well-defined owner.
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (CHUNK_SIZE * 0.5)));
      for (let s = 0; s < steps; s++) {
        const x0 = ax + ((bx - ax) * s) / steps;
        const z0 = az + ((bz - az) * s) / steps;
        const x1 = ax + ((bx - ax) * (s + 1)) / steps;
        const z1 = az + ((bz - az) * (s + 1)) / steps;
        const o = owner((x0 + x1) / 2, (z0 + z1) / 2);
        if (o !== runOwner) {
          flush();
          runOwner = o;
        }
        if (run.length === 0) run.push(x0, z0);
        run.push(x1, z1);
      }
    }
    flush();
  }

  const tb = tileBounds(tx, tz);
  for (const a of raw.areas) {
    const b = ringBounds(a.ring);
    if (b.maxX < tb.minX || b.minX > tb.maxX || b.maxZ < tb.minZ || b.minZ > tb.maxZ) continue;
    const c0x = Math.max(cx0, Math.floor(b.minX / CHUNK_SIZE));
    const c1x = Math.min(cx0 + CHUNKS_PER_TILE - 1, Math.floor(b.maxX / CHUNK_SIZE));
    const c0z = Math.max(cz0, Math.floor(b.minZ / CHUNK_SIZE));
    const c1z = Math.min(cz0 + CHUNKS_PER_TILE - 1, Math.floor(b.maxZ / CHUNK_SIZE));
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const cb = chunkBounds(cx, cz);
        const clipped = clipToRect(a.ring, cb.minX, cb.minZ, cb.maxX, cb.maxZ);
        if (clipped.length >= 6 && Math.abs(signedArea(clipped)) > 2) {
          chunks[chunkKey(cx, cz)].areas.push({ id: a.id, ring: new Float32Array(clipped), kind: a.kind });
        }
      }
    }
  }

  const treeLists = new Map<ChunkData, number[]>();
  for (let i = 0; i < raw.trees.length; i += 2) {
    const c = owner(raw.trees[i], raw.trees[i + 1]);
    if (!c) continue;
    let list = treeLists.get(c);
    if (!list) treeLists.set(c, (list = []));
    list.push(raw.trees[i], raw.trees[i + 1]);
  }
  for (const [c, list] of treeLists) c.trees = new Float32Array(list);

  return { key: tileKey(cityId, tx, tz), tx, tz, source, chunks };
}

/** Collect every ArrayBuffer in a tile so it can be transferred between threads without copying. */
export function tileTransferables(tile: TileData): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const c of Object.values(tile.chunks)) {
    for (const b of c.buildings) for (const r of b.rings) out.push(r.buffer as ArrayBuffer);
    for (const r of c.roads) out.push(r.pts.buffer as ArrayBuffer);
    for (const a of c.areas) out.push(a.ring.buffer as ArrayBuffer);
    out.push(c.trees.buffer as ArrayBuffer);
  }
  return out;
}
