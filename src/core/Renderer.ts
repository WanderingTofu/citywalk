import * as THREE from 'three';
import { PostFX } from '../graphics/PostFX';

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
  private post: PostFX | null = null;
  private wantPost = false;
  private wantAO = false;
  /** When false the internal resolution never changes (benchmarks, screenshots). */
  adaptive = true;
  private maxPixelRatio = 1.5;
  private scale = 1;
  private slowTime = 0;
  private fastTime = 0;
  private width = 1;
  private height = 1;
  private frameStats: RenderStats = { drawCalls: 0, triangles: 0, geometries: 0, textures: 0, programs: 0, pixelRatio: 1 };

  constructor(container: HTMLElement) {
    this.three = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', stencil: false });
    this.three.outputColorSpace = THREE.SRGBColorSpace;
    // AgX rolls bright colours off toward white instead of clipping their hue.
    this.three.toneMapping = THREE.AgXToneMapping;
    this.three.shadowMap.enabled = true;
    this.three.shadowMap.type = THREE.PCFShadowMap;
    // Several passes make up one frame; statistics are reset once per frame by hand.
    this.three.info.autoReset = false;
    this.canvas = this.three.domElement;
    container.appendChild(this.canvas);
  }

  /** Pixel width of the drawing buffer. */
  get drawingWidth(): number {
    return Math.floor(this.width * this.three.getPixelRatio());
  }

  /** Pixel height of the drawing buffer, for footprint-based antialiasing. */
  get drawingHeight(): number {
    return Math.floor(this.height * this.three.getPixelRatio());
  }

  setMaxPixelRatio(max: number): void {
    this.maxPixelRatio = max;
    this.scale = 1;
    this.applySize();
  }

  /** Turn HDR post-processing on or off; the pipeline is built on the next frame. */
  setPostProcessing(on: boolean, ambientOcclusion = false): void {
    const changed = on !== this.wantPost || ambientOcclusion !== this.wantAO;
    this.wantPost = on;
    this.wantAO = ambientOcclusion;
    if (changed && this.post) {
      this.post.dispose();
      this.post = null;
    }
  }

  private applySize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);
    const ratio = Math.max(0.5, dpr * this.scale);
    this.three.setPixelRatio(ratio);
    this.three.setSize(this.width, this.height, true);
    this.post?.setSize(this.width, this.height, ratio);
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.applySize();
  }

  /** Feed the frame time; adjusts internal resolution with hysteresis. */
  adapt(dt: number): void {
    if (!this.adaptive) return;
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
      this.applySize();
    } else if (this.fastTime > 4 && this.scale < 1) {
      this.scale = Math.min(1, this.scale / 0.9);
      this.fastTime = 0;
      this.applySize();
    }
  }

  set exposure(v: number) {
    this.three.toneMappingExposure = v;
  }

  set bloom(v: number) {
    if (this.post) this.post.bloomStrength = v;
  }

  /** Call once at the start of a frame, before any pass draws. */
  beginFrame(): void {
    this.three.info.reset();
  }

  render(scene: THREE.Scene, camera: THREE.Camera, dt: number): void {
    if (this.wantPost && !this.post) {
      this.post = new PostFX(this.three, scene, camera, this.wantAO);
      this.post.setSize(this.width, this.height, this.three.getPixelRatio());
    }
    if (this.post) this.post.render(dt);
    else this.three.render(scene, camera);

    const info = this.three.info;
    this.frameStats = {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      pixelRatio: this.three.getPixelRatio(),
    };
  }

  get stats(): RenderStats {
    return this.frameStats;
  }

  dispose(): void {
    this.post?.dispose();
    this.three.dispose();
    this.canvas.remove();
  }
}
