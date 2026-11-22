import type { StyleConfig } from '../districts/StyleConfig';
import { CHUNK_SIZE } from '../geo/TileAddress';
import { generateBuilding } from './BuildingGenerator';
import { generateGround } from './GroundGenerator';
import { MeshWriter } from './MeshWriter';
import { generateProps } from './PropGenerator';
import type { ChunkData, ChunkGeometry, Lod } from './types';

export interface BuildOptions {
  lod: Lod;
  /** Ground is LOD independent, so it is only built the first time a chunk appears. */
  ground: boolean;
  /** Street props are only wanted near the player. */
  props: boolean;
}

/**
 * Turn a chunk's features into renderable buffers. Pure and deterministic:
 * the same chunk, style and options always produce identical output, which is
 * what lets chunks be discarded and regenerated freely while streaming.
 *
 * Vertex positions are relative to the chunk's corner so precision does not
 * degrade far from the city origin.
 */
export function buildChunkGeometry(chunk: ChunkData, style: StyleConfig, opts: BuildOptions): ChunkGeometry {
  const t0 = performance.now();
  const ox = chunk.cx * CHUNK_SIZE;
  const oz = chunk.cz * CHUNK_SIZE;

  const bw = new MeshWriter(true);
  for (const b of chunk.buildings) generateBuilding(bw, b, style, opts.lod, ox, oz);

  let ground = null;
  if (opts.ground) {
    const gw = new MeshWriter(false);
    generateGround(gw, chunk, style, ox, oz);
    ground = gw.finish();
  }

  const props = opts.props
    ? generateProps(chunk, style, ox, oz)
    : { trees: new Float32Array(0), lamps: new Float32Array(0), cars: new Float32Array(0) };

  return {
    cx: chunk.cx,
    cz: chunk.cz,
    lod: opts.lod,
    buildings: bw.finish(),
    ground,
    trees: props.trees,
    lamps: props.lamps,
    // Cars only exist inside the full-detail ring.
    cars: opts.lod === 0 ? props.cars : new Float32Array(0),
    buildMs: performance.now() - t0,
  };
}
