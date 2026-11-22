# Architecture

## Module map

```
src/
  main.ts                 boot, URL parameters
  core/
    Engine.ts             frame loop, wires subsystems, engine state
    Renderer.ts           GPU backend wrapper, dynamic resolution, render stats
    rng.ts                hashing and seeded PRNG
  config/
    cities.ts             cities, districts, spawn points
    quality.ts            quality presets: LOD ranges, shadows, caps
  districts/
    StyleConfig.ts        the structured style the engine consumes; material and pattern ids
    presets.ts            prompt-derived styles for the six districts
    StyleCompiler.ts      deterministic prompt -> StyleConfig compiler
  geo/                    (no DOM, no three.js; runs in workers and in tests)
    Coordinates.ts        lat/lon <-> local meters
    TileAddress.ts        tile and chunk addressing
    polygon.ts            area, centroid, clipping, ring stitching
    OSMProvider.ts        Overpass query, mirrors, retry
    OSMParser.ts          OSM JSON -> classified features in meters
    DemoProvider.ts       deterministic synthetic city
    TileBuilder.ts        features -> per-chunk buckets
    GeoCache.ts           IndexedDB tile cache
  world/
    types.ts              plain data shared across threads
    BuildingPlan.ts       every per-building decision (height, floors, materials, roof)
    BuildingGenerator.ts  footprint -> walls, roofs, setbacks, signs
    GroundGenerator.ts    slab, areas, road ribbons
    PropGenerator.ts      tree and lamp placement
    ChunkBuilder.ts       chunk features -> vertex buffers
    MeshWriter.ts         merged-mesh accumulator
    worker.ts             worker entry: tile loading and chunk building
    WorkerPool.ts         fixed pool, no internal queue
    Chunk.ts              GPU objects of one chunk
    WorldStreamer.ts      the streaming window
  graphics/
    shaders.ts            procedural material library (GLSL): facades, interiors, ground
    MaterialLibrary.ts    the shared materials and their uniforms
    SkyModel.ts           atmospheric scattering, on the CPU and as GLSL
    Lighting.ts           clock, sun and moon positions, derived light and haze colours, shadows
    Atmosphere.ts         scattering table, sky dome (clouds, stars, moon), environment map, fog
    PostFX.ts             HDR target, ambient occlusion, bloom, tone mapping, grade
    VehicleFactory.ts     vehicle engine: body types from specs, two levels of detail
    TreeFactory.ts        tree engine: species grown from seeds, leaf atlas, far stand-ins
    Props.ts              shared instanced geometry (lamps, light pools) and the two factories
    LODManager.ts         distance -> LOD with hysteresis
  player/
    PlayerController.ts   input, movement, cameras
    CollisionSystem.ts    circle vs. footprint walls in a spatial hash
  ui/
    Controls.ts           HUD
```

`geo/` and the generators in `world/` are pure functions over plain data. That is what makes them testable in Node, runnable in workers, and safe to re-run at any time.

## Data flow

```
player position ──► WorldStreamer.plan()
                      │  which chunks, at which LOD
                      ├──► tile missing? ──► worker: cache ▸ Overpass ▸ procedural fallback
                      │                        parse ▸ project ▸ split into chunks ──► TileData
                      └──► chunk needs (re)build? ──► worker: BuildingPlan ▸ generators ──► buffers
                                                         (transferred, zero copy)
                    applyReady() within a 4 ms/frame budget ──► Chunk (GPU) + CollisionSystem
```

## Decisions

**Tiles vs. chunks.** Network granularity and render granularity want different sizes. An 800 m tile keeps the number of Overpass requests small (the spawn view needs four); a 200 m chunk keeps LOD rings tight and disposal fine-grained.

**Ownership across seams.** Overpass returns whole ways, so neighbouring tile responses overlap. A building belongs to the chunk containing its centroid, a road segment to the chunk containing its midpoint, areas are clipped per chunk. The rule is geometric and identical on both sides of a seam, so there is no duplication and no stitching state.

**Shader facades.** A window is not geometry. Each wall is one quad carrying its length in facade bays, its height, and the building's floor height, storefront height, window pattern and material. The fragment shader draws the rest and antialiases by pixel footprint, fading every pattern to its average before it can alias. Consequences: building count barely affects triangle count; one shader program serves every building in every city; LOD transitions cannot pop facade detail, because that detail was never in the mesh.

**One ground mesh per chunk, stacked exactly.** Slab, parks, water, paving, asphalt and rail all lie on y = 0 in a single mesh and overlap freely. A depth bias cannot order them reliably: the margin needed depends on resolution and distance, and a bias large enough to be safe makes the ground bleed over objects when seen from the air. Instead the stacking is a painter's algorithm: triangles are sorted by layer in the index buffer, and the ground shader writes a depth computed from the pixel position and the ground plane alone. Every ground triangle covering a pixel computes the identical depth, so ties are exact and the later triangle wins. The cost is that the ground cannot use early depth rejection.

**Rooms behind the glass.** Each window is a recess: the view ray is followed a few centimetres into the wall to find where it meets the glass (giving a visible reveal that shifts as you move) and then on into a box room, hit analytically, with a back wall, furniture shapes, a ceiling and a floor. Rooms switch their lights as a unit. All of it is arithmetic in the facade shader.

**Light from one model.** Time of day is the position of the sun. Its colour after the atmosphere, the sky, the haze and the fill light on the street all come from the same scattering model, evaluated on the GPU into a lookup table for the sky and on the CPU for the few values the engine needs each frame. The sky is rendered once more into a cube, with a stand-in skyline and street below the horizon, and prefiltered into the environment map, so image-based lighting and reflections always match what is overhead.

**Generators, not assets.** Vehicles are specifications: a roofline, a waistline, a few dimensions. The body is that profile lofted through a cross-section with tumblehome and plan taper, with glazing and trim assigned by where a face falls on the loft. Trees are parameter sets grown from seeds. Each generator emits a near and a far form, and instances are tinted and slightly scaled.

**Pitched roofs without a straight skeleton.** A roof is a height profile across the footprint's short axis (triangle for a gable, trapezoid for a mansard). The footprint is cut along the profile's break lines so each piece is planar, lifted to the profile, and the exposed boundary edges are closed with gable walls. It works on L-shapes and irregular lots and costs a few polygon clips.

**BuildingPlan.** Height, floor fit, materials, roof and setback are decided once in `planBuilding`, seeded by the OSM id. Geometry at every LOD and the collision volume all read the same plan, so they cannot disagree.

**Never block on the network.** The streamer treats a tile as absent until it arrives. If Overpass fails after retries across mirrors, the worker substitutes deterministic procedural data for that tile, marks it `fallback`, does not cache it, and the HUD says so.

**Bounded memory.** Chunk count is bounded by range and by a hard cap per quality level; tile data is released beyond the streaming radius; CPU copies of vertex buffers are dropped after upload; the IndexedDB cache evicts oldest-first past 240 tiles.

## WebGPU path

World code talks to `core/Renderer.ts` and to three.js scene objects, never to WebGL. The custom shading is injected into three's standard material as plain GLSL math with no dependency on WebGL state. Migration means swapping `WebGLRenderer` for three's `WebGPURenderer` and re-expressing `graphics/shaders.ts` as TSL node functions; generators, streaming and collision are unaffected.

## Extending

- **New city or district:** add an entry to `config/cities.ts` with a spawn point and a style (hand-written in `presets.ts`, or `compileStyle(name, prompt)`).
- **New material:** add an id to `Mat` in `StyleConfig.ts` and a branch to `cwMaterial` in `shaders.ts`.
- **New data source (e.g. Overture):** produce `RawFeatures` and hand them to `buildTile`; nothing downstream knows where features came from.
