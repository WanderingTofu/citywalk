import * as THREE from 'three';
import { CHUNK_SIZE } from '../geo/TileAddress';
import type { MaterialLibrary } from '../graphics/MaterialLibrary';
import { CAR_PAINTS, TREE_TINTS, type PropLibrary } from '../graphics/Props';
import type { LodLevel } from '../graphics/LODManager';
import type { ChunkGeometry, MeshData } from './types';

/** Free the JS-side copy of a vertex buffer once it lives on the GPU. */
function releaseAfterUpload(this: THREE.BufferAttribute): void {
  (this as { array: unknown }).array = new Float32Array(0);
}

function toGeometry(data: MeshData, aSize: number, bSize: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const add = (name: string, array: Float32Array, size: number) => {
    const attr = new THREE.BufferAttribute(array, size);
    attr.onUpload(releaseAfterUpload);
    g.setAttribute(name, attr);
  };
  // Bounds are computed before the CPU copy of the positions is released.
  const position = new THREE.BufferAttribute(data.position, 3);
  g.setAttribute('position', position);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  position.onUpload(releaseAfterUpload);
  add('normal', data.normal, 3);
  add('cwColor', data.color, 3);
  add('cwA', data.a, aSize);
  add('cwB', data.b, bSize);
  if (data.c) add('cwC', data.c, 4);
  g.setIndex(new THREE.BufferAttribute(data.index, 1));
  return g;
}

const tmpMatrix = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const tmpPos = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * GPU-side representation of one chunk: at most five draw calls (buildings,
 * ground, trees, lamps, lamp glow) that are swapped as the LOD changes and
 * disposed as a unit when the chunk leaves the active region.
 */
export class Chunk {
  readonly group = new THREE.Group();
  /** LOD of the buildings currently displayed (-1 = nothing yet). */
  lod: LodLevel = -1;
  hasProps = false;
  /** A build for this chunk is in flight. */
  pending = false;
  /** Triangles currently held on the GPU, for the stats overlay. */
  triangles = 0;

  private buildings: THREE.Mesh | null = null;
  private ground: THREE.Mesh | null = null;
  private props: THREE.InstancedMesh[] = [];

  constructor(
    readonly cx: number,
    readonly cz: number,
    private readonly materials: MaterialLibrary,
    private readonly propLib: PropLibrary,
  ) {
    this.group.position.set(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE);
    this.group.matrixAutoUpdate = false;
    this.group.updateMatrix();
  }

  get hasGround(): boolean {
    return this.ground !== null;
  }

  /** Swap in freshly generated geometry. Runs on the main thread; only buffer handoff, no generation. */
  apply(geo: ChunkGeometry, withProps: boolean): void {
    if (geo.ground && !this.ground) {
      this.ground = new THREE.Mesh(toGeometry(geo.ground, 4, 1), this.materials.ground);
      this.ground.receiveShadow = true;
      this.ground.matrixAutoUpdate = false;
      this.group.add(this.ground);
    }

    this.disposeMesh(this.buildings);
    this.buildings = null;
    if (geo.buildings) {
      this.buildings = new THREE.Mesh(toGeometry(geo.buildings, 3, 4), this.materials.facade);
      this.buildings.castShadow = true;
      this.buildings.receiveShadow = true;
      this.buildings.matrixAutoUpdate = false;
      this.group.add(this.buildings);
    }
    this.lod = geo.lod;

    this.clearProps();
    if (withProps) {
      this.addInstances(this.propLib.tree, this.materials.tree, geo.trees, 6, true);
      this.addCars(geo.cars);
      this.addInstances(this.propLib.lamp, this.materials.lamp, geo.lamps, 4, false);
      this.addInstances(this.propLib.glow, this.materials.lampGlow, geo.lamps, 4, false);
    }
    this.hasProps = withProps;
    this.group.updateMatrixWorld(true);
    this.countTriangles();
  }

  private addInstances(geometry: THREE.BufferGeometry, material: THREE.Material, data: Float32Array, stride: number, isTree: boolean): void {
    const count = data.length / stride;
    if (count === 0) return;
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    for (let i = 0; i < count; i++) {
      const o = i * stride;
      tmpPos.set(data[o], data[o + 1], data[o + 2]);
      if (isTree) {
        const s = data[o + 3];
        tmpQuat.setFromAxisAngle(UP, data[o + 4]);
        tmpScale.set(s, s * (0.9 + 0.2 * ((i * 7) % 5) / 4), s);
        mesh.setColorAt(i, TREE_TINTS[data[o + 5] | 0] ?? TREE_TINTS[0]);
      } else {
        tmpQuat.setFromAxisAngle(UP, data[o + 3]);
        tmpScale.set(1, 1, 1);
      }
      mesh.setMatrixAt(i, tmpMatrix.compose(tmpPos, tmpQuat, tmpScale));
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = isTree;
    mesh.receiveShadow = material !== this.materials.lampGlow;
    mesh.matrixAutoUpdate = false;
    mesh.computeBoundingSphere();
    if (material === this.materials.lampGlow) mesh.renderOrder = 10;
    this.group.add(mesh);
    this.props.push(mesh);
  }

  private addCars(data: Float32Array): void {
    const count = data.length / 6;
    if (count === 0) return;
    const mesh = new THREE.InstancedMesh(this.propLib.car, this.materials.car, count);
    for (let i = 0; i < count; i++) {
      const o = i * 6;
      tmpPos.set(data[o], data[o + 1], data[o + 2]);
      tmpQuat.setFromAxisAngle(UP, data[o + 3]);
      tmpScale.set(1, 1, data[o + 5]);
      mesh.setMatrixAt(i, tmpMatrix.compose(tmpPos, tmpQuat, tmpScale));
      mesh.setColorAt(i, CAR_PAINTS[data[o + 4] | 0] ?? CAR_PAINTS[0]);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    this.props.push(mesh);
  }

  private clearProps(): void {
    for (const m of this.props) {
      this.group.remove(m);
      m.dispose(); // frees per-instance buffers; shared geometry and material stay alive
    }
    this.props.length = 0;
  }

  private disposeMesh(mesh: THREE.Mesh | null): void {
    if (!mesh) return;
    this.group.remove(mesh);
    mesh.geometry.dispose();
  }

  private countTriangles(): void {
    let n = 0;
    for (const m of [this.buildings, this.ground]) if (m) n += (m.geometry.index?.count ?? 0) / 3;
    for (const p of this.props) n += ((p.geometry.index?.count ?? p.geometry.getAttribute('position').count) / 3) * p.count;
    this.triangles = n;
  }

  /** Lamp glow sprites only make sense once it is dark. */
  setNight(night: number): void {
    for (const p of this.props) if (p.material === this.materials.lampGlow) p.visible = night > 0.03;
  }

  dispose(): void {
    this.disposeMesh(this.buildings);
    this.disposeMesh(this.ground);
    this.buildings = this.ground = null;
    this.clearProps();
    this.group.removeFromParent();
    this.lod = -1;
    this.triangles = 0;
  }
}
