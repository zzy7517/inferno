/** Boss #3「深渊监视者们」（单剑首领形态，不做多敌）：瘦长人形快剑士（docs/design/m3-bosses.md Boss#3 帧数据表）
 * 通用机制（状态机/削韧破绽/弹反/多段判定/击飞/冷却/走近追踪）全在 BossBase（boss-base.ts），
 * 本文件只保留监视者专属：剑士外观与 Pose、选招权重、被击后撤斩反击（takeHit 打断后摇）、
 * 火焰旋风（二阶段）、一阶段致死拦截 → 跪地 1.2s → 红焰站起切二阶段（"复活"名场面）。
 * 模块加载即并入共享表（Object.assign(MOVES/FEEL)），引擎/调校台按名字取用，game 侧无需改动。
 */
import * as THREE from "three";
import { MOVES, FEEL, MoveDef, FeelDef } from "./config";
import { Vfx } from "./vfx";
import { AU } from "./audio";
import { BossBase, BossStats, clamp01, smooth, seg, angleWithin } from "./boss-base";
import type { BossHost } from "./boss-base";

export type { BossState, BossHost } from "./boss-base";

// ---------------- 帧数据（m3-bosses.md 一阶段表 + 二阶段新招） ----------------
export const MOVES_WATCHERS: Record<string, MoveDef> = {
  // 三连斩：固定节拍 0.45s/刀。多段时间轴：第 k 段在 min(active*0.4 + k*0.45, active) 触发，
  // active 须 ≥ 0.36+2*0.45≈1.26 才能三段全部触发 → 取 1.3（首刀 0.52 / 二刀 0.97 / 三刀收在 1.30）。
  // 第三刀横扫（表弧 2.6）与前两刀（1.4）的弧度差异用整体 1.6 折中——拆分需引擎改逐段判定，收益不抵。
  watcherCombo: {
    name: "watcherCombo", label: "三连斩", startup: 0.32, active: 1.3, recovery: 0.75,
    dmg: 12, range: 3.0, arc: 1.6, hits: 3, hitInterval: 0.45,
    parryable: true, cd: 3.5, feel: "wCombo",   // 仅首段可弹反由引擎保证（首段命中关窗 + t>active*0.7 关窗）
  },
  // 突进斩：lunge 位移由子类在 movePose tel 段消费（引擎的 lunge 字段仅数据，无人统一施加）
  watcherDash: {
    name: "watcherDash", label: "突进斩", startup: 0.40, active: 0.12, recovery: 0.70,
    dmg: 20, range: 4.5, arc: 0.8, lunge: 2.5, parryable: true, cd: 4.0, feel: "wHeavy",
  },
  // 上挑：击飞（player.applyHit 读 knockUp 抛物线 + 落地硬直，引擎已实现）
  watcherRiser: {
    name: "watcherRiser", label: "上挑", startup: 0.50, active: 0.14, recovery: 0.95,
    dmg: 24, range: 2.8, arc: 1.2, knockUp: 6.5, parryable: true, cd: 5.0, feel: "wHeavy",
  },
  // 后撤斩：被击反击（takeHit 30% 触发），不进 pickMove 池；反向 1.5m 撤步在 movePose tel 段手写
  watcherBackslash: {
    name: "watcherBackslash", label: "后撤斩", startup: 0.25, active: 0.12, recovery: 0.60,
    dmg: 16, range: 2.6, arc: 2.2, parryable: false, cd: 6.0, feel: "wHeavy",
  },
  // 火焰旋风（二阶段）：全向 + 冲击环（shock 走基类 active*0.5 震地/火痕）+ 环形火痕×4（onMoveActive）
  watcherFirenova: {
    name: "watcherFirenova", label: "火焰旋风", startup: 0.75, active: 0.30, recovery: 1.10,
    dmg: 24, range: 4.8, arc: 6.28, shock: 4.8, parryable: false, cd: 7.0,
    phase2Only: true, feel: "wFire",
  },
};
Object.assign(MOVES, MOVES_WATCHERS);

// ---------------- 手感档案（快刀 Boss：更脆更快；wFire 为二阶段燃焰） ----------------
export const FEEL_WATCHERS: Record<string, FeelDef & { label: string }> = {
  wCombo: { label: "监视者·连斩", hitstop: 0.04, shake: 0.30, sparks: 8,  sparkSpeed: 4,   knockback: 0.30, sfx: "hitLight" },
  wHeavy: { label: "监视者·重斩", hitstop: 0.07, shake: 0.45, sparks: 12, sparkSpeed: 5,   knockback: 0.55, sfx: "hitHeavy" },
  wFire:  { label: "监视者·燃焰", hitstop: 0.09, shake: 0.50, sparks: 14, sparkSpeed: 5.5, knockback: 0.60, sfx: "hitHeavy" },
};
Object.assign(FEEL, FEEL_WATCHERS);

export const WATCHERS_STATS: BossStats & { name: string; radius: number } = {
  name: "深渊监视者们", radius: 0.8,
  hp: 620,                       // 一阶段致死→复活 45%：实际总量 ≈ 620 + 279
  poiseMax: 90, poiseDecay: 14,  // 削韧恢复快——快刀 Boss 难打破绽
  staggerDur: 2.0, staggerMul: 1.5, parriedDur: 1.6,
  phase2At: 0.01,                // 二阶段只经 onLethal 触发；0.01 仅兜底 HP 擦线时的演出防误触
  walkSpeed: 4.2, turnRate: 5.0, // 全游最快
};

/** 二阶段燃剑数值 buff（全招 range+0.4 / dmg×1.25）的一阶段基线——模块级快照，多实例/reset 往返安全 */
const P1_BASE: Record<string, { range: number; dmg: number }> = {};
for (const m of Object.values(MOVES_WATCHERS)) P1_BASE[m.name] = { range: m.range, dmg: m.dmg };

// ---------------- 姿态（Pose） ----------------
interface WPose {
  y: number; lean: number; twist: number; crouch: number; reach: number;
  armLift: number; armSwing: number;   // 右臂（剑臂）：lift 正=前甩 负=上举；swing 横向抡
  armL: number;                        // 左臂（匕首）
  nod: number;                         // 头部俯仰（正=低头）
  spin: number;                        // 整体附加旋转（火焰旋风转体）
}
const STANCE: WPose = { y: 0, lean: 0.08, twist: -0.12, crouch: 0, reach: 0, armLift: 0.28, armSwing: 0.1, armL: -0.25, nod: 0.06, spin: 0 };
const STATUE_W: WPose = { ...STANCE, lean: 0.1, twist: 0, armLift: 0.15, armSwing: 0, armL: 0.05, nod: 0.5 };  // 垂剑而立、低头（监视者是站像）
const KNEEL: WPose = { ...STANCE, y: -0.62, lean: 0.5, crouch: 0.55, nod: 0.75, armLift: 0.3, armSwing: 0.25, armL: 0.3 };  // 单膝跪地 + 剑拄地
const RISE: WPose = { ...STANCE, lean: -0.12, armLift: -0.55, armSwing: -0.2, nod: -0.12, twist: 0.1 };                     // 红焰站起挺剑
// 三连斩三刀姿态（拍内 wind→strike；1 右→左斜劈 / 2 左→右回斩 / 3 大横扫最扑）
const C1W: WPose = { ...STANCE, twist: 0.55, armLift: -0.9, armSwing: -0.75 };
const C1K: WPose = { ...STANCE, twist: -0.5, armLift: 0.55, armSwing: 0.9, lean: 0.18 };
const C2W: WPose = { ...STANCE, twist: -0.45, armLift: -0.6, armSwing: 0.8 };
const C2K: WPose = { ...STANCE, twist: 0.5, armLift: 0.5, armSwing: -0.95, lean: 0.14 };
const C3W: WPose = { ...STANCE, twist: 0.8, armLift: -0.35, armSwing: -1.1 };
const C3K: WPose = { ...STANCE, twist: -0.85, armLift: 0.35, armSwing: 1.3, lean: 0.22, crouch: 0.12 };

export class Watchers extends BossBase {
  private body = new THREE.Group();
  private torso = new THREE.Group();
  private head = new THREE.Group();
  private legR = new THREE.Group();
  private legL = new THREE.Group();
  private shinR = new THREE.Group();
  private shinL = new THREE.Group();
  private armR = new THREE.Group();
  private armL = new THREE.Group();
  private eyeMat!: THREE.MeshStandardMaterial;
  private bladeMat!: THREE.MeshStandardMaterial;
  private swordLight!: THREE.PointLight;
  private cape: THREE.Mesh[] = [];

  private pose: WPose = { ...STATUE_W };
  private playerPos = new THREE.Vector3(0, 0, 5);   // pickMove 的背身检测用（update 时缓存）
  private moveFrom = new THREE.Vector3();           // 位移类招（突进/后撤）的起点
  private moveDir = new THREE.Vector3(0, 0, 1);
  private moveLen = 0;
  private p2Applied = false;                        // 二阶段数值 buff 是否已写入共享表
  private slashFired = 0;                           // 已补画刀光的判定段数（与 hitFired 对齐，多段每段一刀光）

  constructor(scene: THREE.Scene, vfx: Vfx, pos: THREE.Vector3, host: BossHost, facing = -Math.PI / 2) {
    super(scene, vfx, pos, host, WATCHERS_STATS, facing);
    this.transformHitAt = 1.2;   // 复活演出时序：跪地 1.2s → 红焰站起（onLethal/reset 同步维护）
    this.transformDur = 2.4;
    this.assemble();
  }

  // ---------------- 外观：瘦长人形剑士（肩宽 1.1 / 高 2.6，黑铁层叠甲 + 破披风 + 眼缝红点） ----------------
  protected override buildBody(): void {
    const iron = new THREE.MeshStandardMaterial({ color: 0x23262c, roughness: 0.75, metalness: 0.35, flatShading: true });
    const ironDark = new THREE.MeshStandardMaterial({ color: 0x17191d, roughness: 0.9, metalness: 0.2, flatShading: true });
    const cloth = new THREE.MeshStandardMaterial({ color: 0x121014, roughness: 1, side: THREE.DoubleSide, flatShading: true });
    this.bladeMat = new THREE.MeshStandardMaterial({ color: 0x9aa4ae, roughness: 0.35, metalness: 0.7, flatShading: true, emissive: 0xff5a20, emissiveIntensity: 0 });
    this.eyeMat = new THREE.MeshStandardMaterial({ color: 0x1a0505, roughness: 0.6, emissive: 0xff3b30, emissiveIntensity: 0.8 });

    const box = (w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z); m.castShadow = true;
      return m;
    };
    // 腿（髋枢轴 + 膝枢轴两组：跪地/蹲伏的弯折）——腿根 y 1.38
    for (const [leg, shin, sx] of [[this.legR, this.shinR, 0.14], [this.legL, this.shinL, -0.14]] as [THREE.Group, THREE.Group, number][]) {
      leg.position.set(sx, 1.38, 0);
      leg.add(box(0.17, 0.66, 0.2, ironDark, 0, -0.33, 0));                 // 大腿
      shin.position.set(0, -0.66, 0);
      shin.add(box(0.14, 0.6, 0.16, ironDark, 0, -0.3, 0.01));             // 小腿
      shin.add(box(0.17, 0.3, 0.19, iron, 0, -0.26, 0.03));                // 胫甲
      shin.add(box(0.16, 0.1, 0.32, ironDark, 0, -0.6, 0.07));             // 脚
      leg.add(shin);
      this.body.add(leg);
    }
    // 骨盆 / 腰带 / 裙甲三片
    this.body.add(box(0.4, 0.26, 0.28, iron, 0, 1.46, 0));
    this.body.add(box(0.44, 0.08, 0.32, ironDark, 0, 1.36, 0));
    for (const [fx, fy, ry] of [[0, 0.17, 0], [0.2, 0.1, 0.6], [-0.2, 0.1, -0.6]] as [number, number, number][]) {
      const plate = box(0.34, 0.3, 0.04, iron, fx, 1.26, fy);
      plate.rotation.set(0.3, ry, 0);
      this.body.add(plate);
    }
    // 躯干（层叠甲片）——底座 y 1.52
    this.torso.position.y = 1.52;
    this.torso.add(box(0.42, 0.34, 0.28, ironDark, 0, 0.05, 0));           // 腹甲
    this.torso.add(box(0.5, 0.44, 0.32, iron, 0, 0.4, 0));                 // 胸甲
    this.torso.add(box(0.56, 0.3, 0.36, iron, 0, 0.52, 0.01));             // 上层甲片
    this.torso.add(box(0.44, 0.4, 0.06, ironDark, 0, 0.42, -0.19));        // 背板（披风锚点）
    this.torso.add(box(0.3, 0.12, 0.26, ironDark, 0, 0.7, 0));             // 护颈
    this.torso.add(box(0.1, 0.12, 0.04, ironDark, 0, 0.52, 0.19));         // 胸口扣
    // 肩甲
    for (const s of [-1, 1]) {
      const p = box(0.26, 0.16, 0.32, iron, s * 0.38, 0.66, 0);
      p.rotation.z = -s * 0.25;
      this.torso.add(p);
    }
    // 头盔：只在眼缝处露两个红点
    this.head.position.set(0, 0.88, 0.03);
    this.head.add(box(0.26, 0.32, 0.3, iron, 0, 0, 0));
    this.head.add(box(0.05, 0.1, 0.26, ironDark, 0, 0.19, 0));             // 盔脊
    this.head.add(box(0.24, 0.09, 0.05, ironDark, 0, 0.03, 0.15));         // 眼缝暗槽
    for (const ex of [-0.062, 0.062]) this.head.add(box(0.05, 0.032, 0.02, this.eyeMat, ex, 0.03, 0.175));
    this.torso.add(this.head);
    // 右臂 + 细长直剑（0.06×1.4 扁条 + 护手）——肩枢轴 y 0.66
    this.armR.position.set(0.33, 0.66, 0);
    this.armR.add(box(0.12, 0.44, 0.14, ironDark, 0, -0.2, 0));
    this.armR.add(box(0.105, 0.42, 0.12, iron, 0, -0.58, 0.03));
    this.armR.add(box(0.125, 0.16, 0.14, iron, 0, -0.86, 0.05));           // 铁手套
    const sword = new THREE.Group();
    sword.position.set(0, -0.94, 0.06);
    sword.rotation.x = 0.28;                                               // 剑尖后曳，垂剑时恰好拄地
    sword.add(box(0.045, 0.2, 0.05, ironDark, 0, 0, 0));                   // 柄
    sword.add(box(0.06, 0.05, 0.06, ironDark, 0, 0.12, 0));                // 柄头
    sword.add(box(0.24, 0.035, 0.06, iron, 0, -0.12, 0));                  // 护手
    sword.add(box(0.06, 1.4, 0.02, this.bladeMat, 0, -0.85, 0));           // 剑身（二阶段燃焰 emissive）
    this.swordLight = new THREE.PointLight(0xff5a20, 0, 5, 2);
    this.swordLight.position.set(0, -0.7, 0);
    sword.add(this.swordLight);
    this.armR.add(sword);
    this.torso.add(this.armR);
    // 左臂 + 圆匕（盘形护手）
    this.armL.position.set(-0.33, 0.66, 0);
    this.armL.add(box(0.11, 0.42, 0.13, ironDark, 0, -0.19, 0));
    this.armL.add(box(0.1, 0.4, 0.11, iron, 0, -0.55, 0.02));
    this.armL.add(box(0.12, 0.15, 0.13, iron, 0, -0.8, 0.04));
    const dagger = new THREE.Group();
    dagger.position.set(0, -0.88, 0.04);
    dagger.rotation.x = 0.35;
    dagger.add(box(0.035, 0.14, 0.04, ironDark));
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.02, 10), iron);
    disc.rotation.z = Math.PI / 2; disc.castShadow = true;
    dagger.add(disc);
    dagger.add(box(0.04, 0.5, 0.015, this.bladeMat, 0, -0.32, 0));
    this.armL.add(dagger);
    this.torso.add(this.armL);
    // 破烂黑披风：三片 Plane，跟随摆动（updateVisuals）
    for (let i = 0; i < 3; i++) {
      const g = new THREE.PlaneGeometry(0.42, 1.0);
      g.translate(0, -0.5, 0);                                             // 上缘为摆动枢轴
      const p = new THREE.Mesh(g, cloth);
      p.position.set((i - 1) * 0.19, 2.06, -0.22);
      p.rotation.y = (i - 1) * 0.13;
      p.castShadow = true;
      this.cape.push(p);
      this.torso.add(p);
    }
    this.root.add(this.body);
    this.body.add(this.torso);
  }

  protected override chestPart(): THREE.Object3D { return this.torso; }
  protected override headPart(): THREE.Object3D { return this.head; }

  // ---------------- 姿态应用 ----------------
  protected override applyPose(): void {
    const p = this.pose;
    this.root.rotation.y = this.yaw + p.spin;
    this.body.position.set(0, p.y - p.crouch * 0.32, p.reach);
    this.torso.rotation.set(p.lean, p.twist, 0);
    this.head.rotation.x = p.nod;
    this.armR.rotation.set(-p.armLift, 0, -p.armSwing);
    this.armL.rotation.set(-p.armL, 0.18, 0);
    // 蹲伏/跪地：前腿弓、后腿跪（膝枢轴随 crouch 弯折）
    this.legR.rotation.x = -p.crouch * 0.7;
    this.shinR.rotation.x = p.crouch * 1.3;
    this.legL.rotation.x = p.crouch * 0.55;
    this.shinL.rotation.x = p.crouch * 0.95;
  }

  private lerpPose(a: WPose, b: WPose, k: number): void {
    const p = this.pose;
    p.y = a.y + (b.y - a.y) * k; p.lean = a.lean + (b.lean - a.lean) * k;
    p.twist = a.twist + (b.twist - a.twist) * k; p.crouch = a.crouch + (b.crouch - a.crouch) * k;
    p.reach = a.reach + (b.reach - a.reach) * k;
    p.armLift = a.armLift + (b.armLift - a.armLift) * k; p.armSwing = a.armSwing + (b.armSwing - a.armSwing) * k;
    p.armL = a.armL + (b.armL - a.armL) * k; p.nod = a.nod + (b.nod - a.nod) * k;
    p.spin = a.spin + (b.spin - a.spin) * k;
  }

  protected override movePose(m: MoveDef, sub: string, t: number, total: number): void {
    const wind: WPose = { ...STANCE }, strike: WPose = { ...STANCE };
    switch (m.name) {
      case "watcherCombo":
        wind.twist = 0.5; wind.armLift = -0.85; wind.armSwing = -0.7; wind.nod = 0.12;
        strike.twist = -0.55; strike.armLift = 0.75; strike.armSwing = 0.95; strike.lean = 0.22;
        break;
      case "watcherDash":
        wind.twist = 0.55; wind.armLift = -0.4; wind.armSwing = -0.5; wind.crouch = 0.18; wind.reach = 0.1;
        strike.twist = -0.2; strike.armLift = 1.05; strike.armSwing = 0.15; strike.lean = 0.4; strike.reach = 0.45;
        break;
      case "watcherRiser":
        wind.twist = 0.3; wind.armLift = 0.75; wind.armSwing = -0.45; wind.crouch = 0.3; wind.lean = 0.3;
        strike.armLift = -2.25; strike.armSwing = 0.1; strike.lean = -0.18; strike.y = 0.14;   // 剑走立圆，人随势拔起
        break;
      case "watcherBackslash":
        wind.twist = -0.6; wind.armLift = -0.5; wind.armSwing = 0.85; wind.crouch = 0.22;
        strike.twist = 0.7; strike.armLift = 0.35; strike.armSwing = -1.15; strike.lean = 0.15;
        break;
      case "watcherFirenova":
        wind.armLift = -2.5; wind.crouch = 0.2; wind.lean = -0.08; wind.twist = 0.4;           // 剑竖举蓄势
        strike.armLift = 0.45; strike.armSwing = 1.25; strike.lean = 0.14;                     // 挥平扫圆（spin 转体）
        break;
    }
    if (sub === "tel") {
      this.lerpPose(STANCE, wind, smooth(seg(t, m.startup * 0.45, m.startup)));
      // 位移段：突进斩前冲（最多冲到玩家身前 1m）/ 后撤斩反向撤步 1.5m（基准在 onMoveStart 记录）
      if (this.moveLen !== 0) {
        const k = smooth(clamp01((t - m.startup * 0.3) / (m.startup * 0.7)));
        this.root.position.copy(this.moveFrom).addScaledVector(this.moveDir, this.moveLen * k);
      }
    } else if (sub === "act") {
      if (m.name === "watcherCombo") this.comboPose(t, m);
      else if (m.name === "watcherFirenova") {
        const k = smooth(clamp01(t / m.active));
        this.lerpPose(wind, strike, k);
        this.pose.spin = Math.PI * 2 * k;   // 恰好整一圈
      } else this.lerpPose(wind, strike, seg(t, 0, m.active));
    } else {
      this.lerpPose(strike, STANCE, smooth(seg(t, m.recovery * 0.35, m.recovery)));
      if (m.name === "watcherFirenova") this.pose.spin = 0;   // 2π≡0：收招直接归零，不倒转
    }
    void total;
  }

  /** 三连斩判定段姿态：三拍与引擎判定时刻对齐（首刀 active*0.4，其后每 0.45s），交替方向、末刀最横 */
  private comboPose(t: number, m: MoveDef): void {
    const firstAt = m.active * 0.4;
    const ph = clamp01((t - firstAt) / (m.active - firstAt)) * 3;
    const idx = Math.min(2, Math.floor(ph));
    const s = smooth(clamp01(ph - idx));
    const w = idx === 0 ? C1W : idx === 1 ? C2W : C3W;
    const k = idx === 0 ? C1K : idx === 1 ? C2K : C3K;
    this.lerpPose(w, k, s);
  }

  // ---------------- 监视者专属覆盖点 ----------------
  /** 缓存玩家位置（pickMove 的背身检测拿不到 playerPos，只在 update 入口有） */
  override update(dt: number, playerPos: THREE.Vector3, playerIframed: boolean): void {
    this.playerPos.copy(playerPos);
    super.update(dt, playerPos, playerIframed);
  }

  /** 唤醒：1.6s 低头石像 → 抬头挺剑（人形起身，比古达快） */
  protected override updateRising(dt: number): void {
    this.t += dt;
    this.lerpPose(STATUE_W, STANCE, smooth(clamp01(this.t / 1.6)));
    if (Math.random() < dt * 8) this.vfx.dust.burst(this.root.position, 2, 2, 0.6);
    if (this.t > 0.35 && this.t - dt <= 0.35) this.host.onBossReveal();
    if (this.t >= 1.6) { this.state = "combat"; this.sub = "idle"; this.t = 0; }
  }

  /** 眼缝红点呼吸 / 二阶段燃剑 / 披风摆动 / 刀光按判定段补画 / 二阶段数值 buff 一次性写入 */
  protected override updateVisuals(): void {
    const now = performance.now();
    let eye = this.state === "statue" ? 0.3 : this.phase === 2 ? 1.8 : 0.8;
    eye += Math.sin(now * 0.004) * 0.18;
    if (this.state === "transform" && this.t < 1.2) eye *= Math.max(0, 1 - this.t);   // 跪地"战死"期间眼火熄灭
    this.eyeMat.emissiveIntensity = Math.max(0, eye);
    const burn = this.phase === 2;
    const flick = 1 + Math.sin(now * 0.02) * 0.15;
    this.bladeMat.emissiveIntensity = burn ? 1.6 * flick : 0;
    this.swordLight.intensity = burn ? 4 * flick : 0;
    for (let i = 0; i < this.cape.length; i++) {
      const c = this.cape[i];
      c.rotation.x = 0.16 + Math.sin(now * 0.003 + i * 1.7) * 0.09;
      c.rotation.z = Math.sin(now * 0.0022 + i * 2.3) * 0.06;
    }
    // 刀光：每段判定一刀光（hitFired 无条件按节拍推进，躲开也照画；首段与命中同帧）
    if (this.state === "combat" && this.sub === "act" && this.move) {
      while (this.slashFired < this.hitFired) {
        this.slashFired++;
        this.vfx.slash(this.chestWorld(), this.yaw, this.move.range * 0.85,
          this.move.arc > 2 || this.move.name === "watcherFirenova", burn ? 0xff5a20 : 0xd7e3ec);
      }
    }
    // 二阶段数值 buff：一次性改写共享帧数据表（reset 还原）
    if (burn && !this.p2Applied) this.applyPhase2Moves();
  }

  private applyPhase2Moves(): void {
    this.p2Applied = true;
    for (const m of Object.values(MOVES_WATCHERS)) {
      m.range = P1_BASE[m.name].range + 0.4;
      m.dmg = Math.round(P1_BASE[m.name].dmg * 1.25);
    }
  }
  private restorePhase1Moves(): void {
    this.p2Applied = false;
    for (const m of Object.values(MOVES_WATCHERS)) {
      m.range = P1_BASE[m.name].range;
      m.dmg = P1_BASE[m.name].dmg;
    }
  }

  /** 高频小幅步态（4Hz，古达 2.4Hz 的快刀版） */
  protected override onIdleWalk(): void {
    this.pose.y = Math.abs(Math.sin(performance.now() * 0.0126)) * 0.045 - 0.015;
  }

  /** 位移类招基准：突进斩朝玩家 / 后撤斩沿面向反向 */
  protected override onMoveStart(m: MoveDef, toPlayer: THREE.Vector3, dist: number): void {
    this.moveFrom.copy(this.root.position);
    this.slashFired = 0;
    this.moveLen = 0;
    if (m.name === "watcherDash") {
      this.moveDir.copy(toPlayer).setY(0).normalize();
      this.moveLen = Math.min(m.lunge ?? 0, Math.max(0, dist - 1.0));
    } else if (m.name === "watcherBackslash") {
      this.moveDir.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      this.moveLen = 1.5;
    }
  }

  /** 火焰旋风落点：环形火痕 ×4（基类 shock 自带正前 1 处 + 震地环） */
  protected override onMoveActive(m: MoveDef): void {
    if (m.name !== "watcherFirenova") return;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      this.vfx.scorch(this.root.position.clone().add(new THREE.Vector3(Math.sin(a) * 2.4, 0, Math.cos(a) * 2.4)), 1.1, 0xff5a20);
    }
  }

  /** 破绽姿态：踉跄后仰 */
  protected override updateStaggerPose(): void {
    this.lerpPose(STANCE, { ...STANCE, lean: 0.5, crouch: 0.4, y: -0.3, armLift: 0.5, nod: 0.3 }, Math.min(1, this.t * 5));
  }

  /** 弹反踉跄：更深后仰 + 剑臂垂荡 */
  protected override updateParriedPose(): void {
    this.lerpPose(STANCE, { ...STANCE, lean: 0.68, crouch: 0.5, y: -0.42, armLift: 0.7, armSwing: 0.6, nod: 0.4 }, Math.min(1, this.t * 8));
  }

  /** 复活演出：t<1.2 单膝跪地剑拄地（"战死"）→ t≥1.2 红焰站起；
   *  阶段切换与 hp 恢复同帧（基类在同一时刻触发震波回调 onBossTransform） */
  protected override updateTransform(): void {
    if (this.t < 1.2) {
      this.lerpPose(STANCE, KNEEL, smooth(this.t / 1.0));
    } else {
      if (this.phase === 1) {
        this.phase = 2;                     // 眼/剑燃焰由 updateVisuals 跟随 phase
        this.hp = this.cfg.hp * 0.45;       // 单血条 UI 妥协：复活回 45%
      }
      this.lerpPose(KNEEL, RISE, smooth(seg(this.t, 1.2, 2.2)));
    }
  }

  /** 死亡：前倾垮塌 + 余烬 */
  protected override updateDeath(dt: number): void {
    this.lerpPose(this.pose, { ...STANCE, lean: 1.3, y: -0.8, crouch: 0.6, nod: 0.5 }, dt * 4);
    if (Math.random() < dt * 20) this.vfx.embers.burst(this.chestWorld(), 3, 3, 1.2);
  }

  /** 一阶段致死拦截：入 transform 状态演"复活"；二阶段返回 false 走正常死亡 */
  protected override onLethal(): boolean {
    if (this.phase !== 1) return false;
    if (this.state === "transform") return true;   // 跪地演出中继续挨打：hp 已被钳 0，不重入计时也不死（白打）
    this.state = "transform"; this.sub = "idle"; this.t = 0;
    this.move = null; this.poise = 0;
    this.transformHitAt = 1.2; this.transformDur = 2.4;   // 跪地 1.2s → 红焰站起（基类 1.2s 时刻切震波）
    AU.transform();
    return true;
  }

  /** 被击反击（后撤斩）：正常受击（未死/未破绽/未入演出）、后摇或待机、cd 好 → 30% 打断后摇立即反击 */
  override takeHit(dmg: number, poise: number): { died: boolean; staggered: boolean } {
    const r = super.takeHit(dmg, poise);
    const bs = MOVES_WATCHERS.watcherBackslash;
    if (!r.died && !r.staggered && this.state === "combat" && (this.sub === "rec" || this.sub === "idle")
      && (this.cds[bs.name] ?? 0) <= 0 && Math.random() < 0.3) {
      this.sub = "tel"; this.move = bs; this.t = 0;
      this.hitDone = false; this.hitFired = 0;
      this.cds[bs.name] = bs.cd;
      const toP = this.playerPos.clone().sub(this.root.position); toP.y = 0;
      this.onMoveStart(bs, toP, Math.max(0.1, toP.length()));   // 撤步位移基准
      AU.telegraph();
    }
    return r;
  }

  /** 复位：演出时序 / 二阶段数值 buff / 外观还原 */
  override reset(): void {
    super.reset();
    this.transformHitAt = 1.2;
    this.transformDur = 2.4;
  }

  protected override releaseSharedState(): void {
    if (this.p2Applied) this.restorePhase1Moves();
  }

  protected override resetVisuals(): void {
    this.restorePhase1Moves();
    this.bladeMat.emissiveIntensity = 0;
    this.swordLight.intensity = 0;
    this.eyeMat.emissiveIntensity = 0.8;
    this.lerpPose(STANCE, STATUE_W, 1);
  }

  // ---------------- 选招（监视者权重） ----------------
  protected override pickMove(dist: number): MoveDef | null {
    const ready = (m: MoveDef) => (this.cds[m.name] ?? 0) <= 0 && (!m.phase2Only || this.phase === 2);
    // 背身（面向偏离玩家 > 2.1rad）或玩家贴身（<1.3）→ 上挑优先（击飞解围）
    const toP = this.playerPos.clone().sub(this.root.position); toP.y = 0;
    const dirYaw = Math.atan2(toP.x, toP.z);
    if ((dist < 1.3 || !angleWithin(this.yaw, dirYaw, 2.1)) && ready(MOVES_WATCHERS.watcherRiser)) {
      return MOVES_WATCHERS.watcherRiser;
    }
    const pool: [MoveDef, number][] = [
      [MOVES_WATCHERS.watcherCombo, 3],
      [MOVES_WATCHERS.watcherDash, dist > 2.0 ? 2.5 : 0],
      [MOVES_WATCHERS.watcherRiser, dist > 1.5 ? 1.5 : 0],
      [MOVES_WATCHERS.watcherFirenova, this.phase === 2 && dist > 2.5 && dist < 4.5 ? 2 : 0],
    ];
    const cands = pool.filter(([m, w]) => w > 0 && ready(m) && dist < m.range * 0.95);
    if (!cands.length) return null;
    const sum = cands.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * sum;
    for (const [m, w] of cands) { r -= w; if (r <= 0) return m; }
    return cands[0][0];
  }
}
