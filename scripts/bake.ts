/**
 * Bake the blueprint of each district: fetch the OpenStreetMap data around its
 * spawn point once, process it exactly as the app would, and write it as
 * static tiles under public/tiles/. The deployed app then loads a city's plan
 * from its own host instead of asking the public Overpass servers at runtime.
 *
 *   npm run bake                         every district, 2 tiles each way (3.2 km square)
 *   npm run bake -- --city tokyo         one city
 *   npm run bake -- --radius 3 --force   wider, and refresh tiles that already exist
 *   npm run bake -- --endpoint URL       use a specific Overpass instance
 *
 * Map data © OpenStreetMap contributors, ODbL 1.0.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CITIES, frameId } from '../src/config/cities';
import { BAKED_VERSION, bakedName, bakedSlug, encodeTile, type BakedIndex } from '../src/geo/BakedTiles';
import { LocalProjection } from '../src/geo/Coordinates';
import { parseOsm } from '../src/geo/OSMParser';
import { OVERPASS_ENDPOINTS, fetchOsm } from '../src/geo/OSMProvider';
import { tileBounds } from '../src/geo/TileAddress';
import { buildTile } from '../src/geo/TileBuilder';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const radius = Number(value('radius') ?? 2);
const only = value('city');
const force = flag('force');
const delay = Number(value('delay') ?? 1500);
const endpoint = value('endpoint');
if (endpoint) OVERPASS_ENDPOINTS.splice(0, OVERPASS_ENDPOINTS.length, endpoint);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const today = new Date().toISOString().slice(0, 10);
const root = join(process.cwd(), 'public', 'tiles');

let baked = 0;
let kept = 0;
let failed = 0;
let bytes = 0;

for (const city of CITIES) {
  if (only && city.id !== only) continue;
  for (const district of city.districts) {
    const dir = join(root, bakedSlug(city.id, district.id));
    mkdirSync(dir, { recursive: true });
    const proj = new LocalProjection(district.spawn);
    const id = frameId(city, district);
    console.log(`\n${city.name} / ${district.name}`);

    for (let tz = -radius; tz < radius; tz++) {
      for (let tx = -radius; tx < radius; tx++) {
        const file = join(dir, `${bakedName(tx, tz)}.json`);
        if (existsSync(file) && !force) {
          kept++;
          continue;
        }
        const b = tileBounds(tx, tz);
        let done = false;
        for (let attempt = 0; attempt < 3 && !done; attempt++) {
          try {
            // A bake can afford to wait; the app at runtime cannot.
            const osm = await fetchOsm(proj.boundsOf(b.minX, b.minZ, b.maxX, b.maxZ), { timeoutMs: 90_000, hedgeMs: 25_000 });
            const tile = buildTile(id, tx, tz, parseOsm(osm, proj), 'osm');
            const json = JSON.stringify(encodeTile(tile, today));
            writeFileSync(file, json);
            const chunks = Object.values(tile.chunks);
            const count = (pick: (c: (typeof chunks)[number]) => number) => chunks.reduce((n, c) => n + pick(c), 0);
            console.log(
              `  ${bakedName(tx, tz).padEnd(7)} ${String(count((c) => c.buildings.length)).padStart(5)} buildings ` +
                `${String(count((c) => c.roads.length)).padStart(5)} road pieces  ${(json.length / 1024).toFixed(0)} kB`,
            );
            baked++;
            bytes += json.length;
            done = true;
          } catch (err) {
            console.log(`  ${bakedName(tx, tz).padEnd(7)} attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : err}`);
            await sleep(4000 * (attempt + 1));
          }
        }
        if (!done) failed++;
        await sleep(delay);
      }
    }

    // The index lists what is actually on disk, so a partial bake still serves what it has.
    const tiles = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json').map((f) => f.replace(/\.json$/, ''));
    const index: BakedIndex = { v: BAKED_VERSION, tiles: tiles.sort(), baked: today };
    const indexFile = join(dir, 'index.json');
    const previous = existsSync(indexFile) ? readFileSync(indexFile, 'utf8') : '';
    const next = JSON.stringify(index);
    if (JSON.stringify({ ...index, baked: '' }) !== JSON.stringify({ ...(previous ? JSON.parse(previous) : {}), baked: '' })) writeFileSync(indexFile, next);
  }
}

console.log(`\nBaked ${baked} tiles (${(bytes / 1048576).toFixed(1)} MB), kept ${kept}, failed ${failed}.`);
// A partial bake is still useful, so only a bake that produced nothing at all is an error.
if (baked === 0 && kept === 0) process.exit(1);
