import * as THREE from 'three';
import { findDistrict, type CityConfig, type DistrictConfig } from '../config/cities';
import { QUALITY, type QualityLevel } from '../config/quality';
import type { TimeOfDay } from '../districts/StyleConfig';
import { LocalProjection } from '../geo/Coordinates';
import { Atmosphere } from '../graphics/Atmosphere';
import { Lighting } from '../graphics/Lighting';
import { MaterialLibrary } from '../graphics/MaterialLibrary';
import { PropLibrary } from '../graphics/Props';
import { CollisionSystem } from '../player/CollisionSystem';
import { PlayerController } from '../player/PlayerController';
import { WorldStreamer, type StreamerStats } from '../world/WorldStreamer';
import { Renderer, type RenderStats } from './Renderer';

export type DataMode = 'live' | 'demo';

export interface EngineStats {
  fps: number;
  frameMs: number;
  /** Worst frame time over the last sampling window, ms. */
  worstMs: number;
  render: RenderStats;
  world: StreamerStats;
  heapMb: number | null;
  position: { x: number; z: number; lat: number; lon: number };
  colliders: number;
}

export interface EngineState {
  city: CityConfig;
  district: DistrictConfig;
  time: TimeOfDay;
  quality: QualityLevel;
  mode: DataMode;
}

/**
 * Owns the frame loop and wires the subsystems together:
 * player -> streamer -> lighting/atmosphere -> renderer.
 */
export class Engine {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.15, 6000);
  readonly renderer: Renderer;
  readonly materials = new MaterialLibrary();
  readonly props = new PropLibrary();
  readonly collision = new CollisionSystem();
  readonly lighting: Lighting;
  readonly atmosphere: Atmosphere;
  readonly streamer: WorldStreamer;
  readonly player: PlayerController;
  state: EngineState;

  private projection: LocalProjection;
  private spawnPending = true;
  private last = 0;
  private running = false;
  private elapsed = 0;
  // Frame statistics over a rolling window.
  private frames = 0;
  private windowTime = 0;
  private windowWorst = 0;
  private fps = 0;
  private frameMs = 0;
  private worstMs = 0;

  constructor(container: HTMLElement, initial: { city?: string; district?: string; time?: TimeOfDay; quality: QualityLevel; mode: DataMode }) {
    const { city, district } = findDistrict(initial.city ?? 'tokyo', initial.district);
    this.state = {
      city,
      district,
      time: initial.time ?? district.style.atmosphere.time,
      quality: initial.quality,
      mode: initial.mode,
    };
    this.projection = new LocalProjection(district.spawn);

    this.renderer = new Renderer(container);
    this.lighting = new Lighting(this.scene);
    this.atmosphere = new Atmosphere(this.scene);
    this.streamer = new WorldStreamer(this.scene, this.materials, this.props, this.collision, QUALITY[initial.quality]);
    this.player = new PlayerController(this.camera, this.renderer.canvas, this.collision, this.scene);

    this.applyQuality();
    this.lighting.setTime(this.state.time, true);
    this.loadWorld();

    const onResize = () => {
      const w = container.clientWidth || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.resize(w, h);
    };
    window.addEventListener('resize', onResize);
    onResize();
  }

  // --- configuration ------------------------------------------------------

  setLocation(cityId: string, districtId?: string): void {
    const { city, district } = findDistrict(cityId, districtId);
    this.state.city = city;
    this.state.district = district;
    // Each district arrives in its own characteristic light.
    this.state.time = district.style.atmosphere.time;
    this.lighting.setTime(this.state.time, true);
    this.loadWorld();
  }

  setTime(time: TimeOfDay): void {
    this.state.time = time;
    this.lighting.setTime(time);
  }

  setQuality(quality: QualityLevel): void {
    this.state.quality = quality;
    this.applyQuality();
  }

  setMode(mode: DataMode): void {
    if (mode === this.state.mode) return;
    this.state.mode = mode;
    this.loadWorld(false);
  }

  private applyQuality(): void {
    const q = QUALITY[this.state.quality];
    this.renderer.setMaxPixelRatio(q.maxPixelRatio);
    this.lighting.setShadowMapSize(q.shadowMapSize);
    // Shadow on/off changes the lit shader variants.
    this.materials.facade.needsUpdate = true;
    this.materials.ground.needsUpdate = true;
    this.streamer.setQuality(q);
    this.atmosphere.viewRange = q.lod2;
  }

  private loadWorld(resetPlayer = true): void {
    const { city, district, mode } = this.state;
    this.projection = new LocalProjection(district.spawn);
    this.materials.applyStyle(district.style);
    this.atmosphere.haze = district.style.atmosphere.fog;
    this.streamer.setWorld({
      // The frame id pins cached tiles to this exact origin.
      frameId: `${city.id}:${district.id}@${district.spawn.lat.toFixed(5)},${district.spawn.lon.toFixed(5)}`,
      origin: district.spawn,
      style: district.style,
      mode,
    });
    if (resetPlayer) this.player.teleport(0, 0, district.heading);
    this.spawnPending = true;
  }

  // --- loop ---------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      requestAnimationFrame(tick);
      this.frame(now);
    };
    requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
  }

  private frame(now: number): void {
    const raw = (now - this.last) / 1000;
    this.last = now;
    // After a stall (tab switch, GC) simulate at most 100 ms.
    const dt = Math.min(raw, 0.1);
    this.elapsed += dt;

    this.player.update(dt);
    this.streamer.update(dt, this.player.position, this.player.velocity, this.player.forward);

    // The spawn coordinate can land inside a footprint; once the surrounding
    // chunk has collision, move the player to the nearest open ground.
    if (this.spawnPending && this.streamer.isDetailedAt(this.player.position.x, this.player.position.z)) {
      this.spawnPending = false;
      const spot = this.collision.findOpenSpot(this.player.position.x, this.player.position.z);
      this.player.position.x = spot.x;
      this.player.position.z = spot.z;
    }

    this.lighting.update(dt, this.player.position);
    this.atmosphere.update(this.lighting, this.camera, this.materials.uniforms);
    this.materials.uniforms.uTime.value = this.elapsed;
    this.streamer.setNight(this.lighting.state.night);
    this.renderer.exposure = this.lighting.state.exposure;
    // Moonlight is too weak to justify the shadow pass.
    this.lighting.sun.castShadow = QUALITY[this.state.quality].shadowMapSize > 0 && this.lighting.state.night < 0.9;

    this.renderer.render(this.scene, this.camera);
    this.renderer.adapt(raw);

    this.frames++;
    this.windowTime += raw;
    this.windowWorst = Math.max(this.windowWorst, raw * 1000);
    if (this.windowTime >= 0.5) {
      this.fps = this.frames / this.windowTime;
      this.frameMs = (this.windowTime / this.frames) * 1000;
      this.worstMs = this.windowWorst;
      this.frames = 0;
      this.windowTime = 0;
      this.windowWorst = 0;
    }
  }

  get stats(): EngineStats {
    const p = this.player.position;
    const geo = this.projection.toGeo(p.x, p.z);
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return {
      fps: this.fps,
      frameMs: this.frameMs,
      worstMs: this.worstMs,
      render: this.renderer.stats,
      world: this.streamer.stats,
      heapMb: mem ? mem.usedJSHeapSize / 1048576 : null,
      position: { x: p.x, z: p.z, lat: geo.lat, lon: geo.lon },
      colliders: this.collision.wallCount,
    };
  }
}
