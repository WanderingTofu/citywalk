import * as THREE from 'three';
import { findDistrict, type CityConfig, type DistrictConfig } from '../config/cities';
import { QUALITY, type QualityLevel } from '../config/quality';
import type { TimeOfDay } from '../districts/StyleConfig';
import { LocalProjection } from '../geo/Coordinates';
import { Atmosphere } from '../graphics/Atmosphere';
import { Lighting, presetHour } from '../graphics/Lighting';
import { MaterialLibrary } from '../graphics/MaterialLibrary';
import { PropLibrary } from '../graphics/Props';
import { CollisionSystem } from '../player/CollisionSystem';
import { PlayerController } from '../player/PlayerController';
import { WorldStreamer, type StreamerStats } from '../world/WorldStreamer';
import { Renderer, type RenderStats } from './Renderer';

export type DataMode = 'live' | 'demo';
/** A named time of day, or 'custom' once the clock has been set by hand. */
export type TimeSetting = TimeOfDay | 'custom';

export interface EngineStats {
  fps: number;
  frameMs: number;
  /** Worst frame time over the last sampling window, ms. */
  worstMs: number;
  render: RenderStats;
  world: StreamerStats;
  heapMb: number | null;
  position: { x: number; z: number; lat: number; lon: number; altitude: number };
  colliders: number;
  /** Local solar time being displayed, 0..24. */
  hour: number;
  flying: boolean;
}

export interface EngineState {
  city: CityConfig;
  district: DistrictConfig;
  time: TimeSetting;
  quality: QualityLevel;
  mode: DataMode;
  /** The day is running by itself. */
  cycle: boolean;
}

export interface EngineOptions {
  city?: string;
  district?: string;
  time?: TimeOfDay;
  hour?: number;
  quality: QualityLevel;
  mode: DataMode;
}

/** Simulated hours per real second while the day cycle runs: a full day in four minutes. */
const CYCLE_SPEED = 0.1;

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

  constructor(container: HTMLElement, initial: EngineOptions) {
    const { city, district } = findDistrict(initial.city ?? 'tokyo', initial.district);
    this.state = {
      city,
      district,
      time: initial.hour !== undefined ? 'custom' : (initial.time ?? district.style.atmosphere.time),
      quality: initial.quality,
      mode: initial.mode,
      cycle: false,
    };
    this.projection = new LocalProjection(district.spawn);

    this.renderer = new Renderer(container);
    this.lighting = new Lighting(this.scene);
    this.atmosphere = new Atmosphere(this.scene, this.renderer.three);
    this.streamer = new WorldStreamer(this.scene, this.materials, this.props, this.collision, QUALITY[initial.quality]);
    this.player = new PlayerController(this.camera, this.renderer.canvas, this.collision, this.scene);

    this.applyQuality();
    this.loadWorld();
    this.lighting.setHour(initial.hour ?? presetHour(this.state.time as TimeOfDay, district.spawn.lat), true);

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
    this.loadWorld();
    // Each district arrives in its own characteristic light.
    this.state.time = district.style.atmosphere.time;
    this.lighting.setHour(presetHour(district.style.atmosphere.time, district.spawn.lat), true);
  }

  /** Jump to a named time of day; the clock runs there so the light changes as a time-lapse. */
  setTime(time: TimeOfDay): void {
    this.state.time = time;
    this.lighting.setHour(presetHour(time, this.state.district.spawn.lat));
  }

  /** Set the clock directly (local solar hours, 0..24). */
  setHour(hour: number): void {
    this.state.time = 'custom';
    this.lighting.setHour(hour, true);
  }

  /** Let the day run by itself, or stop it where it is. */
  setCycle(on: boolean): void {
    this.state.cycle = on;
    if (on) this.state.time = 'custom';
    this.lighting.cycleSpeed = on ? CYCLE_SPEED : 0;
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
    this.renderer.setPostProcessing(q.post, q.ao);
    this.lighting.setShadowMapSize(q.shadowMapSize);
    this.streamer.setQuality(q);
    this.atmosphere.viewRange = q.lod2;
  }

  private loadWorld(resetPlayer = true): void {
    const { city, district, mode } = this.state;
    const a = district.style.atmosphere;
    this.projection = new LocalProjection(district.spawn);
    this.materials.applyStyle(district.style);
    this.atmosphere.haze = a.fog;
    this.atmosphere.clouds = a.clouds;
    this.atmosphere.skyline = a.enclosure;
    this.lighting.skyGlow = a.skyGlow;
    this.lighting.latitude = district.spawn.lat;
    this.streamer.setWorld({
      // The frame id pins cached tiles to this exact origin.
      frameId: `${city.id}:${district.id}@${district.spawn.lat.toFixed(5)},${district.spawn.lon.toFixed(5)}`,
      origin: district.spawn,
      style: district.style,
      mode,
    });
    if (resetPlayer) {
      this.player.setFlying(false);
      this.player.teleport(0, 0, district.heading);
    }
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
    this.renderer.beginFrame();

    this.player.update(dt);
    this.streamer.update(dt, this.player.position, this.player.velocity, this.player.forward);

    // The spawn coordinate can land inside a footprint; once the surrounding
    // chunk has collision, move the player to the nearest open ground.
    if (this.spawnPending && this.streamer.isDetailedAt(this.player.position.x, this.player.position.z)) {
      this.spawnPending = false;
      if (!this.player.flying) {
        const spot = this.collision.findOpenSpot(this.player.position.x, this.player.position.z);
        this.player.position.x = spot.x;
        this.player.position.z = spot.z;
      }
    }

    this.lighting.update(dt, this.player.position);
    this.atmosphere.update(dt, this.elapsed, this.lighting, this.camera, this.materials.uniforms, this.renderer.drawingHeight);
    this.materials.uniforms.uTime.value = this.elapsed;
    this.camera.updateMatrixWorld();
    this.materials.setCamera(this.camera, this.renderer.drawingWidth, this.renderer.drawingHeight);
    this.streamer.setNight(this.lighting.state.night);
    this.renderer.exposure = this.lighting.state.exposure;
    this.renderer.bloom = this.lighting.state.bloom;

    this.renderer.render(this.scene, this.camera, dt);
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
      position: { x: p.x, z: p.z, lat: geo.lat, lon: geo.lon, altitude: this.player.altitude },
      colliders: this.collision.wallCount,
      hour: this.lighting.state.hour,
      flying: this.player.flying,
    };
  }
}
