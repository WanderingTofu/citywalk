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
    shaders.ts            procedural material library (GLSL)
    MaterialLibrary.ts    the five shared materials and their uniforms
    Props.ts              shared instanced geometry
    LODManager.ts         distance -> LOD with hysteresis
    Lighting.ts           sun, sky fill, shadows, time-of-day presets
    Atmosphere.ts         sky dome, fog
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

**One ground mesh per chunk.** Slab, parks, water, paving, asphalt and rail all lie on y = 0 in a single mesh. A per-vertex layer index becomes a small constant clip-space depth bias in the vertex shader, which orders the layers without z-fighting and without one draw call per layer.

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
