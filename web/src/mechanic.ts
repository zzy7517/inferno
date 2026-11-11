/** T6 捷径系统（mechanic.ts）：电梯 / 单向门 —— 与 FogGate/Bonfire 同构的可交互场景机关
 *
 * 状态机：locked（锁链横锁 + 冷色封印，E 提示「捷径尚未开启」）⇄ open（封印化金、锁链崩解，E 搭乘）。
 * 乘坐演出按任务契约简化为「E 交互 → 黑场（宿主复用 #fade）→ 落位」，不做平台升降动画；
 * door 形态（拱门 + 门扇旋开）为设计稿的 C2→A2 侧门 / 塔梯类单向门预留，本期三处捷径均为电梯。
 * 预算纪律：本体一段合批（顶点色）+ 锁链一段合批（locked 可见）+ 封印光圈 1 片 ≤3 draw call；
 * 不加 PointLight——开启视觉走 emissive 微光 + 加色光圈（高墙「超出窗火降级 emissive」既有做法）。
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { COLORS } from "./config";

/** 捷径形态：elevator = 升降平台 / door = 单向拱门（解锁后门扇旋开） */
export type ShortcutKind = "elevator" | "door";

/** 捷径定义（布点表在 game.ts SHORTCUT_DEFS；id 对齐 progress.SHORTCUT_IDS） */
export interface ShortcutDef {
  id: string;            // progress.shortcuts 键（"cemetery:a3-a1" 等）
  kind: ShortcutKind;
  pos: THREE.Vector3;    // 交互圆心（地面，y 恒 0；交互半径 SHORTCUT_RADIUS）
  dest: THREE.Vector3;   // 乘坐落位点（必须落在目标 zone 可走域内）
  destName: string;      // 落位题字（showZoneCard）
  label: string;         // 消息用短名（「捷径开启 · XXX」）
  yaw?: number;          // door 朝向（elevator 忽略）
}

/** 宿主回调：interact 命中即回调（locked 也回调——提示与乘坐归宿主管） */
export interface ShortcutHost {
  onShortcutRide(def: ShortcutDef): void;
}

/** 交互半径（与篝火同量级） */
export const SHORTCUT_RADIUS = 1.6;

/** 色板：石/铁系 + 封印冷暖两态（无外部资源） */
const C = {
  stone: COLORS.stone, stoneDark: COLORS.stoneDark,
  steel: 0x4e535b, iron: 0x363a41, wood: 0x2c2620,
  sealCold: 0x39404e, sealWarm: COLORS.gold,
};

/** 顶点色上色（每面微扰，与场景 paint 同法；机关体量小，扰动取小值） */
function paint(geo: THREE.BufferGeometry, color: number, jitter = 0.06): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 3) {
    const f = jitter ? 1 + (Math.random() - 0.5) * jitter : 1;
    for (let k = 0; k < 3 && i + k < n; k++) {
      arr[(i + k) * 3] = c.r * f; arr[(i + k) * 3 + 1] = c.g * f; arr[(i + k) * 3 + 2] = c.b * f;
    }
  }
  g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return g;
}

function boxG(w: number, h: number, d: number, x: number, y: number, z: number, color: number, ry = 0, rz = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return paint(g, color);
}

/** 合批建 Mesh：源几何释放；静态件关 matrixAutoUpdate（与场景 batch 同法） */
function batch(geoms: THREE.BufferGeometry[], mat: THREE.Material, cast = true): THREE.Mesh {
  const m = new THREE.Mesh(mergeGeometries(geoms, false)!, mat);
  m.castShadow = cast;
  m.receiveShadow = true;
  m.updateMatrix();
  m.matrixAutoUpdate = false;
  for (const g of geoms) g.dispose();
  return m;
}

export class Shortcut {
  readonly group = new THREE.Group();
  readonly def: ShortcutDef;
  private openState: boolean;
  private t = 0;
  private bodyMat: THREE.MeshStandardMaterial;
  private chainMat: THREE.MeshStandardMaterial;
  private runeMat: THREE.MeshBasicMaterial;
  private chainMesh: THREE.Mesh | null = null;
  private leafPivot: THREE.Group | null = null;   // door：门扇铰链组（open 旋开）
  private leafAngle = 0;                          // 门扇当前开角（rad，缓动到目标）

  constructor(scene: THREE.Scene, def: ShortcutDef, open: boolean, private host: ShortcutHost) {
    this.def = def;
    this.openState = open;
    this.group.position.set(def.pos.x, 0, def.pos.z);
    this.group.rotation.y = def.yaw ?? 0;
    this.bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
    this.chainMat = new THREE.MeshStandardMaterial({ color: C.iron, roughness: 0.55, metalness: 0.35, emissive: 0x141a26, emissiveIntensity: 1 });
    this.runeMat = new THREE.MeshBasicMaterial({ color: C.sealCold, transparent: true, opacity: 0.24, blending: THREE.AdditiveBlending, depthWrite: false });
    if (def.kind === "elevator") this.buildElevator();
    else this.buildDoor();
    this.applyState();
    scene.add(this.group);
  }

  get isOpen(): boolean { return this.openState; }

  /** 开启/上锁（Boss 击杀时本场景实例即时开门；幂等） */
  setOpen(open: boolean): void {
    if (this.openState === open) return;
    this.openState = open;
    this.applyState();
  }

  /** E 交互：玩家在半径内则回调宿主并视为命中（locked 也回调，提示交给宿主） */
  interact(playerPos: THREE.Vector3): boolean {
    if (playerPos.distanceTo(this.group.position) > SHORTCUT_RADIUS) return false;
    this.host.onShortcutRide(this.def);
    return true;
  }

  /** 动画：open 封印呼吸 / door 门扇旋开缓动 */
  update(dt: number): void {
    this.t += dt;
    if (this.openState) this.runeMat.opacity = 0.42 + Math.sin(this.t * 2.1) * 0.16;
    if (this.leafPivot) {
      const target = this.openState ? 1.9 : 0;                       // ~109° 单向旋开
      this.leafAngle += (target - this.leafAngle) * Math.min(1, dt * 3.2);
      this.leafPivot.rotation.y = this.leafAngle;
    }
  }

  dispose(): void {
    this.group.traverse(c => {
      const m = c as THREE.Mesh;
      if (m.isMesh) m.geometry?.dispose();
    });
    this.group.removeFromParent();
    this.bodyMat.dispose();
    this.chainMat.dispose();
    this.runeMat.dispose();
  }

  // ---------------- 内部 ----------------

  /** 状态换装：锁链崩解 / 封印冷暖切换 / 本体微弱暖光（emissive 代偿点光） */
  private applyState(): void {
    if (this.chainMesh) this.chainMesh.visible = !this.openState;
    this.runeMat.color.set(this.openState ? C.sealWarm : C.sealCold);
    this.runeMat.opacity = this.openState ? 0.5 : 0.24;
    this.bodyMat.emissive.set(this.openState ? 0x241706 : 0x000000);
  }

  /** 封印光圈（地面环 + 中心印）：单 mesh 单材质，冷暖仅改色 */
  private buildRune(y: number): void {
    const ring = new THREE.RingGeometry(0.58, 0.82, 28);
    ring.rotateX(-Math.PI / 2);
    ring.translate(0, y, 0);
    const seal = new THREE.CircleGeometry(0.17, 20);
    seal.rotateX(-Math.PI / 2);
    seal.translate(0, y + 0.004, 0);
    const m = new THREE.Mesh(mergeGeometries([ring, seal], false)!, this.runeMat);
    this.group.add(m);
  }

  /** 锁链（locked 段）：横跨 z 向的垂链 + 铭牌，开启后整段隐藏（崩解） */
  private buildChain(x: number, y: number, span = 0.8): void {
    const g: THREE.BufferGeometry[] = [];
    const n = 4;
    for (let i = 0; i <= n; i++) {
      const k = i / n;                                   // 0..1，悬链下垂
      const sag = Math.sin(k * Math.PI) * 0.16;
      g.push(boxG(0.09, 0.09, span * 2 / n + 0.06, x, y - sag, -span + k * span * 2, C.iron));
    }
    g.push(boxG(0.07, 0.4, 0.4, x, y - 0.28, 0, C.iron));            // 铭牌
    this.chainMesh = batch(g, this.chainMat, false);
    this.group.add(this.chainMesh);
  }

  /** 电梯：地台（升降平台停在底层）+ 双柱 + 顶梁横担 + 吊索；入口侧锁链 */
  private buildElevator(): void {
    const g: THREE.BufferGeometry[] = [];
    g.push(boxG(2.2, 0.16, 2.6, 0, 0.08, 0, C.stoneDark));            // 地台=停靠平台
    g.push(boxG(1.7, 0.05, 2.1, 0, 0.185, 0, C.iron));                // 平台铁镶面
    for (const s of [-1, 1]) {
      g.push(boxG(0.3, 4.3, 0.3, 0, 2.23, s * 1.08, C.stone));        // 立柱
      g.push(boxG(0.42, 0.18, 0.42, 0, 3.92, s * 1.08, C.iron));      // 柱箍
      g.push(boxG(1.7, 0.16, 0.22, 0, 4.32, s * 0.62, C.stoneDark));  // 横担（吊索挂点）
      for (const c of [-1, 1]) g.push(boxG(0.05, 4.05, 0.05, c * 0.62, 2.2, s * 0.62, C.steel)); // 吊索
    }
    g.push(boxG(0.55, 0.32, 2.66, 0, 4.52, 0, C.stone));              // 顶梁
    g.push(boxG(0.64, 0.2, 0.72, 0, 4.78, 0, C.stoneDark));           // 梁冠
    this.group.add(batch(g, this.bodyMat));
    this.buildChain(0, 1.12);
    this.buildRune(0.215);
  }

  /** 单向门：拱门（双柱 + 楔石楣）+ 单扇门（铰链组，open 旋开）+ 门槛封印 */
  private buildDoor(): void {
    const g: THREE.BufferGeometry[] = [];
    for (const s of [-1, 1]) {
      g.push(boxG(0.85, 3.4, 0.6, 0, 1.7, s * 1.25, C.stone));        // 门柱
      g.push(boxG(1.0, 0.3, 0.75, 0, 3.52, s * 1.25, C.stoneDark));   // 柱头
    }
    g.push(boxG(0.85, 0.5, 3.1, 0, 3.66, 0, C.stone));                // 拱楣
    g.push(boxG(0.92, 0.35, 0.65, 0, 4.06, 0, C.stoneDark));          // 楔石
    g.push(boxG(0.95, 0.12, 2.5, 0, 0.06, 0, C.stoneDark));           // 门槛
    this.group.add(batch(g, this.bodyMat));
    // 门扇：木扇 + 双铁箍，挂在铰链组上（旋转轴在 z=-0.93 柱内侧；扇体几何外偏半宽，batch 后不再位移）
    const leaf: THREE.BufferGeometry[] = [
      boxG(0.12, 2.95, 1.86, 0, 1.53, 0.93, C.wood),
      boxG(0.15, 0.18, 1.86, 0, 0.95, 0.93, C.iron),
      boxG(0.15, 0.18, 1.86, 0, 2.15, 0.93, C.iron),
    ];
    this.leafPivot = new THREE.Group();
    this.leafPivot.position.set(0, 0, -0.93);
    this.leafPivot.add(batch(leaf, this.bodyMat));
    this.group.add(this.leafPivot);
    this.buildChain(0.2, 1.3, 0.75);                                  // 锁链横穿门扇正面
    this.buildRune(0.13);
  }
}
