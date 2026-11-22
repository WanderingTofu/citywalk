/**
 * GLSL for the shared procedural material library.
 *
 * There are no texture files. Every surface in the world is shaded by one of
 * a dozen analytic materials evaluated per pixel from world-space position, so
 * the download cost of "textures" is this file. The chunks below are injected
 * into three.js' standard PBR shader (lighting, shadows, fog and tone mapping
 * stay stock), which also keeps the door open for a WebGPU/TSL port: the
 * material functions are plain math with no WebGL-specific state.
 */

/** Noise + material functions shared by the facade and ground shaders. */
export const MATERIALS_GLSL = /* glsl */ `
uniform float uNight;
uniform float uTime;
uniform float uSignage;
uniform float uLit;
uniform float uWarmth;
uniform float uWeather;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;

float cwHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float cwNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(cwHash(i), cwHash(i + vec2(1.0, 0.0)), f.x),
             mix(cwHash(i + vec2(0.0, 1.0)), cwHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float cwFbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * cwNoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
// 1 inside |d| < halfW, antialiased by the pixel footprint fw.
float cwBox(float d, float halfW, float fw) {
  return 1.0 - smoothstep(halfW - fw, halfW + fw, abs(d));
}
// 1 for a < x < b, antialiased.
float cwBand(float x, float a, float b, float fw) {
  return smoothstep(a - fw, a + fw, x) * (1.0 - smoothstep(b - fw, b + fw, x));
}
// Joint line at the borders of a repeating cell (f in 0..1, cell size in meters).
// Fades out as the cell approaches pixel size, so tiling never turns into moire.
float cwJoint(float f, float cell, float halfW, float fw) {
  float d = min(f, 1.0 - f) * cell;
  float line = 1.0 - smoothstep(halfW - fw, halfW + fw, d);
  return line * (1.0 - smoothstep(cell * 0.25, cell * 0.8, fw));
}
vec3 cwSky(vec3 dir) {
  vec3 sky = mix(uSkyHorizon, uSkyTop, clamp(dir.y * 1.5 + 0.08, 0.0, 1.0));
  // Below the horizon a reflection sees the street, not the sky.
  return mix(uSkyHorizon * 0.3, sky, smoothstep(-0.12, 0.1, dir.y));
}

struct CwSurface { vec3 color; float rough; float metal; float height; };

// Material ids match districts/StyleConfig.ts (Mat).
CwSurface cwMaterial(int id, vec2 p, vec3 tint, float detail) {
  CwSurface s;
  s.color = tint; s.rough = 0.85; s.metal = 0.0; s.height = 0.0;
  float fw = max(fwidth(p.x), fwidth(p.y)) + 1e-4;
  float n = cwFbm(p * 0.7);
  if (id == 0) {            // concrete: cast panels
    vec2 q = p / vec2(2.4, 1.2);
    float j = max(cwJoint(fract(q.x), 2.4, 0.01, fw), cwJoint(fract(q.y), 1.2, 0.01, fw)) * detail;
    s.color = tint * (0.88 + 0.2 * n) * (1.0 - 0.3 * j);
    s.height = n * 0.3 - j;
    s.rough = 0.88;
  } else if (id == 1) {     // brick: running bond
    vec2 q = p / vec2(0.24, 0.08);
    q.x += 0.5 * floor(q.y);
    vec2 c = floor(q), f = fract(q);
    float j = max(cwJoint(f.x, 0.24, 0.011, fw), cwJoint(f.y, 0.08, 0.011, fw)) * detail;
    float v = cwHash(c);
    s.color = tint * (0.84 + 0.28 * v * detail + 0.1 * n);
    s.color = mix(s.color, vec3(0.5, 0.48, 0.45) * (0.5 + dot(tint, vec3(0.5))), j * 0.85);
    s.height = (1.0 - j) * (0.8 + 0.2 * v);
    s.rough = 0.92;
  } else if (id == 2) {     // plaster / stucco
    float streak = cwNoise(vec2(p.x * 2.6, p.y * 0.22));
    s.color = tint * (0.92 + 0.1 * n) * (1.0 - 0.1 * streak);
    s.height = cwNoise(p * 9.0) * 0.25 * detail;
    s.rough = 0.84;
  } else if (id == 3) {     // wood: vertical boards
    float q = p.x / 0.16;
    float c = floor(q);
    float j = cwJoint(fract(q), 0.16, 0.008, fw) * detail;
    float grain = cwNoise(vec2(p.x * 42.0, p.y * 1.6 + c * 7.3));
    s.color = tint * (0.8 + 0.26 * cwHash(vec2(c, 3.0)) + 0.16 * grain * detail) * (1.0 - 0.55 * j);
    s.height = (1.0 - j) * 0.8 + grain * 0.2 * detail;
    s.rough = 0.72;
  } else if (id == 4) {     // stone: ashlar courses
    vec2 q = p / vec2(0.72, 0.36);
    q.x += 0.5 * floor(q.y);
    vec2 c = floor(q), f = fract(q);
    float j = max(cwJoint(f.x, 0.72, 0.009, fw), cwJoint(f.y, 0.36, 0.009, fw)) * detail;
    s.color = tint * (0.9 + 0.14 * cwHash(c) * detail + 0.1 * n) * (1.0 - 0.32 * j);
    s.height = (1.0 - j) * 0.9 + cwNoise(p * 14.0) * 0.1 * detail;
    s.rough = 0.8;
  } else if (id == 5) {     // asphalt
    float speck = cwHash(floor(p * 55.0)) - 0.5;
    s.color = tint * (0.86 + 0.22 * n + 0.12 * speck * detail);
    s.height = speck * 0.4 * detail;
    s.rough = 0.94;
  } else if (id == 6) {     // metal cladding / standing seam
    vec2 q = p / vec2(0.9, 3.0);
    float j = max(cwJoint(fract(q.x), 0.9, 0.012, fw), cwJoint(fract(q.y), 3.0, 0.008, fw)) * detail;
    s.color = tint * (0.92 + 0.1 * n) * (1.0 - 0.35 * j);
    s.height = j;
    s.rough = 0.45; s.metal = 0.3;
  } else if (id == 7) {     // glass (walls of curtain-wall towers between panes)
    s.color = tint * (0.4 + 0.1 * n);
    s.rough = 0.12; s.metal = 0.2;
  } else if (id == 8) {     // ceramic roof tile, rows run up the slope
    vec2 q = p / vec2(0.24, 0.3);
    q.x += 0.5 * floor(q.y);
    vec2 c = floor(q), f = fract(q);
    float fade = (1.0 - smoothstep(0.06, 0.2, fw)) * detail;
    float shade = mix(1.0, 0.72 + 0.36 * f.y, fade);
    s.color = tint * shade * (0.9 + 0.2 * cwHash(c) * fade + 0.08 * n);
    s.height = (f.y * 0.7 + 0.3 * cos((f.x - 0.5) * 6.2832)) * fade;
    s.rough = 0.5; s.metal = 0.05;
  } else if (id == 9) {     // pavement: square setts
    vec2 q = p / 0.6;
    q.x += 0.5 * floor(q.y);
    vec2 c = floor(q), f = fract(q);
    float j = max(cwJoint(f.x, 0.6, 0.008, fw), cwJoint(f.y, 0.6, 0.008, fw)) * detail;
    s.color = tint * (0.9 + 0.12 * cwHash(c) * detail + 0.12 * n) * (1.0 - 0.3 * j);
    s.height = 1.0 - j;
    s.rough = 0.9;
  } else if (id == 10) {    // grass
    s.color = tint * (0.72 + 0.55 * cwFbm(p * 0.33) + 0.12 * (cwHash(floor(p * 30.0)) - 0.5) * detail);
    s.rough = 1.0;
  } else if (id == 11) {    // water (animated in the ground shader)
    s.color = tint * 0.55;
    s.rough = 0.06;
  } else {                  // gravel / ballast
    s.color = tint * (0.7 + 0.5 * cwNoise(p * 16.0) * detail + 0.2 * n);
    s.rough = 1.0;
  }
  return s;
}

// Bump mapping from a procedural height (screen-space derivatives, no tangents needed).
vec3 cwBump(vec3 N, vec3 viewPos, float h, float strength) {
  vec3 dpx = dFdx(viewPos), dpy = dFdy(viewPos);
  float dhx = dFdx(h), dhy = dFdy(h);
  vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);
  float det = dot(dpx, r1);
  vec3 g = sign(det) * (dhx * r1 + dhy * r2);
  return normalize(abs(det) * N - strength * g);
}
`;

/** Vertex-stage declarations and assignments, shared by both shaders. */
export const VERTEX_DECL = (aSize: string, bType: string, hasC: boolean) => /* glsl */ `
attribute ${aSize} cwA;
attribute ${bType} cwB;
${hasC ? 'attribute vec4 cwC;\nvarying vec4 vCwC;' : ''}
attribute vec3 cwColor;
varying ${aSize} vCwA;
varying ${bType} vCwB;
varying vec3 vCwColor;
varying vec3 vCwWPos;
varying vec3 vCwWNormal;
`;

export const VERTEX_BODY = (hasC: boolean) => /* glsl */ `
vCwA = cwA; vCwB = cwB; vCwColor = cwColor;
${hasC ? 'vCwC = cwC;' : ''}
vCwWPos = (modelMatrix * vec4(position, 1.0)).xyz;
vCwWNormal = normal;
`;

export const FACADE_FRAGMENT_DECL = /* glsl */ `
varying vec3 vCwA;
varying vec4 vCwB;
varying vec4 vCwC;
varying vec3 vCwColor;
varying vec3 vCwWPos;
varying vec3 vCwWNormal;
${MATERIALS_GLSL}
vec3 cwHue(float h) {
  return clamp(abs(fract(h + vec3(0.0, 0.6667, 0.3333)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}
`;

/**
 * Facade shading. Inputs (see world/types.ts MeshData):
 *   vCwA = (u in bays, height above base, wall height)
 *   vCwB = (surface, material, seed, window pattern)
 *   vCwC = (floor height, storefront height, window fill x, window fill y)
 * Outputs diffuseColor plus cwRough / cwMetal / cwEmit / cwHeight, consumed
 * by the replaced standard-material chunks.
 */
export const FACADE_FRAGMENT_BODY = /* glsl */ `
vec3 cwN = normalize(vCwWNormal);
vec3 cwV = normalize(cameraPosition - vCwWPos);
float cwDist = length(cameraPosition - vCwWPos);
float cwDetail = 1.0 - smoothstep(50.0, 200.0, cwDist);
int cwSurf = int(vCwB.x + 0.5);
int cwMat = int(vCwB.y + 0.5);
float cwSeed = vCwB.z;
int cwPat = int(vCwB.w + 0.5);
float cwNh = length(cwN.xz);
vec2 cwHn = cwN.xz / max(cwNh, 1e-3);
// Material coordinates: along the wall / up the wall (or up the roof slope).
vec2 cwP = (cwNh < 0.2)
  ? vCwWPos.xz
  : vec2(dot(vCwWPos.xz, vec2(-cwHn.y, cwHn.x)), vCwWPos.y / max(cwNh, 0.3));
CwSurface cwS = cwMaterial(cwMat, cwP, vCwColor, cwDetail);
vec3 cwEmit = vec3(0.0);
float cwGlass = 0.0;

if (cwSurf == 0) {
  float y = vCwA.y;
  float wallH = vCwA.z;
  float floorH = vCwC.x;
  float groundH = vCwC.y;
  vec2 fill = vCwC.zw;
  float u = vCwA.x;
  float fwu = fwidth(u) + 1e-4;
  float fwy = fwidth(y) + 1e-4;

  // Weathering: splash-back grime at the base and rain streaks from the top.
  float grime = (1.0 - smoothstep(0.0, 2.2, y)) * 0.3;
  float streak = cwFbm(vec2(cwP.x * 0.9, cwP.y * 0.1)) * smoothstep(wallH * 0.35, wallH, y) * 0.35;
  cwS.color *= 1.0 - uWeather * (grime + streak);
  // Cornice band.
  float trim = smoothstep(wallH - 0.5 - fwy, wallH - 0.5 + fwy, y) * step(6.0, wallH);
  cwS.color *= 1.0 - 0.16 * trim;

  if (cwPat != 5) {
    float win = 0.0;      // glass coverage
    float glow = 0.0;     // emissive strength at night
    vec3 glassCol = (cwMat == 7) ? vCwColor * 0.42 : vec3(0.045, 0.06, 0.075);
    vec3 lightCol = vec3(1.0);
    if (y > groundH) {
      vec2 cell = vec2(u, (y - groundH) / floorH);
      vec2 cid = floor(cell);
      vec2 f = fract(cell);
      float fwv = fwy / floorH;
      float lod = smoothstep(0.22, 0.6, max(fwu, fwv));   // 1 = cells smaller than ~2 px
      float r1 = cwHash(cid + cwSeed * 91.7);
      float r2 = cwHash(cid * 1.7 + cwSeed * 13.1 + 5.0);
      float sill = (1.0 - fill.y) * 0.42;
      float avg = fill.x * fill.y;
      if (cwPat == 0) {                               // punched grid
        win = cwBox(f.x - 0.5, fill.x * 0.5, fwu) * cwBand(f.y, sill, sill + fill.y, fwv);
        float frame = cwBox(f.x - 0.5, fill.x * 0.5 + 0.035, fwu) * cwBand(f.y, sill - 0.03, sill + fill.y + 0.03, fwv) - win;
        cwS.color *= 1.0 - 0.25 * max(frame, 0.0) * (1.0 - lod);
      } else if (cwPat == 1) {                        // ribbon windows
        win = cwBand(f.y, sill, sill + fill.y, fwv) * (1.0 - cwJoint(f.x, 1.0, 0.03, fwu));
        avg = fill.y;
      } else if (cwPat == 2) {                        // curtain wall
        float mull = max(cwJoint(f.x, 1.0, 0.025, fwu), cwJoint(f.y, 1.0, 0.03, fwv));
        win = 1.0 - mull;
        // Opaque spandrel panel hides the floor slab.
        glassCol *= mix(1.0, 0.55, (1.0 - smoothstep(0.2, 0.24, f.y)) * (1.0 - lod));
        r1 = mix(r1, 1.0, (1.0 - smoothstep(0.2, 0.24, f.y)) * 0.999);
        cwS.color = mix(cwS.color, vec3(0.16, 0.17, 0.19), 0.6);
        avg = 0.92;
      } else if (cwPat == 3) {                        // tall French windows with iron balconies
        win = cwBox(f.x - 0.5, fill.x * 0.5, fwu) * cwBand(f.y, 0.07, 0.07 + fill.y, fwv);
        float surround = cwBox(f.x - 0.5, fill.x * 0.5 + 0.07, fwu) * cwBand(f.y, 0.04, 0.12 + fill.y, fwv) - win;
        cwS.color *= 1.0 + 0.12 * max(surround, 0.0) * (1.0 - lod);
        // Balcony: a rail and balusters across the lower part of the opening.
        float rail = cwBox(f.x - 0.5, fill.x * 0.5 + 0.08, fwu) * cwBand(f.y, 0.05, 0.3, fwv);
        float bars = max(step(0.55, fract(u * 14.0)), cwBand(f.y, 0.27, 0.3, fwv)) * (1.0 - smoothstep(0.02, 0.07, fwu));
        float iron = rail * bars * (1.0 - lod);
        cwS.color = mix(cwS.color, vec3(0.03), iron);
        win *= 1.0 - iron;
        // Floor string course.
        cwS.color *= 1.0 - 0.14 * cwJoint(f.y, floorH, 0.06, fwy) ;
        avg = fill.x * fill.y;
      } else {                                        // timber lattice over paper screens
        float open = cwBox(f.x - 0.5, fill.x * 0.5, fwu) * cwBand(f.y, 0.1, 0.1 + fill.y, fwv);
        float slatFade = 1.0 - smoothstep(0.03, 0.12, fwu);
        float slat = mix(0.5, step(0.5, fract(u * 9.0)), slatFade);
        float railY = cwJoint(fract(f.y * 3.0), floorH / 3.0, 0.025, fwy);
        win = open * (1.0 - slat) * (1.0 - railY);
        glassCol = vec3(0.5, 0.45, 0.36) * (0.55 + 0.3 * r2);    // paper, not glass
        cwS.color = mix(cwS.color, vCwColor * 0.55, open * (1.0 - win));
        avg = fill.x * fill.y * 0.45;
      }
      // Curtains and blinds: some panes read lighter by day.
      glassCol = mix(glassCol, vec3(0.42, 0.4, 0.37) * (0.5 + 0.5 * r2), step(0.78, r2) * 0.55 * (1.0 - lod));
      float litAmount = uLit * (0.35 + 0.6 * fract(cwSeed * 7.3));
      float lit = mix(step(r1, litAmount), litAmount, lod);
      float warm = clamp(uWarmth + (r2 - 0.5) * 0.5, 0.0, 1.0);
      lightCol = mix(vec3(0.72, 0.84, 1.0), vec3(1.0, 0.66, 0.34), warm);
      float interior = 0.65 + 0.35 * cwNoise(f * vec2(2.0, 3.0) + cid * 3.1);
      glow = lit * (0.3 + 0.7 * r2) * mix(interior, 0.8, lod) * (cwPat == 2 ? 0.6 : 1.0);
      win = mix(win, avg, lod);
      if (cwPat != 4) cwGlass = win;
    } else {
      // Ground floor storefront: one shop bay per facade bay.
      float bay = floor(u);
      float fx = fract(u);
      float rb = cwHash(vec2(bay, cwSeed * 57.0));
      float lod = smoothstep(0.22, 0.6, fwu);
      float pane = cwBox(fx - 0.5, 0.43, fwu) * cwBand(y, mix(0.45, 0.05, step(0.78, rb)), groundH - 1.0, fwy);
      win = mix(pane, 0.6, lod);
      cwGlass = win;
      float band = cwBand(y, groundH - 0.9, groundH - 0.18, fwy) * cwBox(fx - 0.5, 0.47, fwu);
      // Fascia sign: saturated where signage is dense, muted otherwise.
      vec3 signCol = mix(vCwColor * 0.55, cwHue(rb * 5.0 + cwSeed) * 0.9 + 0.08, uSignage * step(0.25, fract(rb * 7.1)));
      float glyph = step(0.45, cwHash(floor(vec2(u * 9.0, y * 6.0)) + rb)) * (1.0 - smoothstep(0.03, 0.12, fwu));
      signCol *= 1.0 - 0.45 * glyph;
      band *= 1.0 - lod;
      cwS.color = mix(cwS.color, signCol, band);
      cwEmit += band * signCol * uNight * uSignage * 1.5;
      lightCol = mix(vec3(1.0, 0.86, 0.66), vec3(0.8, 0.9, 1.0), step(0.5, fract(rb * 3.3)) * (1.0 - uWarmth));
      glow = (0.45 + 0.6 * rb) * (0.6 + 0.4 * cwNoise(vec2(u * 3.0, y * 2.0))) * step(fract(rb * 11.0), 0.4 + uLit);
    }
    cwS.color = mix(cwS.color, glassCol, win);
    cwS.rough = mix(cwS.rough, 0.07, cwGlass);
    cwS.metal = mix(cwS.metal, 0.0, cwGlass);
    cwS.height *= 1.0 - win;
    cwEmit += win * glow * lightCol * uNight;
  }
} else if (cwSurf == 1) {
  // Flat roof: gravel-ish, slightly mottled.
  cwS.color *= 0.8 + 0.25 * cwNoise(vCwWPos.xz * 0.35);
} else if (cwSurf == 4) {
  // Illuminated blade sign with blocky pseudo-lettering.
  // One character cell per 0.85 m of height, each a hashed 4x4 block glyph.
  float row = vCwA.y / 0.85;
  vec2 sub = floor(vec2(clamp(vCwA.x, 0.0, 0.99) * 4.4, fract(row) * 5.0));
  float on = step(0.42, cwHash(sub + floor(row) * 7.0 + cwSeed * 37.0)) * step(0.5, sub.y) * step(sub.x, 3.5);
  float fwS = fwidth(vCwA.y) * 5.0;
  on = mix(on, 0.45, smoothstep(0.3, 0.9, fwS));
  vec3 col = vCwColor * mix(0.22, 1.0, on) * step(0.2, cwNh);
  cwS.color = col * 0.7 + 0.03;
  cwS.rough = 0.4; cwS.metal = 0.0; cwS.height = 0.0;
  cwEmit += col * (0.2 + 1.5 * uNight);
}

// Glass picks up the sky; cheap stand-in for an environment probe.
if (cwGlass > 0.0) {
  vec3 R = reflect(-cwV, cwN);
  float fres = 0.05 + 0.95 * pow(1.0 - max(dot(cwN, cwV), 0.0), 4.0);
  cwEmit += cwGlass * cwSky(R) * fres * 0.85;
}
diffuseColor.rgb = cwS.color;
float cwRough = cwS.rough;
float cwMetal = cwS.metal;
float cwHeight = cwS.height;
float cwBumpK = 0.012 * cwDetail;
`;

export const GROUND_FRAGMENT_DECL = /* glsl */ `
varying vec4 vCwA;
varying float vCwB;
varying vec3 vCwColor;
varying vec3 vCwWPos;
varying vec3 vCwWNormal;
${MATERIALS_GLSL}
`;

/**
 * Ground shading. vCwA = (material, across in m, along in m, layer),
 * vCwB = half width of the ribbon the fragment belongs to.
 */
export const GROUND_FRAGMENT_BODY = /* glsl */ `
vec3 cwV = normalize(cameraPosition - vCwWPos);
float cwDist = length(cameraPosition - vCwWPos);
float cwDetail = 1.0 - smoothstep(40.0, 160.0, cwDist);
int cwMat = int(vCwA.x + 0.5);
CwSurface cwS = cwMaterial(cwMat, vCwWPos.xz, vCwColor, cwDetail);
vec3 cwEmit = vec3(0.0);
float cwBumpK = 0.01 * cwDetail;
float ac = vCwA.y;
float al = vCwA.z;
float hw = vCwB;
if (cwMat == 5 && abs(ac) <= hw + 0.01) {
  // Lane markings from the across/along coordinates.
  float fwA = fwidth(ac) + 1e-4;
  float fade = 1.0 - smoothstep(0.08, 0.35, fwA);
  float dash = step(fract(al / 6.0), 0.5);
  float mark = 0.0;
  if (hw >= 5.2) {
    float l = abs(ac);
    mark = max(cwBox(l - 0.16, 0.06, fwA), cwBox(l - (hw - 0.4), 0.07, fwA));
    float lane = cwBox((fract(l / 3.2 + 0.5) - 0.5) * 3.2, 0.06, fwA) * dash * step(1.6, l) * step(l, hw - 1.4);
    mark = max(mark, lane);
  } else if (hw >= 2.9) {
    mark = cwBox(ac, 0.06, fwA) * dash;
  }
  mark *= fade * (0.75 + 0.25 * cwNoise(vCwWPos.xz * 2.0));
  cwS.color = mix(cwS.color, vec3(0.72, 0.72, 0.68), mark * 0.85);
  // Tyre-polished wheel tracks.
  cwS.rough -= 0.12 * (1.0 - smoothstep(0.0, 0.9, abs(fract(abs(ac) / 3.2) - 0.5) * 3.2 - 0.3));
} else if (cwMat == 12 && abs(ac) <= hw + 0.01) {
  float fwA = fwidth(ac) + 1e-4;
  float fade = 1.0 - smoothstep(0.05, 0.25, fwA);
  float sleeper = step(fract(al / 0.65), 0.38) * cwBox(ac, 1.25, fwA);
  cwS.color = mix(cwS.color, vec3(0.2, 0.17, 0.14), sleeper * fade * 0.8);
  float rail = cwBox(abs(ac) - 0.72, 0.04, fwA) * fade;
  cwS.color = mix(cwS.color, vec3(0.42, 0.43, 0.45), rail);
  cwS.rough = mix(cwS.rough, 0.3, rail);
  cwS.metal = rail;
} else if (cwMat == 11) {
  vec2 wp = vCwWPos.xz * 0.4;
  cwS.height = cwFbm(wp + uTime * vec2(0.05, 0.03)) + 0.5 * cwFbm(wp * 2.3 - uTime * vec2(0.04, 0.06));
  cwBumpK = 0.35 * (1.0 - smoothstep(60.0, 300.0, cwDist));
  float fres = 0.03 + 0.97 * pow(1.0 - max(cwV.y, 0.0), 5.0);
  cwEmit += cwSky(reflect(-cwV, vec3(0.0, 1.0, 0.0))) * fres * 0.8;
}
diffuseColor.rgb = cwS.color;
float cwRough = cwS.rough;
float cwMetal = cwS.metal;
float cwHeight = cwS.height;
`;
