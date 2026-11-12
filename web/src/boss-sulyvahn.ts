/** Boss #4「教宗沙力万」（docs/design/m3-bosses.md Boss#4 帧数据表）：高瘦术士剑士、双手细长巨剑 ×2（右火左暗紫）
 * 通用机制（状态机/削韧破绽/弹反/多段判定/冷却/走近追踪/阶段转换）全在 BossBase（boss-base.ts），
 * 本文件只保留沙力万专属：MOVES_SULYVANN/FEEL_SULYVANN（模块加载即并入 config 总表——调校台/存档自动收录，不改现有文件）、
 * 双剑外观与 Pose 系统、选招权重、投射物发射（暗月矢/纵横月焰经 host.fireProjectile → game 侧 Projectiles 池）、
 * 二阶段双焰点燃 + 投影分身（本体骨架克隆换半透明材质，纯视觉不造成伤害）。
 * 暗紫（0x7a4d9e 系）是本 Boss 主题色例外（m3-bosses.md 破例条款，与玻尔多冰蓝同理）。
 */
import * as THREE from "three";
import { MOVES, FEEL, MoveDef, FeelDef } from "./config";
import { Vfx } from "./vfx";
import { BossBase, BossStats, clamp01, smooth, seg } from "./boss-base";
import type { BossHost } from "./boss-base";
import type { ProjDef } from "./projectile";

export type { BossState, BossHost } from "./boss-base";

// ---------------- 主题色（暗紫 = 本 Boss 唯一例外强调色） ----------------
const DARKMOON = 0xb9a6ff;    // 暗月矢 / 月焰投射物（微紫冷光）
const FIRE = 0xff5a20;        // 二阶段右剑焰（与监视者燃焰同源——罪业火焰）
const DARKFLAME = 0x7a4d9e;   // 二阶段左剑暗紫焰
const GHOST_COLOR = 0x9a86d8; // 投影分身 / 眼光
const SLASH_COOL = 0xd7e3ec;  // 一阶段刀光（冷白）

/** 投射物参数（发射走 host.fireProjectile，飞行/命中/消散由 game 侧 Projectiles 池负责） */
const ARROW_PROJ: ProjDef = { speed: 10, radius: 0.4, dmg: 22, feelKey: "sMagic", life: 2.2, color: DARKMOON };
const VOLLEY_PROJ: ProjDef = { speed: 10, radius: 0.4, dmg: 16, feelKey: "sMagic", life: 2.2, color: DARKMOON };

// ---------------- 帧数据（m3-bosses.md 一阶段表 + 二阶段新招） ----------------
export const MOVES_SULYVANN: Record<string, MoveDef> = {
  // 双剑四连：多段时间轴——第 k 段在 min(active*0.4 + k*0.42, active) 触发。
  // 取 active 2.2：首段 0.88，后续 0.88+k*0.42 ⇒ 0.88 / 1.30 / 1.72 / 2.14，末段距收尾还有 0.06s 余量（四段全触发，不受 active 钳制）。
  // 设计表"第 2 刀故意延迟 0.5s 骗取消"用均匀 0.42 近似——引擎只有单一 hitInterval，拆非均匀节拍要改基类逐段表，收益不抵。
  sulyvahnCombo4: {
    name: "sulyvahnCombo4", label: "双剑四连", startup: 0.30, active: 2.2, recovery: 0.85,
    dmg: 11, range: 3.2, arc: 1.6, hits: 4, hitInterval: 0.42,
    parryable: true, cd: 4.0, feel: "sLight",   // 仅首段可弹反由引擎保证（首段命中关窗 + t>active*0.7 关窗）
  },
  // 大回旋：全周身一击；双剑水平回旋视觉在 onMoveActive（宽弧 ×2 反向）
  sulyvahnSpin: {
    name: "sulyvahnSpin", label: "大回旋", startup: 0.60, active: 0.20, recovery: 1.00,
    dmg: 28, range: 4.2, arc: 6.28, parryable: true, cd: 5.0, feel: "sHeavy",
  },
  // 突刺→上挑：两段 min(0.4*active + k*0.35, active)，取 active 0.75 ⇒ 0.30 / 0.65（余量 0.10，两段全触发）。
  // 表值 18+16 用 hits=2 统一 17（2×17=34=18+16，上挑段差异忽略）；前冲 1.5m 在 movePose tel 段消费（不越过玩家）。
  sulyvahnThrustUp: {
    name: "sulyvahnThrustUp", label: "突刺上挑", startup: 0.35, active: 0.75, recovery: 0.90,
    dmg: 17, range: 4.6, arc: 0.9, hits: 2, hitInterval: 0.35, lunge: 1.5,
    parryable: true, cd: 4.5, feel: "sHeavy",   // 仅突刺段可弹反（引擎：首段命中即关窗）
  },
  // 暗月矢：近战判定禁用——range 0.2（基类判定 dist≤range+0.45=0.65，而人/Boss 推挤最小间距 1.45，永不满足）；
  // 伤害由 ARROW_PROJ 承载（速度 10 可翻滚穿），发射在 onMoveActive（挥剑甩矢姿态）。
  sulyvahnArrow: {
    name: "sulyvahnArrow", label: "暗月矢", startup: 0.65, active: 0.2, recovery: 0.80,
    dmg: 22, range: 0.2, arc: 0.9, parryable: false, cd: 6.5, feel: "sMagic",
    proj: { speed: 10, radius: 0.4, life: 2.2 },
  },
  // 纵横月焰（二阶段）：两波各 3 矢扇形（yaw±0.22/0）。波 2 在 act 起点 +0.35s 于 movePose 内补发
  // （active 0.2 ⇒ 落在 rec 段 t≈0.15；不用 setTimeout——调校台暂停会脱钩）。
  sulyvahnVolley: {
    name: "sulyvahnVolley", label: "纵横月焰", startup: 0.70, active: 0.2, recovery: 1.0,
    dmg: 16, range: 0.2, arc: 0.9, parryable: false, cd: 8.0, phase2Only: true, feel: "sMagic",
    proj: { speed: 10, radius: 0.4, life: 2.2 },
  },
};
Object.assign(MOVES, MOVES_SULYVANN);

// ---------------- 手感档案（弹反考试 Boss：轻快双刃 + 魔法命中） ----------------
export const FEEL_SULYVANN: Record<string, FeelDef & { label: string }> = {
  sLight: { label: "沙力万·轻斩", hitstop: 0.05, shake: 0.35, sparks: 10, sparkSpeed: 4, knockback: 0.30, sfx: "hitStone" },
  sHeavy: { label: "沙力万·重斩", hitstop: 0.08, shake: 0.50, sparks: 14, sparkSpeed: 5, knockback: 0.50, sfx: "hitHeavy" },
  sMagic: { label: "暗月·命中",   hitstop: 0.10, shake: 0.45, sparks: 16, sparkSpeed: 5, knockback: 0.60, sfx: "hitHeavy" },  // 投射物命中用
};
Object.assign(FEEL, FEEL_SULYVANN);

export const SULYVANN_STATS: BossStats & { name: string; radius: number } = {
  name: "教宗沙力万", radius: 1.0,
  hp: 720,
  poiseMax: 110, poiseDecay: 12,   // 削韧恢复偏快——弹反才是正解
  staggerDur: 2.0, staggerMul: 1.5, parriedDur: 1.8,
  phase2At: 0.55,
  walkSpeed: 3.6, turnRate: 4.2,   // 术士剑士：滑步快、转向灵
};

/** 二阶段 buff（连段伤害 ×1.2、全部前摇 ×0.9）的一阶段基线——模块级快照，多实例/reset 往返安全（仿 watchers） */
const P1_BASE: Record<string, { startup: number; dmg: number }> = {};
for (const m of Object.values(MOVES_SULYVANN)) P1_BASE[m.name] = { startup: m.startup, dmg: m.dmg };

/** 投影分身材质：半透明暗紫加色（本体克隆件统一换此材质） */
const GHOST_MAT = new THREE.MeshBasicMaterial({
  color: GHOST_COLOR, transparent: true, opacity: 0.35,
  blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
});

// ---------------- 姿态（Pose）：双剑臂各自 lift/swing ----------------
interface Pose {
  y: number; lean: number; twist: number; crouch: number; reach: number;
  rLift: number; rSwing: number;   // 右剑臂：lift 正=前甩 负=上举；swing 正=向左抡
  lLift: number; lSwing: number;   // 左剑臂（镜像）
  nod: number;                     // 头部俯仰（正=低头）
  spin: number;                    // 整体附加旋转（大回旋转体）
}
const STANCE: Pose = { y: 0, lean: 0.07, twist: -0.1, crouch: 0, reach: 0, rLift: 0.3, rSwing: 0.18, lLift: 0.3, lSwing: -0.18, nod: 0.08, spin: 0 };
const STATUE: Pose = { ...STANCE, lean: 0.04, twist: 0, rLift: 0.1, rSwing: 0.05, lLift: 0.1, lSwing: -0.05, nod: 0.52 };  // 垂剑伫立低头（双剑拄地交叉）
// 双剑四连四拍（拍内 wind→strike；1 右横斩 / 2 左回斩 / 3 右力劈 / 4 双剑交剪收尾）
const B1W: Pose = { ...STANCE, twist: 0.55, rLift: -0.75, rSwing: -0.85, nod: 0.12 };
const B1K: Pose = { ...STANCE, twist: -0.5, rLift: 0.55, rSwing: 0.95, lean: 0.16 };
const B2W: Pose = { ...STANCE, twist: -0.55, lLift: -0.75, lSwing: 0.85, nod: 0.12 };
const B2K: Pose = { ...STANCE, twist: 0.5, lLift: 0.55, lSwing: -0.95, lean: 0.14 };
const B3W: Pose = { ...STANCE, twist: 0.35, rLift: -1.55, rSwing: -0.3, lean: -0.08, crouch: 0.06 };
const B3K: Pose = { ...STANCE, twist: -0.6, rLift: 0.75, rSwing: 0.6, lean: 0.3, crouch: 0.1 };
const B4W: Pose = { ...STANCE, twist: 0.7, rLift: -0.9, rSwing: -1.0, lLift: -0.9, lSwing: 1.0 };
const B4K: Pose = { ...STANCE, twist: -0.75, rLift: 0.7, rSwing: 1.25, lLift: 0.7, lSwing: -1.25, lean: 0.24, crouch: 0.12 };
// 突刺→上挑两拍（与判定时刻 0.30/0.65 对齐）
const TW: Pose = { ...STANCE, crouch: 0.22, twist: 0.5, rLift: -0.55, rSwing: -0.35, lean: 0.1 };
const T1K: Pose = { ...STANCE, twist: -0.15, rLift: 1.2, rSwing: 0.05, lean: 0.38, reach: 0.45, crouch: 0.15 };
const T2W: Pose = { ...STANCE, twist: 0.1, rLift: 0.45, rSwing: 0.1, lean: 0.2, crouch: 0.2 };
const T2K: Pose = { ...STANCE, rLift: -2.1, rSwing: 0.1, lean: -0.14, y: 0.12, nod: -0.1 };   // 上挑剑走立圆，人随势拔起
// 暗月矢：左剑高举后甩发（单手甩剑）
const AW: Pose = { ...STANCE, twist: -0.5, lLift: -1.85, lSwing: 0.65, lean: -0.1, nod: 0.12, rLift: 0.2, rSwing: 0.35 };
const AK: Pose = { ...STANCE, twist: 0.22, lLift: 1.0, lSwing: -0.15, lean: 0.3, reach: 0.3, nod: 0.02 };
// 纵横月焰：双剑高举交叉 → 两侧甩开（两波各甩一次）
const VW: Pose = { ...STANCE, rLift: -1.7, rSwing: -0.55, lLift: -1.7, lSwing: 0.55, lean: -0.12, crouch: 0.12, nod: -0.08 };
const VK: Pose = { ...STANCE, rLift: 0.35, rSwing: 1.15, lLift: 0.35, lSwing: -1.15, lean: 0.18 };

export class Sulyvahn extends BossBase {
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
  private bladeFire!: THREE.MeshStandardMaterial;   // 右剑身（二阶段燃焰）
  private bladeDark!: THREE.MeshStandardMaterial;   // 左剑身（二阶段暗紫焰）
  private fireLight!: THREE.PointLight;
  private darkLight!: THREE.PointLight;
  private skirt: THREE.Mesh[] = [];                 // 长袍下摆阶梯层（updateVisuals 摆动）

  private pose: Pose = { ...STATUE };
  private moveFrom = new THREE.Vector3();           // 突刺前冲基准
  private moveDir = new THREE.Vector3(0, 0, 1);
  private moveLen = 0;
  private slashFired = 0;                           // 已补画刀光的判定段数（与 hitFired 对齐）
  private volleyFired = 0;                          // 月焰已发波数（波 2 在 movePose 补发）
  private p2Applied = false;                        // 二阶段数值 buff 是否已写入共享表
  private lastDt = 0;                               // 投影分身缓动用（暂停时 0 → 跟随冻结）

  // 投影分身（仅二阶段）：本体骨架整体克隆换半透明材质，不进 this.root——独立缓动站位
  private ghostRoot = new THREE.Group();
  private gBody!: THREE.Group;
  private gTorso!: THREE.Group;
  private gHead!: THREE.Group;
  private gArmR!: THREE.Group;
  private gArmL!: THREE.Group;
  private gLegR!: THREE.Group;
  private gLegL!: THREE.Group;
  private gShinR!: THREE.Group;
  private gShinL!: THREE.Group;
  private ghostYaw = 0;
  private ghostOn = false;

  constructor(scene: THREE.Scene, vfx: Vfx, pos: THREE.Vector3, host: BossHost, facing = -Math.PI / 2) {
    super(scene, vfx, pos, host, SULYVANN_STATS, facing);
    this.transformHitAt = 0.6;   // 0.6s 爆发波（m3-bosses.md 二阶段变身）
    this.assemble();
  }

  // ---------------- 外观：高瘦术士剑士（肩宽 1.2 / 高 ~2.6，长袍层叠 + 教宗冠 + 冠下无脸紫眼 + 双细长巨剑） ----------------
  protected override buildBody(): void {
    const cloth = new THREE.MeshStandardMaterial({ color: 0x211c2a, roughness: 1, metalness: 0.05, flatShading: true });
    const clothDark = new THREE.MeshStandardMaterial({ color: 0x16131e, roughness: 1, flatShading: true });
    const steel = new THREE.MeshStandardMaterial({ color: 0x494f5c, roughness: 0.6, metalness: 0.4, flatShading: true });
    const gold = new THREE.MeshStandardMaterial({ color: 0xe6c37a, roughness: 0.45, metalness: 0.6, emissive: 0x241a08, flatShading: true });
    this.bladeFire = new THREE.MeshStandardMaterial({ color: 0x8b94a2, roughness: 0.35, metalness: 0.7, flatShading: true, emissive: FIRE, emissiveIntensity: 0 });
    this.bladeDark = new THREE.MeshStandardMaterial({ color: 0x837c95, roughness: 0.35, metalness: 0.7, flatShading: true, emissive: DARKFLAME, emissiveIntensity: 0 });
    this.eyeMat = new THREE.MeshStandardMaterial({ color: 0x0a0710, roughness: 0.5, emissive: GHOST_COLOR, emissiveIntensity: 0.9 });

    const box = (w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z); m.castShadow = true;
      return m;
    };

    // 腿（长袍下若隐若现）——髋枢轴 + 膝枢轴（crouch 弯折）——腿根 y 1.38
    for (const [leg, shin, sx] of [[this.legR, this.shinR, 0.13], [this.legL, this.shinL, -0.13]] as [THREE.Group, THREE.Group, number][]) {
      leg.position.set(sx, 1.38, 0);
      leg.add(box(0.16, 0.64, 0.19, clothDark, 0, -0.32, 0));                 // 大腿
      shin.position.set(0, -0.64, 0);
      shin.add(box(0.13, 0.58, 0.15, clothDark, 0, -0.29, 0.01));             // 小腿
      shin.add(box(0.15, 0.09, 0.28, clothDark, 0, -0.58, 0.06));             // 足
      leg.add(shin);
      this.body.add(leg);
    }
    // 长袍下摆：阶梯三层 box（随步态摆动，见 updateVisuals）
    this.skirt.push(
      box(0.56, 0.36, 0.4, cloth, 0, 1.34, 0),
      box(0.68, 0.34, 0.46, cloth, 0, 1.03, 0),
      box(0.8, 0.34, 0.52, clothDark, 0, 0.72, 0),
    );
    for (const s of this.skirt) this.body.add(s);
    const slit = box(0.05, 0.62, 0.02, clothDark, 0, 1.02, 0.27);             // 袍正中开缝
    this.body.add(slit);
    this.body.add(box(0.46, 0.1, 0.34, steel, 0, 1.46, 0));                   // 腰带

    // 躯干（层叠）——底座 y 1.52
    this.torso.position.y = 1.52;
    this.torso.add(box(0.4, 0.34, 0.26, clothDark, 0, 0.05, 0));              // 腹甲
    this.torso.add(box(0.5, 0.42, 0.3, cloth, 0, 0.38, 0));                   // 胸甲
    this.torso.add(box(0.54, 0.26, 0.34, clothDark, 0, 0.62, 0.01));          // 上层
    this.torso.add(box(0.42, 0.34, 0.06, clothDark, 0, 0.36, -0.17));         // 背板
    // 肩宽 1.2：肩甲 ±0.62 双层
    for (const s of [-1, 1]) {
      const p1 = box(0.3, 0.16, 0.34, steel, s * 0.55, 0.68, 0);
      p1.rotation.z = -s * 0.3;
      const p2 = box(0.2, 0.12, 0.28, clothDark, s * 0.66, 0.56, 0);
      p2.rotation.z = -s * 0.5;
      this.torso.add(p1, p2);
    }
    // 锁链垂饰：胸前三节链 + 旭日徽章
    this.torso.add(box(0.05, 0.05, 0.05, steel, 0.1, 0.6, 0.16));
    this.torso.add(box(0.05, 0.05, 0.05, steel, -0.1, 0.6, 0.16));
    this.torso.add(box(0.04, 0.04, 0.04, steel, 0, 0.5, 0.17));
    const medal = box(0.16, 0.16, 0.04, gold, 0, 0.36, 0.18);
    medal.rotation.z = Math.PI / 4;
    this.torso.add(medal);

    // 头：冠下无脸（黑域）+ 两点紫眼光 + 教宗冠（四棱锥高冠 + 金带 + 冠翼）
    this.head.position.set(0, 0.8, 0.02);
    this.head.add(box(0.22, 0.24, 0.22, clothDark, 0, 0, 0));                 // 面部黑域
    for (const ex of [-0.055, 0.055]) this.head.add(box(0.045, 0.03, 0.02, this.eyeMat, ex, 0.02, 0.115));
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.19, 0.46, 4), cloth);
    crown.position.y = 0.36; crown.rotation.y = Math.PI / 4; crown.castShadow = true;
    this.head.add(crown);
    this.head.add(box(0.26, 0.06, 0.26, gold, 0, 0.16, 0));                   // 冠带
    for (const s of [-1, 1]) {
      const wing = box(0.035, 0.3, 0.13, clothDark, s * 0.17, 0.4, 0);
      wing.rotation.z = -s * 0.35;
      this.head.add(wing);
    }
    this.torso.add(this.head);

    // 双臂 + 细长巨剑（剑长 1.6 比例夸张；右火左暗，剑身 emissive 二阶段点燃）
    const buildSword = (mat: THREE.MeshStandardMaterial, side: 1 | -1, light: THREE.PointLight) => {
      const g = new THREE.Group();
      g.position.set(0, -0.92, 0.06);
      g.rotation.x = 0.35;                       // 剑尖前下曳——垂剑时恰好拄地
      g.rotation.z = side * 0.14;                // 双剑内倾——拄地时剑尖交叉
      g.add(box(0.05, 0.22, 0.055, clothDark));  // 柄
      g.add(box(0.07, 0.06, 0.075, steel, 0, 0.14, 0));                       // 柄头
      g.add(box(0.34, 0.045, 0.07, steel, 0, -0.12, 0));                      // 护手
      g.add(box(0.075, 1.6, 0.03, mat, 0, -0.95, 0));                         // 剑身
      g.add(box(0.05, 0.24, 0.026, mat, 0, -1.84, 0));                        // 剑尖收锋
      light.position.set(0, -1.0, 0);
      g.add(light);
      return g;
    };
    this.fireLight = new THREE.PointLight(FIRE, 0, 5, 2);
    this.darkLight = new THREE.PointLight(DARKFLAME, 0, 5, 2);
    this.armR.position.set(0.36, 0.68, 0);
    this.armR.add(box(0.12, 0.42, 0.13, clothDark, 0, -0.19, 0));
    this.armR.add(box(0.105, 0.4, 0.115, cloth, 0, -0.54, 0.02));
    this.armR.add(box(0.125, 0.15, 0.135, steel, 0, -0.82, 0.04));            // 铁手套
    this.armR.add(buildSword(this.bladeFire, 1, this.fireLight));
    this.torso.add(this.armR);
    this.armL.position.set(-0.36, 0.68, 0);
    this.armL.add(box(0.12, 0.42, 0.13, clothDark, 0, -0.19, 0));
    this.armL.add(box(0.105, 0.4, 0.115, cloth, 0, -0.54, 0.02));
    this.armL.add(box(0.125, 0.15, 0.135, steel, 0, -0.82, 0.04));
    this.armL.add(buildSword(this.bladeDark, -1, this.darkLight));
    this.torso.add(this.armL);

    this.root.add(this.body);
    this.body.add(this.torso);

    // ---- 投影分身：本体骨架整体克隆换半透明投影材质（挂 scene 不挂 root——独立缓动站位；仅二阶段可见） ----
    this.body.name = "sulBody"; this.torso.name = "sulTorso"; this.head.name = "sulHead";
    this.armR.name = "sulArmR"; this.armL.name = "sulArmL";
    this.legR.name = "sulLegR"; this.legL.name = "sulLegL";
    this.shinR.name = "sulShinR"; this.shinL.name = "sulShinL";
    const ghost = this.body.clone(true);
    ghost.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.material = GHOST_MAT; m.castShadow = false; }
      const l = o as THREE.PointLight;
      if (l.isPointLight) l.intensity = 0;      // 分身不发光（本体灯的克隆，永久熄灭）
    });
    this.gBody = ghost;
    this.gTorso = ghost.getObjectByName("sulTorso") as THREE.Group;
    this.gHead = ghost.getObjectByName("sulHead") as THREE.Group;
    this.gArmR = ghost.getObjectByName("sulArmR") as THREE.Group;
    this.gArmL = ghost.getObjectByName("sulArmL") as THREE.Group;
    this.gLegR = ghost.getObjectByName("sulLegR") as THREE.Group;
    this.gLegL = ghost.getObjectByName("sulLegL") as THREE.Group;
    this.gShinR = ghost.getObjectByName("sulShinR") as THREE.Group;
    this.gShinL = ghost.getObjectByName("sulShinL") as THREE.Group;
    this.ghostRoot.name = "sulyvahnGhost";
    this.ghostRoot.add(ghost);
    this.ghostRoot.visible = false;
    (this.root.parent as THREE.Scene).add(this.ghostRoot);
  }

  protected override chestPart(): THREE.Object3D { return this.torso; }
  protected override headPart(): THREE.Object3D { return this.head; }

  // ---------------- 姿态应用 ----------------
  protected override applyPose(): void {
    const p = this.pose;
    this.root.rotation.y = this.yaw + p.spin;
    this.body.position.set(0, p.y - p.crouch * 0.3, p.reach);
    this.torso.rotation.set(p.lean, p.twist, 0);
    this.head.rotation.x = p.nod;
    this.armR.rotation.set(-p.rLift, 0, -p.rSwing);
    this.armL.rotation.set(-p.lLift, -0.15, p.lSwing);
    // 蹲伏：前腿弓、后腿屈（膝枢轴随 crouch 弯折）
    this.legR.rotation.x = -p.crouch * 0.65;
    this.shinR.rotation.x = p.crouch * 1.25;
    this.legL.rotation.x = -p.crouch * 0.5;
    this.shinL.rotation.x = p.crouch * 0.9;
  }

  private lerpPose(a: Pose, b: Pose, k: number): void {
    const p = this.pose;
    p.y = a.y + (b.y - a.y) * k; p.lean = a.lean + (b.lean - a.lean) * k;
    p.twist = a.twist + (b.twist - a.twist) * k; p.crouch = a.crouch + (b.crouch - a.crouch) * k;
    p.reach = a.reach + (b.reach - a.reach) * k;
    p.rLift = a.rLift + (b.rLift - a.rLift) * k; p.rSwing = a.rSwing + (b.rSwing - a.rSwing) * k;
    p.lLift = a.lLift + (b.lLift - a.lLift) * k; p.lSwing = a.lSwing + (b.lSwing - a.lSwing) * k;
    p.nod = a.nod + (b.nod - a.nod) * k; p.spin = a.spin + (b.spin - a.spin) * k;
  }

  protected override movePose(m: MoveDef, sub: string, t: number, total: number): void {
    // 月焰波 2 补发：act 起点 +0.35s（active 0.2 ⇒ 落在 rec 段 t≈0.15；与战斗时间同源，暂停不脱钩）
    if (m.name === "sulyvahnVolley" && this.volleyFired === 1) {
      const ta = sub === "act" ? t : t + m.active;
      if (ta >= 0.35) { this.volleyFired = 2; this.fireSpread(); }
    }
    const wind: Pose = { ...STANCE }, strike: Pose = { ...STANCE };
    switch (m.name) {
      case "sulyvahnSpin":   // 双剑水平展开蓄势 → 转体横扫（spin 转整圈）
        wind.rSwing = -1.35; wind.lSwing = 1.35; wind.rLift = 0.1; wind.lLift = 0.1; wind.lean = 0.14; wind.crouch = 0.1;
        strike.rSwing = -1.5; strike.lSwing = 1.5; strike.rLift = 0.2; strike.lLift = 0.2; strike.lean = 0.3; strike.crouch = 0.16;
        break;
      case "sulyvahnArrow":  // 左剑高举后曳 → 单手甩剑发矢
        Object.assign(wind, AW); Object.assign(strike, AK);
        break;
      case "sulyvahnVolley": // 双剑高举交叉 → 两侧甩开
        Object.assign(wind, VW); Object.assign(strike, VK);
        break;
      case "sulyvahnThrustUp":  // 蓄势拧身（act 两拍在 thrustPose）
        Object.assign(wind, TW);
        break;
    }
    if (sub === "tel") {
      this.lerpPose(STANCE, wind, smooth(seg(t, m.startup * 0.45, m.startup)));
      // 突刺前冲：位移放前摇段（基准在 onMoveStart 记录，act 起点已在玩家身前）
      if (this.moveLen !== 0) {
        const k = smooth(clamp01((t - m.startup * 0.3) / (m.startup * 0.7)));
        this.root.position.copy(this.moveFrom).addScaledVector(this.moveDir, this.moveLen * k);
      }
    } else if (sub === "act") {
      if (m.name === "sulyvahnCombo4") this.comboPose(t, m);
      else if (m.name === "sulyvahnThrustUp") this.thrustPose(t, m);
      else if (m.name === "sulyvahnSpin") {
        const k = smooth(clamp01(t / m.active));
        this.lerpPose(wind, strike, k);
        this.pose.spin = Math.PI * 2 * k;        // 恰好整一圈
      }
      else this.lerpPose(wind, strike, seg(t, 0, m.active));
    } else {
      this.lerpPose(strike, STANCE, smooth(seg(t, m.recovery * 0.35, m.recovery)));
      if (m.name === "sulyvahnSpin") this.pose.spin = 0;   // 2π≡0：收招直接归零，不倒转
    }
    void total;
  }

  /** 双剑四连判定段姿态：四拍与引擎判定时刻对齐（首段 active*0.4=0.88，其后每 0.42s），左右剑交替、末拍双剑交剪 */
  private comboPose(t: number, m: MoveDef): void {
    const firstAt = m.active * 0.4;
    const ph = clamp01((t - firstAt) / (m.active - firstAt)) * 4;
    const idx = Math.min(3, Math.floor(ph));
    const s = smooth(clamp01(ph - idx));
    const w = idx === 0 ? B1W : idx === 1 ? B2W : idx === 2 ? B3W : B4W;
    const k = idx === 0 ? B1K : idx === 1 ? B2K : idx === 2 ? B3K : B4K;
    this.lerpPose(w, k, s);
  }

  /** 突刺→上挑两拍：与判定时刻 active*0.4 / +hitInterval 对齐（0.30 / 0.65） */
  private thrustPose(t: number, m: MoveDef): void {
    const t1 = m.active * 0.4;
    const t2 = t1 + (m.hitInterval ?? 0.35);
    if (t < t1) this.lerpPose(TW, T1K, smooth(clamp01(t / t1)));
    else if (t < t2) this.lerpPose(T1K, T2W, smooth((t - t1) / (t2 - t1)));           // 突刺定住 → 沉臂蓄上挑
    else this.lerpPose(T2W, T2K, smooth(clamp01((t - t2) / Math.max(0.01, m.active - t2))));
  }

  // ---------------- 沙力万专属覆盖点 ----------------
  /** 缓存真实 dt 并在帧末驱动投影分身（super.update 末尾 applyPose 已写入骨架——分身硬抄需在同帧姿态之后） */
  override update(dt: number, playerPos: THREE.Vector3, playerIframed: boolean): void {
    this.lastDt = dt;
    super.update(dt, playerPos, playerIframed);
    this.updateGhost();
  }

  /** 唤醒：垂剑石像 2.0s 抬头展剑（术士起身快于兽形） */
  protected override updateRising(dt: number): void {
    this.t += dt;
    this.lerpPose(STATUE, STANCE, smooth(clamp01(this.t / 2.0)));
    if (Math.random() < dt * 8) this.vfx.dust.burst(this.root.position, 2, 2, 0.6);
    if (this.t > 0.45 && this.t - dt <= 0.45) this.host.onBossReveal();
    if (this.t >= 2.0) { this.state = "combat"; this.sub = "idle"; this.t = 0; }
  }

  /** 眼光呼吸 / 二阶段双焰剑 / 长袍摆动 / 刀光按判定段补画 / 二阶段数值 buff 一次性写入 / 投影分身驱动 */
  protected override updateVisuals(): void {
    const now = performance.now();
    const p2 = this.phase === 2;
    const eye = (this.state === "statue" ? 0.35 : p2 ? 2.0 : 0.9) + Math.sin(now * 0.004) * 0.2;
    this.eyeMat.emissiveIntensity = Math.max(0, eye);
    const flick = 1 + Math.sin(now * 0.02) * 0.15;
    this.bladeFire.emissiveIntensity = p2 ? 1.7 * flick : 0;   // transform 演出点燃（右火左暗紫）
    this.bladeDark.emissiveIntensity = p2 ? 1.7 * flick : 0;
    this.fireLight.intensity = p2 ? 3.2 * flick : 0;
    this.darkLight.intensity = p2 ? 2.6 * flick : 0;
    for (let i = 0; i < this.skirt.length; i++) {
      const s = this.skirt[i];
      s.rotation.x = 0.04 + Math.sin(now * 0.003 + i * 1.3) * 0.05 + this.pose.lean * 0.16;
      s.rotation.z = Math.sin(now * 0.0023 + i * 1.9) * 0.04;
    }
    // 刀光：近战多段每段一刀光（hitFired 无条件按节拍推进，躲开也照画；首段与命中同帧）
    if (this.state === "combat" && this.sub === "act" && this.move &&
      (this.move.name === "sulyvahnCombo4" || this.move.name === "sulyvahnThrustUp")) {
      while (this.slashFired < this.hitFired) {
        this.slashFired++;
        const col = p2 ? (this.slashFired % 2 ? GHOST_COLOR : FIRE) : SLASH_COOL;   // 二阶段火/暗交替
        this.vfx.slash(this.chestWorld(), this.yaw, this.move.range * 0.8, false, col);
      }
    }
    // 二阶段数值 buff：一次性改写共享帧数据表（reset 还原）
    if (p2 && !this.p2Applied) this.applyPhase2Moves();
  }

  /** 二阶段：连段伤害 ×1.2（仅四连）、全部前摇 ×0.9（压力陡增，m3-bosses.md） */
  private applyPhase2Moves(): void {
    this.p2Applied = true;
    for (const m of Object.values(MOVES_SULYVANN)) {
      m.startup = P1_BASE[m.name].startup * 0.9;
      if (m.name === "sulyvahnCombo4") m.dmg = Math.round(P1_BASE[m.name].dmg * 1.2);
    }
  }
  private restorePhase1Moves(): void {
    this.p2Applied = false;
    for (const m of Object.values(MOVES_SULYVANN)) {
      m.startup = P1_BASE[m.name].startup;
      m.dmg = P1_BASE[m.name].dmg;
    }
  }

  /** 术士滑步（高频小幅） */
  protected override onIdleWalk(): void {
    this.pose.y = Math.abs(Math.sin(performance.now() * 0.009)) * 0.04 - 0.012;
  }

  /** 位移基准与段计数复位：突刺朝玩家前冲（不越过） */
  protected override onMoveStart(m: MoveDef, toPlayer: THREE.Vector3, dist: number): void {
    this.moveFrom.copy(this.root.position);
    this.slashFired = 0;
    this.volleyFired = 0;
    this.moveLen = 0;
    if (m.name === "sulyvahnThrustUp") {
      this.moveDir.copy(toPlayer).setY(0).normalize();
      this.moveLen = Math.min(m.lunge ?? 0, Math.max(0, dist - 1.2));
    }
  }

  /** 判定段开始：投射物发射 / 回旋宽弧 */
  protected override onMoveActive(m: MoveDef): void {
    if (m.name === "sulyvahnArrow") {
      const origin = this.chestWorld().setY(1.6);
      this.host.fireProjectile?.(origin, this.yaw, ARROW_PROJ);
      this.vfx.slash(origin, this.yaw, 1.1, false, DARKMOON);   // 甩剑发矢轨迹
    } else if (m.name === "sulyvahnVolley") {
      this.volleyFired = 1;
      this.fireSpread();
    } else if (m.name === "sulyvahnSpin") {
      // 双剑水平回旋：宽弧 ×2 反向（二阶段火/暗双色）
      const c = this.chestWorld();
      this.vfx.slash(c, this.yaw + 0.25, m.range * 0.9, true, this.phase === 2 ? FIRE : SLASH_COOL);
      this.vfx.slash(c.clone().setY(Math.max(0.5, c.y - 0.75)), this.yaw - 0.25, m.range * 0.85, true, this.phase === 2 ? GHOST_COLOR : 0xaeb9c6);
    }
  }

  /** 月焰扇形波：3 矢（yaw±0.22/0），自胸口高 1.6 发射 */
  private fireSpread(): void {
    const origin = this.chestWorld().setY(1.6);
    for (const off of [-0.22, 0, 0.22]) {
      this.host.fireProjectile?.(origin, this.yaw + off, VOLLEY_PROJ);
    }
    this.vfx.slash(origin, this.yaw, 1.3, true, DARKMOON);
  }

  /** 重招风声更闷 */
  protected override activeWhooshVolume(m: MoveDef): number {
    return m.name === "sulyvahnSpin" ? 0.6 : m.name === "sulyvahnThrustUp" || m.name === "sulyvahnVolley" ? 0.8 : 1;
  }

  /** 破绽：高瘦身形前倾垮伏，双剑垂荡 */
  protected override updateStaggerPose(): void {
    this.lerpPose(STANCE, { ...STANCE, lean: 0.48, crouch: 0.36, y: -0.28, nod: 0.36, rLift: 0.18, rSwing: 0.5, lLift: 0.18, lSwing: -0.5 }, Math.min(1, this.t * 5));
  }

  /** 弹反踉跄：后仰 + 双剑上荡（弹反考试 Boss 的代价姿态） */
  protected override updateParriedPose(): void {
    this.lerpPose(STANCE, { ...STANCE, lean: -0.42, crouch: 0.28, y: -0.34, nod: -0.2, rLift: -0.85, rSwing: 0.35, lLift: -0.85, lSwing: -0.35 }, Math.min(1, this.t * 8));
  }

  /** 变身：蜷身蓄势 → 0.6s 爆发波（基类回调 onBossTransform 交 game 结算）→ 双焰点燃 + 投影亮相 → 怒张展剑 */
  protected override updateTransform(): void {
    if (this.t >= this.transformHitAt && this.phase === 1) {
      this.phase = 2;          // 眼/剑/灯燃焰与数值 buff 由 updateVisuals 跟随 phase 写入
      this.spawnGhost();
    }
    const crouch = { ...STANCE, crouch: 0.35, y: -0.3, lean: 0.32, nod: 0.38, rLift: -1.15, lLift: -1.15 };
    if (this.t < this.transformHitAt) {
      this.lerpPose(STANCE, crouch, smooth(this.t / this.transformHitAt));
    } else {
      this.lerpPose(crouch, { ...STANCE, lean: -0.14, nod: -0.14, y: 0.08, rLift: -1.5, rSwing: 0.95, lLift: -1.5, lSwing: -0.95 }, smooth(seg(this.t, this.transformHitAt, this.transformDur)));
    }
  }

  /** 死亡：前倾垮塌 + 余烬 */
  protected override updateDeath(dt: number): void {
    this.lerpPose(this.pose, { ...STANCE, lean: 1.25, y: -0.85, crouch: 0.55, nod: 0.55, rLift: 0.3, lLift: 0.3 }, dt * 3.5);
    if (Math.random() < dt * 20) this.vfx.embers.burst(this.chestWorld(), 3, 3, 1.2);
  }

  protected override releaseSharedState(): void {
    if (this.p2Applied) this.restorePhase1Moves();
  }

  protected override resetVisuals(): void {
    this.restorePhase1Moves();
    this.ghostOn = false;
    this.ghostRoot.visible = false;
    this.slashFired = 0;
    this.volleyFired = 0;
    this.bladeFire.emissiveIntensity = 0;
    this.bladeDark.emissiveIntensity = 0;
    this.fireLight.intensity = 0;
    this.darkLight.intensity = 0;
    this.eyeMat.emissiveIntensity = 0.9;
    this.lerpPose(STANCE, STATUE, 1);
  }

  /** 投影分身挂在 scene 直下（不随 root），dispose 时需单独摘除 */
  protected override extraDispose(): void {
    this.ghostRoot.removeFromParent();
  }

  // ---------------- 投影分身（简化版：纯视觉威慑，不造成伤害） ----------------
  /** 亮相：站位取本体面向的左后 ~2m，姿态先与本体对齐（后续 updateGhost 每帧驱动） */
  private spawnGhost(): void {
    this.ghostOn = true;
    this.ghostYaw = this.yaw;
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    this.ghostRoot.position.set(this.root.position.x - s * 1.45 + c * 1.35, this.root.position.y, this.root.position.z - c * 1.45 - s * 1.35);
    this.ghostRoot.rotation.y = this.ghostYaw;
    const snap = (d: THREE.Object3D, o: THREE.Object3D) => { d.position.copy(o.position); d.rotation.copy(o.rotation); };
    snap(this.gBody, this.body); snap(this.gTorso, this.torso); snap(this.gHead, this.head);
    snap(this.gArmR, this.armR); snap(this.gArmL, this.armL);
    snap(this.gLegR, this.legR); snap(this.gLegL, this.legL);
    snap(this.gShinR, this.shinR); snap(this.gShinL, this.shinL);
  }

  /** 每帧：站位/朝向缓动跟随本体；本体出双剑四连时各关节硬抄（同步共舞），其余缓动尾随（残像感） */
  private updateGhost(): void {
    const show = this.ghostOn && this.phase === 2 && this.state !== "dead";
    this.ghostRoot.visible = show;
    if (!show) return;
    const dt = Math.max(0, this.lastDt);
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    const tx = this.root.position.x - s * 1.45 + c * 1.35;
    const tz = this.root.position.z - c * 1.45 - s * 1.35;
    const k = 1 - Math.exp(-dt * 3.2);
    this.ghostRoot.position.x += (tx - this.ghostRoot.position.x) * k;
    this.ghostRoot.position.z += (tz - this.ghostRoot.position.z) * k;
    let d = this.yaw - this.ghostYaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.ghostYaw += d * k;
    this.ghostRoot.rotation.y = this.ghostYaw;
    const snap = this.state === "combat" && this.move?.name === "sulyvahnCombo4";
    const kp = snap ? 1 : 1 - Math.exp(-dt * 2.6);
    this.easeJoint(this.gBody, this.body, kp);
    this.easeJoint(this.gTorso, this.torso, kp);
    this.easeJoint(this.gHead, this.head, kp);
    this.easeJoint(this.gArmR, this.armR, kp);
    this.easeJoint(this.gArmL, this.armL, kp);
    this.easeJoint(this.gLegR, this.legR, kp);
    this.easeJoint(this.gLegL, this.legL, kp);
    this.easeJoint(this.gShinR, this.shinR, kp);
    this.easeJoint(this.gShinL, this.shinL, kp);
  }

  private easeJoint(dst: THREE.Object3D, src: THREE.Object3D, k: number): void {
    dst.position.lerp(src.position, k);
    dst.rotation.x += (src.rotation.x - dst.rotation.x) * k;
    dst.rotation.y += (src.rotation.y - dst.rotation.y) * k;
    dst.rotation.z += (src.rotation.z - dst.rotation.z) * k;
  }

  // ---------------- 选招（沙力万权重：弹反考试 + 远程压制教学） ----------------
  protected override pickMove(dist: number): MoveDef | null {
    const M = MOVES_SULYVANN;
    const ready = (m: MoveDef) => (this.cds[m.name] ?? 0) <= 0 && (!m.phase2Only || this.phase === 2);
    // >6m 且暗月矢 cd 好 → 必出（远程压制教学：惩罚站桩贪刀）；cd 未好则兽行逼近
    if (dist > 6) return ready(M.sulyvahnArrow) ? M.sulyvahnArrow : null;
    const pool: [MoveDef, number][] = [
      [M.sulyvahnSpin, dist < 1.6 ? 5 : 2],                                                        // 贴身回旋优先
      [M.sulyvahnCombo4, 3],
      [M.sulyvahnThrustUp, 2.5],
      [M.sulyvahnVolley, this.phase === 2 && dist >= 2.5 && dist <= 7 ? 2 : 0],                    // 二阶段月焰走廊
    ];
    // 投射物招（proj 字段）不吃近战 range 闸——其距离带已在权重里
    const cands = pool.filter(([m, w]) => w > 0 && ready(m) && (m.proj || dist < m.range * 0.95));
    if (!cands.length) return null;
    const sum = cands.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * sum;
    for (const [m, w] of cands) { r -= w; if (r <= 0) return m; }
    return cands[0][0];
  }
}
