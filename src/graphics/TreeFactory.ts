import * as THREE from 'three';
import { Rng, hashString } from '../core/rng';

/**
 * Tree engine: species are parameter sets, trees are grown from a seed.
 *
 * The method follows dgreenheck/ez-tree: a recursive skeleton of tapering
 * branch sections, each level splitting into children at a characteristic
 * angle with a little random wander ("gnarliness") and a pull toward the
 * light, finished with leaf cards at the twigs. Leaves and bark are painted
 * procedurally onto a small canvas atlas at start-up, so there are still no
 * image files to download.
 *
 * Each species has a few seeded variants and two levels of detail: the grown
 * tree for the detail ring around the player, and a handful of polygons with
 * the same silhouette beyond it.
 */

export const TREE_SPECIES = ['broadleaf', 'plane', 'conifer', 'palm'] as const;
export type TreeSpecies = (typeof TREE_SPECIES)[number];
export const TREE_VARIANTS = 3;

interface SpeciesSpec {
  trunkLength: number;
  trunkRadius: number;
  /** Number of child branches spawned at each level below the trunk. */
  children: number[];
  /** Angle between a child and its parent, radians. */
  angle: number;
  /** Child length as a fraction of its parent. */
  lengthRatio: number;
  /** Random wander per section, radians. */
  gnarliness: number;
  /** Pull toward vertical per section, 0..1. */
  lift: number;
  leafSize: number;
  leavesPerTwig: number;
}

const SPECS: Record<'broadleaf' | 'plane', SpeciesSpec> = {
  // Round-crowned park tree.
  broadleaf: { trunkLength: 2.8, trunkRadius: 0.2, children: [4, 3], angle: 0.95, lengthRatio: 0.78, gnarliness: 0.16, lift: 0.1, leafSize: 1.7, leavesPerTwig: 3 },
  // Tall street tree with a clear stem and an upswept crown.
  plane: { trunkLength: 4.6, trunkRadius: 0.22, children: [5, 3], angle: 0.7, lengthRatio: 0.72, gnarliness: 0.12, lift: 0.22, leafSize: 1.6, leavesPerTwig: 3 },
};

/** Atlas layout: leaves in the left half (with alpha), bark in the right half (opaque). */
const LEAF_U: [number, number] = [0.01, 0.49];
const BARK_U: [number, number] = [0.52, 0.98];

class TreeMesh {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];

  vertex(p: THREE.Vector3, n: THREE.Vector3, u: number, v: number, shade: number): number {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.col.push(shade, shade, shade);
    return this.pos.length / 3 - 1;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();

/** Any unit vector perpendicular to `d`. */
function perpendicular(d: THREE.Vector3): THREE.Vector3 {
  const p = Math.abs(d.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  return p.cross(d).normalize();
}

/** A tapering tube along a path of sections. Returns nothing; writes into the mesh. */
function tube(mesh: TreeMesh, points: THREE.Vector3[], radii: number[], sides: number, vScale: number): void {
  const first = mesh.pos.length / 3;
  let along = 0;
  for (let i = 0; i < points.length; i++) {
    const dir = tmpA.copy(points[Math.min(i + 1, points.length - 1)]).sub(points[Math.max(i - 1, 0)]).normalize();
    const side = perpendicular(dir);
    const other = tmpB.copy(dir).cross(side).normalize().clone();
    if (i > 0) along += points[i].distanceTo(points[i - 1]);
    for (let k = 0; k <= sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      const n = side.clone().multiplyScalar(Math.cos(a)).addScaledVector(other, Math.sin(a));
      const p = points[i].clone().addScaledVector(n, radii[i]);
      mesh.vertex(p, n, BARK_U[0] + (BARK_U[1] - BARK_U[0]) * (k / sides), along * vScale, 1);
    }
  }
  const ring = sides + 1;
  for (let i = 0; i + 1 < points.length; i++) {
    for (let k = 0; k < sides; k++) {
      const a = first + i * ring + k;
      mesh.idx.push(a, a + 1, a + ring, a + 1, a + ring + 1, a + ring);
    }
  }
}

/** Two crossed quads carrying a spray of leaves. Normals point away from the crown's centre for soft shading. */
function leafCard(mesh: TreeMesh, at: THREE.Vector3, size: number, crown: THREE.Vector3, rng: Rng, shade: number): void {
  const n = at.clone().sub(crown).normalize().multiplyScalar(0.75).add(tmpA.set(0, 0.45, 0)).normalize();
  const yaw = rng.next() * Math.PI;
  const tilt = rng.range(-0.5, 0.5);
  for (let q = 0; q < 2; q++) {
    const a = yaw + (q * Math.PI) / 2;
    const u = new THREE.Vector3(Math.cos(a), Math.sin(tilt) * 0.5, Math.sin(a)).normalize().multiplyScalar(size / 2);
    const v = new THREE.Vector3(-Math.sin(a) * Math.sin(tilt) * 0.3, 1, Math.cos(a) * Math.sin(tilt) * 0.3).normalize().multiplyScalar(size / 2);
    const i0 = mesh.vertex(at.clone().sub(u).sub(v), n, LEAF_U[0], 0.02, shade * 0.8);
    const i1 = mesh.vertex(at.clone().add(u).sub(v), n, LEAF_U[1], 0.02, shade * 0.8);
    const i2 = mesh.vertex(at.clone().add(u).add(v), n, LEAF_U[1], 0.98, shade);
    const i3 = mesh.vertex(at.clone().sub(u).add(v), n, LEAF_U[0], 0.98, shade);
    mesh.idx.push(i0, i1, i2, i0, i2, i3);
  }
}

function growBroadleaf(spec: SpeciesSpec, rng: Rng): THREE.BufferGeometry {
  const mesh = new TreeMesh();
  const twigs: THREE.Vector3[] = [];

  const grow = (origin: THREE.Vector3, direction: THREE.Vector3, length: number, radius: number, level: number): void => {
    const sections = level === 0 ? 5 : level === 1 ? 4 : 3;
    const sides = level === 0 ? 7 : level === 1 ? 5 : 4;
    const points = [origin.clone()];
    const radii = [radius];
    const dir = direction.clone();
    const taper = level === spec.children.length ? 0.85 : 0.45;
    for (let i = 1; i <= sections; i++) {
      // Wander a little, and bend toward the light.
      dir.x += rng.range(-1, 1) * spec.gnarliness;
      dir.z += rng.range(-1, 1) * spec.gnarliness;
      dir.lerp(UP, level === 0 ? 0.3 : spec.lift).normalize();
      points.push(points[i - 1].clone().addScaledVector(dir, length / sections));
      radii.push(radius * (1 - (taper * i) / sections));
    }
    tube(mesh, points, radii, sides, 0.35);

    if (level < spec.children.length) {
      const count = spec.children[level];
      const base = rng.next() * Math.PI * 2;
      for (let c = 0; c < count; c++) {
        // Children leave the upper part of the parent, spread evenly round it.
        const t = level === 0 ? 0.62 + (0.38 * (c + rng.next() * 0.6)) / count : 0.4 + (0.6 * (c + rng.next() * 0.6)) / count;
        const f = t * sections;
        const i = Math.min(sections - 1, Math.floor(f));
        const at = points[i].clone().lerp(points[i + 1], f - i);
        const parent = points[i + 1].clone().sub(points[i]).normalize();
        const side = perpendicular(parent).applyAxisAngle(parent, base + (c / count) * Math.PI * 2 + rng.range(-0.3, 0.3));
        const childDir = parent.clone().applyAxisAngle(side, spec.angle * rng.range(0.8, 1.15)).normalize();
        grow(at, childDir, length * spec.lengthRatio * rng.range(0.85, 1.1), radii[i] * 0.62, level + 1);
      }
      if (level > 0) twigs.push(points[sections]);
    } else {
      // Twigs: leaves along the outer half and at the tip.
      for (let k = 0; k < spec.leavesPerTwig; k++) {
        const t = 0.45 + (0.55 * (k + 1)) / spec.leavesPerTwig;
        const f = t * sections;
        const i = Math.min(sections - 1, Math.floor(f));
        twigs.push(points[i].clone().lerp(points[i + 1], f - i));
      }
    }
  };
  grow(new THREE.Vector3(), new THREE.Vector3(rng.range(-0.06, 0.06), 1, rng.range(-0.06, 0.06)).normalize(), spec.trunkLength, spec.trunkRadius, 0);

  // Crown centre and extent, for shading leaves darker toward the inside.
  const crown = new THREE.Vector3();
  for (const p of twigs) crown.add(p);
  crown.multiplyScalar(1 / Math.max(twigs.length, 1));
  let reach = 0.1;
  for (const p of twigs) reach = Math.max(reach, p.distanceTo(crown));
  for (const p of twigs) {
    const outer = p.distanceTo(crown) / reach;
    const jitter = tmpB.set(rng.range(-0.35, 0.35), rng.range(-0.2, 0.3), rng.range(-0.35, 0.35));
    leafCard(mesh, p.clone().add(jitter), spec.leafSize * rng.range(0.8, 1.2), crown, rng, 0.55 + 0.45 * outer);
  }
  // A few cards in the heart of the crown stop daylight showing straight through it.
  for (let k = 0; k < 6; k++) {
    const p = crown.clone().add(tmpB.set(rng.range(-1, 1), rng.range(-0.6, 0.8), rng.range(-1, 1)).multiplyScalar(reach * 0.45));
    leafCard(mesh, p, spec.leafSize * 1.25, crown, rng, 0.5);
  }
  return mesh.build();
}

function growConifer(rng: Rng): THREE.BufferGeometry {
  const mesh = new TreeMesh();
  const height = rng.range(8, 11);
  tube(mesh, [new THREE.Vector3(), new THREE.Vector3(0, height * 0.5, 0), new THREE.Vector3(0, height, 0)], [0.2, 0.12, 0.03], 6, 0.35);
  const crown = new THREE.Vector3(0, height * 0.55, 0);
  // Tiers of drooping sprays, narrowing to the top.
  const tiers = 7;
  for (let t = 0; t < tiers; t++) {
    const f = t / (tiers - 1);
    const y = height * (0.18 + 0.78 * f);
    const r = (1 - f) * 1.9 + 0.25;
    const n = Math.max(3, Math.round(6 - f * 3));
    const base = rng.next() * Math.PI * 2;
    for (let k = 0; k < n; k++) {
      const a = base + (k / n) * Math.PI * 2;
      leafCard(mesh, new THREE.Vector3(Math.cos(a) * r * 0.55, y, Math.sin(a) * r * 0.55), r * 1.5 + 0.6, crown, rng, 0.6 + 0.4 * f);
    }
  }
  return mesh.build();
}

function growPalm(rng: Rng): THREE.BufferGeometry {
  const mesh = new TreeMesh();
  const height = rng.range(8, 12);
  const lean = new THREE.Vector3(rng.range(-0.12, 0.12), 0, rng.range(-0.12, 0.12));
  const points: THREE.Vector3[] = [];
  const radii: number[] = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    points.push(new THREE.Vector3(lean.x * height * t * t, height * t, lean.z * height * t * t));
    radii.push(0.2 - 0.07 * t + (i === 0 ? 0.08 : 0));
  }
  tube(mesh, points, radii, 7, 1.2);
  const top = points[8];
  const fronds = 15;
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + rng.range(-0.15, 0.15);
    const droop = rng.range(0.25, 1.0);
    const length = rng.range(2.8, 3.8);
    const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const side = new THREE.Vector3(-out.z, 0, out.x);
    const width = 0.55;
    // A frond is a strip that rises, arches over and hangs.
    const segments = 4;
    let prev: [number, number] | null = null;
    for (let s = 0; s <= segments; s++) {
      const t = s / segments;
      const p = top.clone().addScaledVector(out, length * t).add(tmpA.set(0, 0.9 * Math.sin(t * Math.PI * 0.6) - droop * length * 0.45 * t * t, 0));
      const n = new THREE.Vector3(0, 1, 0).addScaledVector(out, t * 0.6).normalize();
      const w = width * (0.5 + Math.sin(t * Math.PI) * 0.9);
      const v = 0.02 + 0.96 * t;
      const i0 = mesh.vertex(p.clone().addScaledVector(side, -w), n, LEAF_U[0], v, 0.75 + 0.25 * t);
      const i1 = mesh.vertex(p.clone().addScaledVector(side, w), n, LEAF_U[1], v, 0.75 + 0.25 * t);
      if (prev) mesh.idx.push(prev[0], prev[1], i1, prev[0], i1, i0);
      prev = [i0, i1];
    }
  }
  return mesh.build();
}

/** Far stand-in: a trunk and a few solid shapes with the species' silhouette, coloured per vertex. */
function simplified(species: TreeSpecies): THREE.BufferGeometry {
  const parts: Array<{ g: THREE.BufferGeometry; color: (y: number) => [number, number, number] }> = [];
  const leaf = (lo: number, hi: number) => (y: number): [number, number, number] => {
    const t = Math.min(1, Math.max(0, (y - lo) / (hi - lo)));
    return [0.05 + 0.1 * t, 0.13 + 0.22 * t, 0.04 + 0.05 * t];
  };
  const bark = (): [number, number, number] => [0.1, 0.075, 0.055];
  const lobe = (x: number, y: number, z: number, r: number, squash = 0.9) => {
    const g = new THREE.IcosahedronGeometry(r, 1);
    g.scale(1, squash, 1);
    g.translate(x, y, z);
    return g;
  };
  if (species === 'conifer') {
    const trunk = new THREE.CylinderGeometry(0.1, 0.18, 2, 5, 1, true).toNonIndexed();
    trunk.translate(0, 1, 0);
    const cone = new THREE.ConeGeometry(1.9, 8, 7, 2, true).toNonIndexed();
    cone.translate(0, 5.5, 0);
    parts.push({ g: trunk, color: bark }, { g: cone, color: leaf(1.5, 9.5) });
  } else if (species === 'palm') {
    const trunk = new THREE.CylinderGeometry(0.13, 0.22, 9.5, 5, 1, true).toNonIndexed();
    trunk.translate(0, 4.75, 0);
    const head = new THREE.ConeGeometry(3.2, 1.6, 8, 1, true).toNonIndexed();
    head.translate(0, 9.6, 0);
    parts.push({ g: trunk, color: bark }, { g: head, color: leaf(8.6, 10.4) });
  } else {
    const tall = species === 'plane';
    const trunk = new THREE.CylinderGeometry(0.11, 0.2, tall ? 5 : 3, 5, 1, true).toNonIndexed();
    trunk.translate(0, tall ? 2.5 : 1.5, 0);
    const y = tall ? 7.4 : 4.6;
    parts.push({ g: trunk, color: bark });
    for (const [x, dy, z, r] of [[0, 0, 0, 2.0], [1.3, -0.5, 0.5, 1.5], [-1.1, -0.4, 0.8, 1.55], [-0.3, -0.6, -1.4, 1.45], [0.5, 1.2, -0.2, 1.4]]) {
      parts.push({ g: lobe(x, y + dy, z, r * (tall ? 1.1 : 1)), color: leaf(y - 2.2, y + 2.6) });
    }
  }
  const pos: number[] = [];
  const col: number[] = [];
  for (const { g, color } of parts) {
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      col.push(...color(p.getY(i)));
    }
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.computeVertexNormals();
  out.computeBoundingSphere();
  return out;
}

/** Paint a leaf spray (left) and bark (right) onto one canvas. */
function paintAtlas(species: TreeSpecies): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const g = canvas.getContext('2d')!;
  const rng = new Rng(hashString('atlas:' + species));
  g.clearRect(0, 0, 512, 256);

  if (species === 'palm') {
    // A feather: a rib with leaflets swept toward the tip (tip at the top of the image).
    g.strokeStyle = '#6f7f3a';
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(128, 254);
    g.lineTo(128, 4);
    g.stroke();
    for (let i = 0; i < 46; i++) {
      const y = 250 - i * 5.3;
      const reach = 118 * Math.sin(Math.min(1, (i + 3) / 46) * Math.PI * 0.95) + 6;
      for (const side of [-1, 1]) {
        g.strokeStyle = `rgb(${rng.int(46, 78)},${rng.int(104, 142)},${rng.int(38, 60)})`;
        g.lineWidth = rng.range(3.2, 5);
        g.beginPath();
        g.moveTo(128, y);
        g.quadraticCurveTo(128 + side * reach * 0.6, y - 10, 128 + side * reach, y - 26 - rng.range(0, 10));
        g.stroke();
      }
    }
  } else {
    // A spray of leaves, dense in the middle and breaking up toward the edge.
    const needles = species === 'conifer';
    const count = needles ? 150 : 64;
    for (let i = 0; i < count; i++) {
      const a = rng.next() * Math.PI * 2;
      const d = Math.pow(rng.next(), 0.7) * 104;
      const x = 128 + Math.cos(a) * d;
      const y = 128 + Math.sin(a) * d * 0.95;
      const light = rng.range(0.7, 1.15);
      g.fillStyle = needles
        ? `rgb(${Math.round(40 * light)},${Math.round(92 * light)},${Math.round(52 * light)})`
        : `rgb(${Math.round(72 * light)},${Math.round(128 * light)},${Math.round(48 * light)})`;
      g.save();
      g.translate(x, y);
      g.rotate(rng.next() * Math.PI * 2);
      g.beginPath();
      if (needles) g.ellipse(0, 0, rng.range(16, 26), rng.range(2.5, 4), 0, 0, Math.PI * 2);
      else g.ellipse(0, 0, rng.range(13, 21), rng.range(7, 11), 0, 0, Math.PI * 2);
      g.fill();
      if (!needles) {
        g.strokeStyle = 'rgba(30,60,24,0.5)';
        g.lineWidth = 1.2;
        g.beginPath();
        g.moveTo(-14, 0);
        g.lineTo(14, 0);
        g.stroke();
      }
      g.restore();
    }
  }

  // Bark: vertical furrows (or rings, for a palm) on the right half.
  g.fillStyle = species === 'palm' ? '#7d6d57' : '#5a4a3c';
  g.fillRect(256, 0, 256, 256);
  for (let i = 0; i < 260; i++) {
    const shade = rng.int(-34, 30);
    g.strokeStyle = `rgba(${shade < 0 ? 0 : 255},${shade < 0 ? 0 : 240},${shade < 0 ? 0 : 220},${Math.abs(shade) / 110})`;
    g.lineWidth = rng.range(1, 4);
    g.beginPath();
    if (species === 'palm') {
      const y = rng.next() * 256;
      g.moveTo(256, y);
      g.lineTo(512, y + rng.range(-4, 4));
    } else {
      const x = 256 + rng.next() * 256;
      const y = rng.next() * 256;
      g.moveTo(x, y);
      g.lineTo(x + rng.range(-5, 5), y + rng.range(30, 110));
    }
    g.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

export class TreeFactory {
  private detailed = new Map<string, THREE.BufferGeometry>();
  private simple = new Map<TreeSpecies, THREE.BufferGeometry>();
  private atlases = new Map<TreeSpecies, THREE.CanvasTexture>();

  /** The grown tree: one mesh, bark and leaves sharing the species atlas. */
  geometry(species: number, variant: number): THREE.BufferGeometry {
    const name = TREE_SPECIES[species] ?? 'broadleaf';
    const key = `${name}:${variant % TREE_VARIANTS}`;
    let g = this.detailed.get(key);
    if (!g) {
      const rng = new Rng(hashString('tree:' + key));
      g = name === 'palm' ? growPalm(rng) : name === 'conifer' ? growConifer(rng) : growBroadleaf(SPECS[name], rng);
      this.detailed.set(key, g);
    }
    return g;
  }

  /** The distant stand-in for a species. */
  simplified(species: number): THREE.BufferGeometry {
    const name = TREE_SPECIES[species] ?? 'broadleaf';
    let g = this.simple.get(name);
    if (!g) this.simple.set(name, (g = simplified(name)));
    return g;
  }

  /** Leaf-and-bark texture for a species, painted on first use. */
  atlas(species: number): THREE.CanvasTexture {
    const name = TREE_SPECIES[species] ?? 'broadleaf';
    // Broadleaf and plane share foliage.
    const key: TreeSpecies = name === 'plane' ? 'broadleaf' : name;
    let t = this.atlases.get(key);
    if (!t) this.atlases.set(key, (t = paintAtlas(key)));
    return t;
  }

  dispose(): void {
    for (const g of this.detailed.values()) g.dispose();
    for (const g of this.simple.values()) g.dispose();
    for (const t of this.atlases.values()) t.dispose();
  }
}
