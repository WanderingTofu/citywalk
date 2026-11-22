import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TreeFactory } from './TreeFactory';
import { VehicleFactory } from './VehicleFactory';

/**
 * Shared geometry for instanced street props. Trees and vehicles come from
 * their generators; whatever is built is shared by every chunk, which only
 * holds instance transforms.
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
  readonly trees = new TreeFactory();
  readonly lamp = makeLamp();
  readonly glow = makeGlow();
  readonly vehicles = new VehicleFactory();

  dispose(): void {
    this.trees.dispose();
    this.lamp.dispose();
    this.glow.dispose();
    this.vehicles.dispose();
  }
}

/** Per-variant foliage tints applied as instance colors. */
export const TREE_TINTS = [new THREE.Color(1, 1, 1), new THREE.Color(0.8, 1.05, 0.75), new THREE.Color(1.15, 1.05, 0.7)];

