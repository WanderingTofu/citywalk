import type { StyleConfig } from '../districts/StyleConfig';
import { DTLA, GION, LE_MARAIS, MANHATTAN, SHIBUYA, SUKHUMVIT } from '../districts/presets';

export interface DistrictConfig {
  id: string;
  name: string;
  /** Spawn point; also the origin of the city's local coordinate frame. */
  spawn: { lat: number; lon: number };
  /** Initial facing, degrees clockwise from north. */
  heading: number;
  style: StyleConfig;
}

export interface CityConfig {
  id: string;
  name: string;
  districts: DistrictConfig[];
}

/**
 * Spawn points are real street locations. If a point happens to fall inside a
 * footprint, the engine nudges the player to the nearest open ground.
 */
export const CITIES: CityConfig[] = [
  {
    id: 'tokyo',
    name: 'Tokyo',
    districts: [
      { id: 'shibuya', name: 'Shibuya', spawn: { lat: 35.65952, lon: 139.70055 }, heading: 320, style: SHIBUYA },
    ],
  },
  {
    id: 'paris',
    name: 'Paris',
    districts: [
      { id: 'le-marais', name: 'Le Marais', spawn: { lat: 48.85735, lon: 2.35835 }, heading: 60, style: LE_MARAIS },
    ],
  },
  {
    id: 'new-york',
    name: 'New York',
    districts: [
      { id: 'manhattan', name: 'Manhattan', spawn: { lat: 40.75802, lon: -73.98553 }, heading: 29, style: MANHATTAN },
    ],
  },
  {
    id: 'bangkok',
    name: 'Bangkok',
    districts: [
      { id: 'sukhumvit', name: 'Sukhumvit', spawn: { lat: 13.73735, lon: 100.56045 }, heading: 110, style: SUKHUMVIT },
    ],
  },
  {
    id: 'los-angeles',
    name: 'Los Angeles',
    districts: [
      { id: 'downtown', name: 'Downtown', spawn: { lat: 34.05035, lon: -118.25395 }, heading: 40, style: DTLA },
    ],
  },
  {
    id: 'kyoto',
    name: 'Kyoto',
    districts: [{ id: 'gion', name: 'Gion', spawn: { lat: 35.00372, lon: 135.77515 }, heading: 180, style: GION }],
  },
];

export function findDistrict(cityId: string, districtId?: string): { city: CityConfig; district: DistrictConfig } {
  const city = CITIES.find((c) => c.id === cityId) ?? CITIES[0];
  const district = city.districts.find((d) => d.id === districtId) ?? city.districts[0];
  return { city, district };
}
