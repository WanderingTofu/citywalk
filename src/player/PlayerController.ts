import * as THREE from 'three';
import type { CollisionSystem } from './CollisionSystem';

export interface PlayerSettings {
  eyeHeight: number;
  walkSpeed: number;
  sprintSpeed: number;
  jumpSpeed: number;
  gravity: number;
  radius: number;
  mouseSensitivity: number;
}

export const DEFAULT_PLAYER: PlayerSettings = {
  eyeHeight: 1.7,
  walkSpeed: 5,
  sprintSpeed: 13,
  jumpSpeed: 6.6,
  gravity: 20,
  radius: 0.38,
  mouseSensitivity: 0.0022,
};

const KEY_FORWARD = ['KeyW', 'ArrowUp'];
const KEY_BACK = ['KeyS', 'ArrowDown'];
const KEY_LEFT = ['KeyA', 'ArrowLeft'];
const KEY_RIGHT = ['KeyD', 'ArrowRight'];

/**
 * First-person walking with an optional third-person chase camera.
 * Movement is integrated in small substeps against the collision system so
 * the player slides along walls and cannot tunnel through them at sprint speed.
 */
export class PlayerController {
  /** Feet position in city-local meters. */
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  /** Unit horizontal view direction. */
  readonly forward = new THREE.Vector3(0, 0, -1);
  yaw = 0;
  pitch = 0;
  thirdPerson = false;
  settings: PlayerSettings = { ...DEFAULT_PLAYER };
  onLockChange: (locked: boolean) => void = () => {};

  private keys = new Set<string>();
  private grounded = true;
  private dragging = false;
  private cameraY = 0;
  private readonly avatar: THREE.Mesh;
  private readonly probe = { x: 0, z: 0 };
  private readonly listeners: Array<() => void> = [];

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly dom: HTMLElement,
    private readonly collision: CollisionSystem,
    scene: THREE.Scene,
  ) {
    this.avatar = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.3, 1.1, 4, 10),
      new THREE.MeshStandardMaterial({ color: 0xd9412b, roughness: 0.6 }),
    );
    this.avatar.castShadow = true;
    this.avatar.visible = false;
    scene.add(this.avatar);
    this.bind();
  }

  get locked(): boolean {
    return document.pointerLockElement === this.dom;
  }

  private on<K extends keyof DocumentEventMap>(target: Document | HTMLElement | Window, type: K, fn: (e: DocumentEventMap[K]) => void): void {
    target.addEventListener(type, fn as EventListener);
    this.listeners.push(() => target.removeEventListener(type, fn as EventListener));
  }

  private bind(): void {
    this.on(document, 'keydown', (e) => {
      if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
      this.keys.add(e.code);
      if (e.code === 'KeyV') this.thirdPerson = !this.thirdPerson;
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    this.on(document, 'keyup', (e) => this.keys.delete(e.code));
    this.on(window, 'blur' as keyof DocumentEventMap, () => this.keys.clear());
    this.on(document, 'pointerlockchange', () => {
      if (!this.locked) this.keys.clear();
      this.onLockChange(this.locked);
    });
    this.on(this.dom, 'mousedown', () => {
      this.dragging = true;
      // Pointer lock can be refused (iframes, automation); drag-to-look still works then.
      if (!this.locked) this.dom.requestPointerLock?.()?.catch?.(() => {});
    });
    this.on(document, 'mouseup', () => (this.dragging = false));
    this.on(document, 'mousemove', (e) => {
      if (!this.locked && !this.dragging) return;
      this.yaw -= e.movementX * this.settings.mouseSensitivity;
      this.pitch -= e.movementY * this.settings.mouseSensitivity;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch));
    });
  }

  /** Place the player. Heading is degrees clockwise from north. */
  teleport(x: number, z: number, headingDeg?: number): void {
    this.position.set(x, 0, z);
    this.velocity.set(0, 0, 0);
    this.grounded = true;
    this.cameraY = this.settings.eyeHeight;
    if (headingDeg !== undefined) {
      this.yaw = (-headingDeg * Math.PI) / 180;
      this.pitch = 0;
    }
  }

  /** Programmatic input, used by automated walkthroughs. */
  setKey(code: string, down: boolean): void {
    if (down) this.keys.add(code);
    else this.keys.delete(code);
  }

  private pressed(codes: string[]): boolean {
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  update(dt: number): void {
    const s = this.settings;
    // yaw = 0 looks north (-Z); positive yaw turns left (counter-clockwise from above).
    this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const rightX = -this.forward.z;
    const rightZ = this.forward.x;

    let mx = 0;
    let mz = 0;
    if (this.pressed(KEY_FORWARD)) mz += 1;
    if (this.pressed(KEY_BACK)) mz -= 1;
    if (this.pressed(KEY_RIGHT)) mx += 1;
    if (this.pressed(KEY_LEFT)) mx -= 1;
    const len = Math.hypot(mx, mz);
    const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? s.sprintSpeed : s.walkSpeed;
    let tx = 0;
    let tz = 0;
    if (len > 0) {
      tx = ((this.forward.x * mz + rightX * mx) / len) * speed;
      tz = ((this.forward.z * mz + rightZ * mx) / len) * speed;
    }
    // Quick but not instant acceleration; less control in the air.
    const k = 1 - Math.exp(-dt * (this.grounded ? 12 : 3));
    this.velocity.x += (tx - this.velocity.x) * k;
    this.velocity.z += (tz - this.velocity.z) * k;

    if (this.grounded && this.keys.has('Space')) {
      this.velocity.y = s.jumpSpeed;
      this.grounded = false;
    }
    if (!this.grounded) this.velocity.y -= s.gravity * dt;

    // Substep so each move is shorter than the collision radius.
    const travel = Math.hypot(this.velocity.x, this.velocity.z) * dt;
    const steps = Math.max(1, Math.ceil(travel / (s.radius * 0.6)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.probe.x = this.position.x + this.velocity.x * h;
      this.probe.z = this.position.z + this.velocity.z * h;
      const before = { x: this.probe.x, z: this.probe.z };
      if (this.collision.resolve(this.probe, s.radius, this.position.y, this.position.y + s.eyeHeight + 0.1)) {
        // Remove the velocity component that was pushing into the wall.
        const nx = this.probe.x - before.x;
        const nz = this.probe.z - before.z;
        const nl = Math.hypot(nx, nz);
        if (nl > 1e-6) {
          const into = (this.velocity.x * nx + this.velocity.z * nz) / nl;
          if (into < 0) {
            this.velocity.x -= (nx / nl) * into;
            this.velocity.z -= (nz / nl) * into;
          }
        }
      }
      this.position.x = this.probe.x;
      this.position.z = this.probe.z;
    }

    // Ground: the world is flat at y = 0 (terrain elevation is not modelled yet).
    this.position.y += this.velocity.y * dt;
    if (this.position.y <= 0) {
      this.position.y = 0;
      this.velocity.y = 0;
      this.grounded = true;
    }

    this.updateCamera(dt);
  }

  private updateCamera(dt: number): void {
    const s = this.settings;
    const eyeY = this.position.y + s.eyeHeight;
    // Vertical smoothing takes the snap out of landings.
    this.cameraY += (eyeY - this.cameraY) * (1 - Math.exp(-dt * 18));
    if (Math.abs(eyeY - this.cameraY) > 3) this.cameraY = eyeY;

    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    this.avatar.visible = this.thirdPerson;
    if (!this.thirdPerson) {
      this.camera.position.set(this.position.x, this.cameraY, this.position.z);
      return;
    }
    this.avatar.position.set(this.position.x, this.position.y + 0.85, this.position.z);
    // Chase camera: back along the view direction, pulled in if a building is in the way.
    const cp = Math.cos(this.pitch);
    const bx = -this.forward.x * cp;
    const by = Math.sin(-this.pitch);
    const bz = -this.forward.z * cp;
    let dist = 5.5;
    for (let d = 0.5; d <= 5.5; d += 0.5) {
      const y = this.cameraY + 0.4 + by * d;
      if (this.collision.isInside(this.position.x + bx * d, this.position.z + bz * d, Math.max(y, 0.2))) {
        dist = Math.max(0.3, d - 0.5);
        break;
      }
    }
    this.camera.position.set(
      this.position.x + bx * dist,
      Math.max(0.3, this.cameraY + 0.4 + by * dist),
      this.position.z + bz * dist,
    );
  }

  dispose(): void {
    for (const off of this.listeners) off();
    this.avatar.removeFromParent();
    this.avatar.geometry.dispose();
    (this.avatar.material as THREE.Material).dispose();
  }
}
