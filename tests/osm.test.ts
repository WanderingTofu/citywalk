import { describe, expect, it } from 'vitest';
import { LocalProjection } from '../src/geo/Coordinates';
import { parseMeters, parseOsm } from '../src/geo/OSMParser';
import { buildQuery, type OsmResponse } from '../src/geo/OSMProvider';
import { buildTile } from '../src/geo/TileBuilder';
import { signedArea } from '../src/geo/polygon';
import { AreaKind, RoadKind } from '../src/world/types';

const ORIGIN = { lat: 35.65952, lon: 139.70055 };
const proj = new LocalProjection(ORIGIN);
/** Geometry in Overpass `out geom` form from local meter coordinates. */
const geom = (pts: Array<[number, number]>) => pts.map(([x, z]) => proj.toGeo(x, z)).map((g) => ({ lat: g.lat, lon: g.lon }));

/** A hand-written response in the exact shape Overpass returns for `out geom`. */
const FIXTURE: OsmResponse = {
  elements: [
    { type: 'way', id: 101, tags: { building: 'retail', 'building:levels': '8' }, geometry: geom([[10, 10], [30, 10], [30, 25], [10, 25], [10, 10]]) },
    // Clockwise ring with a height in feet.
    { type: 'way', id: 102, tags: { building: 'yes', height: '100 ft' }, geometry: geom([[50, 10], [50, 30], [70, 30], [70, 10], [50, 10]]) },
    // Underground and unclosed buildings are ignored.
    { type: 'way', id: 103, tags: { building: 'yes', location: 'underground' }, geometry: geom([[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]]) },
    { type: 'way', id: 104, tags: { building: 'yes' }, geometry: geom([[0, 0], [5, 0], [5, 5]]) },
    // Courtyard building as a multipolygon whose outer ring is split across two ways.
    {
      type: 'relation', id: 201, tags: { type: 'multipolygon', building: 'apartments' },
      members: [
        { type: 'way', role: 'outer', geometry: geom([[100, 100], [140, 100], [140, 140]]) },
        { type: 'way', role: 'outer', geometry: geom([[140, 140], [100, 140], [100, 100]]) },
        { type: 'way', role: 'inner', geometry: geom([[110, 110], [130, 110], [130, 130], [110, 130], [110, 110]]) },
      ],
    },
    { type: 'way', id: 301, tags: { highway: 'primary', lanes: '6' }, geometry: geom([[-300, 0], [0, 0], [300, 0], [900, 0]]) },
    { type: 'way', id: 302, tags: { highway: 'footway' }, geometry: geom([[0, -50], [0, 50]]) },
    { type: 'way', id: 303, tags: { highway: 'primary', tunnel: 'yes' }, geometry: geom([[0, -80], [50, -80]]) },
    { type: 'way', id: 304, tags: { highway: 'proposed' }, geometry: geom([[0, -90], [50, -90]]) },
    { type: 'way', id: 305, tags: { railway: 'rail' }, geometry: geom([[-100, 60], [100, 60]]) },
    { type: 'way', id: 306, tags: { waterway: 'canal', width: '14' }, geometry: geom([[-100, 90], [100, 90]]) },
    { type: 'way', id: 401, tags: { leisure: 'park' }, geometry: geom([[150, -50], [450, -50], [450, 150], [150, 150], [150, -50]]) },
    { type: 'way', id: 402, tags: { natural: 'water' }, geometry: geom([[200, 0], [220, 0], [220, 20], [200, 20], [200, 0]]) },
    { type: 'way', id: 403, tags: { highway: 'pedestrian', area: 'yes' }, geometry: geom([[-60, -60], [-20, -60], [-20, -20], [-60, -20], [-60, -60]]) },
    { type: 'node', id: 501, lat: proj.toGeo(160, 20).lat, lon: proj.toGeo(160, 20).lon, tags: { natural: 'tree' } },
    // Overpass can return the same element twice across statements.
    { type: 'way', id: 101, tags: { building: 'retail' }, geometry: geom([[10, 10], [30, 10], [30, 25], [10, 25], [10, 10]]) },
  ],
};

describe('OSM parsing', () => {
  const raw = parseOsm(FIXTURE, proj);

  it('parses lengths with units', () => {
    expect(parseMeters('12')).toBe(12);
    expect(parseMeters('12.5 m')).toBe(12.5);
    expect(parseMeters('100 ft')).toBeCloseTo(30.48, 6);
    expect(parseMeters('tall')).toBe(0);
    expect(parseMeters(undefined)).toBe(0);
  });

  it('extracts buildings in meters with consistent winding', () => {
    expect(raw.buildings.map((b) => b.kind).sort()).toEqual(['apartments', 'retail', 'yes']);
    const retail = raw.buildings.find((b) => b.kind === 'retail')!;
    expect(retail.levels).toBe(8);
    expect(retail.area).toBeCloseTo(300, 0);
    const tagged = raw.buildings.find((b) => b.kind === 'yes')!;
    expect(tagged.height).toBeCloseTo(30.48, 4);
    for (const b of raw.buildings) expect(signedArea(b.rings[0])).toBeGreaterThan(0);
  });

  it('assembles multipolygons with courtyards', () => {
    const b = raw.buildings.find((x) => x.kind === 'apartments')!;
    expect(b.rings).toHaveLength(2);
    expect(signedArea(b.rings[1])).toBeLessThan(0);
    expect(b.area).toBeCloseTo(1600 - 400, 0);
  });

  it('classifies linear features and skips tunnels and non-roads', () => {
    const byId = new Map(raw.roads.map((r) => [r.id, r]));
    expect(byId.get(301)!.kind).toBe(RoadKind.Road);
    expect(byId.get(301)!.width).toBeCloseTo(6 * 3.2, 6);
    expect(byId.get(302)!.kind).toBe(RoadKind.Path);
    expect(byId.get(305)!.kind).toBe(RoadKind.Rail);
    expect(byId.get(306)!.kind).toBe(RoadKind.Water);
    expect(byId.get(306)!.width).toBe(14);
    expect(byId.has(303)).toBe(false);
    expect(byId.has(304)).toBe(false);
  });

  it('classifies areas and trees', () => {
    const kinds = raw.areas.map((a) => a.kind).sort();
    expect(kinds).toEqual([AreaKind.Green, AreaKind.Water, AreaKind.Plaza].sort());
    expect(raw.trees).toHaveLength(2);
    expect(raw.trees[0]).toBeCloseTo(160, 3);
  });

  it('splits features into chunks without loss or duplication', () => {
    const t00 = buildTile('test', 0, 0, raw, 'osm');
    const tm0 = buildTile('test', -1, 0, raw, 'osm');
    const t10 = buildTile('test', 1, 0, raw, 'osm');
    const tiles = [t00, tm0, t10, buildTile('test', 0, -1, raw, 'osm'), buildTile('test', -1, -1, raw, 'osm')];
    const count = (pick: (c: (typeof t00.chunks)[string]) => number) =>
      tiles.reduce((n, t) => n + Object.values(t.chunks).reduce((m, c) => m + pick(c), 0), 0);
    expect(count((c) => c.buildings.length)).toBe(3);
    expect(count((c) => c.trees.length)).toBe(2);
    // The 1200 m primary road is cut at chunk borders but its total length is preserved.
    const length = count((c) => c.roads.filter((r) => r.id === 301).reduce((s, r) => {
      let l = 0;
      for (let i = 0; i + 3 < r.pts.length; i += 2) l += Math.hypot(r.pts[i + 2] - r.pts[i], r.pts[i + 3] - r.pts[i + 1]);
      return s + l;
    }, 0));
    expect(length).toBeCloseTo(1200, 1);
    expect(tm0.chunks['-1,0'].roads.some((r) => r.id === 301)).toBe(true);
    expect(t10.chunks['4,0'].roads.some((r) => r.id === 301)).toBe(true);
    // The park is clipped per chunk; total area is preserved.
    const parkArea = count((c) => c.areas.filter((a) => a.kind === AreaKind.Green).reduce((s, a) => s + Math.abs(signedArea(a.ring)), 0));
    expect(parkArea).toBeCloseTo(300 * 200, -1);
  });

  it('builds a bounded Overpass query', () => {
    const q = buildQuery(proj.boundsOf(0, 0, 800, 800));
    expect(q).toContain('[out:json]');
    expect(q).toContain('out geom');
    expect(q).toMatch(/\[bbox:35\.\d+,139\.\d+,35\.\d+,139\.\d+\]/);
  });
});
