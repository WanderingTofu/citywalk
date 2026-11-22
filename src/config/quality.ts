export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  /** Upper bound on device pixel ratio. */
  maxPixelRatio: number;
  /** Shadow map resolution, 0 = shadows off. */
  shadowMapSize: number;
  /** Chunks nearer than this (meters) use full detail and collision. */
  lod0: number;
  /** ... simplified buildings up to here ... */
  lod1: number;
  /** ... skyline proxies up to here ... */
  lod2: number;
  /** ... and the flat blueprint (roads and footprints) up to here; nothing beyond. */
  lod3: number;
  /** Street props (trees, lamps) are drawn up to this distance. */
  propRange: number;
  /** Hard cap on live chunks; the farthest are evicted first. */
  maxChunks: number;
  /** HDR rendering with bloom. Off = tone map straight to the canvas. */
  post: boolean;
  /** Screen-space ambient occlusion (needs `post`). */
  ao: boolean;
}

/**
 * Starting LOD ranges. The spec's 50 / 200 / 800 m table is expressed per
 * chunk here (chunks are 200 m), so the detailed ring is rounded up to keep
 * the player's own chunk and its neighbours at full detail.
 */
export const QUALITY: Record<QualityLevel, QualitySettings> = {
  low: { maxPixelRatio: 1, shadowMapSize: 0, lod0: 120, lod1: 320, lod2: 650, lod3: 900, propRange: 200, maxChunks: 90, post: false, ao: false },
  medium: { maxPixelRatio: 1.25, shadowMapSize: 1024, lod0: 160, lod1: 450, lod2: 850, lod3: 1200, propRange: 320, maxChunks: 140, post: true, ao: false },
  high: { maxPixelRatio: 1.75, shadowMapSize: 2048, lod0: 200, lod1: 600, lod2: 1100, lod3: 1600, propRange: 450, maxChunks: 200, post: true, ao: true },
  ultra: { maxPixelRatio: 2, shadowMapSize: 4096, lod0: 260, lod1: 800, lod2: 1500, lod3: 2200, propRange: 600, maxChunks: 320, post: true, ao: true },
};

export function defaultQuality(): QualityLevel {
  if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) return 'low';
  // Start modestly: frame rates on real hardware are unmeasured, and the engine steps
  // quality down by itself if frames run slow. 'high' and 'ultra' are opt-in.
  return 'medium';
}
