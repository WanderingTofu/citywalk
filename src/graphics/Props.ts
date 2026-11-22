import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Shared geometry for instanced street props. One tree mesh and one lamp mesh
 * exist for the entire world; chunks only hold instance transforms.
 */

function paint(geo: THREE.BufferGeometry, color: (y: number) => [number, number, number]): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) col.set(color(pos.getY(i)), i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}

function makeTree(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.1, 0.2, 3.0, 6, 1, true);
  trunk.translate(0, 1.5, 0);
  // The crown is several overlapping, roughened lobes, so instances read as foliage masses rather than balls.
  const lobes: Array<[number, number, number, number]> = [
    [0, 4.3, 0, 1.55], [0.95, 3.9, 0.35, 1.15], [-0.8, 4.0, 0.55, 1.2], [-0.2, 3.8, -1.0, 1.1], [0.35, 5.15, -0.15, 1.05],
  ];
  const parts: THREE.BufferGeometry[] = [paint(trunk, () => [0.1, 0.07, 0.05])];
  lobes.forEach(([lx, ly, lz, r], n) => {
    const lobe = new THREE.IcosahedronGeometry(r, 1);
    const p = lobe.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const z = p.getZ(i);
      const k = 1 + 0.2 * Math.sin(x * 4.1 + y * 2.3 + n) * Math.cos(z * 3.7 + y * 1.3 + n * 2.0);
      p.setXYZ(i, x * k + lx, y * 0.9 * k + ly, z * k + lz);
    }
    const tone = 0.85 + 0.3 * ((n * 37) % 5) / 4;
    // Darker undersides and interior fake the crown shading itself.
    parts.push(
      paint(lobe, (y) => {
        const t = Math.min(1, Math.max(0, (y - 2.8) / 3.2));
        return [(0.05 + 0.1 * t) * tone, (0.13 + 0.22 * t) * tone, (0.04 + 0.05 * t) * tone];
      }),
    );
  });
  const merged = mergeGeometries(parts)!;
  merged.computeVertexNormals();
  return merged;
}

function makeLamp(): THREE.BufferGeometry {
  const pole = new THREE.BoxGeometry(0.13, 5.6, 0.13);
  pole.translate(0, 2.8, 0);
  const arm = new THREE.BoxGeometry(0.08, 0.08, 1.3);
  arm.translate(0, 5.5, 0.6);
  const head = new THREE.BoxGeometry(0.3, 0.1, 0.6);
  head.translate(0, 5.42, 1.1);
  const dark = (): [number, number, number] => [0.05, 0.055, 0.06];
  const merged = mergeGeometries([paint(pole, dark), paint(arm, dark), paint(head, () => [1.0, 0.82, 0.55])])!;
  merged.computeVertexNormals();
  return merged;
}

/**
 * A generic saloon car from a side silhouette. White paint is tinted per
 * instance; glass and tyres are dark enough that the tint does not show.
 */
function makeCar(): THREE.BufferGeometry {
  const outline: Array<[number, number]> = [
    [-2.2, 0.32], [-2.22, 0.72], [-1.75, 0.86], [-0.95, 0.92], [-0.38, 1.38], [0.85, 1.4], [1.42, 0.95], [2.05, 0.88], [2.2, 0.7], [2.18, 0.32],
  ];
  const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  const body = new THREE.ExtrudeGeometry(shape, { depth: 1.72, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 1, curveSegments: 1 });
  body.translate(0, 0, -0.86);
  body.rotateY(-Math.PI / 2); // length along +Z
  const paintBody = paint(body, () => [1, 1, 1]);
  // Glass: everything on the cabin above the waistline except the roof panel and the pillars.
  const pos = paintBody.getAttribute('position');
  const col = paintBody.getAttribute('color');
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y > 0.97 && y < 1.33) col.setXYZ(i, 0.035, 0.045, 0.055);
  }
  const parts = [paintBody];
  for (const [wx, wz] of [[0.8, 1.38], [-0.8, 1.38], [0.8, -1.3], [-0.8, -1.3]]) {
    const wheel = new THREE.CylinderGeometry(0.33, 0.33, 0.24, 8);
    wheel.rotateZ(Math.PI / 2);
    wheel.translate(wx, 0.33, wz);
    parts.push(paint(wheel, () => [0.02, 0.02, 0.022]));
  }
  const merged = mergeGeometries(parts.map((g) => { g.deleteAttribute('normal'); return g; }))!;
  merged.computeVertexNormals();
  return merged;
}

function makeGlow(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(16, 16);
  g.rotateX(-Math.PI / 2);
  g.translate(0, 0.03, 1.1);
  return g;
}

export class PropLibrary {
  readonly tree = makeTree();
  readonly lamp = makeLamp();
  readonly glow = makeGlow();
  readonly car = makeCar();

  dispose(): void {
    this.tree.dispose();
    this.lamp.dispose();
    this.glow.dispose();
    this.car.dispose();
  }
}

/** Per-variant foliage tints applied as instance colors. */
export const TREE_TINTS = [new THREE.Color(1, 1, 1), new THREE.Color(0.8, 1.05, 0.75), new THREE.Color(1.15, 1.05, 0.7)];

/** Paint colours for parked cars, weighted toward the greys real streets are full of. */
export const CAR_PAINTS = [0xe8e8e6, 0x16171a, 0x9a9da1, 0x5b5f66, 0xcfd2d4, 0x1e2a44, 0x7a1418, 0x2c2e31, 0xb8b29f, 0x23402f].map(
  (hex) => new THREE.Color(hex),
);
