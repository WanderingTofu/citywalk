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
  const trunk = new THREE.CylinderGeometry(0.11, 0.2, 2.6, 5, 1, true);
  trunk.translate(0, 1.3, 0);
  const crown = new THREE.IcosahedronGeometry(1.7, 1);
  // Squash and roughen the crown so instances do not read as spheres.
  const p = crown.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const k = 1 + 0.22 * Math.sin(x * 3.1 + y * 2.3) * Math.cos(z * 2.7 + y * 1.3);
    p.setXYZ(i, x * k, y * 1.12 * k, z * k);
  }
  crown.translate(0, 4.1, 0);
  const merged = mergeGeometries([
    paint(trunk, () => [0.1, 0.07, 0.05]),
    // Darker underside fakes self-shadowing.
    paint(crown, (y) => {
      const t = Math.min(1, Math.max(0, (y - 2.4) / 3.4));
      return [0.06 + 0.1 * t, 0.16 + 0.2 * t, 0.045 + 0.05 * t];
    }),
  ])!;
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

  dispose(): void {
    this.tree.dispose();
    this.lamp.dispose();
    this.glow.dispose();
  }
}

/** Per-variant foliage tints applied as instance colors. */
export const TREE_TINTS = [new THREE.Color(1, 1, 1), new THREE.Color(0.8, 1.05, 0.75), new THREE.Color(1.15, 1.05, 0.7)];
