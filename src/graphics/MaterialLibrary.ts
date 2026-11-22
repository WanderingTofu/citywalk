import * as THREE from 'three';
import type { StyleConfig } from '../districts/StyleConfig';
import {
  FACADE_FRAGMENT_BODY,
  FACADE_FRAGMENT_DECL,
  GROUND_FRAGMENT_BODY,
  GROUND_FRAGMENT_DECL,
  VERTEX_BODY,
  VERTEX_DECL,
} from './shaders';

/**
 * The whole world is drawn with the handful of materials created here.
 * Buildings share one material, the ground shares one, props share two.
 * Variation comes from vertex attributes and shared uniforms, never from
 * per-object materials, so shader programs and GPU state changes stay
 * constant no matter how much city is loaded.
 *
 * All of them are three.js standard PBR materials with extra shading injected,
 * so they are lit by the same sun, shadows and sky-derived environment map.
 */

export interface SharedUniforms {
  uNight: { value: number };
  uTime: { value: number };
  uSignage: { value: number };
  uLit: { value: number };
  uWarmth: { value: number };
  uWeather: { value: number };
  /** How enclosed the streets are, 0..1: dims skylight on the ground and lower walls. */
  uStreetAO: { value: number };
  /** Camera matrices and drawing-buffer size, for the ground's analytic depth. */
  uInvViewProj: { value: THREE.Matrix4 };
  uViewProj: { value: THREE.Matrix4 };
  uViewport: { value: THREE.Vector2 };
  /** Standing water on the streets, 0..1. */
  uWet: { value: number };
  /** 0 = stone setts, 1 = concrete slabs. */
  uPaving: { value: number };
  /** Sky radiance overhead, for window reflections. */
  uSkyZenith: { value: THREE.Color };
  /** Haze colour when looking toward the light source. */
  uFogSun: { value: THREE.Color };
  /** Direction to the light source in view space. */
  uSunDirView: { value: THREE.Vector3 };
}

const FOG_DECL = /* glsl */ `
uniform vec3 uFogSun;
uniform vec3 uSunDirView;
`;

/** Fog whose colour depends on view direction: haze glows toward the sun, as real aerosols do. */
const FOG_BODY = /* glsl */ `
#ifdef USE_FOG
  float cwFogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  float cwFogS = pow(max(dot(normalize(-vViewPosition), uSunDirView), 0.0), 6.0);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, mix(fogColor, uFogSun, cwFogS), cwFogF);
#endif
`;

function patchFog(shader: { fragmentShader: string; uniforms: Record<string, THREE.IUniform> }, u: SharedUniforms): void {
  shader.uniforms.uFogSun = u.uFogSun;
  shader.uniforms.uSunDirView = u.uSunDirView;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${FOG_DECL}`)
    .replace('#include <fog_fragment>', FOG_BODY);
}

function patchSurface(
  material: THREE.MeshStandardMaterial,
  uniforms: SharedUniforms,
  vertexDecl: string,
  vertexBody: string,
  fragmentDecl: string,
  fragmentBody: string,
  extraVertex = '',
): void {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexDecl}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${vertexBody}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${extraVertex}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragmentDecl}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${fragmentBody}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = cwRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = cwMetal;')
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        if (cwUseN > 0.5) normal = normalize((viewMatrix * vec4(cwWorldN, 0.0)).xyz);
        else if (cwBumpK > 0.0) normal = cwBump(normal, -vViewPosition, cwHeight, cwBumpK);`,
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += cwEmit;')
      // Occlusion applies to skylight only, never to direct sun.
      .replace(
        '#include <aomap_fragment>',
        '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= cwAO;\nreflectedLight.indirectSpecular *= mix(cwAO, 1.0, 0.5);',
      );
    patchFog(shader, uniforms);
  };
}

export class MaterialLibrary {
  readonly uniforms: SharedUniforms = {
    uNight: { value: 0 },
    uTime: { value: 0 },
    uSignage: { value: 0.5 },
    uLit: { value: 0.5 },
    uWarmth: { value: 0.5 },
    uWeather: { value: 0.4 },
    uStreetAO: { value: 0.5 },
    uInvViewProj: { value: new THREE.Matrix4() },
    uViewProj: { value: new THREE.Matrix4() },
    uViewport: { value: new THREE.Vector2(1, 1) },
    uWet: { value: 0.25 },
    uPaving: { value: 1 },
    uSkyZenith: { value: new THREE.Color(0.2, 0.3, 0.5) },
    uFogSun: { value: new THREE.Color(1, 1, 1) },
    uSunDirView: { value: new THREE.Vector3(0, 1, 0) },
  };

  /** All building surfaces: walls, roofs, rooftop plant, signs. */
  readonly facade: THREE.MeshStandardMaterial;
  /** All ground surfaces: slab, parks, water, paths, roads, rail. */
  readonly ground: THREE.MeshStandardMaterial;
  readonly tree: THREE.MeshStandardMaterial;
  readonly lamp: THREE.MeshStandardMaterial;
  private foliage = new Map<THREE.Texture, THREE.MeshStandardMaterial>();
  /** Parked cars: glossy paint tinted per instance. */
  readonly car: THREE.MeshPhysicalMaterial;
  /** Additive pool of light under each street lamp. */
  readonly lampGlow: THREE.ShaderMaterial;

  constructor() {
    const u = this.uniforms;
    this.facade = new THREE.MeshStandardMaterial({ name: 'cw-facade' });
    patchSurface(this.facade, u, VERTEX_DECL('vec3', 'vec4', true), VERTEX_BODY(true), FACADE_FRAGMENT_DECL, FACADE_FRAGMENT_BODY);
    this.facade.customProgramCacheKey = () => 'cw-facade';

    this.ground = new THREE.MeshStandardMaterial({ name: 'cw-ground' });
    patchSurface(
      this.ground, u, VERTEX_DECL('vec4', 'float', false), VERTEX_BODY(false), GROUND_FRAGMENT_DECL, GROUND_FRAGMENT_BODY,
    );
    this.ground.customProgramCacheKey = () => 'cw-ground';

    this.tree = new THREE.MeshStandardMaterial({ name: 'cw-tree', vertexColors: true, roughness: 0.9, metalness: 0 });
    this.tree.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = u.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace(
          '#include <begin_vertex>',
          // Wind: the whole crown leans and each part of it flutters, more the higher up it is.
          `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vec3 cwRoot = instanceMatrix[3].xyz;
            float cwLift = max(position.y - 2.2, 0.0);
            float cwPhase = cwRoot.x * 0.31 + cwRoot.z * 0.23;
            transformed.x += (sin(uTime * 1.3 + cwPhase) * 0.035 + sin(uTime * 4.1 + position.z * 3.0 + cwPhase) * 0.012) * cwLift;
            transformed.z += (cos(uTime * 1.1 + cwPhase * 1.7) * 0.028 + sin(uTime * 3.7 + position.x * 3.0) * 0.012) * cwLift;
          #endif`,
        );
      patchFog(shader, u);
    };
    this.tree.customProgramCacheKey = () => 'cw-tree';

    this.lamp = new THREE.MeshStandardMaterial({ name: 'cw-lamp', vertexColors: true, roughness: 0.6, metalness: 0.4 });
    this.lamp.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = u.uNight;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uNight;')
        .replace(
          '#include <emissivemap_fragment>',
          // The lamp head is the only bright-coloured part of the geometry.
          '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vColor.rgb * step(0.9, vColor.r) * (0.1 + 2.5 * uNight);',
        );
      patchFog(shader, u);
    };
    this.lamp.customProgramCacheKey = () => 'cw-lamp';

    // Paint is a dielectric under a lacquer, so it gets a clearcoat rather than metalness.
    // The vehicle meshes tag their parts by vertex colour: pure white is paint (tinted per
    // instance), bluish-black is glass, everything else keeps its own colour.
    this.car = new THREE.MeshPhysicalMaterial({ name: 'cw-car', vertexColors: true, clearcoat: 1, clearcoatRoughness: 0.07 });
    this.car.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vCwPaint;\nvarying float vCwGlass;')
        .replace(
          '#include <color_vertex>',
          `#include <color_vertex>
          vCwPaint = step(0.99, min(color.r, min(color.g, color.b)));
          vCwGlass = step(color.r, 0.05) * step(color.r * 1.25, color.b);
          #ifdef USE_INSTANCING_COLOR
            vColor.rgb = mix(color.rgb, instanceColor.rgb, vCwPaint);
          #endif`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vCwPaint;\nvarying float vCwGlass;')
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(mix(0.7, 0.06, vCwGlass), 0.38, vCwPaint);')
        .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = mix(mix(0.1, 0.6, vCwGlass), 0.15, vCwPaint);')
        .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\nmaterial.clearcoat *= vCwPaint;\n#endif');
      patchFog(shader, u);
    };
    this.car.customProgramCacheKey = () => 'cw-car';

    this.lampGlow = new THREE.ShaderMaterial({
      name: 'cw-lamp-glow',
      uniforms: { uNight: u.uNight, uWarmth: u.uWarmth },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          gl_Position.z -= 4e-5 * gl_Position.w;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uNight;
        uniform float uWarmth;
        varying vec2 vUv;
        void main() {
          float d = length(vUv - 0.5) * 2.0;
          float a = pow(max(1.0 - d, 0.0), 2.2);
          vec3 col = mix(vec3(0.8, 0.9, 1.0), vec3(1.0, 0.72, 0.4), uWarmth);
          gl_FragColor = vec4(col * a * uNight * 0.12, 1.0);
        }`,
    });
  }

  /**
   * Material for grown trees: alpha-tested leaf cards and bark from one atlas,
   * swaying in the same wind as the distant stand-ins.
   */
  foliageMaterial(atlas: THREE.Texture): THREE.MeshStandardMaterial {
    let m = this.foliage.get(atlas);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        name: 'cw-foliage', map: atlas, alphaTest: 0.42, side: THREE.DoubleSide, vertexColors: true, roughness: 0.85, metalness: 0,
      });
      m.onBeforeCompile = this.tree.onBeforeCompile;
      m.customProgramCacheKey = () => 'cw-foliage';
      this.foliage.set(atlas, m);
    }
    return m;
  }

  /** Per-frame camera state for shaders that reconstruct positions from pixels. */
  setCamera(camera: THREE.PerspectiveCamera, bufferWidth: number, bufferHeight: number): void {
    const u = this.uniforms;
    u.uViewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    u.uInvViewProj.value.multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
    u.uViewport.value.set(bufferWidth, bufferHeight);
  }

  /** District style -> shader parameters. Geometry is untouched. */
  applyStyle(style: StyleConfig): void {
    const a = style.atmosphere;
    this.uniforms.uSignage.value = a.signageDensity;
    this.uniforms.uLit.value = a.litWindows;
    this.uniforms.uWarmth.value = a.lightWarmth;
    this.uniforms.uWeather.value = a.weathering;
    this.uniforms.uStreetAO.value = a.enclosure;
    this.uniforms.uWet.value = style.ground.wetness;
    this.uniforms.uPaving.value = style.ground.paving === 'slabs' ? 1 : 0;
  }

  dispose(): void {
    this.facade.dispose();
    this.ground.dispose();
    this.tree.dispose();
    for (const m of this.foliage.values()) m.dispose();
    this.lamp.dispose();
    this.car.dispose();
    this.lampGlow.dispose();
  }
}
