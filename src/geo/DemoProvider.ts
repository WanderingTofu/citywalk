import { Rng, hash2, hashString } from '../core/rng';
import { tileBounds } from './TileAddress';
import type { RawArea, RawBuilding, RawFeatures, RawRoad } from './OSMParser';
import { signedArea } from './polygon';
import { AreaKind, RoadKind, type BuildingUse } from '../world/types';

/**
 * Deterministic offline city.
 *
 * Produces the same feature structure as the OSM parser from nothing but a
 * seed and a tile address: an irregular street grid, blocks subdivided into
 * lots, parks and ponds. It is used for demo mode, for tests, and as the
 * fallback when Overpass is unreachable, so a network failure never leaves a
 * hole in the world.
 *
 * This is synthetic geography. The UI labels it as such; it is never
 * presented as a real place.
 */

const BLOCK_X = 112;
const BLOCK_Z = 84;

/** Position of the k-th north-south street (constant x). Defined for every integer k. */
function lineX(seed: number, k: number): number {
  return k * BLOCK_X + ((hash2(seed, k * 2 + 1) % 1000) / 1000 - 0.5) * 26;
}

/** Position of the k-th east-west street (constant z). */
function lineZ(seed: number, k: number): number {
  return k * BLOCK_Z + ((hash2(seed ^ 0x5bd1e995, k * 2) % 1000) / 1000 - 0.5) * 20;
}

function streetWidth(seed: number, k: number, axis: number): number {
  if (((k % 4) + 4) % 4 === 0) return 14;
  return hash2(seed + axis, k) % 5 === 0 ? 4 : 7;
}

export function generateDemoFeatures(cityId: string, tx: number, tz: number): RawFeatures {
  const seed = hashString('demo:' + cityId);
  const tb = tileBounds(tx, tz);
  const out: RawFeatures = { buildings: [], roads: [], areas: [], trees: [] };

  const k0x = Math.floor(tb.minX / BLOCK_X) - 2;
  const k1x = Math.ceil(tb.maxX / BLOCK_X) + 2;
  const k0z = Math.floor(tb.minZ / BLOCK_Z) - 2;
  const k1z = Math.ceil(tb.maxZ / BLOCK_Z) + 2;

  // Streets: one polyline per grid line with a vertex at every crossing.
  for (let k = k0x; k <= k1x; k++) {
    const x = lineX(seed, k);
    const pts: number[] = [];
    for (let j = k0z; j <= k1z; j++) pts.push(x, lineZ(seed, j));
    out.roads.push(road(hash2(seed, k) % 1e9, pts, streetWidth(seed, k, 0)));
  }
  for (let j = k0z; j <= k1z; j++) {
    const z = lineZ(seed, j);
    const pts: number[] = [];
    for (let k = k0x; k <= k1x; k++) pts.push(lineX(seed, k), z);
    out.roads.push(road((hash2(seed, j) % 1e9) + 1e9, pts, streetWidth(seed, j, 1)));
  }

  // Blocks between the streets.
  for (let k = k0x; k < k1x; k++) {
    for (let j = k0z; j < k1z; j++) {
      const sidewalk = 2.6;
      const x0 = lineX(seed, k) + streetWidth(seed, k, 0) / 2 + sidewalk;
      const x1 = lineX(seed, k + 1) - streetWidth(seed, k + 1, 0) / 2 - sidewalk;
      const z0 = lineZ(seed, j) + streetWidth(seed, j, 1) / 2 + sidewalk;
      const z1 = lineZ(seed, j + 1) - streetWidth(seed, j + 1, 1) / 2 - sidewalk;
      if (x1 - x0 < 12 || z1 - z0 < 12) continue;
      const blockSeed = hash2(hash2(seed, k), j);
      const rng = new Rng(blockSeed);
      if (rng.chance(0.07)) park(out, rng, blockSeed, x0, z0, x1, z1);
      else lots(out, rng, blockSeed, x0, z0, x1, z1);
    }
  }
  return out;
}

function road(id: number, pts: number[], width: number): RawRoad {
  return { id, pts, width, kind: width < 5 ? RoadKind.Path : RoadKind.Road };
}

function rect(x0: number, z0: number, x1: number, z1: number): number[] {
  // Counter-clockwise in the x/z math plane (positive signed area).
  return [x0, z0, x1, z0, x1, z1, x0, z1];
}

function park(out: RawFeatures, rng: Rng, id: number, x0: number, z0: number, x1: number, z1: number): void {
  const area: RawArea = { id: id % 1e9, ring: rect(x0, z0, x1, z1), kind: AreaKind.Green };
  out.areas.push(area);
  if (rng.chance(0.6)) {
    // A pond: a 10-gon blob near the middle.
    const cx = (x0 + x1) / 2 + rng.range(-8, 8);
    const cz = (z0 + z1) / 2 + rng.range(-6, 6);
    const r = Math.min(x1 - x0, z1 - z0) * rng.range(0.16, 0.26);
    const ring: number[] = [];
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const rr = r * rng.range(0.8, 1.15);
      ring.push(cx + Math.cos(a) * rr * 1.3, cz + Math.sin(a) * rr);
    }
    out.areas.push({ id: (id % 1e9) + 1, ring, kind: AreaKind.Water });
  }
  const n = Math.round(((x1 - x0) * (z1 - z0)) / 160);
  for (let i = 0; i < n; i++) out.trees.push(rng.range(x0 + 2, x1 - 2), rng.range(z0 + 2, z1 - 2));
}

function lots(out: RawFeatures, rng: Rng, blockSeed: number, x0: number, z0: number, x1: number, z1: number): void {
  const w = x1 - x0;
  const d = z1 - z0;
  const rows = d > 44 ? 2 : 1;
  const cols = Math.max(1, Math.round(w / rng.range(13, 26)));
  // A fraction of blocks are single large buildings (malls, towers, stations).
  if (rng.chance(0.08)) {
    out.buildings.push(building(blockSeed, rect(x0 + 1, z0 + 1, x1 - 1, z1 - 1), rng.chance(0.5) ? rng.int(8, 30) : 0));
    return;
  }
  const lotW = w / cols;
  const lotD = d / rows;
  let n = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      n++;
      if (rng.chance(0.06)) continue; // vacant lot
      const gapX = rng.chance(0.55) ? 0 : rng.range(0.4, 1.6);
      const front = rng.range(0, 1.5);
      const back = rows === 2 ? rng.range(0.5, 4) : rng.range(0, 1.5);
      const lx0 = x0 + c * lotW + gapX;
      const lx1 = x0 + (c + 1) * lotW - gapX;
      // Each row fronts its own street: row 0 faces z0, row 1 faces z1.
      const lz0 = z0 + r * lotD + (r === 0 ? front : back);
      const lz1 = z0 + (r + 1) * lotD - (r === rows - 1 ? front : back);
      if (lx1 - lx0 < 4 || lz1 - lz0 < 4) continue;
      let ring = rect(lx0, lz0, lx1, lz1);
      if (rng.chance(0.18) && lx1 - lx0 > 9 && lz1 - lz0 > 9) {
        // L-shaped footprint: notch out the rear corner.
        const nx = lx0 + (lx1 - lx0) * rng.range(0.4, 0.65);
        const nz = lz0 + (lz1 - lz0) * rng.range(0.4, 0.65);
        ring =
          r === 0
            ? [lx0, lz0, lx1, lz0, lx1, nz, nx, nz, nx, lz1, lx0, lz1]
            : [lx0, lz0, nx, lz0, nx, nz, lx1, nz, lx1, lz1, lx0, lz1];
      }
      // Some buildings carry explicit level tags, the rest exercise the estimator.
      out.buildings.push(building(hash2(blockSeed, n), ring, rng.chance(0.3) ? rng.int(1, 9) : 0));
    }
  }
}

/** Mix of uses in the demo city, weighted toward the unknown case that real data is full of. */
const DEMO_USES: BuildingUse[] = ['unknown', 'unknown', 'unknown', 'retail', 'apartments', 'office', 'commercial', 'apartments', 'unknown', 'retail'];

function building(id: number, ring: number[], levels: number): RawBuilding {
  return {
    id: id % 2 ** 31,
    rings: [ring],
    height: 0,
    levels,
    minHeight: 0,
    kind: 'yes',
    use: DEMO_USES[id % DEMO_USES.length],
    area: Math.abs(signedArea(ring)),
  };
}
