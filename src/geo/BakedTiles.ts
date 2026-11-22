import type { AreaKind, BuildingUse, ChunkData, RoadKind, TileData } from '../world/types';

/**
 * Pre-baked tiles: processed map tiles saved as compact JSON and served as
 * static files next to the app. A city's spawn neighbourhood then loads from
 * the same host in one round trip, without waiting on (or leaning on) the
 * public Overpass servers; live fetching takes over beyond the baked area.
 *
 * Coordinates are stored as integer decimeters, which is finer than the data
 * and about a third of the size of floats in JSON.
 */

export const BAKED_VERSION = 1;
const SCALE = 10;

interface BakedChunk {
  cx: number;
  cz: number;
  /** [id, height*10, levels, minHeight*10, kind, use, area, rings] */
  b: Array<[number, number, number, number, string, BuildingUse, number, number[][]]>;
  /** [id, width*10, kind, points] */
  r: Array<[number, number, number, number[]]>;
  /** [id, kind, ring] */
  a: Array<[number, number, number[]]>;
  t: number[];
}

export interface BakedTile {
  v: number;
  key: string;
  tx: number;
  tz: number;
  /** ISO date the tile was fetched from OpenStreetMap. */
  baked: string;
  chunks: BakedChunk[];
}

export interface BakedIndex {
  v: number;
  /** "tx_tz" of every tile available for this district. */
  tiles: string[];
  baked: string;
}

const pack = (a: ArrayLike<number>): number[] => Array.from(a, (v) => Math.round(v * SCALE));
const unpack = (a: number[]): Float32Array => Float32Array.from(a, (v) => v / SCALE);

export function encodeTile(tile: TileData, baked: string): BakedTile {
  return {
    v: BAKED_VERSION,
    key: tile.key,
    tx: tile.tx,
    tz: tile.tz,
    baked,
    chunks: Object.values(tile.chunks).map((c) => ({
      cx: c.cx,
      cz: c.cz,
      b: c.buildings.map((b) => [b.id, Math.round(b.height * SCALE), b.levels, Math.round(b.minHeight * SCALE), b.kind, b.use, Math.round(b.area), b.rings.map(pack)]),
      r: c.roads.map((r) => [r.id, Math.round(r.width * SCALE), r.kind, pack(r.pts)]),
      a: c.areas.map((a) => [a.id, a.kind, pack(a.ring)]),
      t: pack(c.trees),
    })),
  };
}

export function decodeTile(baked: BakedTile): TileData {
  const chunks: Record<string, ChunkData> = {};
  for (const c of baked.chunks) {
    chunks[`${c.cx},${c.cz}`] = {
      cx: c.cx,
      cz: c.cz,
      buildings: c.b.map(([id, height, levels, minHeight, kind, use, area, rings]) => ({
        id, height: height / SCALE, levels, minHeight: minHeight / SCALE, kind, use, area, rings: rings.map(unpack),
      })),
      roads: c.r.map(([id, width, kind, pts]) => ({ id, width: width / SCALE, kind: kind as RoadKind, pts: unpack(pts) })),
      areas: c.a.map(([id, kind, ring]) => ({ id, kind: kind as AreaKind, ring: unpack(ring) })),
      trees: unpack(c.t),
    };
  }
  return { key: baked.key, tx: baked.tx, tz: baked.tz, source: 'baked', chunks };
}

/** Folder name of a district's baked tiles. */
export function bakedSlug(cityId: string, districtId: string): string {
  return `${cityId}_${districtId}`;
}

export function bakedName(tx: number, tz: number): string {
  return `${tx}_${tz}`;
}
