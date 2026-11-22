import { describe, expect, it } from 'vitest';
import { LocalProjection, haversine } from '../src/geo/Coordinates';

const SHIBUYA = { lat: 35.65952, lon: 139.70055 };

describe('LocalProjection', () => {
  it('maps the origin to (0, 0)', () => {
    const p = new LocalProjection(SHIBUYA);
    const [x, z] = p.toLocal(SHIBUYA.lat, SHIBUYA.lon);
    expect(x).toBeCloseTo(0, 9);
    expect(z).toBeCloseTo(0, 9);
  });

  it('puts east on +X and north on -Z', () => {
    const p = new LocalProjection(SHIBUYA);
    expect(p.toLocal(SHIBUYA.lat, SHIBUYA.lon + 0.01)[0]).toBeGreaterThan(0);
    expect(p.toLocal(SHIBUYA.lat + 0.01, SHIBUYA.lon)[1]).toBeLessThan(0);
  });

  it('round-trips geographic coordinates', () => {
    const p = new LocalProjection(SHIBUYA);
    for (const [dLat, dLon] of [[0.01, 0.02], [-0.03, 0.005], [0.2, -0.2]]) {
      const lat = SHIBUYA.lat + dLat;
      const lon = SHIBUYA.lon + dLon;
      const [x, z] = p.toLocal(lat, lon);
      const g = p.toGeo(x, z);
      expect(g.lat).toBeCloseTo(lat, 10);
      expect(g.lon).toBeCloseTo(lon, 10);
    }
  });

  it('measures real-world meters to within 0.3 % across a few kilometers', () => {
    for (const origin of [SHIBUYA, { lat: 48.85735, lon: 2.35835 }, { lat: 13.73735, lon: 100.56045 }]) {
      const p = new LocalProjection(origin);
      const other = { lat: origin.lat + 0.02, lon: origin.lon + 0.03 };
      const [x, z] = p.toLocal(other.lat, other.lon);
      const truth = haversine(origin, other);
      expect(Math.abs(Math.hypot(x, z) - truth) / truth).toBeLessThan(0.003);
    }
  });

  it('produces a bounding box that contains its rectangle', () => {
    const p = new LocalProjection(SHIBUYA);
    const b = p.boundsOf(-400, -800, 400, 0);
    expect(b.north).toBeGreaterThan(b.south);
    expect(b.east).toBeGreaterThan(b.west);
    const [x0, z0] = p.toLocal(b.north, b.west);
    expect(x0).toBeCloseTo(-400, 6);
    expect(z0).toBeCloseTo(-800, 6);
  });
});
