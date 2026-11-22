/**
 * Deterministic hashing and random numbers.
 * Everything procedural in CITYWALK derives from these, seeded by stable
 * identifiers (OSM ids, chunk coordinates), so a given place always generates
 * the same result on every machine and every visit.
 */

/** 32-bit integer mix (murmur3 finalizer). */
export function hash32(n: number): number {
  let h = n | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Combine two integers into one hash. */
export function hash2(a: number, b: number): number {
  return hash32(hash32(a) ^ Math.imul(b | 0, 0x9e3779b1));
}

/** FNV-1a string hash. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Fold a large (possibly > 2^32) id such as an OSM id into 32 bits. */
export function foldId(id: number): number {
  const lo = id >>> 0;
  const hi = Math.floor(id / 4294967296) >>> 0;
  return hash2(lo, hi);
}

/** Small fast PRNG (mulberry32). */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(min: number, maxInclusive: number): number {
    return Math.floor(this.range(min, maxInclusive + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /** Pick a key from a weight table. Keys are visited in sorted order so the result is stable. */
  weighted<K extends string>(weights: Partial<Record<K, number>>): K {
    const keys = (Object.keys(weights) as K[]).sort();
    let total = 0;
    for (const k of keys) total += weights[k] ?? 0;
    let r = this.next() * total;
    for (const k of keys) {
      r -= weights[k] ?? 0;
      if (r <= 0) return k;
    }
    return keys[keys.length - 1];
  }
}
