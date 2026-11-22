import type { MeshData } from './types';

/**
 * Accumulates vertices for one merged mesh. All geometry of a chunk that
 * shares a material is written into a single writer, so a chunk costs a fixed,
 * small number of draw calls regardless of how many buildings it contains.
 */
export class MeshWriter {
  private pos: number[] = [];
  private nrm: number[] = [];
  private col: number[] = [];
  private a: number[] = [];
  private b: number[] = [];
  private c: number[] = [];
  private idx: number[] = [];
  private keys: number[] = [];
  private sorted = true;
  private count = 0;

  /** Values applied to every vertex pushed until changed. */
  color: [number, number, number] = [1, 1, 1];
  attrB: number[] = [];
  attrC: number[] = [];
  /**
   * Draw-order key for triangles pushed from now on. The finished index buffer
   * is ordered by key (stable), which is how coplanar ground layers are stacked.
   */
  order = 0;

  constructor(private readonly hasC: boolean) {}

  get vertexCount(): number {
    return this.count;
  }

  /** Add a vertex; returns its index. `a` is the per-vertex attribute tuple. */
  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, a0: number, a1: number, a2: number, a3?: number): number {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.col.push(this.color[0], this.color[1], this.color[2]);
    if (a3 === undefined) this.a.push(a0, a1, a2);
    else this.a.push(a0, a1, a2, a3);
    for (let i = 0; i < this.attrB.length; i++) this.b.push(this.attrB[i]);
    if (this.hasC) for (let i = 0; i < this.attrC.length; i++) this.c.push(this.attrC[i]);
    return this.count++;
  }

  tri(i0: number, i1: number, i2: number): void {
    const n = this.keys.length;
    if (n > 0 && this.order < this.keys[n - 1]) this.sorted = false;
    this.idx.push(i0, i1, i2);
    this.keys.push(this.order);
  }

  quad(i0: number, i1: number, i2: number, i3: number): void {
    this.tri(i0, i1, i2);
    this.tri(i0, i2, i3);
  }

  private orderedIndex(): Uint32Array {
    const out = new Uint32Array(this.idx.length);
    if (this.sorted) {
      out.set(this.idx);
      return out;
    }
    const tris = this.keys.map((_, i) => i).sort((a, b) => this.keys[a] - this.keys[b] || a - b);
    tris.forEach((t, k) => {
      out[k * 3] = this.idx[t * 3];
      out[k * 3 + 1] = this.idx[t * 3 + 1];
      out[k * 3 + 2] = this.idx[t * 3 + 2];
    });
    return out;
  }

  finish(): MeshData | null {
    if (this.idx.length === 0) return null;
    const data: MeshData = {
      position: new Float32Array(this.pos),
      normal: new Float32Array(this.nrm),
      color: new Float32Array(this.col),
      a: new Float32Array(this.a),
      b: new Float32Array(this.b),
      index: this.orderedIndex(),
    };
    if (this.hasC) data.c = new Float32Array(this.c);
    return data;
  }
}

export function meshTransferables(m: MeshData | null): ArrayBuffer[] {
  if (!m) return [];
  const out = [m.position.buffer, m.normal.buffer, m.color.buffer, m.a.buffer, m.b.buffer, m.index.buffer] as ArrayBuffer[];
  if (m.c) out.push(m.c.buffer as ArrayBuffer);
  return out;
}
