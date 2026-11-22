import * as THREE from 'three';
import { findDistrict, frameId, type CityConfig, type DistrictConfig } from '../config/cities';
import { QUALITY, type QualityLevel } from '../config/quality';
import type { TimeOfDay } from '../districts/StyleConfig';
import { bakedSlug } from '../geo/BakedTiles';
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

/** State of the loading screen. */
export interface LoadState {
  /** The player has been let into the world. */
  entered: boolean;
  /** The neighbourhood is built and the player may enter. */
  ready: boolean;
  /** 0..1 */
  progress: number;
  stage: string;
}

export interface EngineOptions {
  city?: string;
  district?: string;
  time?: TimeOfDay;
  hour?: number;
  quality: QualityLevel;
  mode: DataMode;
}

/** Radius around the spawn point that must exist before the player is let in, meters. */
const READY_RADIUS = 240;

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
  private entered = false;
  private ready = false;
  private progress = 0;
  private stage = 'Starting';
  /** Endless floor under the streamed ground, so there is never a void beneath the sky. */
  private readonly floor: THREE.Mesh;
  private last = 0;
  private running = false;
  private elapsed = 0;
  // Frame statistics over a rolling window.
  private frames = 0;
  private windowTime = 0;
  private windowWorst = 0;
  private fps = 0;
  private slowTime = 0;
  /** Set when quality was lowered automatically, so the UI can say so. */
  autoLowered: QualityLevel | null = null;
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

    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(16000, 16000).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 }),
    );
    this.floor.position.y = -0.04;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);

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
    this.slowTime = 0;
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
      frameId: frameId(city, district),
      origin: district.spawn,
      style: district.style,
      mode,
      bakedUrl: new URL(`tiles/${bakedSlug(city.id, district.id)}/`, document.baseURI).href,
    });
    (this.floor.material as THREE.MeshStandardMaterial).color.setHex(district.style.ground.base);
    // Back behind the loading screen until this neighbourhood exists.
    this.entered = false;
    this.ready = false;
    this.progress = 0;
    this.stage = mode === 'demo' ? 'Generating the demo city' : 'Fetching map data';
    this.player.enabled = false;
    if (document.pointerLockElement) document.exitPointerLock();
    if (resetPlayer) {
      this.player.setFlying(false);
      this.player.teleport(0, 0, district.heading);
    }
    this.spawnPending = true;
  }

  // --- loading screen ------------------------------------------------------

  get loadState(): LoadState {
    return { entered: this.entered, ready: this.ready, progress: this.progress, stage: this.stage };
  }

  /** Let the player into the world. Only has an effect once it is ready. Call from a click to capture the pointer. */
  enter(): boolean {
    if (!this.ready) return false;
    this.entered = true;
    this.player.enabled = true;
    this.player.capturePointer();
    return true;
  }

  private updateReadiness(): void {
    if (this.ready) return;
    const p = this.player.position;
    const r = this.streamer.readiness(p.x, p.z, READY_RADIUS);
    if (r.total === 0) return;
    // A third of the bar is data arriving, the rest is the neighbourhood rising from its plan.
    const progress = 0.34 * (r.withData / r.total) + 0.16 * (r.built / r.total) + 0.5 * (r.raised / r.total);
    this.progress = Math.max(this.progress, Math.min(progress, 0.99));
    this.stage = r.withData < r.total ? (this.state.mode === 'demo' ? 'Generating the demo city' : 'Fetching map data') : 'Building streets and facades';
    if (r.raised === r.total && r.detailed && !this.spawnPending) {
      this.ready = true;
      this.progress = 1;
      this.stage = 'Ready';
    }
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
    this.streamer.loading = !this.entered;
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

    this.updateReadiness();
    this.floor.position.x = Math.round(this.player.position.x / 100) * 100;
    this.floor.position.z = Math.round(this.player.position.z / 100) * 100;

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
      // Safety net: if frames stay slow after the resolution has already been
      // reduced, step the quality level down rather than leave the user in a slideshow.
      if (this.entered && this.fps < 22) this.slowTime += this.windowTime;
      else this.slowTime = 0;
      const lower: Partial<Record<QualityLevel, QualityLevel>> = { ultra: 'high', high: 'medium', medium: 'low' };
      const next = lower[this.state.quality];
      if (this.slowTime > 5 && next && this.renderer.adaptive) {
        this.autoLowered = next;
        this.setQuality(next);
      }
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
