import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

/** Final look, applied to the tone-mapped image: a little contrast and colour back after AgX, and a soft vignette. */
const GradeShader = {
  name: 'cw-grade',
  uniforms: { tDiffuse: { value: null }, uContrast: { value: 1.1 }, uSaturation: { value: 1.22 }, uVignette: { value: 0.22 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uContrast;
    uniform float uSaturation;
    uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = l + uSaturation * (c - l);
      c = (c - 0.5) * uContrast + 0.5;
      vec2 q = vUv - 0.5;
      c *= 1.0 - dot(q, q) * uVignette;
      // Half a code value of noise hides banding in skies and fog.
      c += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

/**
 * HDR post-processing: the scene is rendered into a multisampled half-float
 * target; ground-truth ambient occlusion adds the contact shadows that anchor
 * buildings, cars and trees to the street; bright parts (sun, signs, lit
 * windows, glints) bloom; and the result is tone mapped and graded once at the
 * end. Skipped entirely on the lowest quality level.
 */
export class PostFX {
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly ao: GTAOPass | null = null;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, ambientOcclusion: boolean) {
    const size = renderer.getSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    if (ambientOcclusion) {
      this.ao = new GTAOPass(scene, camera, size.x, size.y);
      // Occlusion on the scale of kerbs, door recesses and the foot of a wall.
      this.ao.updateGtaoMaterial({ radius: 1.6, distanceExponent: 1.4, thickness: 1.5, scale: 1.25, samples: 12, screenSpaceRadius: false });
      this.ao.blendIntensity = 0.85;
      this.composer.addPass(this.ao);
    }
    // Threshold just above "white wall in sunlight", so only genuine light sources glow.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.2, 0.55, 1.05);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(new ShaderPass(GradeShader));
  }

  set bloomStrength(v: number) {
    this.bloom.strength = v;
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  render(dt: number): void {
    this.composer.render(dt);
  }

  dispose(): void {
    this.ao?.dispose();
    this.composer.dispose();
  }
}
