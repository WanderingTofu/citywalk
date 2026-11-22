/**
 * Plain-data types shared by the main thread and the workers. Everything here
 * must survive structured cloning (no classes, no functions).
 */

export interface BuildingFeature {
  /** Stable id (OSM id, or a deterministic synthetic id in demo mode). Seeds all variation. */
  id: number;
  /** rings[0] = outer (CCW), others = courtyards (CW). Flat x/z pairs, local meters, open rings. */
  rings: Float32Array[];
  /** Tagged height in meters, 0 when unknown. */
  height: number;
  /** Tagged floor count, 0 when unknown. */
  levels: number;
  /** Tagged height of the underside (building raised above ground), meters. */
  minHeight: number;
  /** OSM `building=*` value ("yes", "retail", "garage", ...). */
  kind: string;
  /** Footprint area in m^2. */
  area: number;
}

export const enum RoadKind {
  Road = 0,
  Path = 1,
  Rail = 2,
  Water = 3,
}

export interface RoadFeature {
  id: number;
  /** Polyline, flat x/z pairs. */
  pts: Float32Array;
  width: number;
  kind: RoadKind;
}

export const enum AreaKind {
  Green = 0,
  Forest = 1,
  Water = 2,
  Plaza = 3,
}

export interface AreaFeature {
  id: number;
  /** Outer ring only, already clipped to the chunk. */
  ring: Float32Array;
  kind: AreaKind;
}

/** Everything inside one chunk, in city-local coordinates. */
export interface ChunkData {
  cx: number;
  cz: number;
  buildings: BuildingFeature[];
  roads: RoadFeature[];
  areas: AreaFeature[];
  /** Mapped individual trees, flat x/z pairs. */
  trees: Float32Array;
}

export type TileSource = 'osm' | 'cache' | 'demo' | 'fallback';

export interface TileData {
  key: string;
  tx: number;
  tz: number;
  /** Where the geometry came from. 'demo'/'fallback' are synthetic, not real geography. */
  source: TileSource;
  /** Chunks keyed by chunkKey(cx, cz). Every chunk of the tile is present. */
  chunks: Record<string, ChunkData>;
}

/** Vertex streams for one merged mesh. */
export interface MeshData {
  position: Float32Array;
  normal: Float32Array;
  /** RGB tint per vertex. */
  color: Float32Array;
  /**
   * Per-vertex shader inputs. Layout depends on the mesh type:
   *   buildings: a = (u in bays, height above base, wall height)      [3]
   *              b = (surface, material, seed, window pattern)        [4]
   *              c = (floor height, ground floor height, fill x, y)   [4]
   *   ground:    a = (material, across in meters, along in meters, layer) [4]
   *              b = (half width)                                     [1]
   */
  a: Float32Array;
  b: Float32Array;
  c?: Float32Array;
  index: Uint32Array;
}

/** Level of detail for a chunk's buildings. 0 = closest. */
export type Lod = 0 | 1 | 2;

export interface ChunkGeometry {
  cx: number;
  cz: number;
  lod: Lod;
  buildings: MeshData | null;
  /** Present only when the request asked for it (ground is LOD independent). */
  ground: MeshData | null;
  /** Instances: x, y, z, scale, rotation, variant. */
  trees: Float32Array;
  /** Instances: x, y, z, rotation. */
  lamps: Float32Array;
  buildMs: number;
}
