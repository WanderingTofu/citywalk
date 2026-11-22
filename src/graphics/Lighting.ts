import * as THREE from 'three';
import type { TimeOfDay } from '../districts/StyleConfig';

/** Everything that changes with time of day. Colors are linear. */
export interface LightingState {
  skyTop: THREE.Color;
  skyHorizon: THREE.Color;
  sunColor: THREE.Color;
  sunIntensity: number;
  /** Degrees above the horizon / clockwise from north. */
  sunElevation: number;
  sunAzimuth: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  fogColor: THREE.Color;
  /** Multiplier on the range-derived fog density. */
  fog: number;
  exposure: number;
  /** 0 = day, 1 = night: drives emissive windows, signs and lamps. */
  night: number;
}

const c = (r: number, g: number, b: number) => new THREE.Color(r, g, b);

export const LIGHTING_PRESETS: Record<TimeOfDay, LightingState> = {
  day: {
    skyTop: c(0.16, 0.34, 0.72),
    skyHorizon: c(0.6, 0.73, 0.88),
    sunColor: c(1, 0.95, 0.88),
    sunIntensity: 3.2,
    sunElevation: 50,
    sunAzimuth: 145,
    hemiSky: c(0.55, 0.7, 1),
    hemiGround: c(0.36, 0.33, 0.3),
    hemiIntensity: 1.15,
    fogColor: c(0.62, 0.74, 0.88),
    fog: 1,
    exposure: 0.85,
    night: 0,
  },
  golden: {
    skyTop: c(0.17, 0.25, 0.5),
    skyHorizon: c(0.95, 0.5, 0.24),
    sunColor: c(1, 0.5, 0.22),
    sunIntensity: 3.4,
    sunElevation: 9,
    sunAzimuth: 255,
    hemiSky: c(0.6, 0.55, 0.7),
    hemiGround: c(0.42, 0.3, 0.22),
    hemiIntensity: 1.35,
    fogColor: c(0.72, 0.45, 0.3),
    fog: 1.15,
    exposure: 1.05,
    night: 0.4,
  },
  night: {
    skyTop: c(0.004, 0.008, 0.024),
    skyHorizon: c(0.07, 0.055, 0.075),
    sunColor: c(0.5, 0.62, 0.95),
    sunIntensity: 0.3,
    sunElevation: 42,
    sunAzimuth: 35,
    hemiSky: c(0.14, 0.18, 0.36),
    hemiGround: c(0.16, 0.12, 0.1),
    hemiIntensity: 0.95,
    fogColor: c(0.055, 0.045, 0.065),
    fog: 1.05,
    exposure: 1.15,
    night: 1,
  },
};

function cloneState(s: LightingState): LightingState {
  return {
    ...s,
    skyTop: s.skyTop.clone(),
    skyHorizon: s.skyHorizon.clone(),
    sunColor: s.sunColor.clone(),
    hemiSky: s.hemiSky.clone(),
    hemiGround: s.hemiGround.clone(),
    fogColor: s.fogColor.clone(),
  };
}

const SHADOW_EXTENT = 130; // half-size of the shadowed square around the player, meters

/**
 * Sun/moon, sky fill and shadows. Presets are blended over a short time so
 * switching time of day is a transition rather than a cut.
 */
export class Lighting {
  readonly sun = new THREE.DirectionalLight();
  readonly hemi = new THREE.HemisphereLight();
  /** Current (possibly mid-transition) state; read by Atmosphere and the materials. */
  readonly state: LightingState = cloneState(LIGHTING_PRESETS.day);
  readonly sunDirection = new THREE.Vector3(0, 1, 0);
  private target: LightingState = LIGHTING_PRESETS.day;
  private shadowSize = 0;

  constructor(scene: THREE.Scene) {
    scene.add(this.sun, this.sun.target, this.hemi);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -SHADOW_EXTENT;
    cam.right = cam.top = SHADOW_EXTENT;
    cam.near = 1;
    cam.far = 1400;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.35;
  }

  setTime(time: TimeOfDay, immediate = false): void {
    this.target = LIGHTING_PRESETS[time];
    if (immediate) Object.assign(this.state, cloneState(this.target));
  }

  /** 0 disables shadows. Returns true when the renderer must rebuild its shadow state. */
  setShadowMapSize(size: number): boolean {
    if (size === this.shadowSize) return false;
    this.shadowSize = size;
    this.sun.castShadow = size > 0;
    if (size > 0) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    return true;
  }

  update(dt: number, focus: THREE.Vector3): void {
    const s = this.state;
    const t = this.target;
    const k = 1 - Math.exp(-dt * 2.2);
    s.skyTop.lerp(t.skyTop, k);
    s.skyHorizon.lerp(t.skyHorizon, k);
    s.sunColor.lerp(t.sunColor, k);
    s.hemiSky.lerp(t.hemiSky, k);
    s.hemiGround.lerp(t.hemiGround, k);
    s.fogColor.lerp(t.fogColor, k);
    s.sunIntensity += (t.sunIntensity - s.sunIntensity) * k;
    s.sunElevation += (t.sunElevation - s.sunElevation) * k;
    // Shortest way round for the azimuth.
    const dAz = ((t.sunAzimuth - s.sunAzimuth + 540) % 360) - 180;
    s.sunAzimuth += dAz * k;
    s.hemiIntensity += (t.hemiIntensity - s.hemiIntensity) * k;
    s.fog += (t.fog - s.fog) * k;
    s.exposure += (t.exposure - s.exposure) * k;
    s.night += (t.night - s.night) * k;

    const el = (s.sunElevation * Math.PI) / 180;
    const az = (s.sunAzimuth * Math.PI) / 180;
    // North is -Z, east is +X.
    this.sunDirection.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));

    this.sun.color.copy(s.sunColor);
    this.sun.intensity = s.sunIntensity;
    this.hemi.color.copy(s.hemiSky);
    this.hemi.groundColor.copy(s.hemiGround);
    this.hemi.intensity = s.hemiIntensity;

    // Keep the shadow frustum centred on the player, snapped to whole texels
    // (in light space) so shadow edges do not crawl as the player moves.
    const texel = (SHADOW_EXTENT * 2) / Math.max(this.shadowSize, 1);
    const fx = Math.round(focus.x / texel) * texel;
    const fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, 0, fz);
    this.sun.position.set(fx, 0, fz).addScaledVector(this.sunDirection, 600);
    this.sun.target.updateMatrixWorld();
  }
}
