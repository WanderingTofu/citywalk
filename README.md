# CITYWALK

**One lightweight engine. Real-world geography. Unlimited walkable cities.**

CITYWALK is a browser engine for walking, and flying, through real cities. Streets, building footprints, parks and waterways come from OpenStreetMap. Everything you see on top of that geography (facades, windows, rooms behind them, roofs, materials, trees, parked cars, sky and light) is generated procedurally from a per-district style, so the browser downloads the *ability to generate* a city, not the city.

The architecture is an interpretation, not a reconstruction: footprints and street layout are real; heights are real where OSM has them and estimated by district rules where it does not; facades are never a claim about what a specific building looks like.

Cities: Tokyo (Shibuya), Paris (Le Marais), New York (Manhattan), Bangkok (Sukhumvit), Los Angeles (Downtown), Kyoto (Gion), Chicago (The Loop).

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
| `W` `A` `S` `D` | Move |
| Mouse | Look (click the view to capture the pointer) |
| `Shift` | Sprint, or fly fast |
| `Space` | Jump |
| `F` | Drone: fly anywhere, thread streets, land on roofs |
| `E` / `Q` | Up / down while flying |
| `V` | First / third person |
| `Esc` | Release the pointer |

The **time slider** moves the sun and moon across the sky for that city's latitude; *Run day* lets the day pass by itself.

### URL parameters

`?city=kyoto&district=gion&time=night&quality=high` takes any of `city`, `district`, `time` (`day`, `golden`, `night`), `hour` (0-24, overrides `time`) and `quality` (`low`, `medium`, `high`, `ultra`). `&demo=1` uses the offline demo city; `&res=fixed` pins the render resolution for benchmarks.

## Deploy

The build is a static bundle in `dist/` with relative asset paths, so it runs from any static host or sub-path.

- **Netlify** (current): `netlify.toml` sets the build command (`npm run build`), the publish directory (`dist`) and Node 22. Every push to `main` deploys.
- **GitHub Pages** (optional): set the repository variable `DEPLOY_PAGES` to `true` and, under **Settings → Pages**, set **Source** to **GitHub Actions**.

`.github/workflows/ci.yml` runs typecheck, tests and the build on every push and pull request.

### Baking city plans

```bash
npm run bake                          # every district, 3.2 km square around its spawn point
```

```bash
npm run bake -- --city tokyo --radius 3 --force
```

The **Bake map tiles** workflow (Actions tab → Run workflow) does the same on GitHub's runners and commits the result, which triggers a deploy. It also refreshes monthly. A district with no baked tiles still works: it loads live from Overpass, and falls back to a labelled procedural stand-in if Overpass does not answer.

## How it works

- **Coordinates.** Each district has a local tangent-plane frame in meters anchored at its spawn point (+X east, +Z south).
- **Blueprint, then 3D.** A city's plan (roads, footprints, parks, water) is *baked*: fetched from OpenStreetMap once, processed, and committed as small static tiles under `public/tiles/` that are served with the app. Opening a city reads its plan from the same host in one round trip. The 3D city is then raised from that plan: first the streets around you at full detail, then the flat blueprint laid out in every direction, then buildings rising outward from where you stand. Beyond the baked area, tiles are fetched live from Overpass (hedged across mirrors, with short timeouts) and cached in IndexedDB.
- **Loading screen.** Nobody is dropped into an empty world: a progress bar tracks the data arriving and the neighbourhood being built, and the way in only opens once the streets around the spawn point exist, with collision.
- **Two-level grid.** *Tiles* (800 m) are the unit of data: one file or request, one cache record. *Chunks* (200 m) are the unit of rendering, LOD and disposal. Addresses are pure functions of position.
- **The detail bubble.** Each chunk's level of detail comes from its distance to the camera and to where the camera will be in 2.5 s. Height counts as distance (a drone high up sees a coarser city), and what is behind the camera counts as further away than what is in front. Chunks are generated in Web Workers in priority order, finished buffers are handed to the GPU within a per-frame time budget, and anything out of range is disposed. An endless floor sits under everything, so there is never a void beneath the sky.
- **LOD.** Full detail with collision, grown trees, typed vehicles, awnings and signs → simplified trees and vehicle silhouettes → skyline (outer rings, flat caps, small structures dropped) → blueprint (roads and flat footprints) → unloaded. In the shaders, every pattern fades to its average before it can alias, so detail also falls off per pixel.
- **One material for all buildings.** Walls, roofs, awnings and signs share one PBR material. Recessed windows with real parallax, rooms behind the glass (interior mapping), blinds, sills, balcony ironwork, storefronts, brick, stone, wood, tile and weathering are evaluated per pixel from a few vertex attributes. No facade textures are downloaded.
- **One mesh for all ground.** Slab, parks, water, paving with kerbs, asphalt with markings, cracks, patches, manholes and puddles, and rail are one draw call per chunk. Overlapping layers are stacked by a painter's algorithm made exact by computing each ground pixel's depth analytically from the ground plane.
- **Light from the sky.** The sun and moon follow solar geometry at the district's latitude. An atmospheric scattering model gives the sky, the colour of sunlight and the haze; the sky (with clouds, stars and moon) is baked into the environment map that lights and reflects in every surface. Rendering is HDR with ambient occlusion, bloom, AgX tone mapping and a final grade.
- **Generators.** A vehicle engine lofts ten body types from side profiles at two levels of detail and paints them per instance. A tree engine grows four species from seeded branching skeletons with leaf cards. Both are instanced.
- **Styles.** Each district has a plain-language prompt and a structured `StyleConfig` derived from it. The engine only reads the structured form. `StyleCompiler` is a deterministic keyword compiler and the seam where an AI compiler can plug in.
- **Determinism.** All variation is seeded by OSM ids and chunk addresses, so a place generates identically on every visit and every machine.

More detail: [docs/architecture.md](docs/architecture.md).

## Status

Implemented and exercised by unit tests or headless-browser runs:

- OSM pipeline: Overpass query, parsing (ways, multipolygon relations with courtyards, roads, paths, rail, waterways, parks, water, plazas, mapped trees), building-use classification, projection, chunk assignment, IndexedDB cache with eviction.
- Baked city plans served as static tiles; hedged Overpass requests with benching of failed mirrors beyond them; procedural fallback, labelled in the UI.
- Loading screen gated on the spawn neighbourhood being built; blueprint-first streaming; automatic quality step-down when frames run slow.
- Deterministic offline demo city (`?demo=1`).
- Buildings from real footprints: holes, estimated heights, flat / gable / mansard roofs, parapets, tower setbacks, rooftop plant, awnings, blade signs.
- Streaming with predictive loading, view-cone and altitude-aware LOD, hysteresis, disposal, bounded chunk and tile counts.
- Walking with wall-sliding collision, sprint, jump, third person; drone flight with roof landing.
- Continuous time of day with real sun and moon positions, shadows, physically based sky, clouds, stars, image-based lighting, HDR post-processing.
- Vehicle and tree generators; kerbside parking; street lamps with light pools.
- Seven cities with distinct district styles.
- HUD: selectors, clock, FPS and frame time, draw calls, triangles, chunks per LOD, tiles, queue, GPU geometries, JS heap, render scale; dynamic resolution.

### How it has been verified, and what has not

- **Real geography.** The public Overpass servers were unreachable from the development sandbox, so the live path was verified against a mocked Overpass and against real OSM-derived Chicago footprints and roads (from the CS2 OSM Toolkit, below) served in Overpass's response format. Chicago's baked tiles come from that extract: footprints with classified use and roads by class, without heights. Other districts are baked from Overpass by the workflow above.
- **Performance.** Development ran in headless Chromium on a software rasterizer. That validates correctness and bounded resource use but says nothing about GPU frame rates, so **the 60 FPS desktop / 30 FPS mobile targets are unverified**. The HUD measures frame time, worst frame, draw calls and memory live. The ground and facade shaders are heavy; `low` quality turns off post-processing and shadows.
- **Visual fidelity.** This is a long way from photorealism. Lighting and surfaces are physically motivated; geometry is still mostly extruded footprints.

### Not done yet

- **Terrain elevation.** The world is flat at y = 0.
- **`building:part`, roof tags, landmarks.** Complex buildings are extruded from their outline only.
- **Large river polygons.** Rivers are drawn from their centerline with a tagged or default width.
- **District blending.** One district per city; cross-fading neighbouring styles is not implemented.
- **Volumetric clouds, cloud shadows, sun shafts, rain.**
- **Moving traffic, pedestrians, interiors, multiplayer** (Milestone 5). Parked vehicles have no collision.
- **Touch controls.**
- **WebGPU backend.** Rendering goes through three.js' WebGL2 renderer behind `core/Renderer.ts`.

Initial download is about 190 kB gzipped (three.js is most of it).

## Data, credits and licenses

- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/). The attribution is shown in the app at all times and must be kept in any deployment.
- Data is fetched from public [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) instances, which are shared community infrastructure. CITYWALK caches every tile locally and limits itself to two concurrent requests; for a high-traffic deployment, run your own Overpass instance or pre-bake tiles and change `OVERPASS_ENDPOINTS` in `src/geo/OSMProvider.ts`.
- No Google Maps, Street View, or other proprietary imagery or 3D assets are used.
- Code: MIT (see [LICENSE](LICENSE)). Dependencies: [three.js](https://threejs.org) (MIT), [earcut](https://github.com/mapbox/earcut) (ISC).

Techniques were learned from these projects; no code was copied from the ones whose licenses would not allow it:

| Project | License | What it informed |
|---|---|---|
| [Noniv/atlantis](https://github.com/Noniv/atlantis), [Noniv/web-ocean](https://github.com/Noniv/web-ocean) | MIT | Atmosphere lookup table, flat cloud layers with footprint-filtered noise, sky → environment lighting, AgX and grade |
| [netanelyan/outbound](https://github.com/netanelyan/outbound) | MIT | Vehicle bodies as side profiles lofted through a cross-section; clearcoat paint |
| [dgreenheck/ez-tree](https://github.com/dgreenheck/ez-tree) | MIT | Tree skeletons from branch levels, angles, gnarliness and leaf cards |
| [Osyanne/CitiesSkylines2-osm-toolkit](https://github.com/Osyanne/CitiesSkylines2-osm-toolkit) | MIT | Classifying building use from OSM tags; real Chicago data for testing |
| [Fishypants/cloudscape](https://github.com/Fishypants/cloudscape) | MIT | Reference for volumetric clouds and sun shafts (not implemented yet) |
| [vitaminclaude/voidstruck](https://github.com/vitaminclaude/voidstruck) | source-available | Ideas only: hashed star fields, Milky Way band |
| [reneodlt/civitas](https://github.com/reneodlt/civitas) | AGPL-3.0 | Ideas only: buildings and landmarks as data recipes |
