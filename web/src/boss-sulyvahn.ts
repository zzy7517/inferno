/** Boss #4「教宗沙力万」（docs/design/m3-bosses.md Boss#4 帧数据表）：高瘦术士剑士、双手细长巨剑 ×2（右火左暗紫）
 * 通用机制（状态机/削韧破绽/弹反/多段判定/冷却/走近追踪/阶段转换）全在 BossBase（boss-base.ts），
 * 本文件只保留沙力万专属：MOVES_SULYVANN/FEEL_SULYVANN（模块加载即并入 config 总表——调校台/存档自动收录，不改现有文件）、
 * 双剑外观与 Pose 系统、选招权重、投射物发射（暗月矢/纵横月焰经 host.fireProjectile → game 侧 Projectiles 池）、
 * 二阶段双焰点燃 + 投影分身（本体骨架克隆换半透明材质，纯视觉不造成伤害；
 * 只在一次双剑四连期间现身，四连进入后摇即消散，12s 后才能再召）。
 * 暗紫（0x7a4d9e 系）是本 Boss 主题色例外（m3-bosses.md 破例条款，与玻尔多冰蓝同理）。
 */
import * as THREE from "three";
import { MOVES, FEEL, MoveDef, FeelDef } from "./config";
import { Vfx } from "./vfx";
import { BossBase, BossStats, clamp01, smooth, seg, pickWeighted } from "./boss-base";
import type { AttackVolume, BossHost } from "./boss-base";
import type { ProjDef } from "./projectile";

export type { BossState, BossHost } from "./boss-base";

// ---------------- 主题色（暗紫 = 本 Boss 唯一例外强调色） ----------------
const DARKMOON = 0xb9a6ff;    // 暗月矢 / 月焰投射物（微紫冷光）
const FIRE = 0xff5a20;        // 二阶段右剑焰（与监视者燃焰同源——罪业火焰）
const DARKFLAME = 0x7a4d9e;   // 二阶段左剑暗紫焰
const GHOST_COLOR = 0x9a86d8; // 投影分身 / 眼光

/** 投射物参数（发射走 host.fireProjectile，飞行/命中/消散由 game 侧 Projectiles 池负责） */
const ARROW_PROJ: ProjDef = { speed: 10, radius: 0.4, dmg: 22, feelKey: "sMagic", life: 2.2, color: DARKMOON };
const VOLLEY_PROJ: ProjDef = { speed: 10, radius: 0.4, dmg: 16, feelKey: "sMagic", life: 2.2, color: DARKMOON };

// ---------------- 帧数据（m3-bosses.md 一阶段表 + 二阶段新招） ----------------
/** 四连：第 2 刀相对第 1 刀多停 COMBO_BAIT 秒（骗取消）；其后两刀回到 COMBO_STEP 节拍。
 *  引擎只有一个 hitInterval（firstAt + k*interval），非均匀间隔由 syncComboInterval 在每刀之前改写。
 *  表内 hitInterval 取诱饵间隔本身，这样调校台看到的就是「第 2 刀那一档」。 */
const COMBO_BAIT = 0.5;
const COMBO_STEP = 0.38;

export const MOVES_SULYVANN: Record<string, MoveDef> = {
  // active 2.2：首段 active*0.4=0.88，其后 0.88+0.50 / +0.38 / +0.38 ⇒ 0.88 / 1.38 / 1.76 / 2.14。
  // 末段距收尾 0.06s，四段都落在 active 内，不会被 min(..., active) 并到同一帧。
  // 弹反窗：前摇最后 0.2s，以及判定段直到首段打实（这一下在 0.88s）。打空则整段判定仍可弹。
  sulyvahnCombo4: {
    name: "sulyvahnCombo4", label: "双剑四连", startup: 0.30, active: 2.2, recovery: 0.85,
    dmg: 11, range: 3.2, arc: 1.6, hits: 4, hitInterval: COMBO_BAIT,
    parryable: true, cd: 4.0, feel: "sLight",
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
  // 伤害由 ARROW_PROJ 承载（速度 10 可翻滚穿）。出矢不在 onMoveActive：那一帧还停在举剑蓄力，剑尖朝后，
  // 沿 yaw 飞出会和剑尖反向。等 act 后段剑尖转到正面再离手。
  sulyvahnArrow: {
    name: "sulyvahnArrow", label: "暗月矢", startup: 0.65, active: 0.2, recovery: 0.80,
    dmg: 22, range: 0.2, arc: 0.9, parryable: false, cd: 6.5, feel: "sMagic",
    proj: { speed: 10, radius: 0.4, life: 2.2 },
  },
  // 纵横月焰（二阶段）：两波各 3 矢扇形（yaw±0.22/0）。波 1 在挥剑到位后离手；波 2 在后摇里再举一次才发
  // （不用 setTimeout——调校台暂停会脱钩）。
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

/** 二阶段 buff（连段伤害 ×1.2、全部前摇 ×0.9）的一阶段基线——模块级快照，多实例/reset 往返安全（仿 watchers）。
 *  hitInterval 一并快照：四连会在出手中改写间隔，死亡/重置必须还回，否则下一场第 2 刀不再是 0.5s。 */
const P1_BASE: Record<string, { startup: number; dmg: number; hitInterval?: number }> = {};
for (const m of Object.values(MOVES_SULYVANN)) {
  P1_BASE[m.name] = { startup: m.startup, dmg: m.dmg, hitInterval: m.hitInterval };
}

/** 投影分身材质：半透明暗紫加色（本体克隆件统一换此材质） */
const GHOST_MAT = new THREE.MeshBasicMaterial({
  color: GHOST_COLOR, transparent: true, opacity: 0.35,
  blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
});

// ---------------- 姿态（Pose）：双剑臂各自 lift/swing ----------------
interface Pose {
  y: number; lean: number; twist: number; crouch: number; reach: number;
  rLift: number; rSwing: number;   // 右臂：lift 正=前送 负=后举；swing 负=外展 正=向中线收
  lLift: number; lSwing: number;   // 左臂同一套符号（负=外展）。两臂同号才会真的张开/合拢
  nod: number;                     // 头部俯仰（正=低头）
  spin: number;                    // 整体附加旋转（大回旋转体）
}
const STANCE: Pose = { y: 0, lean: 0.07, twist: -0.1, crouch: 0, reach: 0, rLift: 0.92, rSwing: -0.58, lLift: 0.92, lSwing: -0.58, nod: 0.08, spin: 0 };
const STATUE: Pose = { ...STANCE, lean: 0.04, twist: 0, rLift: 1.2, rSwing: 0.1, lLift: 1.2, lSwing: 0.1, nod: 0.52 };  // 低头，双剑向前交汇拄地
// 双剑四连四拍（拍内 wind→strike；1 右横斩 / 2 左回斩 / 3 右力劈 / 4 双剑交剪收尾）
// 蓄力把出剑的那只手外展，命中再收到身前；另一只手留在站架的外展上，远处仍能看见两把剑。
const B1W: Pose = { ...STANCE, twist: 0.55, rLift: -0.95, rSwing: -1.2, nod: 0.12 };
const B1K: Pose = { ...STANCE, twist: -0.5, rLift: 1.45, rSwing: 0.62, lean: 0.16 };
const B2W: Pose = { ...STANCE, twist: -0.55, lLift: -0.95, lSwing: -1.2, nod: 0.12 };
const B2K: Pose = { ...STANCE, twist: 0.5, lLift: 1.45, lSwing: 0.62, lean: 0.14 };
const B3W: Pose = { ...STANCE, twist: 0.35, rLift: -1.65, rSwing: -0.75, lean: -0.08, crouch: 0.06 };
const B3K: Pose = { ...STANCE, twist: -0.6, rLift: 1.35, rSwing: 0.2, lean: 0.3, crouch: 0.1 };
const B4W: Pose = { ...STANCE, twist: 0.7, rLift: -1.15, rSwing: -1.15, lLift: -1.15, lSwing: -1.15 };
const B4K: Pose = { ...STANCE, twist: -0.75, rLift: 1.4, rSwing: 0.16, lLift: 1.4, lSwing: 0.16, lean: 0.24, crouch: 0.12 };
// 突刺→上挑两拍（与判定时刻 0.30/0.65 对齐）。右剑出手，左剑保持外展。
const TW: Pose = { ...STANCE, crouch: 0.22, twist: 0.5, rLift: -0.35, rSwing: -1.05, lean: 0.1 };
const T1K: Pose = { ...STANCE, twist: -0.15, rLift: 1.55, rSwing: -0.18, lean: 0.38, reach: 0.45, crouch: 0.15 };
const T2W: Pose = { ...STANCE, twist: 0.1, rLift: 1.15, rSwing: -0.35, lean: 0.2, crouch: 0.2 };
const T2K: Pose = { ...STANCE, rLift: -1.75, rSwing: -0.48, lean: -0.14, y: 0.12, nod: -0.1 };   // 上挑剑走立圆，人随势拔起
// 暗月矢：左剑高举后曳（剑尖朝后，这一拍不能出矢）→ 左剑刺到正面（剑尖 yaw=面向，矢沿同一方向离手）
const AW: Pose = { ...STANCE, twist: -0.5, lLift: -1.7, lSwing: -0.8, lean: -0.1, nod: 0.12, rLift: 0.45, rSwing: -0.65 };
const AK: Pose = { ...STANCE, twist: -0.2, lLift: 1.55, lSwing: -0.08, lean: 0.18, reach: 0.25, nod: 0.02, rLift: 0.4, rSwing: -0.65 };
// 纵横月焰：双剑高举外展 → 双剑前送，尖端仍分开，扇形矢从两刃之间离手
const VW: Pose = { ...STANCE, rLift: -1.55, rSwing: -0.95, lLift: -1.55, lSwing: -0.95, lean: -0.12, crouch: 0.12, nod: -0.08 };
const VK: Pose = { ...STANCE, rLift: 1.35, rSwing: -0.7, lLift: 1.35, lSwing: -0.35, twist: 0.5, lean: 0.16, nod: 0.04 };
// 四连第 1 刀之后的假收势：双剑收到中线、头低下，读成「连段结束」——停住再起第 2 刀
const FEINT: Pose = { ...STANCE, lean: 0.06, twist: 0.04, crouch: 0.08, nod: 0.28, rLift: 1.15, rSwing: 0.12, lLift: 1.15, lSwing: 0.12, y: -0.02 };
// 大回旋回旋过后的力竭：剑仍敞着、身子压低，后摇前 0.7s 停在这里
const SPIN_SPENT: Pose = { ...STANCE, rSwing: -1.05, lSwing: -1.05, rLift: 0.3, lLift: 0.3, lean: 0.46, crouch: 0.26, twist: 0.42, nod: 0.32 };

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
  private swordR!: THREE.Group;
  private swordL!: THREE.Group;
  private tipR = new THREE.Object3D();
  private tipL = new THREE.Object3D();
  private hiltR = new THREE.Object3D();
  private hiltL = new THREE.Object3D();
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
  private volleyFired = 0;                          // 月焰已发波数（0 未发 / 1 波 1 已离手 / 2 两波都出）
  private arrowLoosed = false;                      // 暗月矢是否已离手（举剑期间必须保持 false）
  private p2Applied = false;                        // 二阶段数值 buff 是否已写入共享表
  private lastDt = 0;                               // 投影分身缓动用（暂停时 0 → 跟随冻结）
  private lastPick = "";                            // 上一招名：同招再选时降权，避免连刷

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
  private ghostDismiss = false;                     // 四连打完（或被打断）后正在消散
  private ghostFade = 0;                            // 1=实体，0=已散
  private ghostCd = 0;                              // 消散后 12s 内不再召（设计：投影 12s cd）

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
    // 一阶段就用火 / 暗紫本体色，远处能分开；二阶段点燃仍只抬 emissiveIntensity（见 updateVisuals）。
    this.bladeFire = new THREE.MeshStandardMaterial({ color: FIRE, roughness: 0.46, metalness: 0.22, flatShading: true, emissive: FIRE, emissiveIntensity: 0 });
    this.bladeDark = new THREE.MeshStandardMaterial({ color: DARKFLAME, roughness: 0.5, metalness: 0.22, flatShading: true, emissive: DARKFLAME, emissiveIntensity: 0 });
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

    // 双臂 + 细长巨剑。刃比原来长一截，剑格用钢和金，和着色的刃断开；右火左暗紫。
    const buildSword = (mat: THREE.MeshStandardMaterial, side: 1 | -1, light: THREE.PointLight, tip: THREE.Object3D) => {
      const g = new THREE.Group();
      g.position.set(0, -0.88, 0.04);
      g.rotation.x = 0.22;
      g.rotation.z = side * 0.12;                // 外撇，两尖不要叠成一根
      g.add(box(0.05, 0.26, 0.055, clothDark, 0, 0.02, 0));                   // 握柄
      g.add(box(0.09, 0.07, 0.09, gold, 0, 0.18, 0));                         // 柄头
      g.add(box(0.68, 0.09, 0.12, steel, 0, -0.15, 0));                       // 剑格：比刃宽出一截
      g.add(box(0.1, 0.14, 0.14, gold, 0.32, -0.15, 0));
      g.add(box(0.1, 0.14, 0.14, gold, -0.32, -0.15, 0));
      const quillonR = box(0.26, 0.045, 0.07, steel, 0.2, -0.22, 0);
      quillonR.rotation.z = 0.6;
      const quillonL = box(0.26, 0.045, 0.07, steel, -0.2, -0.22, 0);
      quillonL.rotation.z = -0.6;
      g.add(quillonR, quillonL);                                              // 下斜护翼，和直刃断开
      g.add(box(0.1, 0.14, 0.05, steel, 0, -0.28, 0));                        // 茎：钢，刃色从下面才开始
      g.add(box(0.16, 2.08, 0.055, mat, 0, -1.4, 0));                         // 刃
      g.add(box(0.08, 0.32, 0.036, mat, 0, -2.56, 0));                        // 收锋
      tip.position.set(0, -2.74, 0);
      const hilt = side === 1 ? this.hiltR : this.hiltL;
      hilt.position.set(0, 0.02, 0);
      g.add(tip, hilt);
      light.position.set(0, -1.35, 0);
      g.add(light);
      return g;
    };
    this.fireLight = new THREE.PointLight(FIRE, 0, 5, 2);
    this.darkLight = new THREE.PointLight(DARKFLAME, 0, 5, 2);
    this.armR.position.set(0.44, 0.68, 0);
    this.armR.add(box(0.12, 0.42, 0.13, clothDark, 0, -0.19, 0));
    this.armR.add(box(0.105, 0.4, 0.115, cloth, 0, -0.54, 0.02));
    this.armR.add(box(0.125, 0.15, 0.135, steel, 0, -0.82, 0.04));            // 铁手套
    this.swordR = buildSword(this.bladeFire, 1, this.fireLight, this.tipR);
    this.armR.add(this.swordR);
    this.torso.add(this.armR);
    this.armL.position.set(-0.44, 0.68, 0);
    this.armL.add(box(0.12, 0.42, 0.13, clothDark, 0, -0.19, 0));
    this.armL.add(box(0.105, 0.4, 0.115, cloth, 0, -0.54, 0.02));
    this.armL.add(box(0.125, 0.15, 0.135, steel, 0, -0.82, 0.04));
    this.swordL = buildSword(this.bladeDark, -1, this.darkLight, this.tipL);
    this.armL.add(this.swordL);
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

  /** 四连第 1、3 刀右火剑，第 2 刀左暗紫，第 4 刀两把一起。回旋两把都能打中。突刺用右剑。箭和月焰只算飞行物。 */
  protected override attackVolume(m: MoveDef): AttackVolume | null {
    const right = { hilt: this.hiltR, tip: this.tipR, pad: 0.1 };
    const left = { hilt: this.hiltL, tip: this.tipL, pad: 0.1 };
    const both: AttackVolume = { kind: "blade", ...right, also: [left] };
    if (m.name === "sulyvahnSpin") return both;
    if (m.name === "sulyvahnThrustUp") return { kind: "blade", ...right };
    if (m.name === "sulyvahnCombo4") {
      if (this.hitFired === 1) return { kind: "blade", ...left };
      if (this.hitFired >= 3) return both;
      return { kind: "blade", ...right };
    }
    if (m.proj) return { kind: "none" };
    return null;
  }
  protected override headPart(): THREE.Object3D { return this.head; }

  // ---------------- 姿态应用 ----------------
  protected override applyPose(): void {
    const p = this.pose;
    this.root.rotation.y = this.yaw + p.spin;
    this.body.position.set(0, p.y - p.crouch * 0.3, p.reach);
    this.torso.rotation.set(p.lean, p.twist, 0);
    this.head.rotation.x = p.nod;
    this.armR.rotation.set(-p.rLift, -0.16, -p.rSwing);
    this.armL.rotation.set(-p.lLift, 0.16, p.lSwing);
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
    if (m.name === "sulyvahnCombo4") { this.comboMovePose(m, sub, t); void total; return; }
    if (m.name === "sulyvahnArrow") { this.arrowPose(m, sub, t); void total; return; }
    if (m.name === "sulyvahnVolley") { this.volleyPose(m, sub, t); void total; return; }

    const wind: Pose = { ...STANCE }, strike: Pose = { ...STANCE };
    if (m.name === "sulyvahnSpin") {   // 双剑水平展开蓄势 → 转体横扫（spin 转整圈）
      wind.rSwing = -1.2; wind.lSwing = -1.2; wind.rLift = 0.28; wind.lLift = 0.28; wind.lean = 0.14; wind.crouch = 0.1;
      strike.rSwing = -1.35; strike.lSwing = -1.35; strike.rLift = 0.36; strike.lLift = 0.36; strike.lean = 0.3; strike.crouch = 0.16;
    } else if (m.name === "sulyvahnThrustUp") {
      Object.assign(wind, TW);
    }
    if (sub === "tel") {
      this.lerpPose(STANCE, wind, smooth(seg(t, m.startup * 0.45, m.startup)));
      // 突刺前冲：位移放前摇段（基准在 onMoveStart 记录，act 起点已在玩家身前）
      if (this.moveLen !== 0) {
        const k = smooth(clamp01((t - m.startup * 0.3) / (m.startup * 0.7)));
        this.root.position.copy(this.moveFrom).addScaledVector(this.moveDir, this.moveLen * k);
      }
    } else if (sub === "act") {
      if (m.name === "sulyvahnThrustUp") this.thrustPose(t, m);
      else if (m.name === "sulyvahnSpin") {
        const k = smooth(clamp01(t / m.active));
        this.lerpPose(wind, strike, k);
        this.pose.spin = Math.PI * 2 * k;        // 恰好整一圈
      }
    } else if (m.name === "sulyvahnSpin") {
      // 惩罚窗：力竭姿态停满约 0.7s，剩下的后摇才把剑收回。整段 recovery（1.0s）都不能再出手。
      const hold = Math.min(0.70, Math.max(0.2, m.recovery - 0.25));
      if (t < 0.16) this.lerpPose(strike, SPIN_SPENT, smooth(clamp01(t / 0.16)));
      else if (t < hold) this.lerpPose(SPIN_SPENT, SPIN_SPENT, 1);
      else this.lerpPose(SPIN_SPENT, STANCE, smooth(seg(t, hold, m.recovery)));
      this.pose.spin = 0;                         // 2π≡0：收招直接归零，不倒转
    } else {
      this.lerpPose(strike, STANCE, smooth(seg(t, m.recovery * 0.35, m.recovery)));
    }
    void total;
  }

  /** 四连命中时刻（act 内秒）。与 syncComboInterval 同一条轴，姿态停顿才和伤害落在同一帧。 */
  private comboHitTimes(active: number): [number, number, number, number] {
    const t0 = active * 0.4;
    const t1 = t0 + COMBO_BAIT;
    const t2 = t1 + COMBO_STEP;
    const t3 = t2 + COMBO_STEP;
    return [t0, t1, t2, t3];
  }

  /** 让「下一刀」的 firstAt + k*hitInterval 等于 comboHitTimes()[k]。k<=1 时间隔就是 0.5s 诱饵。 */
  private comboIntervalFor(nextIndex: number): number {
    if (nextIndex <= 1) return COMBO_BAIT;
    return (COMBO_BAIT + COMBO_STEP * (nextIndex - 1)) / nextIndex;
  }

  /** 在基类判定循环之前改写间隔；离开判定段立刻还回快照，避免共享表停在 0.42。 */
  private syncComboInterval(): void {
    const m = MOVES_SULYVANN.sulyvahnCombo4;
    const base = P1_BASE[m.name].hitInterval ?? COMBO_BAIT;
    if (this.state === "combat" && this.sub === "act" && this.move?.name === "sulyvahnCombo4") {
      m.hitInterval = this.comboIntervalFor(this.hitFired);
    } else if (m.hitInterval !== base) {
      m.hitInterval = base;
    }
  }

  private comboMovePose(m: MoveDef, sub: string, t: number): void {
    if (sub === "tel") {
      // 前摇就把右剑收到蓄力位，act 第 0 帧从同一姿势接上，不会弹回站姿
      this.lerpPose(STANCE, B1W, smooth(clamp01(t / Math.max(0.01, m.startup))));
      return;
    }
    if (sub === "act") { this.comboPose(t, m); return; }
    // 交剪定住再回架；整段后摇都还在硬直里
    this.lerpPose(B4K, STANCE, smooth(seg(t, Math.min(0.40, m.recovery * 0.45), m.recovery)));
  }

  /** 双剑四连：第 1 刀蓄力可弹反；命中后沉剑停住约 0.5s 的大半（假收招），再突然起第 2 刀。其后 0.38s 一拍。 */
  private comboPose(t: number, m: MoveDef): void {
    const [t0, t1, t2, t3] = this.comboHitTimes(m.active);
    const winds = [B1W, B2W, B3W, B4W];
    const hits = [B1K, B2K, B3K, B4K];
    if (t <= t0) {
      const u = clamp01(t / Math.max(0.01, t0));
      const deeper: Pose = { ...B1W, twist: B1W.twist + 0.14, rLift: B1W.rLift - 0.18 };
      if (u < 0.72) this.lerpPose(B1W, deeper, smooth(u / 0.72));   // 从 tel 的 B1W 续上，缓缓压满
      else this.lerpPose(deeper, hits[0], smooth((u - 0.72) / 0.28));
      return;
    }
    const gaps: [number, number, Pose, Pose][] = [
      [t0, t1, hits[0], hits[1]],
      [t1, t2, hits[1], hits[2]],
      [t2, t3, hits[2], hits[3]],
    ];
    for (let i = 0; i < gaps.length; i++) {
      const [a, b, from, to] = gaps[i];
      if (t > b && i < gaps.length - 1) continue;
      const u = clamp01((t - a) / Math.max(0.01, b - a));
      if (i === 0) {
        // 0.5s 诱饵：冲击定格 → Ease-out 沉到假收势 → 停住 → 短促起手再斩在命中帧
        if (u < 0.08) this.lerpPose(from, from, 1);
        else if (u < 0.22) this.lerpPose(from, FEINT, smooth((u - 0.08) / 0.14));
        else if (u < 0.70) this.lerpPose(FEINT, FEINT, 1);
        else if (u < 0.86) this.lerpPose(FEINT, winds[1], this.easeIn((u - 0.70) / 0.16));
        else this.lerpPose(winds[1], to, smooth((u - 0.86) / 0.14));
      } else if (u < 0.48) {
        this.lerpPose(from, winds[i + 1], smooth(u / 0.48));
      } else {
        this.lerpPose(winds[i + 1], to, smooth((u - 0.48) / 0.52));
      }
      return;
    }
    this.lerpPose(hits[3], hits[3], 1);
  }

  /** 暗月矢：前摇前段举剑并停住；剑尖转到正面之后矢才离手进入飞行。 */
  private arrowPose(m: MoveDef, sub: string, t: number): void {
    if (sub === "tel") {
      const raised = m.startup * 0.58;
      this.lerpPose(STANCE, AW, smooth(clamp01(t / Math.max(0.01, raised))));
      return;
    }
    if (sub === "act") {
      this.lerpPose(AW, AK, smooth(clamp01(t / Math.max(0.01, m.active))));
      // smooth(0.82)≈0.95，剑已基本刺到正面，再发射
      if (!this.arrowLoosed && t >= m.active * 0.82) {
        this.arrowLoosed = true;
        this.fireArrow();
      }
      return;
    }
    this.lerpPose(AK, STANCE, smooth(seg(t, m.recovery * 0.35, m.recovery)));
  }

  /** 纵横月焰：举剑停住 → 前送离手（波 1）→ 后摇再举一次 → 第二波离手，然后才是收招。 */
  private volleyPose(m: MoveDef, sub: string, t: number): void {
    if (sub === "tel") {
      const raised = m.startup * 0.58;
      this.lerpPose(STANCE, VW, smooth(clamp01(t / Math.max(0.01, raised))));
      return;
    }
    if (sub === "act") {
      this.lerpPose(VW, VK, smooth(clamp01(t / Math.max(0.01, m.active))));
      if (this.volleyFired === 0 && t >= m.active * 0.82) {
        this.volleyFired = 1;
        this.fireSpread();
      }
      return;
    }
    const cast = 0.22;
    const loose = 0.40;
    if (t < cast) this.lerpPose(VK, VW, smooth(t / cast));
    else if (t < loose) this.lerpPose(VW, VK, smooth((t - cast) / (loose - cast)));
    else this.lerpPose(VK, STANCE, smooth(seg(t, loose + 0.08, m.recovery)));
    if (this.volleyFired === 1 && t >= loose) {
      this.volleyFired = 2;
      this.fireSpread();
    }
  }

  private easeIn(v: number): number {
    const x = clamp01(v);
    return x * x;
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
    if (this.ghostCd > 0) this.ghostCd = Math.max(0, this.ghostCd - dt);
    this.syncComboInterval();   // 必须在基类判定循环之前：本帧用的就是这一刀的间隔
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
    // 刀光：近战多段每段仍只补一刀（hitFired 无条件按节拍推进，躲开也照画）。颜色和半径贴着当拍那把剑。
    if (this.state === "combat" && this.sub === "act" && this.move &&
      (this.move.name === "sulyvahnCombo4" || this.move.name === "sulyvahnThrustUp")) {
      while (this.slashFired < this.hitFired) {
        this.slashFired++;
        if (this.move.name === "sulyvahnThrustUp" || this.slashFired === 1 || this.slashFired === 3) this.slashOnBlade(1, false);
        else if (this.slashFired === 2) this.slashOnBlade(-1, false);
        else this.slashOnCross();
      }
    }
    // 二阶段数值：进入写一次，离开（重置把 phase 拨回 1）立刻还回。死在二阶段时 phase 仍为 2，
    // 共享表保持加压直到 dispose/reset 把 phase 拨回——releaseSharedState / resetVisuals 负责归还。
    if (p2 && !this.p2Applied) this.applyPhase2Moves();
    else if (!p2 && this.p2Applied) this.restorePhase1Moves();
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
      const b = P1_BASE[m.name];
      m.startup = b.startup;
      m.dmg = b.dmg;
      if (b.hitInterval !== undefined) m.hitInterval = b.hitInterval;
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
    this.arrowLoosed = false;
    this.moveLen = 0;
    // 投影只陪一次四连：冷却中或还没收掉的分身不再叠一个
    if (m.name === "sulyvahnCombo4" && this.phase === 2 && this.ghostCd <= 0 && !this.ghostOn) this.beginGhost();
    if (m.name === "sulyvahnThrustUp") {
      this.moveDir.copy(toPlayer).setY(0).normalize();
      this.moveLen = Math.min(m.lunge ?? 0, Math.max(0, dist - 1.2));
    }
  }

  /** 判定段开始：回旋两道宽弧，各贴一把剑。投射物不在这里发——这一帧姿态还是举剑蓄力，剑尖朝后。 */
  protected override onMoveActive(m: MoveDef): void {
    if (m.name === "sulyvahnSpin") {
      this.slashOnBlade(1, true, 1.05);
      this.slashOnBlade(-1, true, 0.98);
    }
  }

  /** 环带（0.5r–r）压在外刃上：弧心退到剑尖之后，颜色跟那把剑（右火、左暗紫）。 */
  private slashOnBlade(side: 1 | -1, wide: boolean, radiusMul = 1): void {
    this.applyPose();
    this.root.updateMatrixWorld(true);
    const hilt = new THREE.Vector3();
    const tip = new THREE.Vector3();
    (side > 0 ? this.swordR : this.swordL).getWorldPosition(hilt);
    (side > 0 ? this.tipR : this.tipL).getWorldPosition(tip);
    const dx = tip.x - hilt.x;
    const dz = tip.z - hilt.z;
    const flat = Math.hypot(dx, dz);
    const yaw = flat > 0.4 ? Math.atan2(dx, dz) : this.yaw + side * 0.45;
    const radius = Math.min(2.35, Math.max(1.15, (flat > 0.4 ? flat * 0.78 : 1.25) * radiusMul));
    const origin = tip.clone();
    origin.x -= Math.sin(yaw) * radius * 0.86;
    origin.z -= Math.cos(yaw) * radius * 0.86;
    origin.y = hilt.y + (tip.y - hilt.y) * 0.7;
    this.vfx.slash(origin, yaw, radius, wide, side > 0 ? FIRE : DARKFLAME);
  }

  /** 四连收尾交剪仍是一次刀光，弧心落在两刃之间。 */
  private slashOnCross(): void {
    this.applyPose();
    this.root.updateMatrixWorld(true);
    const hiltR = new THREE.Vector3();
    const hiltL = new THREE.Vector3();
    const tipR = new THREE.Vector3();
    const tipL = new THREE.Vector3();
    this.swordR.getWorldPosition(hiltR);
    this.swordL.getWorldPosition(hiltL);
    this.tipR.getWorldPosition(tipR);
    this.tipL.getWorldPosition(tipL);
    const hilt = hiltR.add(hiltL).multiplyScalar(0.5);
    const tip = tipR.add(tipL).multiplyScalar(0.5);
    const dx = tip.x - hilt.x;
    const dz = tip.z - hilt.z;
    const flat = Math.hypot(dx, dz);
    const yaw = flat > 0.35 ? Math.atan2(dx, dz) : this.yaw;
    const radius = Math.min(2.2, Math.max(1.3, flat * 0.8));
    const origin = tip.clone();
    origin.x -= Math.sin(yaw) * radius * 0.84;
    origin.z -= Math.cos(yaw) * radius * 0.84;
    origin.y = Math.max(0.45, hilt.y + (tip.y - hilt.y) * 0.72);
    this.vfx.slash(origin, yaw, radius, false, FIRE);
  }

  /** 沿面向发射。速度用 sin/cos(yaw)，与近战 dirYaw、剑尖在离手帧的水平朝向同一约定；出生点沿该方向推出，矢从剑前离开而不是从胸口倒飞。 */
  private looseAt(yaw: number, def: ProjDef): THREE.Vector3 {
    const origin = this.chestWorld();
    origin.x += Math.sin(yaw) * 0.75;
    origin.z += Math.cos(yaw) * 0.75;
    origin.y = 1.45;
    this.host.fireProjectile?.(origin, yaw, def);
    return origin;
  }

  private fireArrow(): void {
    const origin = this.looseAt(this.yaw, ARROW_PROJ);
    this.vfx.slash(origin, this.yaw, 1.1, false, DARKMOON);
  }

  /** 月焰扇形波：3 矢（yaw±0.22/0），与 VK 双剑尖端同一夹角 */
  private fireSpread(): void {
    const base = this.yaw;
    let mid: THREE.Vector3 | null = null;
    for (const off of [-0.22, 0, 0.22]) {
      const pos = this.looseAt(base + off, VOLLEY_PROJ);
      if (off === 0) mid = pos;
    }
    if (mid) this.vfx.slash(mid, base, 1.3, true, DARKMOON);
  }

  /** 重招风声更闷 */
  protected override activeWhooshVolume(m: MoveDef): number {
    return m.name === "sulyvahnSpin" ? 0.6 : m.name === "sulyvahnThrustUp" || m.name === "sulyvahnVolley" ? 0.8 : 1;
  }

  /** 破绽：高瘦身形前倾垮伏，双剑垂荡 */
  protected override updateStaggerPose(): void {
    this.lerpPose(STANCE, { ...STANCE, lean: 0.48, crouch: 0.36, y: -0.28, nod: 0.36, rLift: 1.35, rSwing: -0.85, lLift: 1.35, lSwing: -0.85 }, Math.min(1, this.t * 5));
  }

  /** 弹反踉跄：后仰 + 双剑上荡（弹反考试 Boss 的代价姿态） */
  protected override updateParriedPose(): void {
    this.lerpPose(STANCE, { ...STANCE, lean: -0.42, crouch: 0.28, y: -0.34, nod: -0.2, rLift: -1.15, rSwing: -0.85, lLift: -1.15, lSwing: -0.85 }, Math.min(1, this.t * 8));
  }

  /** 变身：蜷身蓄势 → 0.6s 爆发波（基类回调 onBossTransform 交 game 结算）→ 双焰点燃 + 投影亮相 → 怒张展剑 */
  protected override updateTransform(): void {
    if (this.t >= this.transformHitAt && this.phase === 1) {
      this.phase = 2;          // 眼/剑/灯燃焰与数值 buff 由 updateVisuals 跟随 phase 写入
      // 投影不在变身时站出来——那会变成第二个会跟着做完全套动作的 Boss。等四连再召。
    }
    const crouch = { ...STANCE, crouch: 0.35, y: -0.3, lean: 0.32, nod: 0.38, rLift: -1.15, lLift: -1.15, rSwing: 0.18, lSwing: 0.18 };
    if (this.t < this.transformHitAt) {
      this.lerpPose(STANCE, crouch, smooth(this.t / this.transformHitAt));
    } else {
      this.lerpPose(crouch, { ...STANCE, lean: -0.14, nod: -0.14, y: 0.08, rLift: -1.4, rSwing: -1.05, lLift: -1.4, lSwing: -1.05 }, smooth(seg(this.t, this.transformHitAt, this.transformDur)));
    }
  }

  /** 死亡：前倾垮塌 + 余烬 */
  protected override updateDeath(dt: number): void {
    this.lerpPose(this.pose, { ...STANCE, lean: 1.25, y: -0.85, crouch: 0.55, nod: 0.55, rLift: 0.55, rSwing: -0.5, lLift: 0.55, lSwing: -0.5 }, dt * 3.5);
    if (Math.random() < dt * 20) this.vfx.embers.burst(this.chestWorld(), 3, 3, 1.2);
  }

  protected override releaseSharedState(): void {
    if (this.p2Applied) this.restorePhase1Moves();
  }

  protected override resetVisuals(): void {
    this.restorePhase1Moves();
    this.ghostOn = false;
    this.ghostDismiss = false;
    this.ghostFade = 0;
    this.ghostCd = 0;
    this.ghostRoot.visible = false;
    GHOST_MAT.opacity = 0.35;
    this.slashFired = 0;
    this.volleyFired = 0;
    this.arrowLoosed = false;
    this.lastPick = "";
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
  /** 四连起手才召：站位取本体面向的侧后 ~2m，姿态先与本体对齐 */
  private beginGhost(): void {
    this.ghostDismiss = false;
    this.ghostFade = 1;
    GHOST_MAT.opacity = 0.35;
    this.spawnGhost();
  }

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

  /** 只在四连的前摇/判定段硬抄骨架。进入后摇、被破绽/弹反打断或死亡则消散，不跟着把其余招式再演一遍。 */
  private updateGhost(): void {
    const mirroring = this.ghostOn && !this.ghostDismiss
      && this.phase === 2 && this.state === "combat"
      && (this.sub === "tel" || this.sub === "act")
      && this.move?.name === "sulyvahnCombo4";
    if (this.ghostOn && !mirroring) this.ghostDismiss = true;
    if (this.ghostDismiss) {
      this.ghostFade = Math.max(0, this.ghostFade - Math.max(0, this.lastDt) / 0.4);
      if (this.ghostFade <= 0) this.finishGhost();
    }
    const show = this.ghostOn && this.ghostFade > 0 && this.phase === 2 && this.state !== "dead";
    this.ghostRoot.visible = show;
    if (!show) {
      if (this.ghostOn) this.finishGhost();
      return;
    }
    GHOST_MAT.opacity = 0.35 * this.ghostFade;
    if (this.ghostDismiss) return;   // 停在四连最后一帧上淡出，不去追下一招
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
    this.easeJoint(this.gBody, this.body, 1);
    this.easeJoint(this.gTorso, this.torso, 1);
    this.easeJoint(this.gHead, this.head, 1);
    this.easeJoint(this.gArmR, this.armR, 1);
    this.easeJoint(this.gArmL, this.armL, 1);
    this.easeJoint(this.gLegR, this.legR, 1);
    this.easeJoint(this.gLegL, this.legL, 1);
    this.easeJoint(this.gShinR, this.shinR, 1);
    this.easeJoint(this.gShinL, this.shinL, 1);
  }

  private finishGhost(): void {
    this.ghostOn = false;
    this.ghostDismiss = false;
    this.ghostFade = 0;
    this.ghostCd = 12;
    this.ghostRoot.visible = false;
    GHOST_MAT.opacity = 0.35;
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
    const take = (m: MoveDef | null): MoveDef | null => {
      if (m) this.lastPick = m.name;
      return m;
    };
    // >6m 且暗月矢 cd 好 → 必出（远程压制教学：惩罚站桩贪刀）；cd 未好则滑步逼近。这一下不降权。
    if (dist > 6) return take(ready(M.sulyvahnArrow) ? M.sulyvahnArrow : null);
    // 同招再选降到 0.35：还进池子（有时就是该再来一刀），但不会连刷同一招
    const w = (m: MoveDef, base: number) => base * (m.name === this.lastPick ? 0.35 : 1);
    const pool: [MoveDef, number][] = [
      [M.sulyvahnSpin, w(M.sulyvahnSpin, dist < 1.6 ? 5 : 2)],                                      // 贴身回旋优先
      [M.sulyvahnCombo4, w(M.sulyvahnCombo4, 3)],
      [M.sulyvahnThrustUp, w(M.sulyvahnThrustUp, 2.5)],
      [M.sulyvahnVolley, w(M.sulyvahnVolley, this.phase === 2 && dist >= 2.5 && dist <= 7 ? 2 : 0)], // 二阶段月焰走廊
    ];
    // 投射物招（proj 字段）不吃近战 range 闸——其距离带已在权重里。够不到的近战不空挥，交给 idle 走近。
    const cands = pool.filter(([m, weight]) => weight > 0 && ready(m) && (m.proj || dist < m.range * 0.95));
    if (!cands.length) return null;
    return take(pickWeighted(cands) ?? cands[0][0]);
  }
}
