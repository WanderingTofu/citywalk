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
 */

export interface SharedUniforms {
  uNight: { value: number };
  uTime: { value: number };
  uSignage: { value: number };
  uLit: { value: number };
  uWarmth: { value: number };
  uWeather: { value: number };
  uSkyTop: { value: THREE.Color };
  uSkyHorizon: { value: THREE.Color };
}

function patch(
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
        '#include <normal_fragment_maps>\nif (cwBumpK > 0.0) normal = cwBump(normal, -vViewPosition, cwHeight, cwBumpK);',
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += cwEmit;');
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
    uSkyTop: { value: new THREE.Color(0.2, 0.4, 0.8) },
    uSkyHorizon: { value: new THREE.Color(0.7, 0.8, 0.9) },
  };

  /** All building surfaces: walls, roofs, rooftop plant, signs. */
  readonly facade: THREE.MeshStandardMaterial;
  /** All ground surfaces: slab, parks, water, paths, roads, rail. */
  readonly ground: THREE.MeshStandardMaterial;
  readonly tree: THREE.MeshStandardMaterial;
  readonly lamp: THREE.MeshStandardMaterial;
  /** Additive pool of light under each street lamp. */
  readonly lampGlow: THREE.ShaderMaterial;

  constructor() {
    this.facade = new THREE.MeshStandardMaterial({ name: 'cw-facade' });
    patch(this.facade, this.uniforms, VERTEX_DECL('vec3', 'vec4', true), VERTEX_BODY(true), FACADE_FRAGMENT_DECL, FACADE_FRAGMENT_BODY);
    this.facade.customProgramCacheKey = () => 'cw-facade';

    this.ground = new THREE.MeshStandardMaterial({ name: 'cw-ground' });
    patch(
      this.ground, this.uniforms, VERTEX_DECL('vec4', 'float', false), VERTEX_BODY(false), GROUND_FRAGMENT_DECL, GROUND_FRAGMENT_BODY,
      // Stacked ground layers share y = 0; a constant clip-space bias per layer orders them without z-fighting.
      'gl_Position.z -= cwA.w * 6e-6 * gl_Position.w;',
    );
    this.ground.customProgramCacheKey = () => 'cw-ground';

    this.tree = new THREE.MeshStandardMaterial({ name: 'cw-tree', vertexColors: true, roughness: 0.95, metalness: 0 });

    this.lamp = new THREE.MeshStandardMaterial({ name: 'cw-lamp', vertexColors: true, roughness: 0.6, metalness: 0.4 });
    const u = this.uniforms;
    this.lamp.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = u.uNight;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uNight;')
        .replace(
          '#include <emissivemap_fragment>',
          // The lamp head is the only bright-coloured part of the geometry.
          '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vColor.rgb * step(0.9, vColor.r) * (0.15 + 3.0 * uNight);',
        );
    };
    this.lamp.customProgramCacheKey = () => 'cw-lamp';

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
          gl_FragColor = vec4(col * a * uNight * 0.55, 1.0);
        }`,
    });
  }

  /** District style -> shader parameters. Geometry is untouched. */
  applyStyle(style: StyleConfig): void {
    const a = style.atmosphere;
    this.uniforms.uSignage.value = a.signageDensity;
    this.uniforms.uLit.value = a.litWindows;
    this.uniforms.uWarmth.value = a.lightWarmth;
    this.uniforms.uWeather.value = a.weathering;
  }

  dispose(): void {
    this.facade.dispose();
    this.ground.dispose();
    this.tree.dispose();
    this.lamp.dispose();
    this.lampGlow.dispose();
  }
}
