import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import type { Lighting } from './Lighting';
import type { SharedUniforms } from './MaterialLibrary';
import { SKY_LUT_HEIGHT, SKY_LUT_WIDTH, SKY_SCATTER_GLSL } from './SkyModel';

/**
 * Sky, clouds, stars, fog and environment lighting.
 *
 * Pipeline (the shape used by Noniv/atlantis and web-ocean, in WebGL2):
 *   1. Atmospheric scattering is baked into a small lookup table whenever the
 *      light source moves.
 *   2. The sky dome samples that table and adds the sun or moon, a flat cloud
 *      layer whose noise octaves fade out below pixel size, and at night a
 *      hashed star field with a Milky Way band.
 *   3. The same sky, plus a stand-in skyline and street, is rendered into a
 *      cube and prefiltered into the scene's environment map, so every
 *      surface is lit by, and reflects, the sky that is actually on screen.
 */

const SKY_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SKY_FRAGMENT = /* glsl */ `
uniform sampler2D tSky;
uniform vec3 uSunDir;
uniform vec3 uSunE;
uniform vec3 uSunColor;
uniform vec3 uGlow;
uniform vec3 uZenith;
uniform vec3 uGround;
uniform float uNight;
uniform float uMoon;
uniform float uTime;
uniform float uClouds;
uniform float uSkyline;
uniform float uSkyGlow;
uniform float uPix;
uniform vec2 uDrift;
varying vec3 vDir;

float h21(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float h31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
// Gradient noise, roughly -0.7..0.7.
float gnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = h21(i) * 6.2831853, b = h21(i + vec2(1.0, 0.0)) * 6.2831853;
  float c = h21(i + vec2(0.0, 1.0)) * 6.2831853, d = h21(i + vec2(1.0, 1.0)) * 6.2831853;
  return mix(mix(dot(vec2(cos(a), sin(a)), f), dot(vec2(cos(b), sin(b)), f - vec2(1.0, 0.0)), u.x),
             mix(dot(vec2(cos(c), sin(c)), f - vec2(0.0, 1.0)), dot(vec2(cos(d), sin(d)), f - vec2(1.0, 1.0)), u.x), u.y);
}
// fbm whose octaves fade once they are smaller than the pixel footprint fp, so
// distant cloud never shimmers; small octaves are billowed for cauliflower edges.
float cloudFbm(vec2 p, float fp, int oct) {
  float s = 0.0, a = 0.5, f = 1.0;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    float w = 1.0 - smoothstep(0.1, 0.35, fp * f);
    float n = gnoise(p);
    if (i >= 2) n = mix(n, abs(n) * 2.0 - 0.38, 0.4);
    s += a * n * w;
    p = rot * p * 2.03 + vec2(13.1, 7.7);
    f *= 2.03;
    a *= 0.5;
  }
  return s;
}
float cloudEdge(vec2 q, float fp, int oct) {
  vec2 w = vec2(gnoise(q * 0.3 + vec2(1.7, 9.2)), gnoise(q * 0.3 + vec2(8.3, 2.8)));
  float base = cloudFbm((q + w * 1.3) * vec2(1.0, 1.5), fp, oct) * 1.35 + 0.5;
  return base + gnoise(q * 0.07 + vec2(3.1, 1.3)) * 0.6 - (1.0 - uClouds);
}

vec3 atmosphere(vec3 d) {
  float el = asin(clamp(d.y, 0.0, 1.0));
  float az = atan(d.z, d.x) - atan(uSunDir.z, uSunDir.x);
  vec2 uv = vec2(az / 6.2831853 + 0.5, clamp(sqrt(el / 1.5707963), 0.006, 0.994));
  vec3 c = texture2D(tSky, uv).rgb * uSunE;
  // Light pollution: the city lights its own haze, strongest toward the horizon.
  return c + uGlow * (0.3 + 0.7 * pow(1.0 - max(d.y, 0.0), 5.0));
}

// Hashed star field: one candidate star per cell.
vec3 starLayer(vec3 d, float scale, float density, float size) {
  vec3 p = d * scale;
  vec3 id = floor(p);
  float r = h31(id);
  if (r > density) return vec3(0.0);
  vec3 c = id + 0.25 + 0.5 * vec3(h31(id + 11.1), h31(id + 23.7), h31(id + 37.3));
  float dist = length(p - c) / scale;                 // radians from the star
  float px = max(uPix, 1e-5) * size;
  float core = exp(-dist * dist / (px * px));
  // Magnitudes follow a steep power law: a few bright stars, many faint ones.
  float mag = pow(1.0 - r / density, 6.0) * 1.1 + 0.05;
  float temp = h31(id + 51.9);
  vec3 col = mix(vec3(1.0, 0.72, 0.5), vec3(0.72, 0.82, 1.0), smoothstep(0.15, 0.85, temp));
  float twinkle = 0.8 + 0.2 * sin(uTime * (2.0 + 5.0 * temp) + r * 600.0);
  return col * core * mag * twinkle;
}
vec3 stars(vec3 d) {
  // The Milky Way: a tilted great circle of unresolved glow and extra faint stars.
  vec3 gn = normalize(vec3(0.45, 0.62, 0.64));
  vec3 gx = normalize(cross(gn, vec3(0.0, 1.0, 0.0)));
  float lat = dot(d, gn);
  float band = exp(-lat * lat * 10.0);
  vec2 gp = vec2(atan(dot(d, gx), dot(d, cross(gn, gx))), lat) * 5.0;
  float dust = 0.5 + gnoise(gp * 1.3) + 0.5 * gnoise(gp * 3.1 + 4.0);
  vec3 col = vec3(0.04, 0.045, 0.065) * band * max(dust, 0.0);
  col += starLayer(d, 70.0, 0.04, 1.1);
  col += starLayer(d, 190.0, 0.02 + 0.06 * band, 0.9) * 0.6;
  // City glow and the thick air near the horizon wash the stars out.
  return col * smoothstep(0.02, 0.4, d.y) * (1.0 - 0.8 * uSkyGlow);
}

void main() {
  vec3 d = normalize(vDir);
  vec3 sky = atmosphere(vec3(d.x, max(d.y, 0.0), d.z));
  float mu = dot(d, uSunDir);
  float sunVis = 1.0;

  #ifndef SKY_ENV
    sky += stars(d) * smoothstep(0.55, 1.0, uNight);
  #endif

  // --- clouds ---------------------------------------------------------
  if (d.y > 0.012 && uClouds > 0.01) {
    float t = 1900.0 / (d.y + 0.07);
    vec2 q = (d.xz * t + uDrift) / 2500.0;
    float fp = t * uPix / max(d.y, 0.06) / 2500.0;
    float e = cloudEdge(q, fp, 6);
    if (e > 0.0) {
      float dn = clamp(e / (0.34 + min(fp, 1.0) * 0.3), 0.0, 1.0);
      // Density a little way toward the sun: where it falls off, that side is lit.
      vec2 sdir = normalize(uSunDir.xz + vec2(1e-4)) * 0.11;
      float e2 = cloudEdge(q + sdir, fp, 4);
      float lit = clamp(0.5 + (e - e2) * 3.2, 0.0, 1.0) * (1.0 - 0.4 * dn) + 0.25;
      vec3 warm = uSunColor * (0.13 + 0.45 * pow(max(mu, 0.0), 6.0));
      vec3 cool = uZenith * 1.5 + uGlow * 2.2;        // bases are lit by the sky, and by the city at night
      vec3 col = mix(cool, warm + cool * 0.6, lit);
      // Silver lining where thin cloud sits in front of the sun.
      col += uSunColor * pow(max(mu, 0.0), 32.0) * dn * (1.0 - dn) * 2.5;
      float far = exp(-t / 22000.0);
      float a = dn * 0.95 * far * smoothstep(0.012, 0.06, d.y);
      #ifndef SKY_ENV
        a *= smoothstep(0.0, fwidth(e) * 1.5 + 1e-5, e);   // analytic edge antialiasing
      #endif
      sky = mix(sky, col, a);
      sunVis = 1.0 - a;
    }
  }

  #ifndef SKY_ENV
    // --- sun or moon ---------------------------------------------------
    float ang = acos(clamp(mu, -1.0, 1.0));
    if (uMoon < 0.5) {
      float disc = 1.0 - smoothstep(0.0085, 0.0105, ang);
      vec3 glare = uSunColor * (pow(max(mu, 0.0), 3500.0) * 2.0 + pow(max(mu, 0.0), 500.0) * 0.3 + pow(max(mu, 0.0), 60.0) * 0.03);
      sky += (min(uSunColor * 40.0, vec3(60.0)) * disc + glare) * sunVis;
    } else {
      const float R = 0.014;
      if (ang < R * 1.02) {
        // A lit sphere with maria, seen full.
        vec3 ax = normalize(cross(uSunDir, vec3(0.0, 1.0, 0.0)));
        vec3 ay = cross(ax, uSunDir);
        vec2 mp = vec2(dot(d, ax), dot(d, ay)) / R;
        float rr = dot(mp, mp);
        float limb = sqrt(max(1.0 - rr, 0.0));
        float maria = smoothstep(-0.25, 0.35, gnoise(mp * 2.3 + 3.7) + 0.5 * gnoise(mp * 5.1));
        vec3 moon = vec3(0.95, 0.93, 0.86) * (0.55 + 0.45 * maria) * (0.35 + 0.65 * limb) * 1.6;
        sky = mix(sky, moon, (1.0 - smoothstep(0.96, 1.02, sqrt(rr))) * sunVis * uNight);
      }
      sky += vec3(0.55, 0.62, 0.8) * (pow(max(mu, 0.0), 900.0) * 0.25 + pow(max(mu, 0.0), 80.0) * 0.02) * sunVis * uNight;
    }
  #else
    // --- what the environment sees below the sky: skyline and street ------
    float az2 = atan(d.z, d.x);
    float tower = h21(vec2(floor(az2 * 13.0), 3.0)) * (0.4 + 0.6 * h21(vec2(floor(az2 * 4.0), 9.0)));
    float line = uSkyline * (0.05 + 0.34 * tower);
    vec3 walls = uGround * 0.7 + uSunColor * 0.035 + uGlow * 4.0;      // facades, part sunlit, lit windows after dark
    sky = mix(walls, sky, smoothstep(line - 0.03, line + 0.03, d.y));
    sky = mix(uGround, sky, smoothstep(-0.06, 0.0, d.y));
  #endif

  gl_FragColor = vec4(sky, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const LUT_FRAGMENT = /* glsl */ `
uniform float uElevation;
varying vec2 vUv;
${SKY_SCATTER_GLSL}
void main() {
  float az = (vUv.x - 0.5) * 6.2831853;
  float el = vUv.y * vUv.y * 1.5707963;
  vec3 rd = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
  vec3 sd = vec3(cos(uElevation), sin(uElevation), 0.0);
  gl_FragColor = vec4(cwSkyScatter(rd, sd), 1.0);
}`;

/** Minimum seconds between environment re-bakes while the light is changing. */
const ENV_INTERVAL = 0.35;

export class Atmosphere {
  readonly fog = new THREE.FogExp2(0xffffff, 0.001);
  /** District haze, 0..1. */
  haze = 0.5;
  /** Cloud cover, 0..1. */
  clouds = 0.4;
  /** How much of the horizon the surrounding buildings block, 0..1. */
  skyline = 0.5;
  /** Farthest distance at which geometry exists, meters. */
  viewRange = 1000;

  private readonly uniforms = {
    tSky: { value: null as THREE.Texture | null },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunE: { value: new THREE.Color() },
    uSunColor: { value: new THREE.Color() },
    uGlow: { value: new THREE.Color() },
    uZenith: { value: new THREE.Color() },
    uGround: { value: new THREE.Color() },
    uNight: { value: 0 },
    uMoon: { value: 0 },
    uTime: { value: 0 },
    uClouds: { value: 0.4 },
    uSkyline: { value: 0.5 },
    uSkyGlow: { value: 0.5 },
    uPix: { value: 0.001 },
    uDrift: { value: new THREE.Vector2() },
  };
  private readonly lut: THREE.WebGLRenderTarget;
  private readonly lutQuad: FullScreenQuad;
  private readonly dome: THREE.Mesh;
  private readonly envScene = new THREE.Scene();
  private readonly pmrem: THREE.PMREMGenerator;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private bakedVersion = -1;
  private bakedElevation = -999;
  private envDirty = true;
  private envTimer = 0;
  private settings = '';

  constructor(
    private readonly scene: THREE.Scene,
    private readonly renderer: THREE.WebGLRenderer,
  ) {
    scene.fog = this.fog;
    this.lut = new THREE.WebGLRenderTarget(SKY_LUT_WIDTH, SKY_LUT_HEIGHT, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      generateMipmaps: false,
    });
    this.uniforms.tSky.value = this.lut.texture;
    this.lutQuad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: { uElevation: { value: 0.8 } },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: LUT_FRAGMENT,
        depthTest: false,
        depthWrite: false,
      }),
    );

    const geometry = new THREE.SphereGeometry(1000, 48, 24);
    const material = (env: boolean, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({
        name: env ? 'cw-sky-env' : 'cw-sky',
        uniforms,
        defines: env ? { SKY_ENV: 1 } : {},
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
        vertexShader: SKY_VERTEX,
        fragmentShader: SKY_FRAGMENT,
      });
    this.dome = new THREE.Mesh(geometry, material(false, this.uniforms));
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    this.dome.matrixAutoUpdate = false;
    scene.add(this.dome);

    // The environment sees the same sky at cube-map pixel size.
    this.envScene.add(new THREE.Mesh(geometry, material(true, { ...this.uniforms, uPix: { value: Math.PI / 2 / 256 } })));
    this.pmrem = new THREE.PMREMGenerator(renderer);
  }

  update(dt: number, elapsed: number, lighting: Lighting, camera: THREE.PerspectiveCamera, shared: SharedUniforms, viewportHeight: number): void {
    const s = lighting.state;
    const u = this.uniforms;

    // 1. Scattering table, only when the light source moved.
    if (Math.abs(s.elevation - this.bakedElevation) > 0.02) {
      this.bakedElevation = s.elevation;
      (this.lutQuad.material as THREE.ShaderMaterial).uniforms.uElevation.value = Math.max(s.elevation, 0.3) * (Math.PI / 180);
      const prev = this.renderer.getRenderTarget();
      this.renderer.setRenderTarget(this.lut);
      this.lutQuad.render(this.renderer);
      this.renderer.setRenderTarget(prev);
      this.envDirty = true;
    }

    u.uSunDir.value.copy(lighting.direction);
    u.uSunE.value.copy(s.illuminance);
    u.uSunColor.value.copy(s.sunColor);
    u.uGlow.value.copy(s.glow);
    u.uZenith.value.copy(s.zenith);
    u.uGround.value.copy(s.ground);
    u.uNight.value = s.night;
    u.uMoon.value = s.moon;
    u.uTime.value = elapsed;
    u.uClouds.value = this.clouds;
    u.uSkyline.value = this.skyline;
    u.uSkyGlow.value = lighting.skyGlow;
    u.uPix.value = (camera.fov * Math.PI) / 180 / Math.max(viewportHeight, 1);
    // Clouds drift with the wind and stay put as the player walks under them.
    u.uDrift.value.set(camera.position.x + elapsed * 9, camera.position.z + elapsed * 4);

    // 2. Fog follows the haze the atmosphere model predicts.
    this.fog.color.copy(s.fogColor);
    // exp(-(density * range)^2) leaves roughly 8-20 % visibility at the streaming edge.
    this.fog.density = (1.2 + 0.55 * this.haze) / this.viewRange;
    shared.uFogSun.value.copy(s.fogSunColor);
    shared.uSkyZenith.value.copy(s.zenith);
    shared.uSunDirView.value.copy(lighting.direction).transformDirection(camera.matrixWorldInverse);
    shared.uNight.value = s.night;

    // 3. Environment lighting, re-baked when the sky changed (throttled during transitions).
    const settings = `${this.clouds}|${this.skyline}|${lighting.skyGlow}`;
    if (lighting.version !== this.bakedVersion || settings !== this.settings) {
      this.bakedVersion = lighting.version;
      this.settings = settings;
      this.envDirty = true;
    }
    this.envTimer -= dt;
    if (this.envDirty && this.envTimer <= 0) {
      this.envDirty = false;
      this.envTimer = ENV_INTERVAL;
      const next = this.pmrem.fromScene(this.envScene, 0, 1, 5000);
      this.scene.environment = next.texture;
      this.envTarget?.dispose();
      this.envTarget = next;
    }

    this.dome.matrix.makeTranslation(camera.position.x, camera.position.y, camera.position.z);
    this.dome.matrixWorldNeedsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.dome);
    this.dome.geometry.dispose();
    (this.dome.material as THREE.Material).dispose();
    this.lut.dispose();
    this.lutQuad.dispose();
    this.envTarget?.dispose();
    this.pmrem.dispose();
    this.scene.environment = null;
  }
}
