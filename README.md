# CITYWALK

**One lightweight engine. Real-world geography. Unlimited walkable cities.**

CITYWALK is a browser engine for walking through real cities. Streets, building footprints, parks and waterways come from OpenStreetMap. Everything you see on top of that geography (facades, windows, roofs, materials, lighting) is generated procedurally from a per-district style, so the browser downloads the *ability to generate* a city, not the city.

The architecture is an interpretation, not a reconstruction: footprints and street layout are real; heights are real where OSM has them and estimated by district rules where it does not; facades are never a claim about what a specific building looks like.

Cities: Tokyo (Shibuya), Paris (Le Marais), New York (Manhattan), Bangkok (Sukhumvit), Los Angeles (Downtown), Kyoto (Gion).

## Run it

Requires Node 20+.

```bash
npm install
npm run dev        # http://localhost:5173
```

```bash
npm test           # unit tests (vitest)
npm run build      # typecheck + production build into dist/
npm run preview    # serve the production build
```

### Controls

| | |
|---|---|
| `W` `A` `S` `D` | Walk |
| Mouse | Look (click the view to capture the pointer) |
| `Shift` | Sprint |
| `Space` | Jump |
| `V` | First / third person |
| `Esc` | Release the pointer |

### URL parameters

`?city=kyoto&district=gion&time=night&quality=high` — any of `city`, `district`, `time` (`day`, `golden`, `night`) and `quality` (`low`, `medium`, `high`, `ultra`). Add `&demo=1` for the offline demo city.

## Deploy

Pushing to `main` runs `.github/workflows/ci.yml`: typecheck, tests, build, then deploy `dist/` to GitHub Pages.

One-time setup: in the repository's **Settings → Pages**, set **Source** to **GitHub Actions**. The build uses relative asset paths, so it works from any sub-path or static host; `dist/` can be copied anywhere.

## How it works

- **Coordinates.** Each district has a local tangent-plane frame in meters anchored at its spawn point (+X east, +Z south).
- **Two-level grid.** *Tiles* (800 m) are the unit of data: one Overpass request, one IndexedDB record. *Chunks* (200 m) are the unit of rendering, LOD and disposal. Addresses are pure functions of position.
- **Streaming.** A window around the player decides each chunk's LOD from its distance to the player *and* to where the player will be in 2.5 s. Missing tiles are fetched (two at a time), chunks are generated in Web Workers in priority order (near and in view first), finished buffers are handed to the GPU within a per-frame time budget, and anything out of range is disposed. A missing tile never blocks: its chunks are simply absent, inside the fog.
- **LOD.** Full detail with collision and props → no signs or rooftop plant → skyline (outer rings only, flat caps, small structures dropped) → unloaded. Fog density is derived from the streaming range.
- **One material for all buildings.** Walls, roofs and signs share a single PBR material. Windows, storefronts, balconies, lattice screens, brick, stone, wood, tile and weathering are evaluated per pixel from a few vertex attributes. No texture files are downloaded. The ground (asphalt, lane markings, paving, grass, water, rail) is a second material, one draw call per chunk.
- **Styles.** Each district has a plain-language prompt and a structured `StyleConfig` derived from it (materials mix, window pattern, roof form, height rules, lighting mood). The engine only reads the structured form. `StyleCompiler` is a deterministic keyword compiler and the seam where an AI compiler can plug in.
- **Determinism.** All variation is seeded by OSM ids and chunk addresses, so a place generates identically on every visit and every machine, and chunks can be thrown away and rebuilt freely.

More detail: [docs/architecture.md](docs/architecture.md).

## Status

Implemented and exercised by tests or headless-browser runs:

- OSM pipeline: Overpass query, parsing (ways, multipolygon relations with courtyards, roads, paths, rail, waterways, parks, water, plazas, mapped trees), projection, chunk assignment, IndexedDB cache with eviction.
- Mirror rotation, timeouts and backoff for Overpass; procedural fallback when it is unreachable, labelled in the UI.
- Deterministic offline demo city (`?demo=1`).
- Building generation from real footprints: holes, estimated heights, flat / gable / mansard roofs over arbitrary footprints, tower setbacks, rooftop plant, blade signs.
- Chunk streaming with predictive loading, three LODs with hysteresis, priority by distance and view direction, disposal, bounded chunk and tile counts.
- First-person walking with wall-sliding collision, sprint, jump, third-person camera.
- Day / golden hour / night with transitions, shadows, fog, emissive windows and signs, lamp light pools.
- Six cities with distinct district styles; city switching.
- HUD: selectors, FPS and frame time, draw calls, triangles, chunks per LOD, tiles, queue, GPU geometries, JS heap, render scale.
- Dynamic resolution scaling when frames run long.

Not done yet (deliberately out of scope for this stage):

- **Terrain elevation.** The world is flat at y = 0.
- **`building:part`, roof tags, landmarks.** Complex buildings are extruded from their outline only.
- **Large river polygons.** Rivers are drawn from their centerline with a tagged or default width, to avoid downloading whole-river multipolygons.
- **District blending.** Each city has one district; the style structure supports more, but cross-fading neighbouring styles is not implemented.
- **Touch controls**, rain, vehicles, pedestrians, interiors, multiplayer (Milestone 5).
- **WebGPU backend.** Rendering goes through three.js' WebGL2 renderer behind `core/Renderer.ts`; shaders are plain math intended to port to TSL.

### Performance

Measured, not assumed: the HUD reports frame time, worst frame, draw calls and memory live. Development verification ran in headless Chromium on a software rasterizer, which validates correctness and bounded resource use but says nothing about real GPU frame rates, so **the 60 FPS desktop / 30 FPS mobile targets are unverified**. Initial download is about 160 kB gzipped (three.js is most of it).

## Data and licenses

- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/). The attribution is shown in the app at all times and must be kept in any deployment.
- Data is fetched from public [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) instances, which are shared community infrastructure. CITYWALK caches every tile locally and limits itself to two concurrent requests; for a high-traffic deployment, run your own Overpass instance or pre-bake tiles and change `OVERPASS_ENDPOINTS` in `src/geo/OSMProvider.ts`.
- No Google Maps, Street View, or other proprietary imagery or 3D assets are used.
- Code: MIT (see [LICENSE](LICENSE)). Dependencies: [three.js](https://threejs.org) (MIT), [earcut](https://github.com/mapbox/earcut) (ISC).
