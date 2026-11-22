import * as THREE from 'three';

export interface RenderStats {
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  pixelRatio: number;
}

/**
 * Thin wrapper around the GPU backend. The rest of the engine talks to this
 * class and to three.js scene objects, not to WebGL, so the backend can be
 * swapped for three's WebGPURenderer later without touching world code.
 *
 * Also owns dynamic resolution: when frames run long the internal resolution
 * drops a step, and it climbs back when there is headroom.
 */
export class Renderer {
  readonly three: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  private maxPixelRatio = 1.5;
  private scale = 1;
  private slowTime = 0;
  private fastTime = 0;

  constructor(container: HTMLElement) {
    this.three = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', stencil: false });
    this.three.outputColorSpace = THREE.SRGBColorSpace;
    this.three.toneMapping = THREE.ACESFilmicToneMapping;
    this.three.shadowMap.enabled = true;
    this.three.shadowMap.type = THREE.PCFShadowMap;
    this.canvas = this.three.domElement;
    container.appendChild(this.canvas);
  }

  setMaxPixelRatio(max: number): void {
    this.maxPixelRatio = max;
    this.scale = 1;
    this.applyPixelRatio();
  }

  private applyPixelRatio(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);
    this.three.setPixelRatio(Math.max(0.5, dpr * this.scale));
  }

  resize(width: number, height: number): void {
    this.applyPixelRatio();
    this.three.setSize(width, height, true);
  }

  /** Feed the frame time; adjusts internal resolution with hysteresis. */
  adapt(dt: number): void {
    if (dt > 1 / 28) {
      this.slowTime += dt;
      this.fastTime = 0;
    } else if (dt < 1 / 50) {
      this.fastTime += dt;
      this.slowTime = 0;
    } else {
      this.slowTime = this.fastTime = 0;
    }
    if (this.slowTime > 1.5 && this.scale > 0.55) {
      this.scale = Math.max(0.55, this.scale * 0.85);
      this.slowTime = 0;
      this.applyPixelRatio();
    } else if (this.fastTime > 4 && this.scale < 1) {
      this.scale = Math.min(1, this.scale / 0.9);
      this.fastTime = 0;
      this.applyPixelRatio();
    }
  }

  set exposure(v: number) {
    this.three.toneMappingExposure = v;
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.three.render(scene, camera);
  }

  get stats(): RenderStats {
    const info = this.three.info;
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      pixelRatio: this.three.getPixelRatio(),
    };
  }

  dispose(): void {
    this.three.dispose();
    this.canvas.remove();
  }
}
