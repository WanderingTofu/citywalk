import earcut from 'earcut';
import { Mat, type StyleConfig } from '../districts/StyleConfig';
import { CHUNK_SIZE } from '../geo/TileAddress';
import { srgbToLinear } from './BuildingPlan';
import type { MeshWriter } from './MeshWriter';
import { AreaKind, RoadKind, type ChunkData } from './types';

/**
 * Ground for one chunk: base slab, green and water areas, footpaths,
 * sidewalks, carriageways and rail, all merged into a single mesh.
 *
 * Everything lies on y = 0. Overlaps are resolved by a per-vertex `layer`
 * that the ground shader converts into a small depth bias, so stacked surfaces
 * never z-fight and the whole ground is still one draw call.
 */

export const Layer = { base: 0, green: 1, water: 2, paving: 3, road: 4, rail: 5 } as const;

/** Sidewalk strip added to each side of a carriageway, meters. */
const SIDEWALK = 2.2;

const GRASS = srgbToLinear(0x5d7a3c);
const FOREST = srgbToLinear(0x41602f);
const WATER = srgbToLinear(0x2f5564);
const GRAVEL = srgbToLinear(0x6b655d);

export function generateGround(w: MeshWriter, chunk: ChunkData, style: StyleConfig, ox: number, oz: number): void {
  const base = srgbToLinear(style.ground.base);
  const paving = srgbToLinear(style.ground.pavement);
  const asphalt = srgbToLinear(style.ground.asphalt);

  // Base slab.
  w.color = base;
  w.attrB = [0];
  const s = CHUNK_SIZE;
  const a = w.vertex(0, 0, 0, 0, 1, 0, Mat.pavement, NO_MARKINGS, 0, Layer.base);
  const b = w.vertex(s, 0, 0, 0, 1, 0, Mat.pavement, NO_MARKINGS, 0, Layer.base);
  const c = w.vertex(s, 0, s, 0, 1, 0, Mat.pavement, NO_MARKINGS, 0, Layer.base);
  const d = w.vertex(0, 0, s, 0, 1, 0, Mat.pavement, NO_MARKINGS, 0, Layer.base);
  w.tri(a, c, b);
  w.tri(a, d, c);

  for (const area of chunk.areas) {
    let mat: number = Mat.grass;
    let layer: number = Layer.green;
    w.color = GRASS;
    if (area.kind === AreaKind.Forest) w.color = FOREST;
    else if (area.kind === AreaKind.Water) {
      mat = Mat.water;
      layer = Layer.water;
      w.color = WATER;
    } else if (area.kind === AreaKind.Plaza) {
      mat = Mat.pavement;
      layer = Layer.paving;
      w.color = [paving[0] * 1.08, paving[1] * 1.08, paving[2] * 1.08];
    }
    polygon(w, area.ring, mat, layer, ox, oz);
  }

  for (const r of chunk.roads) {
    switch (r.kind) {
      case RoadKind.Water:
        w.color = WATER;
        ribbon(w, r.pts, r.width, Mat.water, Layer.water, false, ox, oz);
        break;
      case RoadKind.Path:
        w.color = paving;
        ribbon(w, r.pts, r.width, Mat.pavement, Layer.paving, false, ox, oz);
        break;
      case RoadKind.Rail:
        w.color = GRAVEL;
        ribbon(w, r.pts, r.width, Mat.gravel, Layer.rail, true, ox, oz);
        break;
      default:
        if (r.width >= 5) {
          w.color = paving;
          ribbon(w, r.pts, r.width + SIDEWALK * 2, Mat.pavement, Layer.paving, false, ox, oz);
        }
        w.color = asphalt;
        ribbon(w, r.pts, r.width, Mat.asphalt, Layer.road, true, ox, oz);
    }
  }
}

/** `across` value that tells the shader a surface carries no lane markings. */
const NO_MARKINGS = 1000;

function polygon(w: MeshWriter, ring: ArrayLike<number>, mat: number, layer: number, ox: number, oz: number): void {
  const flat = Array.from(ring);
  const tris = earcut(flat, undefined, 2);
  if (tris.length === 0) return;
  w.attrB = [0];
  const first = w.vertexCount;
  for (let i = 0; i < flat.length; i += 2) {
    w.vertex(flat[i] - ox, 0, flat[i + 1] - oz, 0, 1, 0, mat, NO_MARKINGS, 0, layer);
  }
  for (let t = 0; t < tris.length; t += 3) {
    const i0 = tris[t];
    let i1 = tris[t + 1];
    let i2 = tris[t + 2];
    const cross =
      (flat[i1 * 2] - flat[i0 * 2]) * (flat[i2 * 2 + 1] - flat[i0 * 2 + 1]) -
      (flat[i1 * 2 + 1] - flat[i0 * 2 + 1]) * (flat[i2 * 2] - flat[i0 * 2]);
    if (cross > 0) [i1, i2] = [i2, i1];
    w.tri(first + i0, first + i1, first + i2);
  }
}

/**
 * Polyline -> flat ribbon. Each segment is a quad; a disc at every vertex
 * closes the wedge-shaped gaps at bends and rounds off the ends, which also
 * makes junctions between separately generated pieces seamless.
 */
function ribbon(
  w: MeshWriter, pts: ArrayLike<number>, width: number, mat: number, layer: number,
  markings: boolean, ox: number, oz: number,
): void {
  const hw = width / 2;
  w.attrB = [hw];
  let along = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const x0 = pts[i] - ox;
    const z0 = pts[i + 1] - oz;
    const x1 = pts[i + 2] - ox;
    const z1 = pts[i + 3] - oz;
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    const px = (-dz / len) * hw;
    const pz = (dx / len) * hw;
    const acrossL = markings ? -hw : NO_MARKINGS;
    const acrossR = markings ? hw : NO_MARKINGS;
    const a = w.vertex(x0 - px, 0, z0 - pz, 0, 1, 0, mat, acrossL, along, layer);
    const b = w.vertex(x0 + px, 0, z0 + pz, 0, 1, 0, mat, acrossR, along, layer);
    const c = w.vertex(x1 + px, 0, z1 + pz, 0, 1, 0, mat, acrossR, along + len, layer);
    const d = w.vertex(x1 - px, 0, z1 - pz, 0, 1, 0, mat, acrossL, along + len, layer);
    // This winding has a negative x/z cross product, i.e. it faces +Y.
    w.tri(a, b, c);
    w.tri(a, c, d);
    along += len;
  }
  const sides = hw < 1.6 ? 6 : 10;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const cx = pts[i] - ox;
    const cz = pts[i + 1] - oz;
    const center = w.vertex(cx, 0, cz, 0, 1, 0, mat, NO_MARKINGS, 0, layer);
    const first = w.vertexCount;
    for (let k = 0; k < sides; k++) {
      const ang = (k / sides) * Math.PI * 2;
      w.vertex(cx + Math.cos(ang) * hw, 0, cz + Math.sin(ang) * hw, 0, 1, 0, mat, NO_MARKINGS, 0, layer);
    }
    for (let k = 0; k < sides; k++) w.tri(center, first + ((k + 1) % sides), first + k);
  }
}
