import { describe, expect, it } from 'vitest';
import {
  CHUNKS_PER_TILE, CHUNK_SIZE, TILE_SIZE, chunkBounds, chunkCoordAt, chunkKey, distanceToChunk,
  parseChunkKey, tileBounds, tileCoordAt, tileCoordOfChunk, tileKey,
} from '../src/geo/TileAddress';
import { QUALITY } from '../src/config/quality';
import { selectLod } from '../src/graphics/LODManager';

describe('tile addressing', () => {
  it('assigns each point to exactly one chunk, including negatives and edges', () => {
    expect(chunkCoordAt(0, 0)).toEqual({ x: 0, z: 0 });
    expect(chunkCoordAt(CHUNK_SIZE - 0.001, 0)).toEqual({ x: 0, z: 0 });
    expect(chunkCoordAt(CHUNK_SIZE, 0)).toEqual({ x: 1, z: 0 });
    expect(chunkCoordAt(-0.001, -0.001)).toEqual({ x: -1, z: -1 });
    expect(chunkCoordAt(-CHUNK_SIZE, -CHUNK_SIZE - 1)).toEqual({ x: -1, z: -2 });
  });

  it('nests chunks in tiles consistently', () => {
    for (const [x, z] of [[10, 10], [-10, 950], [1601, -1], [-3201, -3199]]) {
      const c = chunkCoordAt(x, z);
      expect(tileCoordOfChunk(c.x, c.z)).toEqual(tileCoordAt(x, z));
    }
    expect(TILE_SIZE).toBe(CHUNK_SIZE * CHUNKS_PER_TILE);
    expect(tileCoordOfChunk(-1, -1)).toEqual({ x: -1, z: -1 });
    expect(tileCoordOfChunk(-CHUNKS_PER_TILE - 1, CHUNKS_PER_TILE)).toEqual({ x: -2, z: 1 });
  });

  it('has stable, reversible keys', () => {
    expect(chunkKey(-3, 7)).toBe('-3,7');
    expect(parseChunkKey(chunkKey(-3, 7))).toEqual({ x: -3, z: 7 });
    expect(tileKey('tokyo', 1, -2)).toBe('tokyo/1,-2');
  });

  it('computes bounds and distances in meters', () => {
    expect(chunkBounds(1, -1)).toEqual({ minX: CHUNK_SIZE, minZ: -CHUNK_SIZE, maxX: 2 * CHUNK_SIZE, maxZ: 0 });
    expect(tileBounds(-1, 0).minX).toBe(-TILE_SIZE);
    expect(distanceToChunk(50, 50, 0, 0)).toBe(0);
    expect(distanceToChunk(-30, 50, 0, 0)).toBe(30);
    expect(distanceToChunk(-30, -40, 0, 0)).toBe(50);
  });
});

describe('LOD selection', () => {
  const q = QUALITY.high;
  it('maps distance to LOD', () => {
    expect(selectLod(0, q, -1)).toBe(0);
    expect(selectLod(q.lod0 + 1, q, -1)).toBe(1);
    expect(selectLod(q.lod1 + 1, q, -1)).toBe(2);
    expect(selectLod(q.lod2 + 1, q, -1)).toBe(-1);
  });
  it('holds the current level inside the hysteresis band', () => {
    expect(selectLod(q.lod0 * 1.05, q, 0)).toBe(0);
    expect(selectLod(q.lod0 * 1.2, q, 0)).toBe(1);
    expect(selectLod(q.lod2 * 1.05, q, 2)).toBe(2);
    expect(selectLod(q.lod2 * 1.2, q, 2)).toBe(-1);
    // Refinement is immediate.
    expect(selectLod(q.lod0 - 1, q, 1)).toBe(0);
  });
});
