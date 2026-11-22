import { describe, expect, it } from 'vitest';
import { classifyUse } from '../src/geo/OSMParser';
import { moonPosition, presetHour, sunPosition } from '../src/graphics/Lighting';
import { skyRadiance, sunTransmittance } from '../src/graphics/SkyModel';
import { TREE_SPECIES, TREE_VARIANTS, TreeFactory } from '../src/graphics/TreeFactory';
import { PARKED_WEIGHTS, VEHICLE_TYPES, VehicleFactory } from '../src/graphics/VehicleFactory';
import { MeshWriter } from '../src/world/MeshWriter';

const RAD = Math.PI / 180;

describe('sun and moon', () => {
  it('puts the noon sun due south (north of the tropic) at the right height', () => {
    for (const lat of [35.66, 48.86, 40.76, 41.88]) {
      const noon = sunPosition(lat, 12);
      expect(noon.azimuth).toBeCloseTo(180, 0);
      // Late May: declination is about +21 degrees.
      expect(noon.elevation).toBeGreaterThan(90 - lat + 18);
      expect(noon.elevation).toBeLessThan(90 - lat + 24);
    }
  });

  it('rises in the east, sets in the west and is down at midnight', () => {
    expect(sunPosition(40, 7).azimuth).toBeLessThan(120);
    expect(sunPosition(40, 18).azimuth).toBeGreaterThan(240);
    expect(sunPosition(40, 0).elevation).toBeLessThan(-10);
    // The full moon is up when the sun is down.
    expect(moonPosition(40, 0).elevation).toBeGreaterThan(10);
    expect(moonPosition(40, 12).elevation).toBeLessThan(0);
  });

  it('finds golden hour for every latitude in use', () => {
    for (const lat of [13.7, 34.05, 35.0, 40.76, 48.86]) {
      const h = presetHour('golden', lat);
      expect(h).toBeGreaterThan(16);
      expect(h).toBeLessThan(21);
      expect(sunPosition(lat, h).elevation).toBeCloseTo(6.5, 1);
    }
    expect(presetHour('day', 40)).toBe(13);
  });
});

describe('atmosphere model', () => {
  it('reddens and dims the sun toward the horizon', () => {
    const high = sunTransmittance(60 * RAD);
    const low = sunTransmittance(4 * RAD);
    expect(high[0]).toBeGreaterThan(0.85);
    expect(high[2]).toBeGreaterThan(0.6);
    expect(low[0]).toBeGreaterThan(low[1]);
    expect(low[1]).toBeGreaterThan(low[2] * 2);
    expect(low[0]).toBeLessThan(high[0]);
  });

  it('makes the daytime zenith blue and the low sun side warm', () => {
    const el = 50 * RAD;
    const up = skyRadiance(0, 1, 0, Math.cos(el), Math.sin(el), 0);
    expect(up[2]).toBeGreaterThan(up[0] * 2);
    // Realistic magnitude: sky radiance per unit illuminance is a few hundredths.
    expect(up[2]).toBeGreaterThan(0.01);
    expect(up[2]).toBeLessThan(0.2);
    const sunset = 3 * RAD;
    const toward = skyRadiance(Math.cos(0.05), Math.sin(0.05), 0, Math.cos(sunset), Math.sin(sunset), 0);
    expect(toward[0]).toBeGreaterThan(toward[2]);
  });
});

describe('vehicle engine', () => {
  const factory = new VehicleFactory();

  it('builds every body type at both levels of detail', () => {
    expect(PARKED_WEIGHTS).toHaveLength(VEHICLE_TYPES.length);
    VEHICLE_TYPES.forEach((name, type) => {
      const near = factory.geometry(type, 0);
      const far = factory.geometry(type, 1);
      const count = near.getAttribute('position').count;
      expect(count % 3, name).toBe(0);
      expect(near.getAttribute('normal').count).toBe(count);
      expect(near.getAttribute('color').count).toBe(count);
      for (const v of near.getAttribute('position').array) expect(Number.isFinite(v)).toBe(true);
      // "De-polygon with distance": the far mesh is a fraction of the near one.
      expect(factory.triangles(type, 1), name).toBeLessThan(factory.triangles(type, 0) * 0.5);
      expect(factory.triangles(type, 0), name).toBeLessThan(1400);
      expect(far.boundingSphere!.radius).toBeGreaterThan(0.5);
    });
  });

  it('gives each type plausible real-world proportions', () => {
    const size = (type: string) => {
      const g = factory.geometry(VEHICLE_TYPES.indexOf(type as (typeof VEHICLE_TYPES)[number]), 0);
      g.computeBoundingBox();
      const b = g.boundingBox!;
      return { length: b.max.z - b.min.z, width: b.max.x - b.min.x, height: b.max.y - b.min.y };
    };
    expect(size('sedan').length).toBeGreaterThan(4.3);
    expect(size('sedan').length).toBeLessThan(5);
    expect(size('sedan').height).toBeLessThan(size('suv').height);
    expect(size('sports').height).toBeLessThan(size('sedan').height);
    expect(size('truck').height).toBeGreaterThan(2.5);
    expect(size('semi').length).toBeGreaterThan(15);
    expect(size('motorcycle').width).toBeLessThan(1);
    // Wheels touch the road.
    for (const t of VEHICLE_TYPES) {
      const g = factory.geometry(VEHICLE_TYPES.indexOf(t), 0);
      g.computeBoundingBox();
      expect(Math.abs(g.boundingBox!.min.y), t).toBeLessThan(0.02);
    }
  });

  it('is deterministic and tags paint, glass and tyres', () => {
    const a = new VehicleFactory().geometry(0, 0);
    const b = new VehicleFactory().geometry(0, 0);
    expect(a.getAttribute('position').array).toEqual(b.getAttribute('position').array);
    const col = a.getAttribute('color').array;
    let paint = 0, glass = 0, dark = 0;
    for (let i = 0; i < col.length; i += 3) {
      if (col[i] > 0.99 && col[i + 1] > 0.99 && col[i + 2] > 0.99) paint++;
      else if (col[i] < 0.05 && col[i + 2] > col[i] * 1.25) glass++;
      else if (col[i] < 0.05) dark++;
    }
    expect(paint).toBeGreaterThan(100);
    expect(glass).toBeGreaterThan(30);
    expect(dark).toBeGreaterThan(100);
  });
});

describe('tree engine', () => {
  const factory = new TreeFactory();

  it('grows every species and variant deterministically', () => {
    TREE_SPECIES.forEach((name, species) => {
      for (let v = 0; v < TREE_VARIANTS; v++) {
        const g = factory.geometry(species, v);
        const again = new TreeFactory().geometry(species, v);
        expect(g.getAttribute('position').array, name).toEqual(again.getAttribute('position').array);
        expect(g.index!.count % 3).toBe(0);
        expect(g.index!.count / 3, name).toBeLessThan(2500);
        g.computeBoundingBox();
        expect(g.boundingBox!.max.y, name).toBeGreaterThan(4);
        expect(g.boundingBox!.max.y, name).toBeLessThan(16);
        for (const x of g.getAttribute('position').array) expect(Number.isFinite(x)).toBe(true);
      }
      // Variants really differ.
      expect(factory.geometry(species, 0).getAttribute('position').array).not.toEqual(factory.geometry(species, 1).getAttribute('position').array);
    });
  });

  it('has a far stand-in several times cheaper than the grown tree', () => {
    TREE_SPECIES.forEach((name, species) => {
      const far = factory.simplified(species).getAttribute('position').count / 3;
      const near = factory.geometry(species, 0).index!.count / 3;
      expect(far, name).toBeLessThan(near);
      expect(far, name).toBeLessThan(520);
    });
  });
});

describe('building use', () => {
  it('classifies from the most specific tag', () => {
    expect(classifyUse({ building: 'yes' })).toBe('unknown');
    expect(classifyUse({ building: 'house' })).toBe('house');
    expect(classifyUse({ building: 'apartments' })).toBe('apartments');
    expect(classifyUse({ building: 'yes', shop: 'bakery' })).toBe('retail');
    expect(classifyUse({ building: 'yes', shop: 'mall' })).toBe('commercial');
    expect(classifyUse({ building: 'yes', office: 'company' })).toBe('office');
    expect(classifyUse({ building: 'yes', tourism: 'hotel' })).toBe('commercial');
    expect(classifyUse({ building: 'yes', amenity: 'school' })).toBe('civic');
    expect(classifyUse({ building: 'warehouse' })).toBe('industrial');
    expect(classifyUse({ building: 'garage', shop: 'car' })).toBe('minor');
    expect(classifyUse({ building: 'parking' })).toBe('parking');
  });
});

describe('draw order', () => {
  it('sorts triangles by layer, keeping emission order within a layer', () => {
    const w = new MeshWriter(false);
    w.attrB = [0];
    const tri = (order: number) => {
      w.order = order;
      const i = w.vertex(0, 0, 0, 0, 1, 0, order, 0, 0, 0);
      w.vertex(1, 0, 0, 0, 1, 0, order, 0, 0, 0);
      w.vertex(0, 0, 1, 0, 1, 0, order, 0, 0, 0);
      w.tri(i, i + 1, i + 2);
      return i;
    };
    const road = tri(4.2);
    const base = tri(0);
    const walk = tri(3.5);
    const road2 = tri(4.2);
    const index = Array.from(w.finish()!.index);
    expect(index.filter((_, k) => k % 3 === 0)).toEqual([base, walk, road, road2]);
  });
});
