/** 视效层：粒子池 / 刀光弧 / 冲击环 / 篝火 / 雾门 —— onHit 总线的"特效"通道 */
import * as THREE from "three";
import { COLORS } from "./config";

export class Particles {
  private pos: Float32Array;
  private data: { life: number; vx: number; vy: number; vz: number }[];
  private i = 0;
  readonly mesh: THREE.Points;

  constructor(scene: THREE.Scene, n: number, opts: { size: number; color: number; additive?: boolean; gravity?: number }) {
    this.pos = new Float32Array(n * 3);
    this.data = Array.from({ length: n }, () => ({ life: 0, vx: 0, vy: 0, vz: 0 }));
    for (let i = 0; i < n; i++) this.pos[i * 3 + 1] = -999;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    const mat = new THREE.PointsMaterial({
      size: opts.size, color: opts.color, transparent: true, opacity: 0.9,
      depthWrite: false, sizeAttenuation: true,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Points(geo, mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.gravity = opts.gravity ?? 0;
  }
  private gravity: number;

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number): void {
    const i = this.i = (this.i + 1) % this.data.length;
    const d = this.data[i];
    d.life = life; d.vx = vx; d.vy = vy; d.vz = vz;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
  }

  burst(p: THREE.Vector3, n: number, speed: number, life: number, up = 1): void {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const e = (Math.random() - 0.2) * up;
      const s = speed * (0.4 + Math.random() * 0.8);
      const flat = Math.sqrt(Math.max(0, 1 - e * e));
      this.spawn(p.x, p.y, p.z, Math.cos(a) * s * flat, e * s + speed * 0.08, Math.sin(a) * s * flat, life * (0.6 + Math.random() * 0.7));
    }
  }

  update(dt: number): void {
    if (dt <= 0) return;
    let dirty = false;
    for (let i = 0; i < this.data.length; i++) {
      const d = this.data[i];
      if (d.life > 0) {
        dirty = true;
        d.life -= dt;
        d.vy -= this.gravity * dt;
        this.pos[i * 3] += d.vx * dt;
        this.pos[i * 3 + 1] += d.vy * dt;
        this.pos[i * 3 + 2] += d.vz * dt;
        if (this.pos[i * 3 + 1] < 0.03 && this.gravity > 0) { this.pos[i * 3 + 1] = 0.03; d.vy *= -0.3; }
        if (d.life <= 0) this.pos[i * 3 + 1] = -999;
      }
    }
    if (dirty) (this.mesh.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}

interface ArcItem { mesh: THREE.Mesh; life: number; tl: number }

export class Vfx {
  private arcs: ArcItem[] = [];
  private rings: ArcItem[] = [];
  sparks: Particles;
  embers: Particles;
  dust: Particles;

  constructor(private scene: THREE.Scene) {
    this.sparks = new Particles(scene, 260, { size: 0.06, color: 0xffc36a, additive: true, gravity: 9 });
    this.embers = new Particles(scene, 200, { size: 0.05, color: COLORS.ember, additive: true, gravity: -0.4 });
    this.dust = new Particles(scene, 160, { size: 0.14, color: 0x555a60, gravity: 2 });
  }

  private static arcGeo(wide: boolean): THREE.BufferGeometry {
    const t0 = Math.PI / 2 - (wide ? 1.4 : 0.7), tl = wide ? 2.8 : 1.4;
    const g = new THREE.RingGeometry(0.5, 1, 24, 1, t0, tl).toNonIndexed();
    const p = g.attributes.position as THREE.BufferAttribute;
    const arr = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const t = Math.min(1, Math.max(0, ((Math.atan2(p.getY(i), p.getX(i)) - t0 + Math.PI * 4) % (Math.PI * 2)) / tl));
      const k = Math.sin(Math.PI * t);                     // 弧中亮、两端淡出的辉迹
      arr[i * 3] = k; arr[i * 3 + 1] = k * 0.94; arr[i * 3 + 2] = k * 0.82;
    }
    g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
    g.rotateX(-Math.PI / 2);
    return g;
  }

  /** 刀光弧：沿 yaw 方向的水平扇形（辉迹渐变 + 挥出时轻微扩张） */
  slash(pos: THREE.Vector3, yaw: number, radius: number, wide: boolean, color = 0xffd9a0): void {
    const geo = Vfx.arcGeo(wide);
    const mat = new THREE.MeshBasicMaterial({ color, vertexColors: true, transparent: true, opacity: 0.65, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    mesh.rotation.y = yaw + Math.PI;
    mesh.scale.setScalar(radius);
    mesh.userData.target = radius;
    this.scene.add(mesh);
    this.arcs.push({ mesh, life: 0.14, tl: 0.14 });
  }

  /** 冲击环：扩散圆环（下劈震波/变身爆发） */
  ring(pos: THREE.Vector3, radius: number, color = COLORS.ember): void {
    const geo = new THREE.TorusGeometry(1, 0.05, 8, 40);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos); mesh.position.y = 0.06;
    this.scene.add(mesh);
    this.rings.push({ mesh, life: 0.4, tl: 0.4 });
    mesh.userData.target = radius;
  }

  /** 地面残留斑（火痕默认橙；冰霜面传冷色） */
  scorch(pos: THREE.Vector3, r = 1.2, color = 0xff6a20): void {
    const mesh = new THREE.Mesh(
      new THREE.CircleGeometry(r, 18),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(pos.x, 0.035, pos.z);
    mesh.userData.target = r;
    this.scene.add(mesh);
    this.rings.push({ mesh, life: 2.0, tl: 2.0 });   // 复用 rings 淡出逻辑
  }

  update(dt: number): void {
    this.sparks.update(dt); this.embers.update(dt); this.dust.update(dt);
    for (const arr of [this.arcs, this.rings]) {
      for (let i = arr.length - 1; i >= 0; i--) {
        const a = arr[i];
        a.life -= dt;
        const k = Math.max(0, a.life / a.tl);
        const mat = a.mesh.material as THREE.MeshBasicMaterial;
        const target = a.mesh.userData.target as number ?? 1;
        if (arr === this.arcs) {
          a.mesh.scale.setScalar(target * (0.9 + 0.14 * (1 - k)));  // 挥出时轻微扩张
          mat.opacity = 0.65 * Math.pow(k, 0.6);                   // 前段亮、尾段利落淡出
        } else {
          mat.opacity = k * 0.8;
          const s = target * (1 - k * k);              // 扩散
          a.mesh.scale.setScalar(Math.max(0.05, a.tl > 1 ? target : s));
          if (a.tl > 1) a.mesh.scale.setScalar(target); // 火痕只淡不扩
        }
        if (a.life <= 0) {
          this.scene.remove(a.mesh);
          a.mesh.geometry.dispose();                   // 每件新建：到期必须释放 GPU 资源
          (a.mesh.material as THREE.Material).dispose();
          arr.splice(i, 1);
        }
      }
    }
  }
}

/** 篝火：螺旋剑造型 + 火光 + 粒子 */
export interface Bonfire { group: THREE.Group; light: THREE.PointLight; pos: THREE.Vector3 }

export function buildBonfire(scene: THREE.Scene, pos: THREE.Vector3): Bonfire {
  const g = new THREE.Group();
  g.position.copy(pos);
  const ash = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.75, 0.12, 12),
    new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 1 }),
  );
  ash.position.y = 0.06;
  g.add(ash);
  const boneMat = new THREE.MeshStandardMaterial({ color: 0x4a4436, roughness: 0.8 });
  for (let i = 0; i < 4; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.7, 0.08), boneMat);
    b.position.set(Math.sin(i * 1.9) * 0.22, 0.35, Math.cos(i * 1.9) * 0.22);
    b.rotation.set((i % 2 ? 1 : -1) * 0.5, i, (i % 2 ? -1 : 1) * 0.35);
    g.add(b);
  }
  const swordMat = new THREE.MeshStandardMaterial({ color: COLORS.steel, roughness: 0.4, emissive: 0xff8c3a, emissiveIntensity: 0.25 });
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.15, 0.014), swordMat);
  blade.position.y = 0.95; blade.rotation.z = 0.12;
  g.add(blade);
  const hilt = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.04, 0.05), swordMat);
  hilt.position.y = 0.42; hilt.rotation.z = 0.12;
  g.add(hilt);
  const light = new THREE.PointLight(COLORS.ember, 10, 8, 2);
  light.position.set(0, 0.9, 0);
  g.add(light);
  scene.add(g);
  return { group: g, light, pos: pos.clone() };
}

/** 雾门：竖立的白雾墙 */
export class FogGate {
  readonly group = new THREE.Group();
  solid = true;

  constructor(scene: THREE.Scene, pos: THREE.Vector3) {
    this.group.position.copy(pos);
    const mat = new THREE.MeshBasicMaterial({ color: 0xcfd8e8, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide });
    for (let i = 0; i < 3; i++) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 3.4), mat.clone());
      p.position.set((i - 1) * 0.12, 1.7, 0);
      p.rotation.y = Math.PI / 2;
      p.userData.phase = i * 2.1;
      this.group.add(p);
    }
    scene.add(this.group);
  }

  open(): void { this.solid = false; }
  close(): void { this.solid = true; }

  update(t: number): void {
    let o = this.solid ? 0.16 : 0.02;
    for (const child of this.group.children) {
      const p = child as THREE.Mesh;
      const ph = p.userData.phase as number;
      (p.material as THREE.MeshBasicMaterial).opacity = o + Math.sin(t * 1.7 + ph) * 0.05;
      p.position.y = 1.7 + Math.sin(t * 0.8 + ph) * 0.08;
    }
    this.group.visible = o > 0.03 || this.solid;
  }
}

/** 血渍（掉魂点）：倒插残剑 + 幽绿光柱 + 呼吸光（M2 死亡掉魂/拾回） */
export interface SoulSign {
  group: THREE.Group;
  update: (t: number) => void;
  dispose: () => void;
}

export function buildSoulSign(scene: THREE.Scene, pos: THREE.Vector3): SoulSign {
  const g = new THREE.Group();
  g.position.set(pos.x, 0, pos.z);
  // 倒插的残剑
  const swordMat = new THREE.MeshStandardMaterial({ color: 0x39423a, roughness: 0.6, metalness: 0.3 });
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.62, 0.014), swordMat);
  blade.position.y = 0.42; blade.rotation.z = 0.18;
  g.add(blade);
  const hilt = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.04, 0.05), swordMat);
  hilt.position.y = 0.72; hilt.rotation.z = 0.18;
  g.add(hilt);
  // 幽绿光柱（多层同心）
  const glowMat = new THREE.MeshBasicMaterial({ color: 0x6fdc8c, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const glow = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.26, 1.7, 12, 1, true), glowMat);
  glow.position.y = 0.85;
  g.add(glow);
  const light = new THREE.PointLight(0x6fdc8c, 2.4, 4.5, 2);
  light.position.y = 0.85;
  g.add(light);
  scene.add(g);
  return {
    group: g,
    update: (t: number): void => {
      light.intensity = 2.4 + Math.sin(t * 5.2) * 0.8;
      glowMat.opacity = 0.14 + Math.sin(t * 5.2) * 0.05;
    },
    dispose: (): void => {
      scene.remove(g);
      blade.geometry.dispose(); hilt.geometry.dispose(); glow.geometry.dispose();
      swordMat.dispose(); glowMat.dispose();
    },
  };
}
