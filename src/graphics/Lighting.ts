import * as THREE from 'three';
import type { TimeOfDay } from '../districts/StyleConfig';
import { skyRadiance, sunTransmittance } from './SkyModel';

/**
 * Sun, moon and everything that follows from them.
 *
 * Time of day is a single number, the local solar hour. The sun's position
 * comes from real solar geometry at the district's latitude; the light that
 * reaches the street, the colour of the sky and the haze are then derived
 * from the atmosphere model (see SkyModel), not picked by hand. Dragging the
 * time slider therefore moves an actual sun across an actual sky.
 */

const RAD = Math.PI / 180;
const SHADOW_EXTENT = 130; // half-size of the shadowed square around the player, meters
/** Day of the year used for the sun's declination (late May: long days, high sun in the north). */
const DAY_OF_YEAR = 145;
/** Illuminance above the atmosphere, engine units (a sunlit white wall comes out near 1). */
const SUN_E = 4.4;
const MOON_E: [number, number, number] = [0.1, 0.12, 0.17];
/** Hours of simulated time per second while a preset is being approached. */
const SEEK_SPEED = 7;

export interface SkyPosition {
  /** Degrees above the horizon (negative below). */
  elevation: number;
  /** Degrees clockwise from north. */
  azimuth: number;
}

/** Position of a body with the given declination at a local solar hour. */
function position(latitude: number, declination: number, hour: number): SkyPosition {
  const phi = latitude * RAD;
  const dec = declination * RAD;
  const H = (hour - 12) * 15 * RAD;
  const sinEl = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinEl))) / RAD;
  const azimuth = (Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)) / RAD + 180 + 360) % 360;
  return { elevation, azimuth };
}

const DECLINATION = 23.44 * Math.sin(((2 * Math.PI) / 365) * (284 + DAY_OF_YEAR));

export function sunPosition(latitude: number, hour: number): SkyPosition {
  return position(latitude, DECLINATION, hour);
}

/** A full moon: opposite the sun in the sky. */
export function moonPosition(latitude: number, hour: number): SkyPosition {
  return position(latitude, -DECLINATION * 0.8, hour + 12);
}

/** Local solar hour for a named time of day at a latitude. */
export function presetHour(preset: TimeOfDay, latitude: number): number {
  if (preset === 'day') return 13;
  if (preset === 'night') return 23;
  // Golden hour: the afternoon moment the sun is 6.5 degrees up.
  let lo = 12;
  let hi = 23.9;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (sunPosition(latitude, mid).elevation > 6.5) lo = mid;
    else hi = mid;
  }
  return lo;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Values derived from the current time, shared with the sky, fog and materials. */
export interface LightingState {
  /** Local solar time, 0..24. */
  hour: number;
  /** Elevation of the active light source, degrees. */
  elevation: number;
  /** 1 when the active light is the moon. */
  moon: number;
  /** Illuminance of the active light above the atmosphere. */
  illuminance: THREE.Color;
  exposure: number;
  /** 0 = day, 1 = night: drives lit windows, signs and lamps. */
  night: number;
  bloom: number;
  /** Light colour at street level after the atmosphere. */
  sunColor: THREE.Color;
  /** Haze colour looking across the sun, and looking toward it. */
  fogColor: THREE.Color;
  fogSunColor: THREE.Color;
  /** Sky radiance straight up; lights cloud bases. */
  zenith: THREE.Color;
  /** Radiance of street surfaces, for the lower half of the environment. */
  ground: THREE.Color;
  /** Light pollution: the glow a city puts into its own sky. */
  glow: THREE.Color;
}

export class Lighting {
  readonly sun = new THREE.DirectionalLight();
  /** Street-level bounce from lit windows and lamps; only matters after dark. */
  readonly cityFill = new THREE.HemisphereLight();
  /** Unit vector toward the active light source. */
  readonly direction = new THREE.Vector3(0, 1, 0);
  readonly state: LightingState = {
    hour: 13, elevation: 45, moon: 0, illuminance: new THREE.Color(), exposure: 1, night: 0, bloom: 0.16,
    sunColor: new THREE.Color(), fogColor: new THREE.Color(), fogSunColor: new THREE.Color(),
    zenith: new THREE.Color(), ground: new THREE.Color(), glow: new THREE.Color(),
  };
  /** Incremented whenever the sky needs re-baking. */
  version = 0;
  /** How strongly the district lights up its own night sky, 0..1. */
  skyGlow = 0.6;
  latitude = 35;
  /** Simulated hours per real second while the day cycle is running (0 = stopped). */
  cycleSpeed = 0;

  private targetHour = 13;
  private shadowSize = 0;
  private bakedKey = '';

  constructor(scene: THREE.Scene) {
    scene.add(this.sun, this.sun.target, this.cityFill);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -SHADOW_EXTENT;
    cam.right = cam.top = SHADOW_EXTENT;
    cam.near = 1;
    cam.far = 1400;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.35;
    this.sun.shadow.radius = 2.5; // soft penumbra
  }

  /** Target hour the clock is heading for (equals the current hour once it arrives). */
  get hour(): number {
    return this.targetHour;
  }

  /** Set the time. `immediate` jumps; otherwise the clock runs there the short way round. */
  setHour(hour: number, immediate = false): void {
    this.targetHour = ((hour % 24) + 24) % 24;
    if (immediate) this.state.hour = this.targetHour;
  }

  /** 0 disables shadows. */
  setShadowMapSize(size: number): void {
    if (size === this.shadowSize) return;
    this.shadowSize = size;
    if (size > 0) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
  }

  update(dt: number, focus: THREE.Vector3): void {
    const s = this.state;
    if (this.cycleSpeed > 0) {
      this.targetHour = (this.targetHour + this.cycleSpeed * dt) % 24;
      s.hour = this.targetHour;
    } else if (s.hour !== this.targetHour) {
      const delta = ((this.targetHour - s.hour + 36) % 24) - 12;
      const step = SEEK_SPEED * dt;
      s.hour = Math.abs(delta) <= step ? this.targetHour : (s.hour + Math.sign(delta) * step + 24) % 24;
    }

    const sunPos = sunPosition(this.latitude, s.hour);
    const moonPos = moonPosition(this.latitude, s.hour);
    // The sun hands over to the moon once it is far enough down to contribute nothing.
    const useMoon = sunPos.elevation < -5;
    const body = useMoon ? moonPos : sunPos;
    const strength = useMoon ? smooth(0, 7, moonPos.elevation) : smooth(-5, 1, sunPos.elevation);
    if (useMoon) s.illuminance.setRGB(MOON_E[0] * strength, MOON_E[1] * strength, MOON_E[2] * strength);
    else s.illuminance.setRGB(SUN_E * strength, SUN_E * strength, SUN_E * strength);
    s.moon = useMoon ? 1 : 0;
    s.elevation = Math.max(body.elevation, 0.3);

    s.night = 1 - smooth(-6, 14, sunPos.elevation);
    const deepNight = 1 - smooth(-9, -1, sunPos.elevation);
    // Eyes (and cameras) open up as the light goes.
    s.exposure = 1.35 + 0.65 * (1 - smooth(3, 35, sunPos.elevation)) + 0.25 * deepNight;
    s.bloom = 0.15 + 0.4 * s.night;

    const el = s.elevation * RAD;
    const az = body.azimuth * RAD;
    // North is -Z, east is +X.
    this.direction.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));

    // Re-derive the atmosphere-dependent colours only when the inputs moved.
    const key = `${s.elevation.toFixed(2)}|${s.illuminance.g.toFixed(3)}|${s.night.toFixed(2)}|${this.skyGlow}|${s.moon}`;
    if (key !== this.bakedKey) {
      this.bakedKey = key;
      this.derive(el);
      this.version++;
    }

    this.sun.color.copy(s.sunColor);
    this.sun.intensity = 1;
    // Grazing or lunar light is too weak, and its shadows too long, to justify a shadow pass.
    this.sun.castShadow = this.shadowSize > 0 && !useMoon && sunPos.elevation > 2;
    this.cityFill.color.copy(s.glow).multiplyScalar(3);
    this.cityFill.groundColor.setRGB(0.5, 0.36, 0.22).multiplyScalar(s.night * s.night * this.skyGlow * 0.3);
    this.cityFill.intensity = 1;

    // Keep the shadow frustum centred on the player, snapped to whole texels so edges do not crawl.
    const texel = (SHADOW_EXTENT * 2) / Math.max(this.shadowSize, 1);
    const fx = Math.round(focus.x / texel) * texel;
    const fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, 0, fz);
    this.sun.position.set(fx, 0, fz).addScaledVector(this.direction, 600);
    this.sun.target.updateMatrixWorld();
  }

  private derive(el: number): void {
    const s = this.state;
    const E = s.illuminance;
    const T = sunTransmittance(el);
    s.sunColor.setRGB(E.r * T[0], E.g * T[1], E.b * T[2]);
    s.glow.setRGB(0.055, 0.04, 0.032).multiplyScalar(s.night * s.night * this.skyGlow);

    const ce = Math.cos(el);
    const se = Math.sin(el);
    // The light sits on +X in the model frame; only relative azimuth matters.
    const h = 0.05;
    const c = Math.sqrt(1 - h * h);
    const across = skyRadiance(0, h, c, ce, se, 0);
    const toward = skyRadiance(c, h, 0, ce, se, 0);
    const up = skyRadiance(0, 1, 0, ce, se, 0);
    const set = (out: THREE.Color, v: number[]) =>
      out.setRGB(v[0] * E.r + s.glow.r, v[1] * E.g + s.glow.g, v[2] * E.b + s.glow.b);
    set(s.fogColor, across);
    // The forward-scattering peak is far brighter than haze should be: keep its colour, tame its level.
    set(s.fogSunColor, toward);
    const peak = Math.max(s.fogSunColor.r, s.fogSunColor.g, s.fogSunColor.b);
    const cap = Math.max(s.fogColor.r, s.fogColor.g, s.fogColor.b) * 2.2;
    if (peak > cap && peak > 0) s.fogSunColor.multiplyScalar(cap / peak);
    set(s.zenith, up);
    // A 0.2-albedo street, half of it in shadow, plus skylight and what the city itself gives off.
    const sunlit = (0.2 * 0.5 * se) / Math.PI;
    const city = s.night * this.skyGlow;
    s.ground.setRGB(
      s.sunColor.r * sunlit + s.zenith.r * 0.35 + city * 0.012,
      s.sunColor.g * sunlit + s.zenith.g * 0.35 + city * 0.009,
      s.sunColor.b * sunlit + s.zenith.b * 0.35 + city * 0.006,
    );
  }
}
