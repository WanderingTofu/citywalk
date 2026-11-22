import type { QualitySettings } from '../config/quality';
import type { Lod } from '../world/types';

/** LOD decision for a chunk. -1 means "not loaded". */
export type LodLevel = Lod | -1;

/** Fraction by which a chunk must cross a threshold before switching back, to stop flapping at boundaries. */
const HYSTERESIS = 0.12;

/**
 * Distance -> LOD with hysteresis. `current` is the chunk's present level
 * (-1 if absent): moving to a coarser level requires going HYSTERESIS past
 * the threshold, moving to a finer one happens exactly at the threshold.
 */
export function selectLod(distance: number, q: QualitySettings, current: LodLevel): LodLevel {
  const limits = [q.lod0, q.lod1, q.lod2, q.lod3];
  let level: LodLevel = -1;
  for (let i = 0; i < 4; i++) {
    if (distance <= limits[i]) {
      level = i as Lod;
      break;
    }
  }
  if (current === -1 || level === current) return level;
  const coarser = level === -1 || level > current;
  if (coarser && distance <= limits[current] * (1 + HYSTERESIS)) return current;
  return level;
}

/** Whether street props should exist for a chunk at this distance. */
export function wantsProps(distance: number, q: QualitySettings, has: boolean): boolean {
  return distance <= q.propRange * (has ? 1 + HYSTERESIS : 1);
}
