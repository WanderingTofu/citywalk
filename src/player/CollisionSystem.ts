import type { StyleConfig } from '../districts/StyleConfig';
import { pointInPolygon, ringBounds } from '../geo/polygon';
import { buildingTop, planBuilding } from '../world/BuildingPlan';
import type { BuildingFeature } from '../world/types';

/**
 * 2D collision against building footprints.
 *
 * Buildings are vertical prisms, so collision reduces to a circle (the
 * player) against wall segments in plan view, with a height range per wall.
 * Walls live in a uniform spatial hash and are added/removed per chunk as the
 * detailed ring around the player moves.
 */

interface Wall {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  bottom: number;
  top: number;
}

interface Footprint {
  rings: Float32Array[];
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  bottom: number;
  top: number;
}

interface ChunkEntry {
  walls: Wall[];
  footprints: Footprint[];
}

const CELL = 16;
const cellKey = (ix: number, iz: number) => (ix + 32768) * 65536 + (iz + 32768);

/** Structures whose underside is above this are walkable underneath (skywalks, canopies). */
const HEADROOM = 2.6;

export class CollisionSystem {
  private cells = new Map<number, Wall[]>();
  private chunks = new Map<string, ChunkEntry>();

  get wallCount(): number {
    let n = 0;
    for (const c of this.chunks.values()) n += c.walls.length;
    return n;
  }

  hasChunk(key: string): boolean {
    return this.chunks.has(key);
  }

  addChunk(key: string, buildings: BuildingFeature[], style: StyleConfig): void {
    if (this.chunks.has(key)) return;
    const entry: ChunkEntry = { walls: [], footprints: [] };
    for (const b of buildings) {
      const plan = planBuilding(b, style);
      if (plan.baseY > HEADROOM) continue;
      const top = buildingTop(plan);
      const bb = ringBounds(b.rings[0]);
      entry.footprints.push({ rings: b.rings, ...bb, bottom: plan.baseY, top });
      for (const r of b.rings) {
        for (let i = 0; i < r.length; i += 2) {
          const j = (i + 2) % r.length;
          const wall: Wall = { ax: r[i], az: r[i + 1], bx: r[j], bz: r[j + 1], bottom: plan.baseY, top };
          entry.walls.push(wall);
          this.forEachCell(wall, (k) => {
            let list = this.cells.get(k);
            if (!list) this.cells.set(k, (list = []));
            list.push(wall);
          });
        }
      }
    }
    this.chunks.set(key, entry);
  }

  removeChunk(key: string): void {
    const entry = this.chunks.get(key);
    if (!entry) return;
    const doomed = new Set(entry.walls);
    const touched = new Set<number>();
    for (const w of entry.walls) this.forEachCell(w, (k) => touched.add(k));
    for (const k of touched) {
      const list = this.cells.get(k);
      if (!list) continue;
      const kept = list.filter((w) => !doomed.has(w));
      if (kept.length) this.cells.set(k, kept);
      else this.cells.delete(k);
    }
    this.chunks.delete(key);
  }

  clear(): void {
    this.cells.clear();
    this.chunks.clear();
  }

  private forEachCell(w: Wall, fn: (key: number) => void): void {
    const x0 = Math.floor(Math.min(w.ax, w.bx) / CELL);
    const x1 = Math.floor(Math.max(w.ax, w.bx) / CELL);
    const z0 = Math.floor(Math.min(w.az, w.bz) / CELL);
    const z1 = Math.floor(Math.max(w.az, w.bz) / CELL);
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) fn(cellKey(ix, iz));
  }

  /**
   * Push a circle out of any walls it overlaps. `p` is modified in place.
   * Returns true if anything was hit.
   */
  resolve(p: { x: number; z: number }, radius: number, feetY: number, headY: number): boolean {
    let hit = false;
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      const x0 = Math.floor((p.x - radius) / CELL);
      const x1 = Math.floor((p.x + radius) / CELL);
      const z0 = Math.floor((p.z - radius) / CELL);
      const z1 = Math.floor((p.z + radius) / CELL);
      for (let ix = x0; ix <= x1; ix++) {
        for (let iz = z0; iz <= z1; iz++) {
          const list = this.cells.get(cellKey(ix, iz));
          if (!list) continue;
          for (const w of list) {
            if (feetY >= w.top - 0.05 || headY <= w.bottom) continue;
            const ex = w.bx - w.ax;
            const ez = w.bz - w.az;
            const len2 = ex * ex + ez * ez;
            let t = len2 > 0 ? ((p.x - w.ax) * ex + (p.z - w.az) * ez) / len2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const dx = p.x - (w.ax + ex * t);
            const dz = p.z - (w.az + ez * t);
            const d2 = dx * dx + dz * dz;
            if (d2 >= radius * radius) continue;
            const d = Math.sqrt(d2);
            if (d > 1e-5) {
              p.x += (dx / d) * (radius - d);
              p.z += (dz / d) * (radius - d);
            } else {
              // Exactly on the wall line: step out along the wall's outward normal.
              const len = Math.sqrt(len2) || 1;
              p.x += (ez / len) * radius;
              p.z += (-ex / len) * radius;
            }
            moved = hit = true;
          }
        }
      }
      if (!moved) break;
    }
    return hit;
  }

  /**
   * Height of the surface to stand on at (x, z) for something whose feet are
   * at `feetY`: the highest roof at or below the feet, or the street.
   */
  groundAt(x: number, z: number, feetY: number): number {
    let ground = 0;
    for (const c of this.chunks.values()) {
      for (const f of c.footprints) {
        if (x < f.minX || x > f.maxX || z < f.minZ || z > f.maxZ) continue;
        if (f.top > feetY + 0.3 || f.top <= ground) continue;
        if (pointInPolygon(x, z, f.rings)) ground = f.top;
      }
    }
    return ground;
  }

  /** True if the point is inside a solid footprint at the given height. */
  isInside(x: number, z: number, y = 1): boolean {
    for (const c of this.chunks.values()) {
      for (const f of c.footprints) {
        if (x < f.minX || x > f.maxX || z < f.minZ || z > f.maxZ) continue;
        if (y < f.bottom || y > f.top) continue;
        if (pointInPolygon(x, z, f.rings)) return true;
      }
    }
    return false;
  }

  /**
   * Nearest open spot to (x, z): searches outward on a spiral until a point is
   * found that is outside every footprint with `clearance` to spare.
   */
  findOpenSpot(x: number, z: number, clearance = 0.8, maxRadius = 200): { x: number; z: number } {
    const free = (px: number, pz: number): boolean => {
      if (this.isInside(px, pz)) return false;
      const probe = { x: px, z: pz };
      return !this.resolve(probe, clearance, 0, 1.8);
    };
    if (free(x, z)) return { x, z };
    for (let r = 2; r <= maxRadius; r += 2) {
      const steps = Math.max(8, Math.round((Math.PI * 2 * r) / 2.5));
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const px = x + Math.cos(a) * r;
        const pz = z + Math.sin(a) * r;
        if (free(px, pz)) return { x: px, z: pz };
      }
    }
    return { x, z };
  }
}
