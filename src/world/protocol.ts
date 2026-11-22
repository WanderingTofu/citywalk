import type { StyleConfig } from '../districts/StyleConfig';
import type { BuildOptions } from './ChunkBuilder';
import type { ChunkData, ChunkGeometry, TileData } from './types';

/** Messages between the main thread and the generation workers. */

export interface TileRequest {
  type: 'tile';
  /** Identifies the coordinate frame (city + district + origin); part of every cache key. */
  frameId: string;
  origin: { lat: number; lon: number };
  tx: number;
  tz: number;
  /** 'live' = cache, baked tiles, Overpass, then procedural fallback. 'demo' = procedural only. */
  mode: 'live' | 'demo';
  /** Absolute URL of this district's baked-tile folder (ends with a slash). */
  bakedUrl: string;
}

export interface ChunkRequest {
  type: 'chunk';
  chunk: ChunkData;
  style: StyleConfig;
  opts: BuildOptions;
}

export type WorkerRequest = TileRequest | ChunkRequest;

export interface TileResponse {
  tile: TileData;
  /** Set when live data could not be fetched and procedural data was substituted. */
  error?: string;
}

export type WorkerResponseBody = TileResponse | ChunkGeometry;

export interface WorkerEnvelope {
  id: number;
  ok: boolean;
  result?: WorkerResponseBody;
  error?: string;
}
