import type { ChunkRequest, TileRequest, TileResponse, WorkerEnvelope, WorkerRequest, WorkerResponseBody } from './protocol';
import type { ChunkGeometry } from './types';

interface Pending {
  resolve: (r: WorkerResponseBody) => void;
  reject: (e: Error) => void;
  worker: number;
}

/**
 * A small fixed pool of generation workers. The pool does no queueing of its
 * own: callers check `idle` and submit only when a worker is free, so the
 * streamer can always pick the currently most important job.
 */
export class WorkerPool {
  private workers: Worker[] = [];
  private busy: number[] = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<WorkerEnvelope>) => this.onMessage(e.data);
      w.onerror = (e) => this.onCrash(i, e.message || 'worker error');
      this.workers.push(w);
      this.busy.push(0);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  /** Number of workers with nothing in flight. */
  get idle(): number {
    return this.busy.filter((b) => b === 0).length;
  }

  loadTile(req: Omit<TileRequest, 'type'>): Promise<TileResponse> {
    return this.send({ type: 'tile', ...req }) as Promise<TileResponse>;
  }

  buildChunk(req: Omit<ChunkRequest, 'type'>): Promise<ChunkGeometry> {
    return this.send({ type: 'chunk', ...req }) as Promise<ChunkGeometry>;
  }

  private send(req: WorkerRequest): Promise<WorkerResponseBody> {
    // Least-loaded worker. Tile loads are mostly network wait, so they may share a worker.
    let worker = 0;
    for (let i = 1; i < this.busy.length; i++) if (this.busy[i] < this.busy[worker]) worker = i;
    const id = this.nextId++;
    this.busy[worker]++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, worker });
      this.workers[worker].postMessage({ id, req });
    });
  }

  private onMessage(msg: WorkerEnvelope): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    this.busy[p.worker]--;
    if (msg.ok && msg.result) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? 'worker failed'));
  }

  private onCrash(worker: number, message: string): void {
    for (const [id, p] of this.pending) {
      if (p.worker !== worker) continue;
      this.pending.delete(id);
      p.reject(new Error(message));
    }
    this.busy[worker] = 0;
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    for (const p of this.pending.values()) p.reject(new Error('pool disposed'));
    this.pending.clear();
  }
}
