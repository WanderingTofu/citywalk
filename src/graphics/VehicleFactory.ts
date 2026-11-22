import * as THREE from 'three';

/**
 * Vehicle engine: every body type is generated from a short specification.
 *
 * A vehicle is a side silhouette lofted through a cross-section, the method
 * used in netanelyan/outbound: the section is pinched at the sills, widest at
 * the shoulder, pulled in toward the roof and tapered in plan at both ends, so
 * a few numbers give a body with real tumblehome rather than an extruded slab.
 * Glazing, trim, lamps and wheels are assigned by where a face sits on that
 * loft, not modelled by hand.
 *
 * Each type is built at two levels of detail. Paint is left white and tinted
 * per instance, and instances are scaled slightly, so a handful of meshes
 * populate a street with vehicles that do not repeat.
 */

export const VEHICLE_TYPES = [
  'sedan', 'hatchback', 'suv', 'pickup', 'van', 'sports', 'convertible', 'truck', 'motorcycle', 'semi',
] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

/** How often each type is found parked at the kerb (same order as VEHICLE_TYPES). */
export const PARKED_WEIGHTS = [26, 18, 20, 7, 9, 5, 3, 4, 6, 0];

/** Vertex colours double as part tags; the vehicle shader reads them back. */
const PAINT: RGB = [1, 1, 1];
const GLASS: RGB = [0.03, 0.04, 0.052];
const TRIM: RGB = [0.04, 0.04, 0.04];
const TYRE: RGB = [0.02, 0.02, 0.02];
const RIM: RGB = [0.46, 0.46, 0.46];
const HEADLAMP: RGB = [0.9, 0.88, 0.8];
const TAILLAMP: RGB = [0.45, 0.02, 0.02];
const CARGO: RGB = [0.8, 0.8, 0.78];
const CABIN: RGB = [0.05, 0.045, 0.04];

type RGB = [number, number, number];

interface VehicleSpec {
  length: number;
  width: number;
  height: number;
  /** Ground clearance, meters. */
  clearance: number;
  wheelRadius: number;
  /** Axle positions along the length, as fractions from the centre (rear negative). */
  axles: number[];
  /** Height of the waistline, fraction of the height. */
  belt: number;
  /** Roofline from tail (-0.5) to nose (+0.5): [position, height fraction]. */
  top: Array<[number, number]>;
  /** Indices i where the roofline segment i -> i+1 is glass (rear window, windscreen). */
  glass: number[];
  /** Extent of the side windows along the length. */
  cabin: [number, number];
  /** Width of the roof relative to the body (tumblehome). */
  tumble: number;
  /** Open top: the cabin is a tub with seats instead of a roof. */
  open?: boolean;
  /** Cargo bodies behind the cab: [x0, x1, y0, y1, half-width fraction]. */
  boxes?: Array<[number, number, number, number, number]>;
}

const SPECS: Record<VehicleType, VehicleSpec> = {
  sedan: {
    length: 4.65, width: 1.82, height: 1.44, clearance: 0.17, wheelRadius: 0.33, axles: [-0.3, 0.3], belt: 0.62,
    top: [[-0.5, 0.42], [-0.47, 0.6], [-0.3, 0.63], [-0.16, 0.97], [0.08, 1.0], [0.24, 0.64], [0.46, 0.57], [0.5, 0.38]],
    glass: [2, 4], cabin: [-0.28, 0.22], tumble: 0.82,
  },
  hatchback: {
    length: 4.05, width: 1.76, height: 1.5, clearance: 0.16, wheelRadius: 0.31, axles: [-0.31, 0.31], belt: 0.6,
    top: [[-0.5, 0.4], [-0.48, 0.66], [-0.36, 0.97], [0.06, 1.0], [0.25, 0.63], [0.46, 0.55], [0.5, 0.36]],
    glass: [1, 3], cabin: [-0.42, 0.23], tumble: 0.84,
  },
  suv: {
    length: 4.75, width: 1.93, height: 1.76, clearance: 0.23, wheelRadius: 0.38, axles: [-0.3, 0.3], belt: 0.6,
    top: [[-0.5, 0.42], [-0.49, 0.72], [-0.42, 0.98], [0.08, 1.0], [0.22, 0.66], [0.45, 0.6], [0.5, 0.4]],
    glass: [1, 3], cabin: [-0.44, 0.2], tumble: 0.87,
  },
  pickup: {
    length: 5.5, width: 1.98, height: 1.86, clearance: 0.26, wheelRadius: 0.4, axles: [-0.3, 0.3], belt: 0.58,
    top: [[-0.5, 0.44], [-0.495, 0.6], [-0.1, 0.6], [-0.08, 0.98], [0.12, 1.0], [0.24, 0.64], [0.46, 0.6], [0.5, 0.42]],
    glass: [2, 4], cabin: [-0.08, 0.22], tumble: 0.88,
  },
  van: {
    length: 5.05, width: 1.98, height: 2.02, clearance: 0.19, wheelRadius: 0.35, axles: [-0.3, 0.33], belt: 0.56,
    top: [[-0.5, 0.4], [-0.5, 0.97], [0.24, 1.0], [0.38, 0.6], [0.48, 0.52], [0.5, 0.36]],
    glass: [2], cabin: [0.1, 0.36], tumble: 0.93,
  },
  sports: {
    length: 4.45, width: 1.92, height: 1.22, clearance: 0.12, wheelRadius: 0.34, axles: [-0.29, 0.31], belt: 0.64,
    top: [[-0.5, 0.48], [-0.47, 0.68], [-0.32, 0.72], [-0.12, 0.98], [0.02, 1.0], [0.2, 0.68], [0.46, 0.52], [0.5, 0.34]],
    glass: [2, 4], cabin: [-0.3, 0.18], tumble: 0.76,
  },
  convertible: {
    length: 4.4, width: 1.88, height: 1.24, clearance: 0.13, wheelRadius: 0.33, axles: [-0.29, 0.31], belt: 0.66,
    top: [[-0.5, 0.46], [-0.47, 0.68], [-0.2, 0.7], [-0.18, 0.56], [0.1, 0.56], [0.13, 0.98], [0.22, 0.68], [0.46, 0.55], [0.5, 0.36]],
    glass: [5], cabin: [0.0, 0.0], tumble: 0.9, open: true,
  },
  truck: {
    length: 6.0, width: 2.2, height: 2.3, clearance: 0.3, wheelRadius: 0.42, axles: [-0.3, 0.34], belt: 0.5,
    top: [[-0.5, 0.36], [-0.5, 0.4], [0.2, 0.4], [0.21, 0.98], [0.36, 1.0], [0.46, 0.62], [0.5, 0.5], [0.5, 0.3]],
    glass: [4], cabin: [0.22, 0.44], tumble: 0.94,
    boxes: [[-0.5, 0.19, 0.4, 1.42, 1.04]],
  },
  motorcycle: {
    length: 2.1, width: 0.72, height: 1.08, clearance: 0.28, wheelRadius: 0.31, axles: [-0.34, 0.34], belt: 0.7,
    top: [[-0.45, 0.62], [-0.3, 0.74], [-0.02, 0.72], [0.06, 0.9], [0.22, 0.86], [0.3, 0.62]],
    glass: [], cabin: [0, 0], tumble: 0.6,
  },
  semi: {
    length: 16.5, width: 2.5, height: 2.9, clearance: 0.45, wheelRadius: 0.5, axles: [-0.45, -0.37, 0.22, 0.42], belt: 0.5,
    top: [[-0.5, 0.36], [-0.5, 0.4], [0.3, 0.4], [0.305, 0.98], [0.44, 1.0], [0.49, 0.66], [0.5, 0.5], [0.5, 0.26]],
    glass: [4], cabin: [0.32, 0.47], tumble: 0.96,
    boxes: [[-0.5, 0.26, 0.42, 1.38, 1.0]],
  },
};

/** Accumulates flat-coloured triangles with smooth normals supplied by the caller. */
class Soup {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];

  tri(a: number[], b: number[], c: number[], na: number[], nb: number[], nc: number[], color: RGB): void {
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.nrm.push(na[0], na[1], na[2], nb[0], nb[1], nb[2], nc[0], nc[1], nc[2]);
    for (let i = 0; i < 3; i++) this.col.push(color[0], color[1], color[2]);
  }

  /** Flat-shaded quad a-b-c-d, wound so its normal agrees with `n`. */
  quad(a: number[], b: number[], c: number[], d: number[], n: number[], color: RGB): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const g = (uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2];
    if (g >= 0) {
      this.tri(a, b, c, n, n, n, color);
      this.tri(a, c, d, n, n, n, color);
    } else {
      this.tri(a, c, b, n, n, n, color);
      this.tri(a, d, c, n, n, n, color);
    }
  }

  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: RGB): void {
    const p = (x: number, y: number, z: number) => [x, y, z];
    this.quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1), [0, 0, 1], color);
    this.quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y1, z0), p(x0, y1, z0), [0, 0, -1], color);
    this.quad(p(x1, y0, z0), p(x1, y0, z1), p(x1, y1, z1), p(x1, y1, z0), [1, 0, 0], color);
    this.quad(p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0), [-1, 0, 0], color);
    this.quad(p(x0, y1, z0), p(x1, y1, z0), p(x1, y1, z1), p(x0, y1, z1), [0, 1, 0], color);
    this.quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1), [0, -1, 0], color);
  }

  /** Wheel: a tyre with its axle along z, and optionally a rim face and a dark arch behind it. */
  wheel(x: number, r: number, zIn: number, zOut: number, sides: number, detailed: boolean): void {
    const out = zOut > zIn ? 1 : -1;
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const p00 = [x + c0 * r, r + s0 * r, zIn], p01 = [x + c0 * r, r + s0 * r, zOut];
      const p10 = [x + c1 * r, r + s1 * r, zIn], p11 = [x + c1 * r, r + s1 * r, zOut];
      const n0 = [c0, s0, 0], n1 = [c1, s1, 0];
      // Tread, with smooth normals round the tyre.
      if (out > 0) {
        this.tri(p00, p10, p11, n0, n1, n1, TYRE);
        this.tri(p00, p11, p01, n0, n1, n0, TYRE);
      } else {
        this.tri(p00, p11, p10, n0, n1, n1, TYRE);
        this.tri(p00, p01, p11, n0, n0, n1, TYRE);
      }
      // Sidewall and rim, as a fan on the outer face.
      const hub = [x, r, zOut + out * 0.004];
      const nz = [0, 0, out];
      const k = detailed ? 0.62 : 1;
      const q0 = [x + c0 * r * k, r + s0 * r * k, hub[2]], q1 = [x + c1 * r * k, r + s1 * r * k, hub[2]];
      if (detailed) this.quad(p01, p11, q1, q0, nz, TYRE);
      const face = detailed ? RIM : TYRE;
      if (out > 0) this.tri(hub, q0, q1, nz, nz, nz, face);
      else this.tri(hub, q1, q0, nz, nz, nz, face);
    }
  }
}

function sampleTop(top: Array<[number, number]>, x: number): number {
  if (x <= top[0][0]) return top[0][1];
  for (let i = 0; i + 1 < top.length; i++) {
    const [x0, y0] = top[i];
    const [x1, y1] = top[i + 1];
    if (x <= x1) return x1 - x0 < 1e-6 ? Math.max(y0, y1) : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return top[top.length - 1][1];
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function buildVehicle(type: VehicleType, lod: 0 | 1): THREE.BufferGeometry {
  const spec = SPECS[type];
  const detailed = lod === 0;
  const s = new Soup();
  const L = spec.length;
  const H = spec.height;
  const halfW = spec.width / 2;
  const beltY = spec.belt * H;

  if (type === 'motorcycle') {
    motorcycle(s, spec, detailed);
  } else {
    // --- stations along the length -------------------------------------
    const stations: number[] = [];
    for (let i = 0; i < spec.top.length; i++) {
      const x = spec.top[i][0];
      if (stations.length === 0 || x - stations[stations.length - 1] > 1e-4) stations.push(x);
      else stations.push(x + 2e-4); // a vertical step in the roofline needs two distinct stations
      if (detailed && i + 1 < spec.top.length && spec.top[i + 1][0] - x > 0.12) stations.push((x + spec.top[i + 1][0]) / 2);
    }
    stations.sort((a, b) => a - b);

    // --- cross-section at each station ---------------------------------
    // Half-ring from the centre of the floor up the side to the centre of the roof.
    const ringAt = (xf: number): number[][] => {
      const yTop = sampleTop(spec.top, xf) * H;
      // Plan taper: the body narrows toward nose and tail.
      const w = halfW * (1 - 0.13 * smooth(0.34, 0.5, Math.abs(xf)));
      // How much of a greenhouse there is above the waistline here.
      const roofed = smooth(beltY + 0.03, beltY + 0.3, yTop);
      const tu = 1 - (1 - spec.tumble) * roofed - 0.03;
      const shoulder = Math.min(beltY, yTop - 0.07);
      const x = xf * L;
      const half = detailed
        ? [
            [x, spec.clearance, 0], [x, spec.clearance, w * 0.86], [x, spec.clearance + 0.11, w], [x, shoulder, w],
            [x, yTop - 0.06, w * tu], [x, yTop, w * tu - 0.09], [x, yTop + 0.015, 0],
          ]
        : [[x, spec.clearance, w], [x, shoulder, w], [x, yTop, w * tu]];
      const ring = half.slice();
      for (let i = half.length - 1; i >= 0; i--) {
        if (detailed && (i === half.length - 1 || i === 0)) continue; // centre points are shared
        ring.push([half[i][0], half[i][1], -half[i][2]]);
      }
      return ring;
    };
    const rings = stations.map(ringAt);
    const R = rings[0].length;

    // Smooth normals: average of the faces around each loft vertex.
    const normals = rings.map((r) => r.map(() => [0, 0, 0]));
    const faceNormal = (a: number[], b: number[], c: number[]) => {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    };
    for (let i = 0; i + 1 < rings.length; i++) {
      for (let k = 0; k < R; k++) {
        const k1 = (k + 1) % R;
        const n = faceNormal(rings[i][k], rings[i + 1][k], rings[i][k1]);
        for (const [ii, kk] of [[i, k], [i + 1, k], [i, k1], [i + 1, k1]]) {
          normals[ii][kk][0] += n[0];
          normals[ii][kk][1] += n[1];
          normals[ii][kk][2] += n[2];
        }
      }
    }
    // The loft winds so that face normals point inward for one handedness; fix the sign from a known side.
    const probe = normals[Math.floor(rings.length / 2)][detailed ? 3 : 1];
    const flip = probe[2] < 0 ? -1 : 1;
    for (const ring of normals) {
      for (const n of ring) {
        const l = Math.hypot(n[0], n[1], n[2]) || 1;
        n[0] = (n[0] / l) * flip;
        n[1] = (n[1] / l) * flip;
        n[2] = (n[2] / l) * flip;
      }
    }

    // --- skin, classified by where each face sits ------------------------
    const glassSegment = (x: number): boolean => {
      for (const g of spec.glass) if (x > spec.top[g][0] - 1e-3 && x < spec.top[g + 1][0] + 1e-3) return true;
      return false;
    };
    for (let i = 0; i + 1 < rings.length; i++) {
      const xm = (stations[i] + stations[i + 1]) / 2;
      const inCabin = xm > spec.cabin[0] && xm < spec.cabin[1];
      const roofHere = sampleTop(spec.top, xm) * H > beltY + 0.2;
      for (let k = 0; k < R; k++) {
        const k1 = (k + 1) % R;
        // Edge index measured up one side of the car, whichever side this is.
        const e = detailed ? (k < 6 ? k : 11 - k) : k < 2 ? k : k === 2 ? 2 : k === 5 ? -1 : 4 - k;
        let color: RGB = PAINT;
        if (detailed) {
          if (e === 0 || e === 1) color = TRIM;                                    // floor and sills
          else if (e === 3 && inCabin && roofHere) color = GLASS;                  // side windows
          else if (e === 5 && glassSegment(xm)) color = GLASS;                     // windscreen and rear window
          else if (e === 5 && spec.open && xm > spec.top[3][0] && xm < spec.top[4][0]) color = CABIN;
        } else {
          if (e === -1) color = TRIM;
          else if (e === 1 && inCabin && roofHere) color = GLASS;
          else if (e === 2 && glassSegment(xm)) color = GLASS;
        }
        const a = rings[i][k], b = rings[i + 1][k], c = rings[i + 1][k1], d = rings[i][k1];
        const na = normals[i][k], nb = normals[i + 1][k], nc = normals[i + 1][k1], nd = normals[i][k1];
        const g = faceNormal(a, b, c);
        const out = (g[0] * na[0] + g[1] * na[1] + g[2] * na[2]) >= 0;
        if (out) {
          s.tri(a, b, c, na, nb, nc, color);
          s.tri(a, c, d, na, nc, nd, color);
        } else {
          s.tri(a, c, b, na, nc, nb, color);
          s.tri(a, d, c, na, nd, nc, color);
        }
      }
    }
    // End caps.
    for (const [ring, nx] of [[rings[0], -1], [rings[rings.length - 1], 1]] as const) {
      const n = [nx, 0, 0];
      for (let k = 1; k + 1 < R; k++) {
        if (nx > 0) s.tri(ring[0], ring[k + 1], ring[k], n, n, n, PAINT);
        else s.tri(ring[0], ring[k], ring[k + 1], n, n, n, PAINT);
      }
    }

    // --- cargo bodies -----------------------------------------------------
    for (const [x0, x1, y0, y1, wf] of spec.boxes ?? []) s.box(x0 * L, x1 * L, y0 * H, y1 * H, -halfW * wf, halfW * wf, CARGO);

    if (detailed) {
      // Bumpers, lamps and a grille, placed against the tapered ends.
      const endW = halfW * 0.86;
      const nose = L / 2;
      const noseY = sampleTop(spec.top, 0.47) * H;
      const tailY = sampleTop(spec.top, -0.47) * H;
      s.box(nose - 0.02, nose + 0.035, spec.clearance, spec.clearance + 0.2, -endW, endW, TRIM);
      s.box(-nose - 0.035, -nose + 0.02, spec.clearance, spec.clearance + 0.2, -endW, endW, TRIM);
      s.box(nose - 0.02, nose + 0.03, noseY - 0.3, noseY - 0.17, -endW * 0.45, endW * 0.45, TRIM);
      for (const side of [-1, 1]) {
        s.box(nose - 0.02, nose + 0.032, noseY - 0.3, noseY - 0.17, side * endW * 0.55, side * endW * 0.95, HEADLAMP);
        s.box(-nose - 0.032, -nose + 0.02, tailY - 0.24, tailY - 0.1, side * endW * 0.5, side * endW * 0.95, TAILLAMP);
      }
      if (spec.open) {
        // Two seats and a dashboard in the tub.
        for (const side of [-1, 1]) s.box(-0.12 * L, -0.02 * L, beltY - 0.25, beltY + 0.1, side * 0.2 - 0.17, side * 0.2 + 0.17, CABIN);
      }
    }

    // --- wheels -------------------------------------------------------------
    const sides = detailed ? 12 : 6;
    const tyre = spec.wheelRadius * 0.7;
    for (const ax of spec.axles) {
      const w = halfW * (1 - 0.13 * smooth(0.34, 0.5, Math.abs(ax)));
      for (const side of [-1, 1]) {
        s.wheel(ax * L, spec.wheelRadius, side * (w - tyre + 0.02), side * (w + 0.02), sides, detailed);
        if (detailed) {
          // Dark wheel arch: a disc just proud of the body behind the tyre.
          const r = spec.wheelRadius * 1.22;
          const z = side * (w + 0.006);
          const n = [0, 0, side];
          for (let i = 0; i < 12; i++) {
            const a0 = (i / 12) * Math.PI * 2, a1 = ((i + 1) / 12) * Math.PI * 2;
            const p0 = [ax * L + Math.cos(a0) * r, Math.max(spec.wheelRadius + Math.sin(a0) * r, spec.clearance), z];
            const p1 = [ax * L + Math.cos(a1) * r, Math.max(spec.wheelRadius + Math.sin(a1) * r, spec.clearance), z];
            const c = [ax * L, spec.wheelRadius, z];
            if (side > 0) s.tri(c, p0, p1, n, n, n, TRIM);
            else s.tri(c, p1, p0, n, n, n, TRIM);
          }
        }
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(s.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(s.nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(s.col, 3));
  // Built with the length along +X; instances expect it along +Z.
  g.rotateY(-Math.PI / 2);
  g.computeBoundingSphere();
  return g;
}

/** A motorcycle is too thin to loft: wheels, a tank, a seat and a few bars. */
function motorcycle(s: Soup, spec: VehicleSpec, detailed: boolean): void {
  const L = spec.length;
  const r = spec.wheelRadius;
  const sides = detailed ? 12 : 6;
  for (const ax of spec.axles) {
    s.wheel(ax * L, r, -0.06, 0.06, sides, detailed);
    s.wheel(ax * L, r, 0.06, -0.06, sides, detailed);
  }
  s.box(-0.05, 0.3, 0.68, 0.9, -0.14, 0.14, PAINT);            // tank
  s.box(-0.62, -0.05, 0.7, 0.8, -0.13, 0.13, CABIN);           // seat
  s.box(-0.35, 0.35, 0.34, 0.66, -0.11, 0.11, TRIM);           // engine
  s.box(-0.78, -0.55, 0.62, 0.74, -0.09, 0.09, PAINT);         // tail
  if (detailed) {
    s.box(0.5, 0.56, 0.9, 1.04, -0.32, 0.32, TRIM);            // handlebar
    s.box(0.56, 0.62, 0.5, 1.0, -0.035, 0.035, RIM);           // fork
    s.box(0.6, 0.66, 0.8, 0.94, -0.08, 0.08, HEADLAMP);
    s.box(-0.8, -0.77, 0.66, 0.72, -0.06, 0.06, TAILLAMP);
    s.box(-0.5, -0.1, 0.3, 0.36, 0.1, 0.16, RIM);              // exhaust
  }
}

export class VehicleFactory {
  private cache = new Map<string, THREE.BufferGeometry>();

  /** Geometry for a type at a level of detail (0 = near). Built on first use and shared. */
  geometry(type: number, lod: 0 | 1): THREE.BufferGeometry {
    const name = VEHICLE_TYPES[type] ?? 'sedan';
    const key = `${name}:${lod}`;
    let g = this.cache.get(key);
    if (!g) this.cache.set(key, (g = buildVehicle(name, lod)));
    return g;
  }

  /** Triangle count of a type at a level of detail, for tests and budgets. */
  triangles(type: number, lod: 0 | 1): number {
    return this.geometry(type, lod).getAttribute('position').count / 3;
  }

  dispose(): void {
    for (const g of this.cache.values()) g.dispose();
    this.cache.clear();
  }
}

/** Paint colours, weighted toward the whites, blacks and greys real streets are full of. */
export const VEHICLE_PAINTS = [
  0xe9e9e6, 0xe9e9e6, 0x17181b, 0x17181b, 0x9a9da1, 0x9a9da1, 0x5b5f66, 0xcfd2d4, 0x1e2a44, 0x7a1418, 0x2c2e31, 0xb8b29f,
  0x23402f, 0x6b6f75, 0x2f5f8a, 0xc9a227,
].map((hex) => new THREE.Color(hex));
