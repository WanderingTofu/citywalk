/**
 * 2D polygon helpers on flat [x0, z0, x1, z1, ...] rings (open: the last
 * point is not a repeat of the first). All coordinates are local meters.
 */

export type Ring = Float32Array | number[];

/** Signed area (shoelace). Positive = counter-clockwise in the x/z math plane. */
export function signedArea(r: Ring): number {
  let a = 0;
  const n = r.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    a += r[i] * r[j + 1] - r[j] * r[i + 1];
  }
  return a / 2;
}

export function centroid(r: Ring): [number, number] {
  let cx = 0;
  let cz = 0;
  let a = 0;
  const n = r.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    const f = r[i] * r[j + 1] - r[j] * r[i + 1];
    cx += (r[i] + r[j]) * f;
    cz += (r[i + 1] + r[j + 1]) * f;
    a += f;
  }
  if (Math.abs(a) < 1e-9) {
    // Degenerate: fall back to the vertex average.
    let sx = 0;
    let sz = 0;
    for (let i = 0; i < n; i += 2) {
      sx += r[i];
      sz += r[i + 1];
    }
    return [sx / (n / 2), sz / (n / 2)];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

export function reversed(r: Ring): number[] {
  const out: number[] = [];
  for (let i = r.length - 2; i >= 0; i -= 2) out.push(r[i], r[i + 1]);
  return out;
}

/** Return the ring with the requested orientation (ccw = positive signed area). */
export function oriented(r: Ring, ccw: boolean): number[] {
  return signedArea(r) > 0 === ccw ? Array.from(r) : reversed(r);
}

export function pointInRing(x: number, z: number, r: Ring): boolean {
  let inside = false;
  const n = r.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = r[i];
    const zi = r[i + 1];
    const xj = r[j];
    const zj = r[j + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Point inside a polygon with holes (rings[0] is the outer ring). */
export function pointInPolygon(x: number, z: number, rings: Ring[]): boolean {
  if (!pointInRing(x, z, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) if (pointInRing(x, z, rings[i])) return false;
  return true;
}

/** Drop repeated points and points that lie on a straight line between their neighbours. */
export function cleanRing(r: Ring, eps = 0.05): number[] {
  const pts: number[] = [];
  const n = r.length;
  for (let i = 0; i < n; i += 2) {
    const m = pts.length;
    if (m >= 2 && Math.hypot(r[i] - pts[m - 2], r[i + 1] - pts[m - 1]) < eps) continue;
    pts.push(r[i], r[i + 1]);
  }
  while (pts.length >= 4 && Math.hypot(pts[0] - pts[pts.length - 2], pts[1] - pts[pts.length - 1]) < eps) {
    pts.length -= 2;
  }
  let changed = true;
  while (changed && pts.length > 6) {
    changed = false;
    const m = pts.length;
    for (let i = 0; i < m; i += 2) {
      const p = (i - 2 + m) % m;
      const q = (i + 2) % m;
      const ax = pts[i] - pts[p];
      const az = pts[i + 1] - pts[p + 1];
      const bx = pts[q] - pts[i];
      const bz = pts[q + 1] - pts[i + 1];
      const cross = Math.abs(ax * bz - az * bx);
      const len = Math.hypot(pts[q] - pts[p], pts[q + 1] - pts[p + 1]);
      if (ax * bx + az * bz > 0 && cross < eps * Math.max(len, 1e-6)) {
        pts.splice(i, 2);
        changed = true;
        break;
      }
    }
  }
  return pts;
}

/**
 * Clip a polygon against the half-plane  a*x + b*z + c >= 0  (Sutherland-Hodgman).
 * Exact for convex subjects; for concave subjects it can leave zero-width
 * bridges along the cut line, which are invisible once triangulated.
 */
export function clipHalfPlane(r: Ring, a: number, b: number, c: number): number[] {
  const out: number[] = [];
  const n = r.length;
  if (n < 6) return out;
  let px = r[n - 2];
  let pz = r[n - 1];
  let pd = a * px + b * pz + c;
  for (let i = 0; i < n; i += 2) {
    const x = r[i];
    const z = r[i + 1];
    const d = a * x + b * z + c;
    if (d >= 0 !== pd >= 0) {
      const t = pd / (pd - d);
      out.push(px + (x - px) * t, pz + (z - pz) * t);
    }
    if (d >= 0) out.push(x, z);
    px = x;
    pz = z;
    pd = d;
  }
  return out.length >= 6 ? out : [];
}

/** Clip a polygon to an axis-aligned rectangle. */
export function clipToRect(r: Ring, minX: number, minZ: number, maxX: number, maxZ: number): number[] {
  let p: number[] = clipHalfPlane(r, 1, 0, -minX);
  if (p.length) p = clipHalfPlane(p, -1, 0, maxX);
  if (p.length) p = clipHalfPlane(p, 0, 1, -minZ);
  if (p.length) p = clipHalfPlane(p, 0, -1, maxZ);
  return p;
}

export function ringBounds(r: Ring): { minX: number; minZ: number; maxX: number; maxZ: number } {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    if (r[i] < minX) minX = r[i];
    if (r[i] > maxX) maxX = r[i];
    if (r[i + 1] < minZ) minZ = r[i + 1];
    if (r[i + 1] > maxZ) maxZ = r[i + 1];
  }
  return { minX, minZ, maxX, maxZ };
}

/**
 * Principal axis of a footprint: the direction of its longest edge, which for
 * buildings is almost always parallel to a facade. Returns a unit vector.
 */
export function longestEdgeDirection(r: Ring): [number, number] {
  let best = 0;
  let dx = 1;
  let dz = 0;
  const n = r.length;
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n;
    const ex = r[j] - r[i];
    const ez = r[j + 1] - r[i + 1];
    const l = ex * ex + ez * ez;
    if (l > best) {
      best = l;
      dx = ex;
      dz = ez;
    }
  }
  const len = Math.hypot(dx, dz) || 1;
  return [dx / len, dz / len];
}

/**
 * Join open way segments end-to-end into closed rings (OSM multipolygon
 * members arrive as separate ways). Unclosable leftovers are dropped.
 */
export function stitchRings(parts: number[][], eps = 0.05): number[][] {
  const rings: number[][] = [];
  const open = parts.filter((p) => p.length >= 4).map((p) => p.slice());
  const same = (ax: number, az: number, bx: number, bz: number) => Math.abs(ax - bx) < eps && Math.abs(az - bz) < eps;

  while (open.length) {
    let cur = open.pop()!;
    let grew = true;
    while (grew) {
      const n = cur.length;
      if (n >= 8 && same(cur[0], cur[1], cur[n - 2], cur[n - 1])) break;
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const o = open[i];
        const m = o.length;
        const ex = cur[cur.length - 2];
        const ez = cur[cur.length - 1];
        if (same(ex, ez, o[0], o[1])) {
          cur = cur.concat(o.slice(2));
        } else if (same(ex, ez, o[m - 2], o[m - 1])) {
          cur = cur.concat(reversed(o).slice(2));
        } else {
          continue;
        }
        open.splice(i, 1);
        grew = true;
        break;
      }
    }
    const n = cur.length;
    if (n >= 8 && same(cur[0], cur[1], cur[n - 2], cur[n - 1])) {
      cur.length = n - 2;
      rings.push(cur);
    }
  }
  return rings;
}
