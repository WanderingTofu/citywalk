import type { LocalProjection } from './Coordinates';
import type { OsmElement, OsmGeomPoint, OsmResponse } from './OSMProvider';
import { cleanRing, oriented, signedArea, stitchRings } from './polygon';
import { AreaKind, RoadKind, type BuildingUse } from '../world/types';

/**
 * OSM elements -> projected, classified features in local meters.
 * Pure: no network, no DOM, so it runs in a worker and under test.
 */

export interface RawBuilding {
  id: number;
  rings: number[][];
  height: number;
  levels: number;
  minHeight: number;
  kind: string;
  use: BuildingUse;
  area: number;
}

export interface RawRoad {
  id: number;
  pts: number[];
  width: number;
  kind: RoadKind;
}

export interface RawArea {
  id: number;
  ring: number[];
  kind: AreaKind;
}

export interface RawFeatures {
  buildings: RawBuilding[];
  roads: RawRoad[];
  areas: RawArea[];
  trees: number[];
}

/** Default carriageway widths in meters by highway class. */
const ROAD_WIDTH: Record<string, number> = {
  motorway: 15,
  trunk: 14,
  primary: 13,
  secondary: 11,
  tertiary: 9,
  motorway_link: 7,
  trunk_link: 7,
  primary_link: 7,
  secondary_link: 6.5,
  tertiary_link: 6,
  residential: 6,
  unclassified: 6,
  living_street: 5,
  road: 6,
  service: 3.6,
  busway: 6,
};

const PATH_WIDTH: Record<string, number> = {
  pedestrian: 6,
  footway: 2.4,
  path: 2,
  cycleway: 2.4,
  steps: 2.4,
  track: 3,
  bridleway: 2,
};

const WATER_WIDTH: Record<string, number> = { river: 30, canal: 10, stream: 3 };

const USE_BY_BUILDING: Record<string, BuildingUse> = {};
const assign = (use: BuildingUse, values: string) => values.split(' ').forEach((v) => (USE_BY_BUILDING[v] = use));
assign('house', 'house detached semidetached_house terrace bungalow farm cabin static_caravan houseboat');
assign('apartments', 'apartments residential dormitory public_housing council_house tower residential_tower');
assign('retail', 'retail supermarket shop kiosk');
assign('commercial', 'commercial hotel mall');
assign('office', 'office skyscraper');
assign('industrial', 'industrial warehouse manufacture factory hangar depot storage_tank silo');
assign('civic', 'school university college hospital public civic government church cathedral chapel temple shrine mosque synagogue train_station station museum library fire_station stadium');
assign('parking', 'parking');
assign('minor', 'garage garages shed hut roof carport toilets greenhouse bicycle_parking service container tent');

const COMMERCIAL_AMENITIES = new Set(['restaurant', 'cafe', 'bar', 'pub', 'fast_food', 'cinema', 'theatre', 'casino', 'nightclub', 'bank', 'marketplace']);
const CIVIC_AMENITIES = new Set(['school', 'university', 'college', 'hospital', 'place_of_worship', 'townhall', 'library', 'police', 'fire_station', 'courthouse']);

/** Classify a building's use from its tags; the most specific tag wins. */
export function classifyUse(tags: Record<string, string>): BuildingUse {
  const byBuilding = USE_BY_BUILDING[tags.building];
  if (byBuilding === 'minor' || byBuilding === 'parking') return byBuilding;
  if (tags.amenity === 'parking') return 'parking';
  if (tags.shop) return tags.shop === 'mall' ? 'commercial' : 'retail';
  if (tags.office) return 'office';
  if (tags.tourism === 'hotel' || (tags.amenity && COMMERCIAL_AMENITIES.has(tags.amenity))) return 'commercial';
  if (tags.amenity && CIVIC_AMENITIES.has(tags.amenity)) return 'civic';
  if (tags.man_made === 'works') return 'industrial';
  return byBuilding ?? 'unknown';
}

/** Parse "12", "12.5 m", "40 ft" style tag values. Returns 0 when unusable. */
export function parseMeters(v: string | undefined): number {
  if (!v) return 0;
  const m = /^\s*(-?\d+(?:[.,]\d+)?)\s*(m|ft|feet|')?/i.exec(v);
  if (!m) return 0;
  const n = parseFloat(m[1].replace(',', '.'));
  if (!isFinite(n)) return 0;
  return m[2] && m[2].toLowerCase() !== 'm' ? n * 0.3048 : n;
}

function project(geom: OsmGeomPoint[], proj: LocalProjection): number[] {
  const out: number[] = [];
  for (const p of geom) {
    if (!p) continue; // Overpass emits null for nodes outside a clipped geometry
    const [x, z] = proj.toLocal(p.lat, p.lon);
    out.push(x, z);
  }
  return out;
}

function isClosed(pts: number[]): boolean {
  const n = pts.length;
  return n >= 8 && Math.abs(pts[0] - pts[n - 2]) < 0.01 && Math.abs(pts[1] - pts[n - 1]) < 0.01;
}

/** Closed way geometry -> cleaned open ring, or null if degenerate. */
function toRing(pts: number[]): number[] | null {
  if (!isClosed(pts)) return null;
  const ring = cleanRing(pts.slice(0, pts.length - 2));
  return ring.length >= 6 && Math.abs(signedArea(ring)) > 1 ? ring : null;
}

/** Outer and inner rings of a way or multipolygon relation. */
function polygonRings(el: OsmElement, proj: LocalProjection): { outers: number[][]; inners: number[][] } {
  if (el.type === 'way') {
    const ring = el.geometry ? toRing(project(el.geometry, proj)) : null;
    return { outers: ring ? [ring] : [], inners: [] };
  }
  const outerParts: number[][] = [];
  const innerParts: number[][] = [];
  for (const m of el.members ?? []) {
    if (m.type !== 'way' || !m.geometry) continue;
    (m.role === 'inner' ? innerParts : outerParts).push(project(m.geometry, proj));
  }
  const finish = (parts: number[][]) =>
    stitchRings(parts)
      .map((r) => cleanRing(r))
      .filter((r) => r.length >= 6 && Math.abs(signedArea(r)) > 1);
  return { outers: finish(outerParts), inners: finish(innerParts) };
}

function classifyArea(tags: Record<string, string>): AreaKind | null {
  const natural = tags.natural;
  const landuse = tags.landuse;
  const leisure = tags.leisure;
  if (natural === 'water' || landuse === 'basin' || landuse === 'reservoir') return AreaKind.Water;
  if (natural === 'wood' || landuse === 'forest') return AreaKind.Forest;
  if (leisure === 'park' || leisure === 'garden' || leisure === 'pitch' || leisure === 'playground') return AreaKind.Green;
  if (natural === 'scrub' || natural === 'grassland') return AreaKind.Green;
  if (landuse) return AreaKind.Green;
  return null;
}

export function parseOsm(response: OsmResponse, proj: LocalProjection): RawFeatures {
  const out: RawFeatures = { buildings: [], roads: [], areas: [], trees: [] };
  const seen = new Set<string>();

  for (const el of response.elements) {
    const dedupe = el.type[0] + el.id;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const tags = el.tags ?? {};

    if (el.type === 'node') {
      if (tags.natural === 'tree' && el.lat !== undefined && el.lon !== undefined) {
        const [x, z] = proj.toLocal(el.lat, el.lon);
        out.trees.push(x, z);
      }
      continue;
    }

    // --- buildings -------------------------------------------------------
    if (tags.building && tags.building !== 'no') {
      if (tags.location === 'underground') continue;
      const { outers, inners } = polygonRings(el, proj);
      outers.forEach((outer, i) => {
        const ccw = oriented(outer, true);
        const rings = [ccw];
        // Courtyards only attach unambiguously when there is a single outer ring.
        if (outers.length === 1) for (const h of inners) rings.push(oriented(h, false));
        let area = Math.abs(signedArea(ccw));
        for (let k = 1; k < rings.length; k++) area -= Math.abs(signedArea(rings[k]));
        if (area < 4) return;
        out.buildings.push({
          // Multi-outer relations get distinct stable ids per part.
          id: el.id * 8 + (el.type === 'relation' ? 4 : 0) + Math.min(i, 3),
          rings,
          height: parseMeters(tags.height ?? tags['building:height']),
          levels: Math.max(0, Math.round(parseFloat(tags['building:levels'] ?? '0') || 0)),
          minHeight: parseMeters(tags.min_height),
          kind: tags.building,
          use: classifyUse(tags),
          area,
        });
      });
      continue;
    }

    // --- linear features (ways only) ------------------------------------
    if (el.type === 'way' && el.geometry) {
      const highway = tags.highway;
      const tunnel = tags.tunnel && tags.tunnel !== 'no' && tags.tunnel !== 'building_passage';
      if (highway) {
        if (tunnel || tags.indoor === 'yes' || tags.area === 'yes' && !(highway in PATH_WIDTH)) continue;
        const pts = project(el.geometry, proj);
        if (highway in PATH_WIDTH && tags.area === 'yes') {
          const ring = toRing(pts);
          if (ring) out.areas.push({ id: el.id, ring: oriented(ring, true), kind: AreaKind.Plaza });
          continue;
        }
        let width = ROAD_WIDTH[highway];
        let kind = RoadKind.Road;
        if (width === undefined) {
          width = PATH_WIDTH[highway];
          kind = RoadKind.Path;
        }
        if (width === undefined) continue; // proposed, construction, platform, corridor, ...
        const lanes = parseFloat(tags.lanes ?? '');
        const tagged = parseMeters(tags.width);
        if (tagged > 1 && tagged < 60) width = tagged;
        else if (kind === RoadKind.Road && lanes >= 1 && lanes <= 12) width = Math.max(width, lanes * 3.2);
        if (pts.length >= 4) out.roads.push({ id: el.id, pts, width, kind });
        continue;
      }
      if (tags.railway) {
        if (tunnel) continue;
        const pts = project(el.geometry, proj);
        if (pts.length >= 4) out.roads.push({ id: el.id, pts, width: 3.2, kind: RoadKind.Rail });
        continue;
      }
      if (tags.waterway && tags.waterway in WATER_WIDTH) {
        if (tags.tunnel && tags.tunnel !== 'no') continue;
        const pts = project(el.geometry, proj);
        const tagged = parseMeters(tags.width);
        const width = tagged > 0.5 && tagged < 400 ? tagged : WATER_WIDTH[tags.waterway];
        if (pts.length >= 4) out.roads.push({ id: el.id, pts, width, kind: RoadKind.Water });
        continue;
      }
    }

    // --- areas -----------------------------------------------------------
    const kind = classifyArea(tags);
    if (kind !== null) {
      const { outers } = polygonRings(el, proj);
      outers.forEach((ring, i) => out.areas.push({ id: el.id * 8 + Math.min(i, 7), ring: oriented(ring, true), kind }));
    }
  }
  return out;
}
