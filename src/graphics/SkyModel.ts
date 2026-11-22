/**
 * Atmosphere model shared by the CPU and the GPU.
 *
 * Single scattering through a Rayleigh + Mie + ozone atmosphere with a small
 * multiple-scattering term, the same structure used by production sky
 * renderers (Hillaire-style, as in Noniv/atlantis and Noniv/web-ocean, whose
 * approach this follows). The GPU version is baked into a small lookup table
 * whenever the sun moves; the CPU version supplies the handful of values the
 * engine needs every frame without reading pixels back: the sun's colour after
 * the atmosphere, and the haze colour for fog.
 *
 * Because everything derives from the sun's elevation, time of day is one
 * number, not a table of hand-picked colours.
 */

// Planet and scattering coefficients, meters and 1/meter.
const RG = 6360e3;
const RT = 6460e3;
const BR = [5.802e-6, 13.558e-6, 33.1e-6];
const HR = 8000;
const BM = 3.996e-6;
const BME = 4.44e-6;
const HM = 1200;
const BO = [0.65e-6, 1.881e-6, 0.085e-6];
const EYE = 30;
/** Share of scattered light that is scattered again toward the viewer. */
const MULTI = 0.04;

type V3 = [number, number, number];

function densities(h: number): V3 {
  return [Math.exp(-h / HR), Math.exp(-h / HM), Math.max(0, 1 - Math.abs(h - 25000) / 15000)];
}

function exitDistance(px: number, py: number, pz: number, dx: number, dy: number, dz: number): number {
  const b = px * dx + py * dy + pz * dz;
  const q = b * b - (px * px + py * py + pz * pz) + RT * RT;
  return q < 0 ? 0 : -b + Math.sqrt(q);
}

/** Optical depth (Rayleigh, Mie, ozone) from a point to space along a direction. */
function opticalDepth(px: number, py: number, pz: number, dx: number, dy: number, dz: number, steps: number): V3 {
  const tm = exitDistance(px, py, pz, dx, dy, dz);
  const dt = tm / steps;
  const od: V3 = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const x = px + dx * t;
    const y = py + dy * t;
    const z = pz + dz * t;
    const d = densities(Math.hypot(x, y, z) - RG);
    od[0] += d[0] * dt;
    od[1] += d[1] * dt;
    od[2] += d[2] * dt;
  }
  return od;
}

function transmittance(od: V3): V3 {
  return [
    Math.exp(-(BR[0] * od[0] + BME * od[1] + BO[0] * od[2])),
    Math.exp(-(BR[1] * od[0] + BME * od[1] + BO[1] * od[2])),
    Math.exp(-(BR[2] * od[0] + BME * od[1] + BO[2] * od[2])),
  ];
}

/** Fraction of sunlight (per channel) reaching the ground for a sun at this elevation, radians. */
export function sunTransmittance(elevation: number): V3 {
  const e = Math.max(elevation, 0.005);
  return transmittance(opticalDepth(0, RG + EYE, 0, Math.cos(e), Math.sin(e), 0, 24));
}

/**
 * Sky radiance per unit of sun illuminance, looking along (dx, dy, dz) with the
 * sun at (sx, sy, sz). Both unit vectors, y up, dy >= 0.
 */
export function skyRadiance(dx: number, dy: number, dz: number, sx: number, sy: number, sz: number, steps = 20): V3 {
  const py = RG + EYE;
  const tm = exitDistance(0, py, 0, dx, dy, dz);
  const mu = dx * sx + dy * sy + dz * sz;
  const pr = (3 / (16 * Math.PI)) * (1 + mu * mu);
  const g = 0.8;
  const pm = ((3 / (8 * Math.PI)) * (1 - g * g) * (1 + mu * mu)) / ((2 + g * g) * Math.pow(1 + g * g - 2 * g * mu, 1.5));
  const od: V3 = [0, 0, 0];
  const L: V3 = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    // Quadratic spacing: most of the air is close to the viewer.
    const t0 = tm * (i / steps) ** 2;
    const t1 = tm * ((i + 1) / steps) ** 2;
    const dt = t1 - t0;
    const t = (t0 + t1) / 2;
    const x = dx * t;
    const y = py + dy * t;
    const z = dz * t;
    const d = densities(Math.hypot(x, y, z) - RG);
    od[0] += d[0] * dt * 0.5;
    od[1] += d[1] * dt * 0.5;
    od[2] += d[2] * dt * 0.5;
    const tv = transmittance(od);
    const ts = transmittance(opticalDepth(x, y, z, sx, sy, sz, 6));
    for (let c = 0; c < 3; c++) {
      const scatter = BR[c] * d[0] * pr + BM * d[1] * pm + (BR[c] * d[0] + BM * d[1]) * MULTI;
      L[c] += tv[c] * scatter * ts[c] * dt;
    }
    od[0] += d[0] * dt * 0.5;
    od[1] += d[1] * dt * 0.5;
    od[2] += d[2] * dt * 0.5;
  }
  return L;
}

const f = (n: number) => n.toExponential(6);

/** The same model in GLSL. `cwSkyScatter(dir, sun)` returns radiance per unit sun illuminance. */
export const SKY_SCATTER_GLSL = /* glsl */ `
const float SK_RG = ${f(RG)};
const float SK_RT = ${f(RT)};
const vec3 SK_BR = vec3(${BR.map(f).join(', ')});
const vec3 SK_BO = vec3(${BO.map(f).join(', ')});
const float SK_BM = ${f(BM)};
const float SK_BME = ${f(BME)};
vec3 skDens(vec3 p) {
  float h = length(p) - SK_RG;
  return vec3(exp(-h / ${f(HR)}), exp(-h / ${f(HM)}), max(0.0, 1.0 - abs(h - 25000.0) / 15000.0));
}
vec3 skExt(vec3 d) { return SK_BR * d.x + vec3(SK_BME * d.y) + SK_BO * d.z; }
float skExit(vec3 p, vec3 d) {
  float b = dot(p, d);
  float q = b * b - dot(p, p) + SK_RT * SK_RT;
  return q < 0.0 ? 0.0 : -b + sqrt(q);
}
vec3 skSunDepth(vec3 p, vec3 s) {
  float dt = skExit(p, s) / 8.0;
  vec3 od = vec3(0.0);
  for (int i = 0; i < 8; i++) od += skDens(p + s * (float(i) + 0.5) * dt) * dt;
  return od;
}
vec3 cwSkyScatter(vec3 rd, vec3 sd) {
  vec3 ro = vec3(0.0, SK_RG + ${f(EYE)}, 0.0);
  float tm = skExit(ro, rd);
  float mu = dot(rd, sd);
  float pr = 3.0 / (16.0 * 3.14159265) * (1.0 + mu * mu);
  const float g = 0.8;
  float pm = 3.0 / (8.0 * 3.14159265) * (1.0 - g * g) * (1.0 + mu * mu) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
  vec3 od = vec3(0.0);
  vec3 L = vec3(0.0);
  const float N = 32.0;
  for (float i = 0.0; i < N; i += 1.0) {
    float t0 = tm * (i / N) * (i / N);
    float t1 = tm * ((i + 1.0) / N) * ((i + 1.0) / N);
    float dt = t1 - t0;
    vec3 p = ro + rd * (t0 + t1) * 0.5;
    vec3 d = skDens(p);
    od += d * dt * 0.5;
    vec3 ts = exp(-skExt(skSunDepth(p, sd)));
    L += exp(-skExt(od)) * ((SK_BR * d.x * pr + SK_BM * d.y * pm) + (SK_BR * d.x + SK_BM * d.y) * ${f(MULTI)}) * ts * dt;
    od += d * dt * 0.5;
  }
  return L;
}
`;

/** Lookup-table layout: u = azimuth from the sun, v = sqrt(elevation / 90 deg). */
export const SKY_LUT_WIDTH = 192;
export const SKY_LUT_HEIGHT = 96;
