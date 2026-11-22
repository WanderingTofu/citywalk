/**
 * Stable addressing for the two-level streaming grid.
 *
 *   Tile  = unit of geographic data (one network request, one cache record).
 *   Chunk = unit of rendering, LOD and disposal. A tile holds
 *           CHUNKS_PER_TILE x CHUNKS_PER_TILE chunks.
 *
 * Both grids are axis-aligned in the city's local meter frame, so an address
 * is a pure function of position and never changes between sessions.
 */

export const CHUNK_SIZE = 200; // meters
export const CHUNKS_PER_TILE = 4;
export const TILE_SIZE = CHUNK_SIZE * CHUNKS_PER_TILE; // 800 m

export interface GridCoord {
  x: number;
  z: number;
}

export function chunkCoordAt(x: number, z: number): GridCoord {
  return { x: Math.floor(x / CHUNK_SIZE), z: Math.floor(z / CHUNK_SIZE) };
}

export function tileCoordOfChunk(cx: number, cz: number): GridCoord {
  return { x: Math.floor(cx / CHUNKS_PER_TILE), z: Math.floor(cz / CHUNKS_PER_TILE) };
}

export function tileCoordAt(x: number, z: number): GridCoord {
  return { x: Math.floor(x / TILE_SIZE), z: Math.floor(z / TILE_SIZE) };
}

export function chunkKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

export function tileKey(cityId: string, tx: number, tz: number): string {
  return `${cityId}/${tx},${tz}`;
}

export function parseChunkKey(key: string): GridCoord {
  const i = key.indexOf(',');
  return { x: Number(key.slice(0, i)), z: Number(key.slice(i + 1)) };
}

/** Local-space rectangle covered by a chunk. */
export function chunkBounds(cx: number, cz: number): { minX: number; minZ: number; maxX: number; maxZ: number } {
  return {
    minX: cx * CHUNK_SIZE,
    minZ: cz * CHUNK_SIZE,
    maxX: (cx + 1) * CHUNK_SIZE,
    maxZ: (cz + 1) * CHUNK_SIZE,
  };
}

/** Local-space rectangle covered by a tile. */
export function tileBounds(tx: number, tz: number): { minX: number; minZ: number; maxX: number; maxZ: number } {
  return {
    minX: tx * TILE_SIZE,
    minZ: tz * TILE_SIZE,
    maxX: (tx + 1) * TILE_SIZE,
    maxZ: (tz + 1) * TILE_SIZE,
  };
}

/** Horizontal distance from a point to the nearest point of a chunk's rectangle (0 when inside). */
export function distanceToChunk(x: number, z: number, cx: number, cz: number): number {
  const b = chunkBounds(cx, cz);
  const dx = Math.max(b.minX - x, 0, x - b.maxX);
  const dz = Math.max(b.minZ - z, 0, z - b.maxZ);
  return Math.hypot(dx, dz);
}
