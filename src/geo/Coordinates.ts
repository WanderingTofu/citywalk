/**
 * Geographic <-> local Cartesian conversion.
 *
 * Each city gets a local tangent-plane frame anchored at its origin
 * (equirectangular projection about the origin latitude). Units are meters.
 *
 *   +X = east,  +Y = up,  +Z = south  (so north is -Z, matching a right-handed
 *   Y-up renderer looking at a north-up map from above).
 *
 * The approximation error is well under 0.1 % within ~50 km of the origin,
 * which is far more than a walkable session covers.
 */

export const EARTH_RADIUS = 6378137; // WGS84 equatorial radius, meters
const DEG = Math.PI / 180;

export interface LatLon {
  lat: number;
  lon: number;
}

export interface GeoBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export class LocalProjection {
  readonly origin: LatLon;
  private readonly mPerDegLat: number;
  private readonly mPerDegLon: number;

  constructor(origin: LatLon) {
    this.origin = origin;
    this.mPerDegLat = EARTH_RADIUS * DEG;
    this.mPerDegLon = EARTH_RADIUS * DEG * Math.cos(origin.lat * DEG);
  }

  /** Geographic -> local meters. Returns [x, z]. */
  toLocal(lat: number, lon: number): [number, number] {
    return [(lon - this.origin.lon) * this.mPerDegLon, -(lat - this.origin.lat) * this.mPerDegLat];
  }

  /** Local meters -> geographic. */
  toGeo(x: number, z: number): LatLon {
    return {
      lat: this.origin.lat - z / this.mPerDegLat,
      lon: this.origin.lon + x / this.mPerDegLon,
    };
  }

  /** Geographic bounding box of a local axis-aligned rectangle. */
  boundsOf(minX: number, minZ: number, maxX: number, maxZ: number): GeoBounds {
    const nw = this.toGeo(minX, minZ);
    const se = this.toGeo(maxX, maxZ);
    return { south: se.lat, west: nw.lon, north: nw.lat, east: se.lon };
  }
}

/** Great-circle distance in meters (haversine), used to validate the projection. */
export function haversine(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(s));
}
