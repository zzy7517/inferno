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
import { BossBase, BossStats, clamp01, clampMag, smooth, seg, angleWithin, pickWeighted } from "./boss-base";
import type { AttackVolume, BossHost } from "./boss-base";

export type { BossState, BossHost } from "./boss-base";

// ---------------- 帧数据（m3-bosses.md 一阶段表 + 二阶段新招） ----------------
export const MOVES_WATCHERS: Record<string, MoveDef> = {
  // 三连斩拆成三招：BossBase 一次判定只用同一个 m.arc，第三刀要真横扫只能单独一招（弧 2.6）。
  // watcherCombo 的名字不动；回斩/横扫只走 chain，不进选招池，所以节拍仍是「出了第一刀就有第三刀」。
  // 吃刀硬直 0.4s、翻滚 0.7s（无敌 0.04–0.30）。命中间隔 = 上一段 active×0.6 + 后摇 + 下一段前摇 + 下一段 active×0.4。
  // 前两刀间隔 0.84s（active 0.22，命中落在 0.088s，约等于表内 0.10 判定）：硬直末段缓冲的翻滚能盖住下一刀。
  // 第三刀前摇 0.52s，剑扔开再扫。首段可弹反：前摇最后 0.2s 加上判定段，直到这一下打实。
  // 旧数据把三段塞进 active 1.3、弧折中 1.6：第三刀被钳到 t=active（间隔只剩 0.33s，短于硬直），
  // 且刀光与切后摇同一帧，updateVisuals 只在 act 里补画，第三刀刀光从不出现。
  watcherCombo: {
    name: "watcherCombo", label: "三连斩", startup: 0.32, active: 0.22, recovery: 0.28,
    dmg: 12, range: 3.0, arc: 1.4,
    parryable: true, cd: 3.5, chain: "watcherCombo2", feel: "wCombo", // 仅首段可弹反
  },
  watcherCombo2: {
    name: "watcherCombo2", label: "三连斩·回斩", startup: 0.34, active: 0.22, recovery: 0.28,
    dmg: 12, range: 3.0, arc: 1.4,
    parryable: false, cd: 0, chain: "watcherSweep", feel: "wCombo",
  },
  // 第三刀横扫。前摇里把剑横着拉开并停住；后摇 0.75 是整段连斩的惩罚窗口（表内后摇落在收尾）。
  watcherSweep: {
    name: "watcherSweep", label: "三连斩·横扫", startup: 0.52, active: 0.22, recovery: 0.75,
    dmg: 12, range: 3.0, arc: 2.6,
    parryable: false, cd: 0, feel: "wHeavy",
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
const STANCE: WPose = { y: 0, lean: 0.08, twist: -0.12, crouch: 0, reach: 0, armLift: 0.28, armSwing: -0.62, armL: -0.25, nod: 0.06, spin: 0 }; // 大剑垂在身侧，尖落在地面附近
const STATUE_W: WPose = { ...STANCE, lean: 0.1, twist: 0, armLift: 0.15, armSwing: -0.64, armL: 0.05, nod: 0.5 };  // 垂剑而立、低头（监视者是站像）
const KNEEL: WPose = { ...STANCE, y: -0.62, lean: 0.5, crouch: 0.55, nod: 0.75, armLift: 1.7, armSwing: -0.5, armL: 0.3 };  // 单膝跪地，大剑向前拄地
const RISE: WPose = { ...STANCE, lean: -0.12, armLift: -1.15, armSwing: -0.45, nod: -0.12, twist: 0.1 };                   // 红焰站起，把长剑挑起来
// 三连斩三刀姿态（1 右→左斜劈 / 2 左→右回斩 / 3 躯干连剑一起扔开——轮廓必须比前两刀宽一档）
// 手臂行程比旧姿态大，判定拍上的挥幅才盖得住这把剑；时间比例不改。
const C1W: WPose = { ...STANCE, twist: 0.55, armLift: -1.2, armSwing: -1.15 };
const C1K: WPose = { ...STANCE, twist: -0.5, armLift: 1.0, armSwing: 1.35, lean: 0.18 };
const C2W: WPose = { ...STANCE, twist: -0.45, armLift: -1.0, armSwing: 1.2 };
const C2K: WPose = { ...STANCE, twist: 0.5, armLift: 0.9, armSwing: -1.4, lean: 0.14 };
const C3W: WPose = { ...STANCE, twist: 1.2, armLift: -0.8, armSwing: -1.9, lean: -0.16, crouch: 0.24, reach: -0.06, nod: 0.22, armL: 0.5 };
const C3K: WPose = { ...STANCE, twist: -1.22, armLift: 0.4, armSwing: 2.05, lean: 0.48, crouch: 0.02, reach: 0.5, nod: -0.1, armL: -0.45, y: 0.03 };

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
  private swordHilt = new THREE.Object3D();
  private swordTip = new THREE.Object3D();
  private cape: THREE.Mesh[] = [];

  private pose: WPose = { ...STATUE_W };
  private playerPos = new THREE.Vector3(0, 0, 5);   // pickMove 的背身检测用（update 时缓存）
  private moveFrom = new THREE.Vector3();           // 位移类招（突进/后撤）的起点
  private moveDir = new THREE.Vector3(0, 0, 1);
  private moveLen = 0;
  private p2Applied = false;                        // 二阶段数值 buff 是否已写入共享表
  private slashFired = 0;                           // 已补画刀光的判定段数（与 hitFired 对齐，多段每段一刀光）
  private lastPick = "";                            // 上一记选招，同招连续降权
  private steerT = 0;                               // 上挑前摇内转向的段内时钟

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
    // 右臂 + 大剑。长握柄露出拳头以下一截，宽剑格，厚脊薄刃，尖端逐级收窄。
    // 刃全部用 bladeMat：二阶段整刃一起燃，点燃时机不改。不新开灯。
    this.armR.position.set(0.33, 0.66, 0);
    this.armR.add(box(0.12, 0.44, 0.14, ironDark, 0, -0.2, 0));
    this.armR.add(box(0.105, 0.42, 0.12, iron, 0, -0.58, 0.03));
    this.armR.add(box(0.125, 0.16, 0.14, iron, 0, -0.86, 0.05));           // 铁手套
    const sword = new THREE.Group();
    sword.position.set(0, -0.94, 0.06);
    sword.rotation.x = 0.3;                                                // 略后曳，身侧垂剑时尖落在地面附近
    sword.add(box(0.05, 0.5, 0.056, ironDark, 0, -0.06, 0));               // 长柄：拳头以下还露出一截
    for (const gy of [0.1, 0, -0.1, -0.2]) sword.add(box(0.064, 0.026, 0.07, iron, 0, gy, 0)); // 柄缠
    sword.add(box(0.092, 0.07, 0.082, ironDark, 0, 0.185, 0));             // 柄头
    sword.add(box(0.048, 0.04, 0.05, iron, 0, 0.24, 0));
    sword.add(box(0.5, 0.07, 0.09, iron, 0, -0.34, 0));                    // 剑格
    sword.add(box(0.12, 0.1, 0.11, ironDark, 0, -0.34, 0));
    const ql = box(0.06, 0.15, 0.065, iron, -0.22, -0.4, 0);
    ql.rotation.z = 0.75;
    const qr = box(0.06, 0.15, 0.065, iron, 0.22, -0.4, 0);
    qr.rotation.z = -0.75;
    sword.add(ql, qr);                                                     // 剑格两端下垂
    sword.add(box(0.13, 0.22, 0.06, this.bladeMat, 0, -0.48, 0));          // 剑根
    sword.add(box(0.08, 1.0, 0.052, this.bladeMat, 0, -1.05, 0));          // 脊
    sword.add(box(0.072, 0.92, 0.018, this.bladeMat, -0.07, -1.05, 0));    // 左刃
    sword.add(box(0.072, 0.92, 0.018, this.bladeMat, 0.07, -1.05, 0));     // 右刃
    sword.add(box(0.028, 0.7, 0.012, ironDark, 0, -1.02, 0.032));          // 血槽，刃缘仍走 bladeMat
    sword.add(box(0.05, 0.32, 0.034, this.bladeMat, 0, -1.6, 0));          // 收窄
    sword.add(box(0.04, 0.26, 0.014, this.bladeMat, -0.038, -1.6, 0));
    sword.add(box(0.04, 0.26, 0.014, this.bladeMat, 0.038, -1.6, 0));
    sword.add(box(0.032, 0.16, 0.02, this.bladeMat, 0, -1.74, 0));         // 尖
    sword.add(box(0.014, 0.08, 0.01, this.bladeMat, 0, -1.81, 0));         // 剑尖，末端 y=-1.85
    this.swordHilt.position.set(0, -0.06, 0);
    this.swordTip.position.set(0, -1.85, 0);
    sword.add(this.swordHilt, this.swordTip);
    this.swordLight = new THREE.PointLight(0xff5a20, 0, 5, 2);
    this.swordLight.position.set(0, -1.05, 0);
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

  /** 斩击贴着大剑。火焰旋风是身边那圈火，半径用已经在画的冲击环。 */
  protected override attackVolume(m: MoveDef): AttackVolume | null {
    if (m.name === "watcherFirenova") {
      return { kind: "disk", x: this.root.position.x, z: this.root.position.z, r: m.shock ?? m.range };
    }
    if (m.name.startsWith("watcher")) {
      return { kind: "blade", hilt: this.swordHilt, tip: this.swordTip, pad: 0.12 };
    }
    return null;
  }
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
        Object.assign(wind, C1W); Object.assign(strike, C1K);
        break;
      case "watcherCombo2":
        Object.assign(wind, C2W); Object.assign(strike, C2K);
        break;
      case "watcherSweep":
        Object.assign(wind, C3W); Object.assign(strike, C3K);
        break;
      case "watcherDash":
        wind.twist = 0.55; wind.armLift = -0.9; wind.armSwing = -0.85; wind.crouch = 0.18; wind.reach = 0.1;
        strike.twist = -0.2; strike.armLift = 1.35; strike.armSwing = 0.35; strike.lean = 0.4; strike.reach = 0.45;
        break;
      case "watcherRiser":
        wind.twist = 0.3; wind.armLift = 1.15; wind.armSwing = -0.65; wind.crouch = 0.3; wind.lean = 0.3;
        strike.armLift = -2.5; strike.armSwing = 0.2; strike.lean = -0.18; strike.y = 0.14;   // 剑走立圆，人随势拔起
        break;
      case "watcherBackslash":
        wind.twist = -0.6; wind.armLift = -0.7; wind.armSwing = 1.2; wind.crouch = 0.22;
        strike.twist = 0.7; strike.armLift = 0.55; strike.armSwing = -1.55; strike.lean = 0.15;
        break;
      case "watcherFirenova":
        // 剑竖直举起（和横扫的侧向拉开分开），后半段前摇停在这个姿势上
        wind.armLift = -2.55; wind.armSwing = -0.15; wind.crouch = 0.22; wind.lean = -0.2; wind.twist = 0.12; wind.nod = -0.28;
        strike.armLift = 0.4; strike.armSwing = 1.75; strike.lean = 0.12; strike.crouch = 0.06;
        break;
    }
    if (sub === "tel") {
      // 上挑：绕背时前摇内转过身，否则弧 1.2 永远打在空气里（idle 转向会被这记选招立刻打断）
      if (m.name === "watcherRiser") {
        const dt = Math.min(0.05, Math.max(0, t - this.steerT));
        this.steerT = t;
        this.facePlayer(6.2, dt);
      }
      // 横扫 / 旋风：前半段摆到蓄势，后半段停住。连斩两刀的前摇全程都在动，缝才看得见。
      const held = m.name === "watcherSweep" || m.name === "watcherFirenova";
      const linked = m.name === "watcherCombo" || m.name === "watcherCombo2";
      const tell = held
        ? smooth(seg(t, m.startup * 0.05, m.startup * 0.5))
        : linked
          ? smooth(seg(t, m.startup * 0.08, m.startup * 0.9))
          : smooth(seg(t, m.startup * 0.45, m.startup));
      this.lerpPose(STANCE, wind, tell);
      // 位移段：突进斩前冲（最多冲到玩家身前 1m）/ 后撤斩反向撤步 1.5m / 横扫小踏步（基准在 onMoveStart 记录）
      if (this.moveLen !== 0) {
        const k = smooth(clamp01((t - m.startup * 0.3) / (m.startup * 0.7)));
        this.root.position.copy(this.moveFrom).addScaledVector(this.moveDir, this.moveLen * k);
      }
    } else if (sub === "act") {
      this.emitSlash(m, t);   // 与命中同一帧；收在 active 末帧的刀也不会因为切后摇被吃掉
      if (m.name === "watcherFirenova") {
        const k = smooth(clamp01(t / m.active));
        this.lerpPose(wind, strike, k);
        this.pose.spin = Math.PI * 2 * k;   // 恰好整一圈
      } else if (m.name === "watcherSweep") {
        // 命中在 active*0.4；在此之前甩到扔开的尽头并停住
        const k = clamp01(t / (m.active * 0.42));
        this.lerpPose(wind, strike, 1 - (1 - k) * (1 - k));
      } else if (m.name === "watcherCombo" || m.name === "watcherCombo2") {
        this.lerpPose(wind, strike, smooth(clamp01(t / (m.active * 0.75))));
      } else this.lerpPose(wind, strike, seg(t, 0, m.active));
    } else {
      this.lerpPose(strike, STANCE, smooth(seg(t, m.recovery * 0.35, m.recovery)));
      if (m.name === "watcherFirenova") this.pose.spin = 0;   // 2π≡0：收招直接归零，不倒转
    }
    void total;
  }

  /** 刀光与基类多段时刻同一公式，画在 act 内、命中判定之前。
   *  半径是这一拍剑尖离胸口的距离，弧内缘落在剑身上；不跟 m.range 走（二阶段加长的是判定，不是剑）。
   *  颜色仍是钢色 / 余烬暖色。 */
  private emitSlash(m: MoveDef, t: number): void {
    const hits = m.hits ?? 1;
    const firstAt = m.active * 0.4;
    const interval = m.hitInterval ?? 0.45;
    const burn = this.phase === 2;
    while (this.slashFired < hits && t >= Math.min(firstAt + this.slashFired * interval, m.active)) {
      this.slashFired++;
      this.vfx.slash(this.chestWorld(), this.yaw, this.slashReach(m.name),
        m.arc > 2 || m.name === "watcherFirenova", burn ? 0xff5a20 : 0xd7e3ec);
    }
  }

  /** 判定拍上剑尖到胸口的距离（剑尖本地 y=-1.85，与挥砍姿态一起量的） */
  private slashReach(name: string): number {
    switch (name) {
      case "watcherCombo": return 2.24;
      case "watcherCombo2": return 2.41;
      case "watcherSweep": return 2.61;
      case "watcherDash": return 2.48;
      case "watcherRiser": return 2.5;
      case "watcherBackslash": return 2.31;
      case "watcherFirenova": return 2.72;
      default: return 2.45;
    }
  }

  /** 前摇内朝玩家转，速率封顶，卡帧不会一帧拧过身 */
  private facePlayer(rate: number, dt: number): void {
    const toP = this.playerPos.clone().sub(this.root.position);
    toP.y = 0;
    if (toP.lengthSq() < 1e-4 || dt <= 0) return;
    let d = Math.atan2(toP.x, toP.z) - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.yaw += clampMag(d, rate * dt);
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

  /** 眼缝红点呼吸 / 二阶段燃剑 / 披风摆动 / 二阶段数值 buff 一次性写入（刀光在 movePose 的判定帧画） */
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
    // 二阶段数值 buff：一次性改写共享帧数据表（reset 还原）。刀光在 movePose 的 act 里画，与命中同帧。
    if (burn && !this.p2Applied) this.applyPhase2Moves();
  }

  private applyPhase2Moves(): void {
    this.p2Applied = true;
    for (const m of Object.values(MOVES_WATCHERS)) {
      // 燃剑只加长判定距离和伤害。前摇保持各招原值，二阶段不是无前摇连段。
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

  /** 横扫 whoosh 更闷，和前两刀的脆刀分开 */
  protected override activeWhooshVolume(m: MoveDef): number {
    return m.name === "watcherSweep" || m.name === "watcherFirenova" ? 0.62 : 1;
  }

  /** 位移类招基准：突进斩朝玩家 / 后撤斩沿面向反向 / 横扫踏进一步 */
  protected override onMoveStart(m: MoveDef, toPlayer: THREE.Vector3, dist: number): void {
    this.moveFrom.copy(this.root.position);
    this.slashFired = 0;
    this.steerT = 0;
    this.moveLen = 0;
    if (m.name === "watcherDash") {
      this.moveDir.copy(toPlayer).setY(0).normalize();
      this.moveLen = Math.min(m.lunge ?? 0, Math.max(0, dist - 1.0));
    } else if (m.name === "watcherBackslash") {
      this.moveDir.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      this.moveLen = 1.5;
    } else if (m.name === "watcherSweep") {
      this.moveDir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      this.moveLen = Math.min(0.7, Math.max(0, dist - 0.9));
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

  /** 被击反击（后撤斩）：正常受击（未死/未破绽/未入演出）、后摇或待机、cd 好 → 30% 打断后摇立即反击。
   *  不进选招池。三连斩的段间后摇不是反击窗口，否则第三刀横扫会被受击掐掉。 */
  override takeHit(dmg: number, poise: number): { died: boolean; staggered: boolean } {
    const r = super.takeHit(dmg, poise);
    const bs = MOVES_WATCHERS.watcherBackslash;
    const linking = this.move?.name === "watcherCombo" || this.move?.name === "watcherCombo2";
    if (linking) return r;
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
    this.lastPick = "";
    this.steerT = 0;
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

  /** 三连斩的后续段必出。基类 chain 是 40% 且出了射程就取消，会把「第三刀必横扫」变成掷骰。 */
  protected override pickChain(m: MoveDef, dist: number, toPlayer: THREE.Vector3): MoveDef | null {
    if (m.name === "watcherCombo" || m.name === "watcherCombo2") {
      const next = m.chain ? MOVES_WATCHERS[m.chain] : undefined;
      return next ?? null;
    }
    return super.pickChain(m, dist, toPlayer);
  }

  // ---------------- 选招（监视者权重） ----------------
  protected override pickMove(dist: number): MoveDef | null {
    const M = MOVES_WATCHERS;
    const ready = (m: MoveDef) => (this.cds[m.name] ?? 0) <= 0 && (!m.phase2Only || this.phase === 2);
    // 背身或贴身 → 上挑解围。必须在命中距离内：原先任意距离背身都会挥空，而且前摇不转向，弧 1.2 打不中。
    // 贴身连续上挑让给权重池（同招降权）；绕背仍然上挑，因为只有这一招会在前摇里转身。
    const toP = this.playerPos.clone().sub(this.root.position); toP.y = 0;
    const dirYaw = Math.atan2(toP.x, toP.z);
    const riser = M.watcherRiser;
    const facedAway = toP.lengthSq() > 1e-4 && !angleWithin(this.yaw, dirYaw, 2.1);
    const hugging = dist < 1.3;
    if (ready(riser) && dist <= riser.range + 0.35 && (facedAway || (hugging && this.lastPick !== riser.name))) {
      return this.remember(riser);
    }
    const penalize = (m: MoveDef, w: number) => (w > 0 && m.name === this.lastPick ? w * 0.35 : w);
    // 贴身时上挑仍留在池里（降权后），否则「刚上挑过」会把唯一够得着的招也拿掉
    const riserW = dist > 1.5 || hugging ? 1.5 : 0;
    // 二阶段刀长 +0.4，旋风的出手距离带跟着外扩，否则加长的判定接不到人
    const novaFar = 4.5 + (this.phase === 2 ? 0.4 : 0);
    const pool: [MoveDef, number][] = [
      [M.watcherCombo, penalize(M.watcherCombo, 3)],
      [M.watcherDash, penalize(M.watcherDash, dist > 2.0 ? 2.5 : 0)],
      [M.watcherRiser, penalize(M.watcherRiser, riserW)],
      [M.watcherFirenova, penalize(M.watcherFirenova, this.phase === 2 && dist > 2.5 && dist < novaFar ? 2 : 0)],
    ];
    // 回斩 / 横扫 / 后撤斩不进池：后两段只从 chain 来，后撤斩只从受击来
    const cands = pool.filter(([m, w]) => w > 0 && ready(m) && dist < m.range * 0.95);
    if (!cands.length) return null;
    return this.remember(pickWeighted(cands) ?? cands[0][0]);
  }

  private remember(m: MoveDef): MoveDef {
    this.lastPick = m.name;
    return m;
  }
}
