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
  /** ... skyline proxies up to here, nothing beyond. */
  lod2: number;
  /** Street props (trees, lamps) are drawn up to this distance. */
  propRange: number;
  /** Hard cap on live chunks; the farthest are evicted first. */
  maxChunks: number;
}

/**
 * Starting LOD ranges. The spec's 50 / 200 / 800 m table is expressed per
 * chunk here (chunks are 200 m), so the detailed ring is rounded up to keep
 * the player's own chunk and its neighbours at full detail.
 */
export const QUALITY: Record<QualityLevel, QualitySettings> = {
  low: { maxPixelRatio: 1, shadowMapSize: 0, lod0: 120, lod1: 320, lod2: 650, propRange: 200, maxChunks: 90 },
  medium: { maxPixelRatio: 1.25, shadowMapSize: 1024, lod0: 160, lod1: 450, lod2: 850, propRange: 320, maxChunks: 140 },
  high: { maxPixelRatio: 1.75, shadowMapSize: 2048, lod0: 200, lod1: 600, lod2: 1100, propRange: 450, maxChunks: 200 },
  ultra: { maxPixelRatio: 2, shadowMapSize: 4096, lod0: 260, lod1: 800, lod2: 1500, propRange: 600, maxChunks: 320 },
};

export function defaultQuality(): QualityLevel {
  if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) return 'low';
  if (typeof navigator !== 'undefined' && (navigator.hardwareConcurrency ?? 8) <= 4) return 'medium';
  return 'high';
}
