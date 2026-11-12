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

  /** 水平扇形。截面是刃：内缘有厚度，向外收到薄刃口。外径 1，由 slash 按 radius 缩放。 */
  private static arcGeo(wide: boolean): THREE.BufferGeometry {
    const span = wide ? 2.8 : 1.4;
    const t0 = Math.PI / 2 - span / 2;
    const seg = 24;
    // r 半径，z 厚度（rotateX 后成高度），b 这条边上的亮度。弧向仍是中段亮、两端淡。
    const section = [
      [0.50, -0.034, 0.70], // 内缘下沿
      [0.50,  0.048, 0.84], // 内缘上沿
      [0.58,  0.054, 0.48], // 脊棱，把内缘从刃面上抬出来
      [0.78,  0.026, 0.32], // 刃面
      [0.92,  0.018, 0.58], // 收到刃口
      [1.00,  0.012, 1.00], // 刃口上
      [1.00, -0.012, 1.00], // 刃口下，薄而最亮
      [0.92, -0.010, 0.46],
      [0.78, -0.014, 0.28],
      [0.58, -0.022, 0.38],
    ];
    const n = section.length;
    const cols = seg + 1;
    const pos = new Float32Array(cols * n * 3);
    const col = new Float32Array(cols * n * 3);
    for (let i = 0; i < cols; i++) {
      const t = i / seg;
      const ang = t0 + span * t;
      const taper = 0.45 + 0.55 * Math.sin(Math.PI * t);
      const fade = Math.sin(Math.PI * t);
      const c = Math.cos(ang), s = Math.sin(ang);
      for (let j = 0; j < n; j++) {
        const [r, z, b] = section[j];
        const o = (i * n + j) * 3;
        pos[o] = c * r; pos[o + 1] = s * r; pos[o + 2] = z * taper;
        const k = fade * b;
        col[o] = k; col[o + 1] = k * 0.94; col[o + 2] = k * 0.82;
      }
    }
    const idx = new Uint16Array(seg * n * 6);
    let w = 0;
    for (let i = 0; i < seg; i++) {
      for (let j = 0; j < n; j++) {
        const j2 = (j + 1) % n;
        const a = i * n + j;
        const b = (i + 1) * n + j;
        const c = (i + 1) * n + j2;
        const d = i * n + j2;
        idx[w++] = a; idx[w++] = b; idx[w++] = c;
        idx[w++] = a; idx[w++] = c; idx[w++] = d;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.Uint16BufferAttribute(idx, 1));
    g.rotateX(-Math.PI / 2);
    return g;
  }

  /** 刀光弧：沿 yaw 的水平扇形，截面是有内缘的刃（辉迹渐变 + 挥出时轻微扩张） */
  slash(pos: THREE.Vector3, yaw: number, radius: number, wide: boolean, color = 0xffd9a0): void {
    const geo = Vfx.arcGeo(wide);
    const mat = new THREE.MeshBasicMaterial({ color, vertexColors: true, transparent: true, opacity: 0.65, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    mesh.rotation.y = yaw + Math.PI;
    mesh.scale.setScalar(radius);
    mesh.userData.target = radius;
    this.scene.add(mesh);
    this.arcs.push({ mesh, life: 0.25, tl: 0.25 });   // 约 0.25s：前段亮、尾段淡出
  }

  /** 贴地冲击波。外径 1 是波前，由 ring 按 radius 缩放。内缘贴地偏暗，外缘抬起成一条亮边。 */
  private static ringGeo(): THREE.BufferGeometry {
    const seg = 48;
    // r 半径，y 离地高度，b 亮度（乘到调用方传入的颜色上，不改色相）。
    const section = [
      [0.78, 0.008, 0.14], // 内缘贴地
      [0.78, 0.022, 0.24], // 内缘上沿
      [0.86, 0.040, 0.34], // 波身
      [0.92, 0.064, 0.48], // 抬向波峰
      [0.96, 0.082, 0.72], // 波峰，亮边开始
      [1.00, 0.058, 1.00], // 波前上沿
      [1.00, 0.012, 1.00], // 波前贴地，最亮
      [0.90, 0.008, 0.32], // 腹下收回
      [0.82, 0.006, 0.16],
    ];
    const n = section.length;
    const pos = new Float32Array(seg * n * 3);
    const col = new Float32Array(seg * n * 3);
    for (let i = 0; i < seg; i++) {
      const ang = (i / seg) * Math.PI * 2;
      const c = Math.cos(ang), s = Math.sin(ang);
      for (let j = 0; j < n; j++) {
        const [r, y, b] = section[j];
        const o = (i * n + j) * 3;
        pos[o] = c * r; pos[o + 1] = y; pos[o + 2] = s * r;
        col[o] = b; col[o + 1] = b; col[o + 2] = b;
      }
    }
    const idx = new Uint16Array(seg * n * 6);
    let w = 0;
    for (let i = 0; i < seg; i++) {
      const i2 = (i + 1) % seg;
      for (let j = 0; j < n; j++) {
        const j2 = (j + 1) % n;
        const a = i * n + j;
        const b = i2 * n + j;
        const c = i2 * n + j2;
        const d = i * n + j2;
        idx[w++] = a; idx[w++] = b; idx[w++] = c;
        idx[w++] = a; idx[w++] = c; idx[w++] = d;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.Uint16BufferAttribute(idx, 1));
    return g;
  }

  /** 冲击环：贴地扩散的波前（下劈震波/变身爆发） */
  ring(pos: THREE.Vector3, radius: number, color = COLORS.ember): void {
    const geo = Vfx.ringGeo();
    const mat = new THREE.MeshBasicMaterial({ color, vertexColors: true, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
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

/** 篝火：冷灰灰堆、碎石环、盘在灰里的弯刃、余烬火舌 */
export interface Bonfire { group: THREE.Group; light: THREE.PointLight; pos: THREE.Vector3 }

export function buildBonfire(scene: THREE.Scene, pos: THREE.Vector3): Bonfire {
  const g = new THREE.Group();
  g.position.copy(pos);

  // 冷灰石底。暖色只留给火舌，灰堆不再是一圈立柱。
  const ashMat = new THREE.MeshStandardMaterial({ color: COLORS.stoneDark, roughness: 1, flatShading: true });
  const ash = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.78, 0.14, 6), ashMat);
  ash.position.y = 0.07;
  g.add(ash);
  const pit = new THREE.Mesh(
    new THREE.CylinderGeometry(0.2, 0.3, 0.05, 6),
    new THREE.MeshStandardMaterial({ color: COLORS.ground, roughness: 1, flatShading: true }),
  );
  pit.position.y = 0.15;
  g.add(pit);

  // 碎石环把灰堆从地面上勾出来，远处先看见一圈石头。
  const rockMat = new THREE.MeshStandardMaterial({ color: COLORS.stone, roughness: 1, flatShading: true });
  const ring: number[][] = [
    [0.2, 0.88, 0.22, 0.1, 0.16, 0.4, 0.12],
    [0.95, 0.8, 0.14, 0.08, 0.12, 1.2, -0.18],
    [1.6, 0.96, 0.26, 0.16, 0.18, 0.3, 0.16],
    [2.3, 0.82, 0.13, 0.07, 0.11, 2.0, 0.08],
    [2.95, 0.92, 0.2, 0.11, 0.15, 0.7, -0.14],
    [3.6, 0.84, 0.16, 0.09, 0.13, 1.6, 0.2],
    [4.3, 0.98, 0.22, 0.18, 0.16, 0.5, -0.1],
    [5.05, 0.86, 0.15, 0.08, 0.12, 2.4, 0.15],
    [5.75, 0.94, 0.18, 0.11, 0.14, 1.0, -0.22],
  ];
  for (let i = 0; i < ring.length; i++) {
    const [a, rad, w, h, d, ry, rz] = ring[i];
    const rock = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), i % 2 ? ashMat : rockMat);
    rock.position.set(Math.cos(a) * rad, h * 0.4, Math.sin(a) * rad);
    rock.rotation.set(0, ry, rz);
    g.add(rock);
  }

  // 弯刃盘进灰里：几段扁盒子绕成一圈多的弧，剪影不再是一根直木棍。
  const steel = new THREE.MeshStandardMaterial({ color: COLORS.steel, roughness: 0.4, metalness: 0.5, flatShading: true });
  const n = 6;
  const turns = 1.08;
  const y0 = 0.16, y1 = 0.5, r0 = 0.36, r1 = 0.18;
  const sweep = Math.PI * 2 * turns;
  const tangent = new THREE.Vector3();
  const side = new THREE.Vector3();
  const bladeUp = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const basis = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const a = t * sweep;
    const r = r0 + (r1 - r0) * t;
    const y = y0 + (y1 - y0) * t;
    tangent.set(
      (r1 - r0) * Math.cos(a) - r * Math.sin(a) * sweep,
      y1 - y0,
      (r1 - r0) * Math.sin(a) + r * Math.cos(a) * sweep,
    );
    const speed = tangent.length();
    tangent.multiplyScalar(1 / speed);
    side.crossVectors(tangent, up);
    if (side.lengthSq() < 1e-8) side.set(0, 0, 1);
    side.normalize();
    bladeUp.crossVectors(side, tangent).normalize();
    basis.makeBasis(tangent, bladeUp, side);
    const len = speed / (n - 1) * 1.08;
    const seg = new THREE.Mesh(new THREE.BoxGeometry(len, 0.09 - t * 0.02, 0.04), steel);
    seg.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
    seg.quaternion.setFromRotationMatrix(basis);
    g.add(seg);
    if (i === 0) {
      const guard = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.22), steel);
      guard.position.copy(seg.position).addScaledVector(tangent, -len * 0.5);
      guard.quaternion.copy(seg.quaternion);
      g.add(guard);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.046, 0.046), steel);
      grip.position.copy(guard.position).addScaledVector(tangent, -0.1);
      grip.quaternion.copy(seg.quaternion);
      g.add(grip);
    }
  }

  // 火舌：方锥，自发光只用余烬色。远处靠这团暖色认出篝火。
  const flameMat = new THREE.MeshStandardMaterial({
    color: COLORS.ember, emissive: COLORS.ember, emissiveIntensity: 1.6,
    roughness: 1, flatShading: true,
  });
  const tongues: number[][] = [
    [0, 0, 0.88, 0.11, 0.05, -0.04],
    [-0.1, 0.07, 0.56, 0.07, -0.26, 0.14],
    [0.09, -0.08, 0.64, 0.08, 0.2, 0.22],
    [0.1, 0.1, 0.4, 0.06, 0.14, -0.3],
    [-0.08, -0.1, 0.46, 0.055, -0.18, -0.12],
    [0.02, 0.05, 0.3, 0.09, 0.08, 0.06],
  ];
  for (const [x, z, h, rad, rx, rz] of tongues) {
    const flame = new THREE.Mesh(new THREE.ConeGeometry(rad, h, 4), flameMat);
    flame.position.set(x, 0.18 + h * 0.5, z);
    flame.rotation.set(rx, 0, rz);
    g.add(flame);
  }

  const light = new THREE.PointLight(COLORS.ember, 10, 8, 2);
  light.position.set(0, 0.55, 0);
  g.add(light);
  scene.add(g);
  return { group: g, light, pos: pos.clone() };
}

/** 雾门：冷灰石柱托一道石梁，门洞里仍是雾。关上时雾中见铁栅，打开时栅收进梁底、雾变淡。不加点光。 */
export class FogGate {
  readonly group = new THREE.Group();
  solid = true;
  private readonly sheets: THREE.Mesh[] = [];
  private readonly emberMat: THREE.MeshBasicMaterial;
  private readonly coalMat: THREE.MeshStandardMaterial;
  /** 枢轴在梁底。scale.y = 1 栅落下，趋近 0 时收进石梁。 */
  private readonly bars: THREE.Group;
  private grate = 1;
  private lastT = -1;

  constructor(scene: THREE.Scene, pos: THREE.Vector3) {
    this.group.position.copy(pos);
    const stone = new THREE.MeshStandardMaterial({ color: COLORS.stone, roughness: 1, flatShading: true });
    const stoneDark = new THREE.MeshStandardMaterial({ color: COLORS.stoneDark, roughness: 1, flatShading: true });
    const iron = new THREE.MeshStandardMaterial({
      color: new THREE.Color(COLORS.steel).multiplyScalar(0.45),
      roughness: 0.42, metalness: 0.7, flatShading: true,
    });
    this.coalMat = new THREE.MeshStandardMaterial({
      color: COLORS.stoneDark, emissive: COLORS.ember, emissiveIntensity: 0.65,
      roughness: 1, flatShading: true,
    });
    const add = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material): void => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      this.group.add(m);
    };

    // 净空约 3×3.5：柱内缘钉在 z=±1.5，梁底 y=3.5。石只占两侧和顶上。
    for (const s of [-1, 1]) {
      const courses: [number, number, number, number, number, THREE.Material][] = [
        [0.98, 0.36, 0.72, 0.18, 0, stoneDark],
        [0.70, 1.14, 0.50, 0.91, 0.03, stone],
        [0.64, 1.08, 0.54, 2.00, -0.04, stoneDark],
        [0.72, 0.96, 0.48, 3.00, 0.02, stone],
        [0.90, 0.26, 0.64, 3.39, 0, stone],
      ];
      for (const [w, h, d, y, xo, mat] of courses) add(w, h, d, xo * s, y, s * (1.5 + d / 2), mat);
    }
    const voussoirs: [number, number, number, THREE.Material][] = [
      [-1.88, 0.44, 0.88, stone],
      [-0.94, 0.52, 0.90, stoneDark],
      [0, 0.68, 1.02, stone],
      [0.94, 0.52, 0.90, stoneDark],
      [1.88, 0.44, 0.88, stone],
    ];
    for (const [z, h, w, mat] of voussoirs) add(w, h, 0.96, 0, 3.5 + h / 2, z, mat);
    for (const x of [-0.52, 0.52]) {
      const coal = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.16, 0.18), this.coalMat);
      coal.position.set(x, 3.86, 0);
      this.group.add(coal);
    }

    const fogMat = new THREE.MeshBasicMaterial({
      color: 0xcfd8e8, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide,
    });
    for (let i = 0; i < 3; i++) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(2.96, 3.28), fogMat.clone());
      p.position.set([-0.22, 0.12, 0.28][i], 1.7, 0);
      p.rotation.y = Math.PI / 2;
      p.userData.phase = i * 2.1;
      this.sheets.push(p);
      this.group.add(p);
    }

    // 余烬只勾门洞内缘，关上才亮。贴在石面上，不挡 3 米净空。
    this.emberMat = new THREE.MeshBasicMaterial({
      color: COLORS.ember, transparent: true, opacity: 0.4,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    for (const s of [-1, 1]) {
      const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.5, 3.05, 0.035), this.emberMat);
      jamb.position.set(0, 1.82, s * 1.518);
      jamb.renderOrder = 1;
      this.group.add(jamb);
    }
    for (const x of [-0.46, 0.46]) {
      const lip = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.025, 2.88), this.emberMat);
      lip.position.set(x, 3.475, 0);
      lip.renderOrder = 1;
      this.group.add(lip);
    }

    this.bars = new THREE.Group();
    this.bars.position.set(0, 3.46, 0);
    const barH = 3.32;
    const z0 = -1.22;
    const z1 = 1.22;
    const n = 7;
    for (let i = 0; i < n; i++) {
      const z = z0 + (z1 - z0) * (i / (n - 1));
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.06, barH, 0.08), iron);
      bar.position.set(0, -barH / 2, z);
      this.bars.add(bar);
    }
    for (const ly of [-0.85, -1.85, -3.05]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.05, z1 - z0 + 0.06), iron);
      rail.position.set(0, ly, 0);
      this.bars.add(rail);
    }
    this.group.add(this.bars);
    scene.add(this.group);
  }

  open(): void { this.solid = false; }
  close(): void { this.solid = true; }

  update(t: number): void {
    const dt = this.lastT < 0 ? 0 : Math.min(0.05, Math.max(0, t - this.lastT));
    this.lastT = t;
    const target = this.solid ? 1 : 0;
    const k = dt > 0 ? 1 - Math.exp(-8 * dt) : 1;
    this.grate += (target - this.grate) * k;
    this.bars.scale.y = Math.max(this.grate, 0.001);
    this.bars.visible = this.grate > 0.04;

    const o = this.solid ? 0.16 : 0.04;
    const amp = this.solid ? 0.05 : 0.012;
    for (const p of this.sheets) {
      const ph = p.userData.phase as number;
      (p.material as THREE.MeshBasicMaterial).opacity = o + Math.sin(t * 1.7 + ph) * amp;
      p.position.y = 1.7 + Math.sin(t * 0.8 + ph) * 0.06;
    }
    this.emberMat.opacity = this.solid ? 0.4 + Math.sin(t * 0.85) * 0.05 : 0;
    this.coalMat.emissiveIntensity = this.solid ? 0.62 + Math.sin(t * 0.85) * 0.12 : 0;
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
  // 幽绿光柱：加高加亮，雾不吃掉亮度，隔一段距离找得到死亡点。仍是魂绿。
  const pillarH = 4.8;
  const glowMat = new THREE.MeshBasicMaterial({ color: 0x6fdc8c, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const glow = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.42, pillarH, 12, 1, true), glowMat);
  glow.position.y = pillarH / 2;
  g.add(glow);
  const light = new THREE.PointLight(0x6fdc8c, 2.4, 4.5, 2);
  light.position.y = 0.85;
  g.add(light);
  scene.add(g);
  return {
    group: g,
    update: (t: number): void => {
      light.intensity = 2.4 + Math.sin(t * 5.2) * 0.8;
      glowMat.opacity = 0.32 + Math.sin(t * 5.2) * 0.08;
    },
    dispose: (): void => {
      scene.remove(g);
      blade.geometry.dispose(); hilt.geometry.dispose(); glow.geometry.dispose();
      swordMat.dispose(); glowMat.dispose();
    },
  };
}
