import * as THREE from 'three';
import type { Lighting } from './Lighting';
import type { SharedUniforms } from './MaterialLibrary';

/**
 * Sky dome and distance fog. The fog is tuned to the streaming range: its
 * density is derived from the farthest LOD distance so chunks appear and
 * disappear inside the haze instead of popping on a clear horizon.
 */
export class Atmosphere {
  readonly fog = new THREE.FogExp2(0xffffff, 0.001);
  private readonly sky: THREE.Mesh;
  private readonly skyUniforms = {
    uTop: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color() },
    uNight: { value: 0 },
  };
  /** District haze, 0..1. */
  haze = 0.5;
  /** Farthest distance at which geometry exists, meters. */
  viewRange = 1000;

  constructor(private readonly scene: THREE.Scene) {
    scene.fog = this.fog;
    const material = new THREE.ShaderMaterial({
      name: 'cw-sky',
      uniforms: this.skyUniforms,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop;
        uniform vec3 uHorizon;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform float uNight;
        varying vec3 vDir;
        float hash(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }
        void main() {
          vec3 d = normalize(vDir);
          float h = max(d.y, 0.0);
          vec3 col = mix(uHorizon, uTop, pow(h, 0.55));
          float s = max(dot(d, uSunDir), 0.0);
          // Glow around the sun plus the disc itself.
          col += uSunColor * (0.35 * pow(s, 12.0) + 0.9 * pow(s, 220.0) + 6.0 * smoothstep(0.9993, 0.9997, s)) * (1.0 - 0.75 * uNight);
          // Stars: sparse hashed cells, only well above the city glow.
          vec2 sp = d.xz / (abs(d.y) + 0.35) * 90.0;
          float star = step(0.9965, hash(floor(sp))) * smoothstep(0.12, 0.5, d.y);
          col += vec3(0.8, 0.85, 1.0) * star * smoothstep(0.6, 1.0, uNight) * 0.45;
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), material);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1000;
    this.sky.matrixAutoUpdate = false;
    scene.add(this.sky);
  }

  update(lighting: Lighting, camera: THREE.Camera, shared: SharedUniforms): void {
    const s = lighting.state;
    this.skyUniforms.uTop.value.copy(s.skyTop);
    this.skyUniforms.uHorizon.value.copy(s.skyHorizon);
    this.skyUniforms.uSunDir.value.copy(lighting.sunDirection);
    this.skyUniforms.uSunColor.value.copy(s.sunColor);
    this.skyUniforms.uNight.value = s.night;
    shared.uSkyTop.value.copy(s.skyTop);
    shared.uSkyHorizon.value.copy(s.skyHorizon);
    shared.uNight.value = s.night;

    this.fog.color.copy(s.fogColor);
    // exp(-(density * range)^2) leaves ~8-20 % visibility at the streaming edge.
    this.fog.density = ((1.25 + 0.5 * this.haze) * s.fog) / this.viewRange;

    this.sky.matrix.makeTranslation(camera.position.x, camera.position.y, camera.position.z);
    this.sky.matrixWorld.copy(this.sky.matrix);
  }

  dispose(): void {
    this.scene.remove(this.sky);
    this.sky.geometry.dispose();
    (this.sky.material as THREE.Material).dispose();
  }
}
