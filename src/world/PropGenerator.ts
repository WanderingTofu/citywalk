import { Rng, hash2 } from '../core/rng';
import type { StyleConfig } from '../districts/StyleConfig';
import { pointInRing, ringBounds } from '../geo/polygon';
import { AreaKind, RoadKind, type ChunkData } from './types';

/**
 * Placement of instanced street furniture. Only positions are computed here;
 * the meshes are shared GPU instances (see graphics/Props).
 *
 * Mapped trees come straight from OSM. Everything else is placed by
 * deterministic rules: trees scattered through green areas, street trees and
 * lamps spaced along roads, never inside a building footprint.
 */

export interface PropPlacement {
  /** x, y, z, scale, rotation, variant */
  trees: Float32Array;
  /** x, y, z, rotation */
  lamps: Float32Array;
  /** x, y, z, rotation, colour index, length scale */
  cars: Float32Array;
}

const MAX_TREES = 900;
const MAX_LAMPS = 400;
const MAX_CARS = 260;
/** Kerb length one parked car takes up, meters. */
const CAR_SLOT = 6.1;
export const CAR_COLORS = 10;

export function generateProps(chunk: ChunkData, style: StyleConfig, ox: number, oz: number): PropPlacement {
  const seed = hash2(chunk.cx, chunk.cz);
  const rng = new Rng(seed);
  const trees: number[] = [];
  const lamps: number[] = [];
  const cars: number[] = [];

  const boxes = chunk.buildings.map((b) => ringBounds(b.rings[0]));
  const blocked = (x: number, z: number): boolean => {
    for (let i = 0; i < boxes.length; i++) {
      const bb = boxes[i];
      if (x < bb.minX - 0.6 || x > bb.maxX + 0.6 || z < bb.minZ - 0.6 || z > bb.maxZ + 0.6) continue;
      if (pointInRing(x, z, chunk.buildings[i].rings[0])) return true;
    }
    return false;
  };
  const tree = (x: number, z: number, scale: number) => {
    if (trees.length >= MAX_TREES * 6) return;
    trees.push(x - ox, 0, z - oz, scale, rng.next() * Math.PI * 2, rng.int(0, 2));
  };

  for (let i = 0; i < chunk.trees.length; i += 2) tree(chunk.trees[i], chunk.trees[i + 1], rng.range(0.85, 1.3));

  // Scatter through parks and woods on a jittered grid.
  for (const a of chunk.areas) {
    if (a.kind !== AreaKind.Green && a.kind !== AreaKind.Forest) continue;
    const spacing = a.kind === AreaKind.Forest ? 7 : 14;
    const b = ringBounds(a.ring);
    for (let x = b.minX + spacing / 2; x < b.maxX; x += spacing) {
      for (let z = b.minZ + spacing / 2; z < b.maxZ; z += spacing) {
        const px = x + rng.range(-0.4, 0.4) * spacing;
        const pz = z + rng.range(-0.4, 0.4) * spacing;
        const keep = rng.next() < (a.kind === AreaKind.Forest ? 0.85 : 0.45);
        if (keep && pointInRing(px, pz, a.ring) && !blocked(px, pz)) tree(px, pz, rng.range(0.8, 1.5));
      }
    }
  }

  // Kerbside parking: cars sit in slots along both sides of ordinary streets.
  // Each run of cars is hashed per slot, so the pattern is stable and has gaps and clusters.
  const parking = style.atmosphere.parking;
  if (parking > 0) {
    for (const r of chunk.roads) {
      if (r.kind !== RoadKind.Road || r.width < 6.5 || r.width > 22) continue;
      const offset = r.width / 2 - 1.15;
      let dist = CAR_SLOT * 1.5;
      let slot = 0;
      for (let i = 0; i + 3 < r.pts.length; i += 2) {
        const x0 = r.pts[i];
        const z0 = r.pts[i + 1];
        const dx = r.pts[i + 2] - x0;
        const dz = r.pts[i + 3] - z0;
        const len = Math.hypot(dx, dz);
        if (len < 0.01) continue;
        // Leave the ends of each stretch clear, where the junctions are.
        while (dist < len - CAR_SLOT) {
          const t = dist / len;
          for (const side of [1, -1]) {
            const h = hash2(hash2(seed, r.id | 0), slot * 2 + (side > 0 ? 1 : 0));
            if ((h % 1000) / 1000 >= parking || cars.length >= MAX_CARS * 6) continue;
            const x = x0 + dx * t + (-dz / len) * offset * side;
            const z = z0 + dz * t + (dx / len) * offset * side;
            if (blocked(x, z)) continue;
            // Cars face the direction of travel on their side of the road.
            const heading = Math.atan2(dx * side, dz * side);
            cars.push(x - ox, 0, z - oz, heading, (h >>> 10) % CAR_COLORS, 0.92 + ((h >>> 16) % 100) / 500);
          }
          dist += CAR_SLOT;
          slot++;
        }
        dist = Math.max(dist - len, CAR_SLOT * 0.5);
      }
    }
  }

  const spacing = Math.max(12, style.atmosphere.lampSpacing);
  for (const r of chunk.roads) {
    const lit = r.kind === RoadKind.Road ? r.width >= 5 : r.kind === RoadKind.Path && r.width >= 4;
    if (!lit) continue;
    const offset = r.width / 2 + (r.kind === RoadKind.Road ? 0.9 : -0.5);
    const streetTrees = r.kind === RoadKind.Road && r.width >= 6 && style.atmosphere.streetTrees > 0;
    let dist = spacing * 0.5;
    let side = hash2(seed, r.id | 0) & 1 ? 1 : -1;
    let n = 0;
    for (let i = 0; i + 3 < r.pts.length; i += 2) {
      const x0 = r.pts[i];
      const z0 = r.pts[i + 1];
      const dx = r.pts[i + 2] - x0;
      const dz = r.pts[i + 3] - z0;
      const len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      while (dist < len) {
        const t = dist / len;
        const px = -dz / len;
        const pz = dx / len;
        const x = x0 + dx * t + px * offset * side;
        const z = z0 + dz * t + pz * offset * side;
        if (!blocked(x, z) && lamps.length < MAX_LAMPS * 4) {
          // Rotation turns the lamp arm toward the carriageway.
          lamps.push(x - ox, 0, z - oz, Math.atan2(-px * side, -pz * side));
        }
        if (streetTrees && rng.next() < style.atmosphere.streetTrees) {
          const tx = x0 + dx * t + px * (offset + 0.6) * -side + (dx / len) * spacing * 0.4;
          const tz = z0 + dz * t + pz * (offset + 0.6) * -side + (dz / len) * spacing * 0.4;
          if (!blocked(tx, tz)) tree(tx, tz, rng.range(0.7, 1.05));
        }
        side = -side;
        dist += spacing;
        n++;
      }
      dist -= len;
    }
    void n;
  }

  return { trees: new Float32Array(trees), lamps: new Float32Array(lamps), cars: new Float32Array(cars) };
}
