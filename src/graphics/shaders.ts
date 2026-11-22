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
uniform float uStreetAO;
uniform float uWet;
uniform float uPaving;
uniform vec3 uSkyZenith;

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
    s.rough = 0.4; s.metal = 0.6;
  } else if (id == 7) {     // glass (walls of curtain-wall towers between panes)
    s.color = tint * (0.5 + 0.1 * n);
    s.rough = 0.14; s.metal = 0.5;
  } else if (id == 8) {     // ceramic roof tile, rows run up the slope
    vec2 q = p / vec2(0.24, 0.3);
    q.x += 0.5 * floor(q.y);
    vec2 c = floor(q), f = fract(q);
    float fade = (1.0 - smoothstep(0.06, 0.2, fw)) * detail;
    float shade = mix(1.0, 0.72 + 0.36 * f.y, fade);
    s.color = tint * shade * (0.9 + 0.2 * cwHash(c) * fade + 0.08 * n);
    s.height = (f.y * 0.7 + 0.3 * cos((f.x - 0.5) * 6.2832)) * fade;
    s.rough = 0.5; s.metal = 0.05;
  } else if (id == 9) {     // pavement: stone setts in a running bond, or large concrete slabs
    float cs = mix(0.6, 1.5, uPaving);
    vec2 q = p / cs;
    q.x += 0.5 * floor(q.y) * (1.0 - uPaving);
    vec2 c = floor(q), f = fract(q);
    float j = max(cwJoint(f.x, cs, 0.008, fw), cwJoint(f.y, cs, 0.008, fw)) * detail;
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
${hasC ? 'attribute vec4 cwC;\nflat varying vec4 vCwC;' : ''}
attribute vec3 cwColor;
varying ${aSize} vCwA;
// Per-building constants are flat: interpolating them is not bit-exact, and the hashes below amplify the error.
flat varying ${bType} vCwB;
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
flat varying vec4 vCwB;
flat varying vec4 vCwC;
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
vec2 cwT = vec2(-cwHn.y, cwHn.x);          // along the wall, the direction u increases
// Material coordinates: along the wall / up the wall (or up the roof slope).
vec2 cwP = (cwNh < 0.2) ? vCwWPos.xz : vec2(dot(vCwWPos.xz, cwT), vCwWPos.y / max(cwNh, 0.3));
CwSurface cwS = cwMaterial(cwMat, cwP, vCwColor, cwDetail);
vec3 cwEmit = vec3(0.0);
float cwGlass = 0.0;
float cwAO = 1.0;

if (cwSurf == 0) {
  float y = vCwA.y;
  float wallH = vCwA.z;
  float floorH = vCwC.x;
  float groundH = vCwC.y;
  vec2 fill = vCwC.zw;
  float u = vCwA.x;
  float fwu = fwidth(u) + 1e-4;
  float fwy = fwidth(y) + 1e-4;
  // Width of one facade bay in meters, recovered from how fast u and position change together.
  float bayM = clamp(fwidth(cwP.x) / fwu, 0.6, 14.0);
  // View vector in wall space: x along the wall, y up, z out of the wall.
  vec3 vt = vec3(dot(cwV.xz, cwT), cwV.y, max(dot(cwV, cwN), 0.08));

  // Weathering: splash-back grime at the base and rain streaks from the top.
  float grime = (1.0 - smoothstep(0.0, 2.2, y)) * 0.3;
  float streak = cwFbm(vec2(cwP.x * 0.9, cwP.y * 0.1)) * smoothstep(wallH * 0.35, wallH, y) * 0.35;
  cwS.color *= 1.0 - uWeather * (grime + streak);
  // Cornice band.
  float trim = smoothstep(wallH - 0.5 - fwy, wallH - 0.5 + fwy, y) * step(6.0, wallH);
  cwS.color *= 1.0 - 0.16 * trim;
  // Street canyon: the lower a wall, the less sky it sees.
  cwAO = mix(1.0 - 0.45 * uStreetAO, 1.0, smoothstep(0.0, min(wallH, 16.0), y));

  if (cwPat == 4 && y > groundH) {
    // Timber lattice over paper screens: flat, glowing softly from within.
    vec2 cell = vec2(u, (y - groundH) / floorH);
    vec2 cid = floor(cell);
    vec2 f = fract(cell);
    float fwv = fwy / floorH;
    float lod = smoothstep(0.22, 0.6, max(fwu, fwv));
    float r1 = cwHash(cid + cwSeed * 91.7);
    float r2 = cwHash(cid * 1.7 + cwSeed * 13.1 + 5.0);
    float open = cwBox(f.x - 0.5, fill.x * 0.5, fwu) * cwBand(f.y, 0.1, 0.1 + fill.y, fwv);
    float slat = mix(0.5, step(0.5, fract(u * 9.0)), 1.0 - smoothstep(0.03, 0.12, fwu));
    float railY = cwJoint(fract(f.y * 3.0), floorH / 3.0, 0.025, fwy);
    float win = mix(open * (1.0 - slat) * (1.0 - railY), fill.x * fill.y * 0.45, lod);
    vec3 paper = vec3(0.5, 0.45, 0.36) * (0.55 + 0.3 * r2);
    cwS.color = mix(cwS.color, vCwColor * 0.55, open * (1.0 - win) * (1.0 - lod));
    cwS.color = mix(cwS.color, paper, win);
    float litAmount = uLit * (0.35 + 0.6 * fract(cwSeed * 7.3));
    float lit = mix(step(r1, litAmount), litAmount, lod);
    cwEmit += win * lit * (0.5 + 0.8 * r2) * vec3(1.0, 0.66, 0.34) * uNight;
    cwS.height *= 1.0 - win;
  } else if (cwPat != 5) {
    bool store = y <= groundH;
    float cellH = store ? groundH : floorH;
    vec2 cell = vec2(u, store ? y / groundH : (y - groundH) / floorH);
    vec2 cid = vec2(floor(cell.x), store ? -1.0 : floor(cell.y));
    vec2 f = vec2(fract(cell.x), store ? clamp(cell.y, 0.0, 1.0) : fract(cell.y));
    vec2 fw = vec2(fwu, fwy / cellH);
    float lod = smoothstep(0.22, 0.6, max(fw.x, fw.y));       // 1 = cells smaller than ~2 px
    float r1 = cwHash(cid + cwSeed * 91.7);
    float r2 = cwHash(cid * 1.7 + cwSeed * 13.1 + 5.0);

    // The opening in cell units: half width, bottom, top; how deep the glass sits; how deep the room is.
    float hx = fill.x * 0.5;
    float y0 = (1.0 - fill.y) * 0.42;
    float y1 = y0 + fill.y;
    float depth = 0.17;
    float roomD = 5.0;
    float roomBays = 2.0;
    float avg = fill.x * fill.y;
    if (store) {
      hx = 0.44; y0 = mix(0.45, 0.04, step(0.78, r1)) / groundH; y1 = 1.0 - 1.0 / groundH;
      depth = 0.22; roomD = 9.0; roomBays = 1.0; avg = 0.6;
    } else if (cwPat == 1) {
      hx = 0.5; depth = 0.1; avg = fill.y;
    } else if (cwPat == 2) {
      hx = 0.5; y0 = 0.0; y1 = 1.0; depth = 0.06; avg = 0.92; roomD = 7.0;
    } else if (cwPat == 3) {
      y0 = 0.07; y1 = 0.07 + fill.y; depth = 0.24;
    }

    // Parallax: where the view ray meets the glass plane, set back behind the wall face.
    vec2 shift = clamp(-vt.xy / vt.z * depth / vec2(bayM, cellH), -0.45, 0.45) * (1.0 - lod);
    vec2 g = f + shift;
    float openF = cwBand(f.y, y0, y1, fw.y);
    float openG = cwBand(g.y, y0, y1, fw.y);
    if (hx < 0.5) {
      openF *= cwBox(f.x - 0.5, hx, fw.x);
      openG *= cwBox(g.x - 0.5, hx, fw.x);
    }
    float glass = openF * openG;
    float reveal = openF * (1.0 - openG);                    // the jamb, sill and head of the opening

    // Frames, glazing bars and per-style trim.
    float bars = 0.0;
    if (cwPat == 2 && !store) bars = max(cwJoint(g.x, bayM, 0.03, fwu * bayM), cwJoint(g.y, cellH, 0.035, fwy));
    else if (hx >= 0.5) bars = cwJoint(g.x, bayM, 0.035, fwu * bayM);
    else bars = max(cwBox(g.x - 0.5, 0.02 / bayM, fw.x), cwBox(g.y - mix(y0, y1, store ? 0.72 : 0.5), 0.02 / cellH, fw.y)) * (store || hx * bayM > 0.45 ? 1.0 : 0.0);
    bars *= 1.0 - lod;
    if (!store && hx < 0.5) {
      // A projecting sill, the shadow it casts, and the dirt that rain washes down below it.
      float sillH = 0.07 / cellH;
      float across = cwBox(f.x - 0.5, hx + 0.05, fw.x) * (1.0 - lod);
      cwS.color *= 1.0 + 0.2 * across * cwBand(f.y, y0 - sillH, y0, fw.y);
      cwS.color *= 1.0 - 0.38 * across * cwBand(f.y, y0 - 2.6 * sillH, y0 - sillH, fw.y);
      float drip = cwBox(f.x - 0.5, hx, fw.x) * smoothstep(y0 - 0.45, y0 - sillH, f.y) * step(f.y, y0 - sillH);
      cwS.color *= 1.0 - uWeather * 0.3 * drip * cwNoise(vec2(u * 23.0, 1.0)) * (1.0 - lod);
    }
    if (cwPat == 0 && !store) {
      float frame = cwBox(f.x - 0.5, hx + 0.035, fw.x) * cwBand(f.y, y0 - 0.03, y1 + 0.03, fw.y) - openF;
      cwS.color *= 1.0 - 0.25 * max(frame, 0.0) * (1.0 - lod);
    } else if (cwPat == 3 && !store) {
      float surround = cwBox(f.x - 0.5, hx + 0.07, fw.x) * cwBand(f.y, y0 - 0.03, y1 + 0.05, fw.y) - openF;
      cwS.color *= 1.0 + 0.12 * max(surround, 0.0) * (1.0 - lod);
      cwS.color *= 1.0 - 0.14 * cwJoint(f.y, floorH, 0.06, fwy);                 // string course
    } else if (cwPat == 2 && !store) {
      cwS.color = mix(cwS.color, vec3(0.16, 0.17, 0.19), 0.6);                  // mullions are dark metal
    }

    // Interior mapping: a box room behind the glass, hit analytically.
    vec2 rc = vec2((cid.x + g.x) / roomBays, g.y);
    vec2 rid = vec2(floor(rc.x), cid.y);
    float q1 = cwHash(rid + cwSeed * 91.7);
    float q2 = cwHash(rid * 1.7 + cwSeed * 13.1 + 5.0);
    vec3 ro = vec3(fract(rc.x), clamp(g.y, 0.001, 0.999), 0.0);
    vec3 rd = vec3(-vt.x / (bayM * roomBays), -vt.y / cellH, -vt.z / roomD);
    vec2 sgn = step(vec2(0.0), rd.xy);
    vec2 txy = (sgn - ro.xy) / (rd.xy + (sgn * 2.0 - 1.0) * 1e-5);
    float tz = -1.0 / min(rd.z, -1e-4);
    float tHit = min(tz, min(txy.x, txy.y));
    vec3 hit = ro + rd * tHit;
    float shade;
    if (tHit == tz) {
      // Back wall, with the dark shapes of furniture or shelving against it.
      shade = 0.5 + 0.22 * hit.y;
      float furn = step(hit.y, 0.26 + 0.26 * cwHash(vec2(floor(hit.x * 3.0), q1 * 31.0)));
      shade *= mix(1.0, 0.5, furn);
      if (store) shade *= 0.72 + 0.28 * step(0.45, fract(hit.y * 5.0));
    } else if (tHit == txy.y) {
      shade = rd.y > 0.0 ? 0.95 : 0.3;                         // ceiling, floor
    } else {
      shade = 0.46;                                            // side walls
    }
    shade *= mix(1.0, 0.45, clamp(-hit.z, 0.0, 1.0));
    vec3 roomTint = mix(vec3(0.92, 0.87, 0.78), vec3(0.62, 0.7, 0.82), step(0.82, q2));
    vec3 interior = roomTint * shade;

    // Blinds drawn part-way down some windows; opaque spandrels on curtain walls.
    float gy = clamp((g.y - y0) / max(y1 - y0, 1e-3), 0.0, 1.0);
    float drop = store ? 0.0 : max(r2 - 0.68, 0.0) * 2.0;
    float blind = step(1.0 - drop, gy);
    float slats = mix(0.88, 0.76 + 0.24 * step(0.5, fract(g.y * cellH * 14.0)), 1.0 - smoothstep(0.012, 0.05, fwy));
    vec3 blindCol = vec3(0.5, 0.48, 0.44) * slats;
    float spandrel = (cwPat == 2 && !store) ? 1.0 - smoothstep(0.2, 0.23, g.y) : 0.0;

    // Light: whole rooms switch together.
    float litAmount = store ? 0.45 + uLit : uLit * (0.35 + 0.6 * fract(cwSeed * 7.3));
    float lit = step(q1, litAmount);
    float warm = clamp(uWarmth + (q2 - 0.5) * 0.5, 0.0, 1.0);
    vec3 lightCol = mix(vec3(0.74, 0.85, 1.0), vec3(1.0, 0.68, 0.36), warm);
    if (store) lightCol = mix(vec3(1.0, 0.88, 0.7), vec3(0.82, 0.92, 1.0), step(0.5, fract(q1 * 3.3)) * (1.0 - uWarmth));
    float power = store ? 0.34 + 0.3 * q2 : 0.16 + 0.34 * q2;

    vec3 tint = (cwMat == 7) ? mix(vec3(1.0), vCwColor * 2.2, 0.6) : vec3(1.0);
    vec3 glassCol = interior * 0.13 * tint;                    // an unlit room through glass is dark
    vec3 glow = interior * lightCol * power * lit * tint;
    glassCol = mix(glassCol, blindCol * 0.55, blind);
    glow = mix(glow, blindCol * lightCol * power * lit * 0.4, blind);
    glassCol = mix(glassCol, vCwColor * 0.3, spandrel);
    glow *= 1.0 - spandrel;
    glassCol = mix(glassCol, vec3(0.05), bars);
    glow *= 1.0 - bars;
    // Beyond the point where cells resolve, fall back to their averages.
    glassCol = mix(glassCol, roomTint * 0.07 * tint, lod);
    glow = mix(glow, roomTint * lightCol * 0.45 * power * min(litAmount, 1.0) * tint, lod);
    glass = mix(glass, avg, lod);

    float iron = 0.0;
    if (cwPat == 3 && !store) {
      // Balcony: a rail and balusters across the lower part of the opening, in front of the glass.
      float rail = cwBox(f.x - 0.5, hx + 0.08, fw.x) * cwBand(f.y, 0.05, 0.3, fw.y);
      float bal = max(step(0.6, fract(u * 12.0)), cwBand(f.y, 0.265, 0.3, fw.y)) * (1.0 - smoothstep(0.02, 0.07, fwu));
      iron = rail * bal * (1.0 - lod);
      glassCol = mix(glassCol, vec3(0.03), iron);
      glow *= 1.0 - iron;
      cwS.color = mix(cwS.color, vec3(0.03), iron * (1.0 - openF));
    }

    cwS.color *= 1.0 - 0.5 * reveal * (1.0 - lod);
    cwS.color = mix(cwS.color, glassCol, glass);
    cwGlass = glass * (1.0 - bars) * (1.0 - blind * 0.7) * (1.0 - iron);
    cwS.rough = mix(cwS.rough, 0.06, cwGlass);
    // Coated tower glass mirrors the sky; ordinary glass only glints.
    cwS.metal = mix(cwS.metal, cwMat == 7 ? 0.55 : 0.0, cwGlass);
    cwS.height *= 1.0 - glass;
    cwEmit += glass * glow * uNight;
    if (cwMat != 7) {
      // Double glazing mirrors roughly a tenth of what is in front of it, far more at a glancing angle.
      vec3 R = reflect(-cwV, cwN);
      // Below a ragged roofline the reflection is of the buildings opposite, above it of the sky.
      float roofline = 0.18 + 0.22 * cwNoise(vec2(atan(R.z, R.x) * 6.0, cwSeed * 9.0));
      vec3 seen = mix(fogColor * 0.22, mix(fogColor * 0.7, uSkyZenith * 1.3, smoothstep(0.0, 0.7, R.y)), smoothstep(roofline - 0.04, roofline + 0.04, R.y));
      cwEmit += cwGlass * seen * (0.09 + 0.4 * pow(1.0 - vt.z, 4.0));
    }

    if (store) {
      // Fascia sign above the shopfront: saturated where signage is dense, muted otherwise.
      float fx = fract(u);
      float rb = cwHash(vec2(floor(u), cwSeed * 57.0));
      float band = cwBand(y, groundH - 0.9, groundH - 0.18, fwy) * cwBox(fx - 0.5, 0.47, fwu) * (1.0 - lod);
      vec3 signCol = mix(vCwColor * 0.55, cwHue(rb * 5.0 + cwSeed) * 0.9 + 0.08, uSignage * step(0.25, fract(rb * 7.1)));
      float glyph = step(0.45, cwHash(floor(vec2(u * 9.0, y * 6.0)) + rb)) * (1.0 - smoothstep(0.03, 0.12, fwu));
      signCol *= 1.0 - 0.45 * glyph;
      cwS.color = mix(cwS.color, signCol, band);
      cwS.rough = mix(cwS.rough, 0.5, band);
      cwEmit += band * signCol * uNight * uSignage * 1.1;
    }
  }
} else if (cwSurf == 1) {
  // Flat roof: gravel-ish, slightly mottled.
  cwS.color *= 0.8 + 0.25 * cwNoise(vCwWPos.xz * 0.35);
} else if (cwSurf == 5) {
  // Canvas awning: striped along the shopfront, slightly translucent to the shop light below it.
  float stripe = step(0.5, fract(vCwA.x / 0.42));
  cwS.color = mix(vCwColor, vec3(0.86, 0.84, 0.78), stripe * step(0.5, cwSeed));
  cwS.color *= 0.85 + 0.15 * cwNoise(vCwWPos.xz * 3.0);
  cwS.rough = 0.92; cwS.metal = 0.0; cwS.height = 0.0;
  cwEmit += cwS.color * 0.12 * uNight;
} else if (cwSurf == 4) {
  // Illuminated blade sign: one character cell per 0.85 m of height, each a hashed 4x4 block glyph.
  float row = vCwA.y / 0.85;
  vec2 sub = floor(vec2(clamp(vCwA.x, 0.0, 0.99) * 4.4, fract(row) * 5.0));
  float on = step(0.42, cwHash(sub + floor(row) * 7.0 + cwSeed * 37.0)) * step(0.5, sub.y) * step(sub.x, 3.5);
  float fwS = fwidth(vCwA.y) * 5.0;
  on = mix(on, 0.45, smoothstep(0.3, 0.9, fwS));
  vec3 col = vCwColor * mix(0.22, 1.0, on) * step(0.2, cwNh);
  cwS.color = col * 0.7 + 0.03;
  cwS.rough = 0.4; cwS.metal = 0.0; cwS.height = 0.0;
  cwEmit += col * (0.15 + 1.3 * uNight);
}

diffuseColor.rgb = cwS.color;
float cwRough = cwS.rough;
float cwMetal = cwS.metal;
float cwHeight = cwS.height;
float cwBumpK = 0.012 * cwDetail;
float cwUseN = 0.0;
vec3 cwWorldN = vec3(0.0, 1.0, 0.0);
`;

export const GROUND_FRAGMENT_DECL = /* glsl */ `
uniform mat4 uInvViewProj;
uniform mat4 uViewProj;
uniform vec2 uViewport;
varying vec4 vCwA;
flat varying float vCwB;
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
// Depth of the ground plane under this pixel, from the pixel position alone. Every
// ground triangle covering the pixel computes the identical value, so overlapping
// layers tie exactly and draw order decides which one shows.
{
  vec2 cwNdc = gl_FragCoord.xy / uViewport * 2.0 - 1.0;
  vec4 cwFar = uInvViewProj * vec4(cwNdc, 1.0, 1.0);
  vec3 cwRay = cwFar.xyz / cwFar.w - cameraPosition;
  if (cwRay.y < -1e-6) {
    vec4 cwClip = uViewProj * vec4(cameraPosition + cwRay * (-cameraPosition.y / cwRay.y), 1.0);
    gl_FragDepth = clamp(cwClip.z / cwClip.w * 0.5 + 0.5, 0.0, 1.0);
  } else {
    gl_FragDepth = gl_FragCoord.z;
  }
}
vec3 cwV = normalize(cameraPosition - vCwWPos);
float cwDist = length(cameraPosition - vCwWPos);
float cwDetail = 1.0 - smoothstep(40.0, 160.0, cwDist);
int cwMat = int(vCwA.x + 0.5);
CwSurface cwS = cwMaterial(cwMat, vCwWPos.xz, vCwColor, cwDetail);
vec3 cwEmit = vec3(0.0);
float cwBumpK = 0.01 * cwDetail;
float cwUseN = 0.0;
vec3 cwWorldN = vec3(0.0, 1.0, 0.0);
// Ground between buildings sees only a strip of sky.
float cwAO = 1.0 - 0.3 * uStreetAO;
float ac = vCwA.y;
float al = vCwA.z;
float hw = vCwB;
vec2 gp = vCwWPos.xz;
float gfw = max(fwidth(gp.x), fwidth(gp.y)) + 1e-4;
float gNear = 1.0 - smoothstep(0.03, 0.2, gfw);          // 1 where centimetre detail resolves
// Standing water collects in the same low spots every time; how much of it is a district property.
float cwWet = smoothstep(mix(0.92, 0.5, uWet), mix(1.0, 0.68, uWet), cwFbm(gp * 0.11 + 4.0)) * step(0.01, uWet);
if (cwMat == 5) {
  // Worn asphalt: broad tonal drift, rectangular repair patches, meandering cracks, manhole covers.
  cwS.color *= 0.88 + 0.26 * cwFbm(gp * 0.07);
  vec2 pc = gp / vec2(7.0, 11.0);
  vec2 pi = floor(pc), pf = fract(pc);
  vec2 sz = 0.18 + 0.27 * vec2(cwHash(pi + 3.0), cwHash(pi + 7.0));
  float repair = step(cwHash(pi + 2.0), 0.24) * cwBox(pf.x - 0.5, sz.x, gfw / 7.0) * cwBox(pf.y - 0.5, sz.y, gfw / 11.0);
  cwS.color *= mix(1.0, 0.76 + 0.36 * cwHash(pi + 11.0), repair * (1.0 - smoothstep(0.3, 2.0, gfw)));
  float crack = (1.0 - smoothstep(0.0, 0.006 + gfw * 0.25, abs(cwFbm(gp * 0.22 + 9.0) - 0.5)))
    * smoothstep(0.42, 0.6, cwNoise(gp * 0.05 + 3.0)) * gNear;
  cwS.color *= 1.0 - 0.6 * crack;
  cwS.height -= crack * 2.0;
  vec2 mc = gp / 27.0;
  vec2 mi = floor(mc);
  float md = length((fract(mc) - (0.25 + 0.5 * vec2(cwHash(mi + 5.0), cwHash(mi + 9.0)))) * 27.0);
  float cover = step(cwHash(mi + 1.0), 0.5) * (1.0 - smoothstep(0.37 - gfw, 0.37 + gfw, md)) * (1.0 - smoothstep(0.15, 0.7, gfw));
  cwS.color = mix(cwS.color, vec3(0.085, 0.08, 0.075) * (0.7 + 0.3 * step(0.5, fract(md * 9.0))), cover);
  cwS.rough = mix(cwS.rough, 0.45, cover);
  cwS.metal = cover * 0.7;
}
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
  // Tyre-polished wheel tracks, an oil-dark strip down each lane, and damp gutters.
  float lane = abs(fract(abs(ac) / 3.2) - 0.5) * 3.2;
  cwS.rough -= 0.12 * (1.0 - smoothstep(0.0, 0.9, lane - 0.3));
  cwS.color *= 1.0 - 0.1 * (1.0 - smoothstep(0.0, 0.5, lane)) * (0.5 + cwNoise(vec2(ac, al * 0.15)));
  float gutter = smoothstep(hw - 1.1, hw - 0.15, abs(ac));
  cwS.color *= 1.0 - 0.18 * gutter;
  cwWet = max(cwWet, gutter * uWet * smoothstep(0.35, 0.65, cwNoise(vec2(al * 0.08, ac))));
} else if (cwMat == 12 && abs(ac) <= hw + 0.01) {
  float fwA = fwidth(ac) + 1e-4;
  float fade = 1.0 - smoothstep(0.05, 0.25, fwA);
  float sleeper = step(fract(al / 0.65), 0.38) * cwBox(ac, 1.25, fwA);
  cwS.color = mix(cwS.color, vec3(0.2, 0.17, 0.14), sleeper * fade * 0.8);
  float rail = cwBox(abs(ac) - 0.72, 0.04, fwA) * fade;
  cwS.color = mix(cwS.color, vec3(0.42, 0.43, 0.45), rail);
  cwS.rough = mix(cwS.rough, 0.3, rail);
  cwS.metal = rail;
} else if (cwMat == 9) {
  cwS.color *= 0.9 + 0.2 * cwFbm(gp * 0.09 + 2.0);
  // Old chewing gum and stains.
  cwS.color *= 1.0 - 0.28 * step(0.988, cwHash(floor(gp * 8.0))) * gNear;
  if (abs(ac) <= hw + 0.01) {
    // The sidewalk ribbon is the road plus a strip each side: draw the kerb where the two meet.
    float fwA = fwidth(ac) + 1e-4;
    float e = abs(ac) - (hw - 2.2);
    float kerb = cwBand(e, 0.0, 0.17, fwA);
    cwS.color = mix(cwS.color, vCwColor * (1.12 + 0.1 * cwNoise(vec2(al * 0.5, 0.0))), kerb);
    cwS.color *= 1.0 - 0.5 * cwBox(e + 0.01, 0.03, fwA) - 0.22 * cwBox(e - 0.18, 0.012, fwA);
    cwS.color *= mix(1.0, 0.86, step(e, 0.0));          // gutter apron under the kerb line
  }
  cwWet *= 0.5;
} else if (cwMat == 11) {
  // Water: two drifting noise fields give an analytic surface normal; the sky
  // reflection and sun glitter then come from the environment and the sun light.
  vec2 wp = vCwWPos.xz;
  vec2 d1 = uTime * vec2(0.09, 0.05);
  vec2 d2 = uTime * vec2(-0.07, 0.11);
  const float e = 0.3;
  float h0 = cwFbm(wp * 0.45 + d1) + 0.5 * cwFbm(wp * 1.3 + d2);
  float hx = cwFbm((wp + vec2(e, 0.0)) * 0.45 + d1) + 0.5 * cwFbm((wp + vec2(e, 0.0)) * 1.3 + d2);
  float hz = cwFbm((wp + vec2(0.0, e)) * 0.45 + d1) + 0.5 * cwFbm((wp + vec2(0.0, e)) * 1.3 + d2);
  float amp = 0.5 * (1.0 - smoothstep(60.0, 350.0, cwDist)) + 0.06;
  cwWorldN = normalize(vec3(-(hx - h0) / e * amp, 1.0, -(hz - h0) / e * amp));
  cwUseN = 1.0;
  cwS.color = vCwColor * 0.3;
  cwS.rough = 0.05;
  cwBumpK = 0.0;
  cwAO = 1.0;
}
if (cwMat == 5 || cwMat == 9) {
  // Puddles: dark, mirror-smooth, flat.
  cwS.color *= mix(1.0, 0.5, cwWet);
  cwS.rough = mix(cwS.rough, 0.035, cwWet);
  cwS.height *= 1.0 - cwWet;
}
diffuseColor.rgb = cwS.color;
float cwRough = cwS.rough;
float cwMetal = cwS.metal;
float cwHeight = cwS.height;
`;
