import * as THREE from 'three';
import type { QualitySettings } from '../config/quality';
import type { StyleConfig } from '../districts/StyleConfig';
import {
  CHUNK_SIZE,
  TILE_SIZE,
  chunkKey,
  distanceToChunk,
  tileBounds,
  tileCoordOfChunk,
  tileKey,
} from '../geo/TileAddress';
import { selectLod, wantsProps, type LodLevel } from '../graphics/LODManager';
import type { MaterialLibrary } from '../graphics/MaterialLibrary';
import type { PropLibrary } from '../graphics/Props';
import type { CollisionSystem } from '../player/CollisionSystem';
import { Chunk } from './Chunk';
import type { ChunkGeometry, Lod, TileData, TileSource } from './types';
import { WorkerPool } from './WorkerPool';

interface TileEntry {
  tx: number;
  tz: number;
  state: 'loading' | 'ready' | 'failed';
  data: TileData | null;
  retryAt: number;
}

interface BuildJob {
  key: string;
  lod: Lod;
  props: boolean;
  priority: number;
}

export interface StreamerStats {
  chunks: number;
  chunksByLod: [number, number, number, number];
  tiles: number;
  tilesLoading: number;
  buildsPending: number;
  queue: number;
  triangles: number;
  sources: Record<TileSource, number>;
  lastBuildMs: number;
  lastError: string;
}

export interface WorldDescriptor {
  frameId: string;
  origin: { lat: number; lon: number };
  style: StyleConfig;
  mode: 'live' | 'demo';
  /** Absolute URL of the district's baked-tile folder. */
  bakedUrl: string;
}

/** How much of the neighbourhood around a point exists yet. */
export interface Readiness {
  /** Chunks within the radius. */
  total: number;
  /** ... whose map tile has arrived. */
  withData: number;
  /** ... that have their plan on screen. */
  built: number;
  /** ... that have been raised into 3D. */
  raised: number;
  /** The chunk under the point is fully detailed, with collision. */
  detailed: boolean;
}

/** Seconds of player motion to look ahead when deciding what to load. */
const PREDICT_SECONDS = 2.5;
const PLAN_INTERVAL = 0.2;
/** How much further away a chunk directly behind the camera counts as (0.5 = half as far again). */
const BEHIND_PENALTY = 0.5;
/** Concurrent tile downloads; kept low out of respect for the public Overpass servers. */
const MAX_TILE_LOADS = 2;
/** Main-thread budget per frame for handing finished geometry to the GPU. */
const APPLY_BUDGET_MS = 4;
/** ... and while the loading screen is up, when nobody is watching the frame rate. */
const APPLY_BUDGET_LOADING_MS = 40;

/**
 * Moving streaming window around the player.
 *
 * Each planning pass computes, for every chunk in range, the LOD it should
 * have. Missing tiles are requested, chunks are (re)built in workers in
 * priority order, finished geometry is applied within a per-frame budget, and
 * anything out of range is disposed. Nothing here ever blocks on the network:
 * until a tile arrives its chunks are simply absent, hidden by fog.
 */
export class WorldStreamer {
  readonly root = new THREE.Group();
  private readonly pool: WorkerPool;
  private world: WorldDescriptor | null = null;
  private quality: QualitySettings;
  private tiles = new Map<string, TileEntry>();
  private chunks = new Map<string, Chunk>();
  private buildQueue: BuildJob[] = [];
  private tileQueue: TileEntry[] = [];
  private ready: Array<{ geo: ChunkGeometry; props: boolean; epoch: number }> = [];
  private tilesInFlight = 0;
  private buildsInFlight = 0;
  /** Incremented on every world change so late worker results can be recognised and dropped. */
  private epoch = 0;
  private planTimer = 0;
  private lastBuildMs = 0;
  private lastError = '';
  private night = 0;
  /** True while the loading screen covers the view: geometry is taken in as fast as it arrives. */
  loading = false;
  private readonly predicted = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    private readonly materials: MaterialLibrary,
    private readonly propLib: PropLibrary,
    private readonly collision: CollisionSystem,
    quality: QualitySettings,
  ) {
    this.quality = quality;
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    this.pool = new WorkerPool(Math.min(4, Math.max(2, cores - 2)));
    scene.add(this.root);
  }

  /** Switch city / district / data mode. Disposes everything from the previous world. */
  setWorld(world: WorldDescriptor): void {
    this.epoch++;
    for (const c of this.chunks.values()) c.dispose();
    this.chunks.clear();
    this.tiles.clear();
    this.collision.clear();
    this.buildQueue = [];
    this.tileQueue = [];
    this.ready = [];
    this.lastError = '';
    this.world = world;
    this.planTimer = 0;
  }

  setQuality(q: QualitySettings): void {
    this.quality = q;
    this.planTimer = 0;
  }

  setNight(night: number): void {
    this.night = night;
    for (const c of this.chunks.values()) c.setNight(night);
  }

  /** Progress of the neighbourhood within `radius` of (x, z): what the loading screen waits for. */
  readiness(x: number, z: number, radius: number): Readiness {
    const out: Readiness = { total: 0, withData: 0, built: 0, raised: 0, detailed: this.isDetailedAt(x, z) };
    if (!this.world) return out;
    const c0x = Math.floor((x - radius) / CHUNK_SIZE);
    const c1x = Math.floor((x + radius) / CHUNK_SIZE);
    const c0z = Math.floor((z - radius) / CHUNK_SIZE);
    const c1z = Math.floor((z + radius) / CHUNK_SIZE);
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        if (distanceToChunk(x, z, cx, cz) > radius) continue;
        out.total++;
        const t = tileCoordOfChunk(cx, cz);
        if (this.tiles.get(tileKey(this.world.frameId, t.x, t.z))?.state === 'ready') out.withData++;
        const chunk = this.chunks.get(chunkKey(cx, cz));
        if (chunk && chunk.lod !== -1) out.built++;
        if (chunk && chunk.lod !== -1 && chunk.lod !== 3) out.raised++;
      }
    }
    return out;
  }

  /** True once the chunk under (x, z) is fully detailed with collision. */
  isDetailedAt(x: number, z: number): boolean {
    const c = this.chunks.get(chunkKey(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)));
    return !!c && c.lod === 0;
  }

  /**
   * `pos` is the camera's ground position with its height in y; `forward` its horizontal view direction.
   */
  update(dt: number, pos: THREE.Vector3, vel: THREE.Vector3, forward: THREE.Vector3): void {
    if (!this.world) return;
    this.applyReady();
    this.planTimer -= dt;
    if (this.planTimer <= 0) {
      this.planTimer = PLAN_INTERVAL;
      this.plan(pos, vel, forward);
    }
    this.dispatch();
  }

  // --- planning -----------------------------------------------------------

  private plan(pos: THREE.Vector3, vel: THREE.Vector3, forward: THREE.Vector3): void {
    const q = this.quality;
    // Look ahead along the direction of travel, but never further than one detailed ring.
    this.predicted.copy(vel).multiplyScalar(PREDICT_SECONDS);
    this.predicted.y = 0;
    if (this.predicted.length() > q.lod0) this.predicted.setLength(q.lod0);
    this.predicted.add(pos);

    const reach = q.lod3 * 1.15 + CHUNK_SIZE;
    const c0x = Math.floor((Math.min(pos.x, this.predicted.x) - reach) / CHUNK_SIZE);
    const c1x = Math.floor((Math.max(pos.x, this.predicted.x) + reach) / CHUNK_SIZE);
    const c0z = Math.floor((Math.min(pos.z, this.predicted.z) - reach) / CHUNK_SIZE);
    const c1z = Math.floor((Math.max(pos.z, this.predicted.z) + reach) / CHUNK_SIZE);

    const jobs: BuildJob[] = [];
    const wantedTiles = new Map<string, number>();
    const keep = new Set<string>();
    const now = performance.now();

    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const dNow = distanceToChunk(pos.x, pos.z, cx, cz);
        const dGround = Math.min(dNow, distanceToChunk(this.predicted.x, this.predicted.z, cx, cz));
        const key = chunkKey(cx, cz);
        const chunk = this.chunks.get(key);

        // The detail bubble. Full detail is spent where the camera can use it:
        //  - height counts as distance, so a drone high above sees a coarser city;
        //  - beyond the player's immediate surroundings, what is behind the camera
        //    is treated as further away than what is in front of it.
        const toX = (cx + 0.5) * CHUNK_SIZE - pos.x;
        const toZ = (cz + 0.5) * CHUNK_SIZE - pos.z;
        const len = Math.hypot(toX, toZ) || 1;
        const facing = (toX * forward.x + toZ * forward.z) / len;
        const behind = dGround > CHUNK_SIZE * 0.6 ? Math.min(1, Math.max(0, (0.15 - facing) / 0.6)) : 0;
        const d = Math.hypot(dGround, Math.max(0, pos.y - 40) * 0.8) * (1 + BEHIND_PENALTY * behind);

        const lod = selectLod(d, q, chunk ? chunk.lod : -1);
        if (lod === -1) continue;
        keep.add(key);
        // What the player is facing also loads first.
        const priority = d - (facing > 0.3 ? 80 : 0);

        const t = tileCoordOfChunk(cx, cz);
        const tKey = tileKey(this.world!.frameId, t.x, t.z);
        const tile = this.tiles.get(tKey);
        if (!tile || tile.state !== 'ready') {
          if (!tile || (tile.state === 'failed' && now >= tile.retryAt)) {
            wantedTiles.set(tKey, Math.min(wantedTiles.get(tKey) ?? Infinity, priority));
            if (!tile) this.tiles.set(tKey, { tx: t.x, tz: t.z, state: 'failed', data: null, retryAt: 0 });
          }
          continue;
        }

        const props = wantsProps(d, q, chunk ? chunk.hasProps : false);
        if (!chunk || chunk.lod !== lod || chunk.hasProps !== props) {
          if (chunk?.pending) continue;
          const empty = !chunk || chunk.lod === -1;
          if (dNow <= Math.max(q.lod0 * 1.6, 250)) {
            // Where the player stands, and the streets around it, come before everything else, straight to 3D.
            jobs.push({ key, lod: lod as Lod, props, priority: priority - 2000 });
          } else if (empty && lod !== 3) {
            // Then the blueprint: the 2D plan of a chunk costs almost nothing, so lay it
            // down everywhere before raising any more of the city in 3D.
            jobs.push({ key, lod: 3, props: false, priority: priority * 0.25 - 400 });
          } else {
            // Then the 3D, nearest and in view first; refinements of what is already
            // standing wait for chunks that are still flat.
            jobs.push({ key, lod: lod as Lod, props, priority: priority + (chunk && chunk.lod !== -1 && chunk.lod !== 3 ? 120 : 0) });
          }
        }
      }
    }

    jobs.sort((a, b) => a.priority - b.priority);
    this.buildQueue = jobs;
    this.tileQueue = [...wantedTiles.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => this.tiles.get(k)!);

    // Release chunks that fell out of range.
    for (const [key, chunk] of this.chunks) {
      if (!keep.has(key) && !chunk.pending) this.dropChunk(key, chunk);
    }
    // Hard cap as a safety net: evict the farthest chunks first.
    if (this.chunks.size > q.maxChunks) {
      const byDistance = [...this.chunks.entries()]
        .map(([key, c]) => ({ key, c, d: distanceToChunk(pos.x, pos.z, c.cx, c.cz) }))
        .sort((a, b) => b.d - a.d);
      for (let i = 0; i < byDistance.length && this.chunks.size > q.maxChunks; i++) {
        if (!byDistance[i].c.pending) this.dropChunk(byDistance[i].key, byDistance[i].c);
      }
    }
    // Release tile data that no chunk in range can need.
    for (const [key, tile] of this.tiles) {
      if (tile.state === 'loading') continue;
      const b = tileBounds(tile.tx, tile.tz);
      const dx = Math.max(b.minX - pos.x, 0, pos.x - b.maxX);
      const dz = Math.max(b.minZ - pos.z, 0, pos.z - b.maxZ);
      if (Math.hypot(dx, dz) > reach + TILE_SIZE * 0.5) this.tiles.delete(key);
    }
  }

  private dropChunk(key: string, chunk: Chunk): void {
    chunk.dispose();
    this.chunks.delete(key);
    this.collision.removeChunk(key);
  }

  // --- work dispatch ------------------------------------------------------

  private dispatch(): void {
    const world = this.world!;
    while (this.tilesInFlight < MAX_TILE_LOADS && this.tileQueue.length) {
      const tile = this.tileQueue.shift()!;
      if (tile.state === 'loading' || tile.state === 'ready') continue;
      tile.state = 'loading';
      this.tilesInFlight++;
      const epoch = this.epoch;
      this.pool
        .loadTile({ frameId: world.frameId, origin: world.origin, tx: tile.tx, tz: tile.tz, mode: world.mode, bakedUrl: world.bakedUrl })
        .then((res) => {
          if (epoch !== this.epoch) return;
          tile.data = res.tile;
          tile.state = 'ready';
          if (res.error) this.lastError = `Live map data unavailable (${res.error}); showing procedural stand-in.`;
          this.planTimer = 0;
        })
        .catch((err: Error) => {
          if (epoch !== this.epoch) return;
          tile.state = 'failed';
          tile.retryAt = performance.now() + 5000;
          this.lastError = err.message;
        })
        .finally(() => {
          this.tilesInFlight--;
        });
    }

    while (this.buildsInFlight < this.pool.size && this.buildQueue.length) {
      const job = this.buildQueue.shift()!;
      const [cx, cz] = job.key.split(',').map(Number);
      const t = tileCoordOfChunk(cx, cz);
      const tile = this.tiles.get(tileKey(world.frameId, t.x, t.z));
      const data = tile?.data?.chunks[job.key];
      if (!data) continue;
      let chunk = this.chunks.get(job.key);
      if (chunk?.pending) continue;
      if (!chunk) {
        chunk = new Chunk(cx, cz, this.materials, this.propLib);
        this.chunks.set(job.key, chunk);
      }
      chunk.pending = true;
      this.buildsInFlight++;
      const epoch = this.epoch;
      const target = chunk;
      this.pool
        .buildChunk({ chunk: data, style: world.style, opts: { lod: job.lod, ground: !chunk.hasGround, props: job.props } })
        .then((geo) => {
          this.lastBuildMs = geo.buildMs;
          this.ready.push({ geo, props: job.props, epoch });
        })
        .catch((err: Error) => {
          this.lastError = err.message;
          target.pending = false;
        })
        .finally(() => {
          this.buildsInFlight--;
        });
    }
  }

  /** Hand finished geometry to the GPU, a few chunks per frame at most. */
  private applyReady(): void {
    const start = performance.now();
    while (this.ready.length) {
      const { geo, props, epoch } = this.ready.shift()!;
      if (epoch !== this.epoch) continue;
      const key = chunkKey(geo.cx, geo.cz);
      const chunk = this.chunks.get(key);
      if (!chunk) continue; // went out of range while building
      chunk.pending = false;
      chunk.apply(geo, props);
      chunk.setNight(this.night);
      if (!chunk.group.parent) this.root.add(chunk.group);

      if (geo.lod === 0) {
        const t = tileCoordOfChunk(geo.cx, geo.cz);
        const data = this.tiles.get(tileKey(this.world!.frameId, t.x, t.z))?.data?.chunks[key];
        if (data) this.collision.addChunk(key, data.buildings, this.world!.style);
      } else {
        this.collision.removeChunk(key);
      }
      if (performance.now() - start > (this.loading ? APPLY_BUDGET_LOADING_MS : APPLY_BUDGET_MS)) break;
    }
  }

  // --- introspection ------------------------------------------------------

  get stats(): StreamerStats {
    const byLod: [number, number, number, number] = [0, 0, 0, 0];
    let triangles = 0;
    for (const c of this.chunks.values()) {
      if (c.lod >= 0) byLod[c.lod as Lod]++;
      triangles += c.triangles;
    }
    const sources: Record<TileSource, number> = { osm: 0, cache: 0, baked: 0, demo: 0, fallback: 0 };
    let loading = 0;
    for (const t of this.tiles.values()) {
      if (t.state === 'loading') loading++;
      if (t.data) sources[t.data.source]++;
    }
    return {
      chunks: this.chunks.size,
      chunksByLod: byLod,
      tiles: this.tiles.size,
      tilesLoading: loading + this.tileQueue.length,
      buildsPending: this.buildsInFlight + this.ready.length,
      queue: this.buildQueue.length,
      triangles,
      sources,
      lastBuildMs: this.lastBuildMs,
      lastError: this.lastError,
    };
  }

  /** Current LOD of every live chunk, for tests and debugging. */
  chunkLods(): Record<string, LodLevel> {
    const out: Record<string, LodLevel> = {};
    for (const [k, c] of this.chunks) out[k] = c.lod;
    return out;
  }

  dispose(): void {
    this.epoch++;
    for (const c of this.chunks.values()) c.dispose();
    this.chunks.clear();
    this.tiles.clear();
    this.pool.dispose();
    this.root.removeFromParent();
  }
}
