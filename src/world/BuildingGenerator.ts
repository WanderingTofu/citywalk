import earcut from 'earcut';
import { Rng, foldId } from '../core/rng';
import { Mat, WindowPattern, type StyleConfig } from '../districts/StyleConfig';
import { centroid, clipHalfPlane, pointInRing, type Ring } from '../geo/polygon';
import { planBuilding, srgbToLinear, type BuildingPlan } from './BuildingPlan';
import type { MeshWriter } from './MeshWriter';
import type { BuildingFeature, Lod } from './types';

/**
 * Footprint -> building geometry.
 *
 * Geometry is spent only on silhouette: walls following the real footprint,
 * roof forms, setbacks, rooftop plant and projecting signs. Windows, doors,
 * storefronts, balconies and trim are drawn by the facade shader from the
 * per-vertex attributes written here, so a 40-storey tower costs the same
 * handful of quads as a shed.
 */

/** Surface types understood by the facade shader (attribute b.x). */
export const Surface = { wall: 0, flatRoof: 1, pitchedRoof: 2, solid: 3, sign: 4 } as const;

const SIGN_COLORS = [0xff3b6b, 0x29d3ff, 0xffd23f, 0xf5f5f5, 0xff5a2b, 0x55f08a, 0xc86bff].map(srgbToLinear);

export function generateBuilding(
  w: MeshWriter,
  b: BuildingFeature,
  style: StyleConfig,
  lod: Lod,
  ox: number,
  oz: number,
): void {
  const plan = planBuilding(b, style);
  // Skyline LOD drops structures that cannot be seen from that far.
  if (lod === 2 && b.area < 30 && plan.wallTop < 8) return;

  const rings: Ring[] = lod === 2 ? [b.rings[0]] : b.rings;
  const base = plan.baseY;
  w.color = plan.tint;
  w.attrC = [plan.floorH, plan.groundH, plan.fill[0], plan.fill[1]];

  let upper: number[] | null = null;
  let tierY = 0;
  if (plan.setbackAt > 0 && lod < 2) {
    upper = scaledRing(b.rings[0], 0.72);
    // Keep floors continuous across the step.
    tierY = base + plan.groundH + Math.max(1, Math.round(((plan.wallTop - base) * plan.setbackAt - plan.groundH) / plan.floorH)) * plan.floorH;
    if (!upper || tierY > plan.wallTop - plan.floorH * 2) upper = null;
  }

  if (upper) {
    walls(w, rings, base, tierY, plan, ox, oz);
    flatRoof(w, rings, tierY, plan, ox, oz);
    walls(w, [upper], tierY, plan.wallTop, plan, ox, oz);
    flatRoof(w, [upper], plan.wallTop, plan, ox, oz);
    if (lod === 0) rooftopUnit(w, b, upper, plan, ox, oz);
  } else if (plan.roof !== 'flat' && lod < 2) {
    walls(w, rings, base, plan.wallTop, plan, ox, oz);
    profileRoof(w, b.rings[0], plan, ox, oz);
  } else {
    // Far LOD replaces a pitched roof with a flat cap at its mean height.
    const top = plan.wallTop + (plan.roof !== 'flat' ? plan.roofRise * 0.5 : 0);
    walls(w, rings, base, top, plan, ox, oz);
    flatRoof(w, rings, top, plan, ox, oz);
    if (lod === 0 && plan.roof === 'flat') rooftopUnit(w, b, b.rings[0], plan, ox, oz);
  }

  if (lod === 0 && plan.sign) sign(w, b, plan, ox, oz);
}

function scaledRing(r: Ring, k: number): number[] | null {
  const [cx, cz] = centroid(r);
  const out: number[] = [];
  for (let i = 0; i < r.length; i += 2) {
    const x = cx + (r[i] - cx) * k;
    const z = cz + (r[i + 1] - cz) * k;
    // Shrinking about the centroid only stays inside for roughly convex shapes; verify.
    if (!pointInRing(x, z, r)) return null;
    out.push(x, z);
  }
  return out;
}

function walls(w: MeshWriter, rings: Ring[], y0: number, y1: number, p: BuildingPlan, ox: number, oz: number): void {
  if (y1 - y0 < 0.05) return;
  const wallH = p.wallTop - p.baseY;
  let uBase = 0;
  w.color = p.tint;
  for (const r of rings) {
    const n = r.length;
    for (let i = 0; i < n; i += 2) {
      const j = (i + 2) % n;
      const ax = r[i];
      const az = r[i + 1];
      const dx = r[j] - ax;
      const dz = r[j + 1] - az;
      const len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      // Rings are oriented so that (dz, -dx) points out of the solid.
      const nx = dz / len;
      const nz = -dx / len;
      // Bays are fitted to each wall so windows are never cut at a corner.
      const bays = Math.max(1, Math.round(len / p.bay));
      const pattern = len < p.bay * 0.6 ? WindowPattern.none : p.pattern;
      w.attrB = [Surface.wall, p.wallMat, p.seed, pattern];
      const v0 = y0 - p.baseY;
      const v1 = y1 - p.baseY;
      const a = w.vertex(ax - ox, y0, az - oz, nx, 0, nz, uBase, v0, wallH);
      const b = w.vertex(ax + dx - ox, y0, az + dz - oz, nx, 0, nz, uBase + bays, v0, wallH);
      const c = w.vertex(ax + dx - ox, y1, az + dz - oz, nx, 0, nz, uBase + bays, v1, wallH);
      const d = w.vertex(ax - ox, y1, az - oz, nx, 0, nz, uBase, v1, wallH);
      w.tri(a, c, b);
      w.tri(a, d, c);
      uBase += bays;
    }
  }
}

/** Triangulate rings (outer + holes) and call `emit` with each upward-facing triangle. */
function triangulate(rings: Ring[], emit: (i0: number, i1: number, i2: number, flat: number[]) => void): void {
  const flat: number[] = [];
  const holes: number[] = [];
  rings.forEach((r, k) => {
    if (k > 0) holes.push(flat.length / 2);
    for (let i = 0; i < r.length; i++) flat.push(r[i]);
  });
  const tris = earcut(flat, holes.length ? holes : undefined, 2);
  for (let t = 0; t < tris.length; t += 3) {
    const i0 = tris[t];
    let i1 = tris[t + 1];
    let i2 = tris[t + 2];
    const cross =
      (flat[i1 * 2] - flat[i0 * 2]) * (flat[i2 * 2 + 1] - flat[i0 * 2 + 1]) -
      (flat[i1 * 2 + 1] - flat[i0 * 2 + 1]) * (flat[i2 * 2] - flat[i0 * 2]);
    // In (x, z) a positive cross product faces -Y, so swap to face up.
    if (cross > 0) [i1, i2] = [i2, i1];
    emit(i0, i1, i2, flat);
  }
}

function flatRoof(w: MeshWriter, rings: Ring[], y: number, p: BuildingPlan, ox: number, oz: number): void {
  w.color = p.roofTint;
  w.attrB = [Surface.flatRoof, Mat.concrete, p.seed, 0];
  const first = w.vertexCount;
  let count = 0;
  for (const r of rings) {
    for (let i = 0; i < r.length; i += 2) {
      w.vertex(r[i] - ox, y, r[i + 1] - oz, 0, 1, 0, 0, y, y);
      count++;
    }
  }
  if (count < 3) return;
  triangulate(rings, (i0, i1, i2) => w.tri(first + i0, first + i1, first + i2));
}

/**
 * Pitched roof over an arbitrary footprint.
 *
 * The roof is a height profile across the building's short axis (a triangle
 * for a gable, a trapezoid for a mansard). The footprint is cut along the
 * profile's break lines so every piece is planar, then each piece is lifted to
 * the profile. Boundary edges that end up above the eaves are closed with
 * gable walls. This handles L-shapes and irregular lots without a straight
 * skeleton; it is an interpretation of the roof, not a survey of it.
 */
function profileRoof(w: MeshWriter, ring: Ring, p: BuildingPlan, ox: number, oz: number): void {
  const [ax, az] = p.axis;
  const nx = -az; // across-axis direction
  const nz = ax;
  const half = p.halfSpan;
  const mid = p.midSpan;
  const rise = p.roofRise;
  const inset = p.roof === 'gable' ? half : Math.min(half * 0.6, rise * 0.55);
  const heightAt = (x: number, z: number) => {
    const s = nx * x + nz * z;
    return rise * Math.min(1, Math.max(0, (half - Math.abs(s - mid)) / inset));
  };

  // Bands across the span: [lo, hi] in projected coordinate, with their slope sign.
  const bands: Array<{ lo: number; hi: number; slope: number }> = [];
  if (p.roof === 'gable') {
    bands.push({ lo: -Infinity, hi: mid, slope: 1 }, { lo: mid, hi: Infinity, slope: -1 });
  } else {
    bands.push(
      { lo: -Infinity, hi: mid - half + inset, slope: 1 },
      { lo: mid - half + inset, hi: mid + half - inset, slope: 0 },
      { lo: mid + half - inset, hi: Infinity, slope: -1 },
    );
  }

  const top = p.wallTop;
  for (const band of bands) {
    let piece: number[] = Array.from(ring);
    if (isFinite(band.lo)) piece = clipHalfPlane(piece, nx, nz, -band.lo);
    if (piece.length && isFinite(band.hi)) piece = clipHalfPlane(piece, -nx, -nz, band.hi);
    if (piece.length < 6) continue;

    // Roof surface. Normal of the plane y = top + slope * (rise / inset) * s.
    const g = (band.slope * rise) / inset;
    const nl = Math.hypot(g, 1);
    w.color = p.roofTint;
    w.attrB = [Surface.pitchedRoof, p.roofMat, p.seed, 0];
    const first = w.vertexCount;
    for (let i = 0; i < piece.length; i += 2) {
      const y = top + heightAt(piece[i], piece[i + 1]);
      w.vertex(piece[i] - ox, y, piece[i + 1] - oz, (-g * nx) / nl, 1 / nl, (-g * nz) / nl, 0, y, top);
    }
    triangulate([piece], (i0, i1, i2) => w.tri(first + i0, first + i1, first + i2));

    // Gable walls under boundary edges that rise above the eaves.
    w.color = p.tint;
    w.attrB = [Surface.wall, p.wallMat, p.seed, WindowPattern.none];
    const n = piece.length;
    for (let i = 0; i < n; i += 2) {
      const j = (i + 2) % n;
      const x0 = piece[i];
      const z0 = piece[i + 1];
      const x1 = piece[j];
      const z1 = piece[j + 1];
      const s0 = nx * x0 + nz * z0;
      const s1 = nx * x1 + nz * z1;
      // Edges lying on a cut line are interior to the roof.
      const onCut = (c: number) => isFinite(c) && Math.abs(s0 - c) < 1e-3 && Math.abs(s1 - c) < 1e-3;
      if (onCut(band.lo) || onCut(band.hi)) continue;
      const h0 = heightAt(x0, z0);
      const h1 = heightAt(x1, z1);
      if (h0 < 0.02 && h1 < 0.02) continue;
      const dx = x1 - x0;
      const dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      const wx = dz / len;
      const wz = -dx / len;
      const wallH = p.wallTop - p.baseY;
      const a = w.vertex(x0 - ox, top, z0 - oz, wx, 0, wz, 0, wallH, wallH + rise);
      const b = w.vertex(x1 - ox, top, z1 - oz, wx, 0, wz, 0, wallH, wallH + rise);
      const c = w.vertex(x1 - ox, top + h1, z1 - oz, wx, 0, wz, 0, wallH + h1, wallH + rise);
      const d = w.vertex(x0 - ox, top + h0, z0 - oz, wx, 0, wz, 0, wallH + h0, wallH + rise);
      w.tri(a, c, b);
      w.tri(a, d, c);
    }
  }
}

/** Oriented box. (ux, uz) is the unit direction of the box's U axis. */
function box(
  w: MeshWriter, cx: number, cz: number, y0: number, y1: number,
  ux: number, uz: number, halfU: number, halfV: number,
): void {
  const vx = -uz;
  const vz = ux;
  const corner = (su: number, sv: number): [number, number] => [
    cx + ux * halfU * su + vx * halfV * sv,
    cz + uz * halfU * su + vz * halfV * sv,
  ];
  const sides: Array<[[number, number], [number, number], number, number, number]> = [
    [corner(-1, -1), corner(1, -1), -vx, -vz, halfU * 2],
    [corner(1, -1), corner(1, 1), ux, uz, halfV * 2],
    [corner(1, 1), corner(-1, 1), vx, vz, halfU * 2],
    [corner(-1, 1), corner(-1, -1), -ux, -uz, halfV * 2],
  ];
  const h = y1 - y0;
  for (const [p0, p1, nx, nz, width] of sides) {
    const a = w.vertex(p0[0], y0, p0[1], nx, 0, nz, 0, 0, h);
    const b = w.vertex(p1[0], y0, p1[1], nx, 0, nz, width, 0, h);
    const c = w.vertex(p1[0], y1, p1[1], nx, 0, nz, width, h, h);
    const d = w.vertex(p0[0], y1, p0[1], nx, 0, nz, 0, h, h);
    // Winding chosen so the face is front-facing from outside for either handedness of (u, v).
    const cross = (p1[0] - p0[0]) * nz - (p1[1] - p0[1]) * nx;
    if (cross > 0) {
      w.tri(a, b, c);
      w.tri(a, c, d);
    } else {
      w.tri(a, c, b);
      w.tri(a, d, c);
    }
  }
  const c00 = corner(-1, -1);
  const c10 = corner(1, -1);
  const c11 = corner(1, 1);
  const c01 = corner(-1, 1);
  for (const [y, ny] of [[y1, 1], [y0, -1]] as const) {
    const a = w.vertex(c00[0], y, c00[1], 0, ny, 0, 0, 0, h);
    const b = w.vertex(c10[0], y, c10[1], 0, ny, 0, 0, 0, h);
    const c = w.vertex(c11[0], y, c11[1], 0, ny, 0, 0, 0, h);
    const d = w.vertex(c01[0], y, c01[1], 0, ny, 0, 0, 0, h);
    // (u, v) is a right-handed pair in x/z, which faces -Y when wound a-b-c.
    if (ny > 0) {
      w.tri(a, c, b);
      w.tri(a, d, c);
    } else {
      w.tri(a, b, c);
      w.tri(a, c, d);
    }
  }
}

/** Mechanical plant on larger flat roofs: breaks up the skyline for the cost of one box. */
function rooftopUnit(w: MeshWriter, b: BuildingFeature, ring: Ring, p: BuildingPlan, ox: number, oz: number): void {
  if (b.area < 140 || p.wallTop - p.baseY < 11) return;
  const rng = new Rng(foldId(b.id) ^ 0x51ed270b);
  if (!rng.chance(0.7)) return;
  const [cx, cz] = centroid(ring);
  const size = Math.min(7, Math.max(1.6, Math.sqrt(b.area) * rng.range(0.14, 0.24)));
  const halfU = size;
  const halfV = size * rng.range(0.5, 0.9);
  const [ux, uz] = p.axis;
  // All four corners must sit on the roof.
  for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const x = cx + ux * halfU * su - uz * halfV * sv;
    const z = cz + uz * halfU * su + ux * halfV * sv;
    if (!pointInRing(x, z, ring)) return;
  }
  w.color = [p.roofTint[0] * 0.8, p.roofTint[1] * 0.8, p.roofTint[2] * 0.82];
  w.attrB = [Surface.solid, Mat.metal, p.seed, 0];
  box(w, cx - ox, cz - oz, p.wallTop, p.wallTop + rng.range(1.6, 3.4), ux, uz, halfU, halfV);
}

/** Vertical illuminated blade sign projecting from the longest street wall. */
function sign(w: MeshWriter, b: BuildingFeature, p: BuildingPlan, ox: number, oz: number): void {
  const r = b.rings[0];
  const rng = new Rng(foldId(b.id) ^ 0x2f6b9d11);
  let best = -1;
  let bestLen = 4;
  for (let i = 0; i < r.length; i += 2) {
    const j = (i + 2) % r.length;
    const len = Math.hypot(r[j] - r[i], r[j + 1] - r[i + 1]);
    if (len > bestLen) {
      bestLen = len;
      best = i;
    }
  }
  if (best < 0) return;
  const j = (best + 2) % r.length;
  const dx = (r[j] - r[best]) / bestLen;
  const dz = (r[j + 1] - r[best + 1]) / bestLen;
  const nx = dz;
  const nz = -dx;
  const t = rng.range(0.15, 0.85);
  const reach = rng.range(0.7, 1.1);
  const height = Math.min(p.wallTop - p.baseY - p.groundH - 1.5, rng.range(3, 9));
  if (height < 2) return;
  const cx = r[best] + dx * bestLen * t + nx * (0.15 + reach / 2);
  const cz = r[best + 1] + dz * bestLen * t + nz * (0.15 + reach / 2);
  const y0 = p.baseY + p.groundH + 0.6;
  w.color = rng.pick(SIGN_COLORS);
  w.attrB = [Surface.sign, Mat.metal, rng.next(), 0];
  // U axis along the wall normal so the broad faces look up and down the street.
  box(w, cx - ox, cz - oz, y0, y0 + height, nx, nz, reach / 2, 0.11);
}
