/** Boss #8「碎星拉塔恩」（艾尔登法环·盖利德红星，同人改编）：8 Boss 线墓地深处守关者（cemetery:D 碎星战场）
  * 通用机制（状态机/削韧破绽/弹反/多段判定/冷却/走近追踪/阶段转换）全在 BossBase（boss-base.ts），
  * 本文件只保留拉塔恩专属：MOVES_RADAHN/FEEL_RADAHN 模块加载即并入 config 总表（调校台/存档自动收录，不改现有文件）。
  * 视觉纪律（与既有 Boss 不同）：纯几何 + 顶点色 mergeGeometries 合批——本体 11 mesh（9 castShadow）+ 1 粒子 Points ≈ 21 dc，无 PointLight；
  * 红发巨大剪影（radius 1.6 全场最大身位）+ 双碎星大剑（拖地）+ 残破头盔 + 鬃毛披洒。
  * 重力紫（0x8a6fd1 家族）是本 Boss 主题色例外（同玻尔多冰蓝破例条款——重力魔法的身份标识色，全局冷灰纪律不变）。
  * 招式对照 wiki（fextralife）忠实还原：
  * - 一阶段：双剑交叉斩/单手变奏三连、拖剑旋风（tel 段重力吸引→全周双段旋斩）、重力拉动（act 段猛拽玩家位移+命中硬直→40% 接交叉斩）、
  *   岩石块投掷 2 连（抛物线投射物）、超远箭狙（开战远程压制——速度 17 高伤巨箭）
  * - 二阶段（hp≤55%）：变身演出＝升空→陨石坠落回归（砸向玩家位+冲击波，跑位可躲）；碎星箭雨（扇形 5 矢）、重力波（地面行波投射物）、濒死狂暴加速
  * - 全程不可弹反（wiki：Radahn 不可弹反，同葛瑞克处理）；hp 950 / poiseMax 130 按本作 8 Boss 守关档。
  */
import * as THREE from "three";
import { MOVES, FEEL, MoveDef, FeelDef } from "./config";
import { Vfx, Particles } from "./vfx";
import { AU } from "./audio";
import { BossBase, BossStats, clamp01, smooth, seg } from "./boss-base";
import type { BossHost } from "./boss-base";
import type { ProjDef } from "./projectile";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export type { BossState, BossHost } from "./boss-base";

// ---------------- 主题色（重力紫 = 本 Boss 唯一例外强调色，同玻尔多冰蓝破例条款） ----------------
const GRAVITY = 0x8a6fd1;        // 重力紫（引力汇聚/冲击环/剑缘辉光）
const GRAVITY_DEEP = 0x5d4a9e;   // 深紫（岩块/波体）
const GRAVITY_GLOW = 0xa98fe8;   // 紫辉（箭矢/刀光/瞳）
const SLASH_COOL = 0xcdd6e4;     // 一阶段剑光（冷白）
const HAIR = 0x8f3a2a;           // 红鬃（暗赤）
const HAIR_DARK = 0x6d2c20;
const SKIN = 0x6e6355;           // 枯肤（重力干枯的将军之躯）
const IRON = 0x3a3e47;           // 暗铁甲
const IRON_DARK = 0x2b2e36;
const GOLD_TRIM = 0xa8783c;      // 将军甲金饰（稀疏点缀）
const STEEL = 0x707888;          // 剑身钢色

/** 投射物参数（发射走 host.fireProjectile，飞行/命中/消散由 game 侧 Projectiles 池负责）
 *  命中高度带 0.15–1.85（projectile.ts）：狙击箭平飞 1.8 全程在带内；岩/箭雨自高处抛落，入带段=威胁距离带 */
const ROCK_PROJ: ProjDef = { speed: 9, radius: 0.55, dmg: 18, feelKey: "rMagic", life: 2.2, color: GRAVITY_DEEP, drop: 1.4 };   // 自 2.2m 高抛落：威胁带 ~4.5–14.7m
const ARROW_PROJ: ProjDef = { speed: 17, radius: 0.35, dmg: 20, feelKey: "rMagic", life: 2.0, color: GRAVITY_GLOW };            // 碎星巨箭：平飞高速
const RAIN_PROJ: ProjDef = { speed: 8.5, radius: 0.4, dmg: 12, feelKey: "rMagic", life: 1.4, color: GRAVITY_GLOW, drop: 2.8 };  // 自 3.0m 高坠落：威胁带 ~5–8.5m
const WAVE_PROJ: ProjDef = { speed: 7.5, radius: 0.85, dmg: 18, feelKey: "rWave", life: 2.4, color: GRAVITY };                  // 地面行波：0.7m 平推全场

// ---------------- 帧数据（键名 radahn 前缀 / 手感键 r 开头；fextralife wiki 对照，全程不可弹反） ----------------
export const MOVES_RADAHN: Record<string, MoveDef> = {
  // 双剑交叉斩（双碎星大剑合剪·招牌）：两段判定 0.30/0.65（active 0.75，余量 0.10）；三连近身 chain 接出
  radahnCross: {
    name: "radahnCross", label: "双剑交叉斩", startup: 0.62, active: 0.75, recovery: 1.0,
    dmg: 16, range: 4.8, arc: 1.5, hits: 2, hitInterval: 0.35,
    parryable: false, cd: 4.2, feel: "rHeavy",
  },
  // 双剑三连（左右手单斩变奏 + 双剑下劈收尾）：三段判定 0.68/1.18/1.68（active 1.7，末段余量 0.02）
  radahnTriple: {
    name: "radahnTriple", label: "双剑三连", startup: 0.42, active: 1.7, recovery: 1.0,
    dmg: 12, range: 4.4, arc: 1.8, hits: 3, hitInterval: 0.5, chain: "radahnCross",
    parryable: false, cd: 4.6, feel: "rLight",
  },
  // 拖剑旋风（Starcaller Vortex·贴身解围）：tel 段重力吸引（3.2m/s 拽向自身，至 3.4m 止）
  // → 全周双段旋斩 0.34/0.74（spin 整圈，arc 6.28 周身）
  radahnVortex: {
    name: "radahnVortex", label: "拖剑旋风", startup: 1.05, active: 0.85, recovery: 1.15,
    dmg: 14, range: 5.2, arc: 6.28, hits: 2, hitInterval: 0.4,
    parryable: false, cd: 7.0, feel: "rHeavy",
  },
  // 重力拉动（Gravity Pull·设定技）：tel 缓吸 → act 猛拽（6m/s 至 2.7m 止，位移+命中硬直＝拽到面前）
  // → 40% 接交叉斩（chain——wiki：拽近后常接挥砍连段）
  radahnPull: {
    name: "radahnPull", label: "重力拉动", startup: 0.6, active: 0.6, recovery: 0.8,
    dmg: 10, range: 6.5, arc: 6.28, chain: "radahnCross",
    parryable: false, cd: 8.0, feel: "rPull",
  },
  // 岩石块投掷（Rock Throw·2 连）：抛物线重力岩×2（首发 act 起点、第二发 +0.55s 于 movePose 补发，与战斗时间同源）；
  // 近战判定禁用（range 0.2——人/Boss 推挤最小间距永不满足），伤害由 ROCK_PROJ 承载
  radahnRocks: {
    name: "radahnRocks", label: "岩石投掷", startup: 0.6, active: 0.25, recovery: 1.05,
    dmg: 18, range: 0.2, arc: 0.9, proj: { speed: 9, radius: 0.55, life: 2.2 },
    parryable: false, cd: 7.0, feel: "rMagic",
  },
  // 碎星之矢（Greatarrow Snipe·开战远程压制/标志）：超远高伤巨箭，速度 17 可翻滚穿；弓为召唤显形（bowShow）
  radahnSnipe: {
    name: "radahnSnipe", label: "碎星之矢", startup: 0.9, active: 0.2, recovery: 0.95,
    dmg: 20, range: 0.2, arc: 0.9, proj: { speed: 17, radius: 0.35, life: 2.0 },
    parryable: false, cd: 6.5, feel: "rMagic",
  },
  // ---- 二阶段（phase2Only） ----
  // 陨石回归（Meteor Crash）：升空压顶 → 坠砸玩家位（lunge 12 全场射程；落点在出手时锁定，跑位可躲）
  // + 紫色巨冲击波 + 击飞（knockUp 3）；落地大硬直 1.6s＝最大惩罚窗口
  radahnMeteor: {
    name: "radahnMeteor", label: "陨石回归", startup: 1.0, active: 0.22, recovery: 1.6,
    dmg: 34, range: 4.8, arc: 2.6, lunge: 12, knockUp: 3,
    parryable: false, cd: 9.0, phase2Only: true, feel: "rHeavy",
  },
  // 碎星箭雨（Arrow Rain·扇形射弹）：5 矢扇面 ±0.32rad 自高处抛落（威胁带 5–8.5m——中距压制喝药/站桩）
  radahnArrowRain: {
    name: "radahnArrowRain", label: "碎星箭雨", startup: 0.75, active: 0.2, recovery: 1.1,
    dmg: 12, range: 0.2, arc: 0.9, proj: { speed: 8.5, radius: 0.4, life: 1.4 },
    parryable: false, cd: 8.0, phase2Only: true, feel: "rMagic",
  },
  // 重力波（Gravity Wave·地面行波）：双剑砸地放出行波（大半径慢速平推投射物，0.7m 高全程在命中带）
  radahnGravityWave: {
    name: "radahnGravityWave", label: "重力波", startup: 0.7, active: 0.25, recovery: 1.0,
    dmg: 18, range: 0.2, arc: 0.9, proj: { speed: 7.5, radius: 0.85, life: 2.4 },
    parryable: false, cd: 7.0, phase2Only: true, feel: "rWave",
  },
};
Object.assign(MOVES, MOVES_RADAHN);

// ---------------- 手感档案（重力将军：巨剑沉、重力命中带紫爆） ----------------
export const FEEL_RADAHN: Record<string, FeelDef & { label: string }> = {
  rLight: { label: "拉塔恩·轻斩", hitstop: 0.05, shake: 0.40, sparks: 10, sparkSpeed: 4,   knockback: 0.35, sfx: "hitStone" },
  rHeavy: { label: "拉塔恩·重斩", hitstop: 0.10, shake: 0.60, sparks: 16, sparkSpeed: 5,   knockback: 0.65, sfx: "hitHeavy" },
  rMagic: { label: "重力·命中",   hitstop: 0.08, shake: 0.45, sparks: 14, sparkSpeed: 5,   knockback: 0.50, sfx: "hitHeavy" },
  rPull:  { label: "重力·拽引",   hitstop: 0.06, shake: 0.35, sparks: 10, sparkSpeed: 4,   knockback: 0.20, sfx: "hitStone" },
  rWave:  { label: "重力波·命中", hitstop: 0.09, shake: 0.55, sparks: 14, sparkSpeed: 5,   knockback: 0.70, sfx: "hitHeavy" },
};
Object.assign(FEEL, FEEL_RADAHN);

export const RADAHN_STATS: BossStats & { name: string; radius: number } = {
  name: "碎星拉塔恩", radius: 1.6,      // 全场最大身位（wiki：残破将军巨躯）
  hp: 950,                              // wiki 19096 ÷ 本作 8 Boss 守关尺度 ~20
  poiseMax: 130, poiseDecay: 8,         // wiki Stance 130——巨躯韧厚，恢复慢
  staggerDur: 2.4, staggerMul: 1.5, parriedDur: 1.8,   // 不可弹反——parriedDur 仅存结构位
  phase2At: 0.55,                       // wiki：~55% 升空陨石回归
  walkSpeed: 3.0, turnRate: 2.5,        // 大步横移的巨躯：直行不慢、转向钝
};

/** 阶段数值基线快照（多实例/reset 往返安全，仿 margit/sulyvahn）；濒死狂暴（≤18%）在 P2 buff 之上再叠 */
const P1_BASE: Record<string, { startup: number; dmg: number }> = {};
for (const m of Object.values(MOVES_RADAHN)) if (!m.phase2Only) P1_BASE[m.name] = { startup: m.startup, dmg: m.dmg };
const BASE_WALK = RADAHN_STATS.walkSpeed;
const BASE_TURN = RADAHN_STATS.turnRate;
const ENRAGE_AT = 0.18;                 // 濒死狂暴线（wiki：低血量显著加速）

// ---------------- 顶点色几何工具（同 scene-cemetery：非索引化 + 每面微扰 + merge 合批） ----------------
let seed = 20261112;
const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;

interface GOpt { rx?: number; ry?: number; rz?: number; jitter?: number }

function paint(geo: THREE.BufferGeometry, color: number, jitter = 0): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 3) {
    const f = jitter ? 1 + (rnd() - 0.5) * jitter : 1;
    for (let k = 0; k < 3 && i + k < n; k++) {
      const j = (i + k) * 3;
      arr[j] = c.r * f; arr[j + 1] = c.g * f; arr[j + 2] = c.b * f;
    }
  }
  g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return g;
}

function boxG(w: number, h: number, d: number, x: number, y: number, z: number, color: number, opt: GOpt = {}): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (opt.rx) g.rotateX(opt.rx);
  if (opt.ry) g.rotateY(opt.ry);
  if (opt.rz) g.rotateZ(opt.rz);
  g.translate(x, y, z);
  return paint(g, color, opt.jitter ?? 0);
}

/** 合批建部件 Mesh：merge 后释放源几何（一件关节 = 1 draw call） */
function part(geoms: THREE.BufferGeometry[], mat: THREE.Material, shadow = true): THREE.Mesh {
  const merged = mergeGeometries(geoms, false)!;
  for (const g of geoms) g.dispose();
  const m = new THREE.Mesh(merged, mat);
  m.castShadow = shadow;
  return m;
}

// ---------------- 姿态（Pose）：双剑臂各自 lift/swing（同沙力万双持范式，巨躯无膝枢轴——腿整体随 crouch 前倾） ----------------
interface Pose {
  y: number; lean: number; twist: number; crouch: number; reach: number;
  rLift: number; rSwing: number;   // 右剑臂：lift 正=前甩 负=上举；swing 正=向左抡
  lLift: number; lSwing: number;   // 左剑臂（镜像）
  nod: number;                     // 头部俯仰（正=低头）
  spin: number;                    // 整体附加旋转（拖剑旋风整圈）
}
const STANCE: Pose = { y: 0, lean: 0.12, twist: -0.06, crouch: 0.04, reach: 0, rLift: 0.26, rSwing: 0.14, lLift: 0.26, lSwing: -0.14, nod: 0.1, spin: 0 };
const STATUE: Pose = { ...STANCE, lean: 0.3, crouch: 0.16, y: -0.1, nod: 0.55, rLift: 0.5, rSwing: 0.05, lLift: 0.5, lSwing: -0.05 };   // 双剑前拄垂首伫立
// 交叉斩：双剑大开 → 合剪两拍（与判定 0.30/0.65 对齐）
const XW: Pose = { ...STANCE, twist: 0.5, rLift: -1.3, rSwing: -1.1, lLift: -1.3, lSwing: 1.1, lean: -0.08, crouch: 0.1 };
const X1: Pose = { ...STANCE, twist: -0.4, rLift: 0.5, rSwing: 0.9, lLift: 0.5, lSwing: -0.9, lean: 0.25, crouch: 0.12 };
const X2: Pose = { ...STANCE, twist: -0.55, rLift: 0.62, rSwing: 1.15, lLift: 0.62, lSwing: -1.15, lean: 0.32, crouch: 0.18, reach: 0.2 };
// 三连三拍（与判定 0.68/1.18/1.68 对齐）：右单斩 / 左单斩 / 双剑下劈
const T1W: Pose = { ...STANCE, twist: 0.5, rLift: -1.2, rSwing: -0.9, nod: 0.12 };
const T1K: Pose = { ...STANCE, twist: -0.45, rLift: 0.6, rSwing: 1.1, lean: 0.2 };
const T2W: Pose = { ...STANCE, twist: -0.5, lLift: -1.2, lSwing: 0.9, nod: 0.12 };
const T2K: Pose = { ...STANCE, twist: 0.45, lLift: 0.6, lSwing: -1.1, lean: 0.18 };
const T3W: Pose = { ...STANCE, rLift: -1.6, lLift: -1.6, rSwing: -0.3, lSwing: 0.3, lean: -0.1, crouch: 0.1 };
const T3K: Pose = { ...STANCE, rLift: 0.7, lLift: 0.7, rSwing: 0.15, lSwing: -0.15, lean: 0.4, crouch: 0.2, reach: 0.3 };
// 拖剑旋风：拖剑低开蓄势（吸引段）→ 张臂转体（spin 整圈）
const VW: Pose = { ...STANCE, crouch: 0.3, lean: 0.2, nod: 0.25, rLift: 0.1, rSwing: -1.3, lLift: 0.1, lSwing: 1.3 };
const VK: Pose = { ...STANCE, crouch: 0.18, lean: 0.1, rLift: 0.35, rSwing: -1.5, lLift: 0.35, lSwing: 1.5 };
// 重力拉动：双臂前伸上举（掌心向外凝聚）→ 猛收回胸前（拽引）
const PW: Pose = { ...STANCE, rLift: -0.9, lLift: -0.9, rSwing: 0.3, lSwing: -0.3, lean: -0.05, nod: 0.05 };
const PK: Pose = { ...STANCE, rLift: 0.4, lLift: 0.4, rSwing: -0.3, lSwing: 0.3, lean: 0.3, crouch: 0.2, reach: 0.15 };
// 岩石投掷：双臂高举过头（重力岩悬浮）→ 向前下方猛掷
const RW: Pose = { ...STANCE, rLift: -2.2, lLift: -2.2, rSwing: 0.2, lSwing: -0.2, lean: -0.15, nod: -0.15, crouch: 0.08 };
const RK: Pose = { ...STANCE, rLift: 1.0, lLift: 1.0, rSwing: 0.1, lSwing: -0.1, lean: 0.45, crouch: 0.2, nod: 0.25 };
// 碎星之矢：左臂前平持弓（召唤显形）→ 右手满弦后拉 → 释放
const SW: Pose = { ...STANCE, lLift: 1.3, lSwing: 0.05, rLift: 0.9, rSwing: -0.5, twist: 0.4, lean: 0.05, nod: 0.02 };
const SK: Pose = { ...STANCE, lLift: 1.25, lSwing: 0.05, rLift: 1.2, rSwing: 0.2, twist: 0.05, lean: 0.18 };
// 陨石回归（战斗内复用）：深蹲蓄势 → 升空张臂 → 头前脚后坠落 → 落地跪伏
const MW: Pose = { ...STANCE, crouch: 0.5, y: -0.3, lean: 0.3, nod: 0.3, rLift: 0.3, lLift: 0.3 };
const MUP: Pose = { ...STANCE, lean: -0.2, nod: -0.2, rLift: -2.0, lLift: -2.0, rSwing: -0.4, lSwing: 0.4 };
const MDIVE: Pose = { ...STANCE, lean: 0.9, nod: 0.45, rLift: -1.6, lLift: -1.6, rSwing: 0.3, lSwing: -0.3, crouch: 0.1 };
const MLAND: Pose = { ...STANCE, crouch: 0.5, y: -0.28, lean: 0.5, nod: 0.35, rLift: 1.2, lLift: 1.2, rSwing: 0.2, lSwing: -0.2 };
// 箭雨：双臂高举交叉 → 向前下扫开
const AW: Pose = { ...STANCE, rLift: -1.9, lLift: -1.9, rSwing: -0.6, lSwing: 0.6, lean: -0.12, nod: -0.1, crouch: 0.1 };
const AK: Pose = { ...STANCE, rLift: 0.6, lLift: 0.6, rSwing: 0.5, lSwing: -0.5, lean: 0.3, crouch: 0.15 };
// 重力波：双剑高举过头合并 → 砸地放波
const WW: Pose = { ...STANCE, rLift: -2.4, lLift: -2.4, rSwing: -0.2, lSwing: 0.2, lean: -0.16, nod: -0.18 };
const WK: Pose = { ...STANCE, rLift: 1.1, lLift: 1.1, rSwing: 0.1, lSwing: -0.1, lean: 0.5, crouch: 0.35, y: -0.15, nod: 0.3 };
// 变身演出（升空→陨石回归）：深蹲聚引 → 升空张臂（重力喷射）→ 坠落弹道 → 落地跪伏
const TF_CROUCH: Pose = { ...STANCE, crouch: 0.5, y: -0.3, lean: 0.28, nod: 0.35, rLift: -0.6, lLift: -0.6 };
const TF_RISE: Pose = { ...STANCE, lean: -0.22, nod: -0.3, rLift: -2.1, lLift: -2.1, rSwing: -0.5, lSwing: 0.5, y: 0 };
const TF_FALL: Pose = { ...STANCE, lean: 1.0, nod: 0.4, rLift: -1.7, lLift: -1.7, rSwing: 0.3, lSwing: -0.3 };
const TF_LAND: Pose = { ...STANCE, crouch: 0.52, y: -0.3, lean: 0.55, nod: 0.4, rLift: 1.1, lLift: 1.1 };

export class Radahn extends BossBase {
  private body = new THREE.Group();
  private torso = new THREE.Group();
  private head = new THREE.Group();
  private hairG = new THREE.Group();
  private legR = new THREE.Group();
  private legL = new THREE.Group();
  private armR = new THREE.Group();
  private armL = new THREE.Group();
  private bow = new THREE.Group();                 // 召唤碎星大弓（snipe 显形，bowShow 缓动）
  private eyeMat!: THREE.MeshBasicMaterial;        // 双瞳（重力紫辉·加色）
  private swordMat!: THREE.MeshStandardMaterial;   // 双剑（剑缘紫辉随阶段呼吸）
  private bowMat!: THREE.MeshBasicMaterial;
  private gravDust!: Particles;                    // 重力紫尘池（拽引/陨石尾迹/P2 周身）

  private pose: Pose = { ...STATUE };
  private playerLive = new THREE.Vector3(0, 0, 5); // update 入口接管玩家位置活引用（重力拽引直接写回）
  private moveFrom = new THREE.Vector3();          // 位移类招（陨石）基准
  private moveDir = new THREE.Vector3(0, 0, 1);
  private moveLen = 0;
  private lastDt = 0;                              // 拽引强度按帧 dt（顿帧/暂停时 0＝冻结）
  private slashFired = 0;                          // 已补画剑光的判定段数（与 hitFired 对齐）
  private rockFired = 0;                           // 已掷出岩石数
  private fxStep = 0;                              // 落点表现步进（陨石砸地）
  private bowShow = 0;                             // 大弓显形度 0..1
  private p2Applied = false;                       // 二阶段数值 buff 是否已写入共享表
  private enraged = false;                         // 濒死狂暴（≤18%）
  private tfDrift = false;                         // 变身高空横移段已锁定落点
  private tfTarget = new THREE.Vector3();          // 陨石坠落落点（锁定玩家位——跑位可躲）
  private tfStep = 0;                              // 变身落地帧步进

  constructor(scene: THREE.Scene, vfx: Vfx, pos: THREE.Vector3, host: BossHost, facing = -Math.PI / 2) {
    super(scene, vfx, pos, host, RADAHN_STATS, facing);
    this.gravDust = new Particles(scene, 160, { size: 0.06, color: GRAVITY, additive: true, gravity: -0.12 });
    this.transformHitAt = 2.0;    // 升空 0.55–1.1 → 高空锁点横移 1.1–1.75 → 坠落 1.75–2.0 → 2.0s 陨石砸地冲击波
    this.transformDur = 2.7;
    this.assemble();
  }

  // ---------------- 外观：红发巨大剪影（肩宽 ~3.3 / 高 ~3.8，radius 1.6）+ 双碎星大剑 + 残破头盔 + 紫瞳 ----------------
  // 预算：11 mesh（9 castShadow）+ 1 Points ≈ 21 dc，无 PointLight——紫辉靠剑缘 emissive / 加色瞳 / vfx 承载
  protected override buildBody(): void {
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.9, metalness: 0.15, flatShading: true });
    this.swordMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.4, metalness: 0.55, flatShading: true,
      emissive: GRAVITY, emissiveIntensity: 0.25,
    });
    this.eyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    this.bowMat = new THREE.MeshBasicMaterial({ color: GRAVITY_GLOW, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });

    // 巨躯双腿（髋枢轴 y 1.95，无膝枢轴——整腿随 crouch 前倾；一件腿 = 1 mesh）
    for (const [leg, sx] of [[this.legR, 0.55], [this.legL, -0.55]] as [THREE.Group, number][]) {
      leg.position.set(sx, 1.95, 0);
      leg.add(part([
        boxG(0.52, 0.95, 0.58, 0, -0.47, 0, IRON, { jitter: 0.06 }),                    // 大腿甲
        boxG(0.56, 0.3, 0.62, 0, -0.98, 0.05, IRON_DARK),                               // 膝甲
        boxG(0.44, 0.9, 0.48, 0, -1.5, 0.02, IRON_DARK, { jitter: 0.05 }),              // 小腿
        boxG(0.48, 0.16, 0.84, 0, -1.88, 0.16, IRON),                                   // 巨足
      ], bodyMat));
      this.body.add(leg);
    }

    // 躯干（枢轴 y 2.0，一件 = 1 mesh）：盆甲 + 战裙 + 胸甲 + 背板 + 双层巨肩甲
    this.torso.position.y = 2.0;
    this.torso.add(part([
      boxG(1.34, 0.44, 0.82, 0, -0.08, 0, IRON_DARK, { jitter: 0.05 }),                 // 盆甲
      boxG(1.46, 0.14, 0.9, 0, 0.12, 0, GOLD_TRIM),                                    // 束带
      boxG(0.52, 0.55, 0.09, 0.34, -0.38, 0.42, IRON_DARK, { rz: 0.22 }),              // 战裙前片 ×2
      boxG(0.52, 0.55, 0.09, -0.34, -0.38, 0.42, IRON_DARK, { rz: -0.22 }),
      boxG(1.28, 0.52, 0.76, 0, 0.42, 0, IRON, { jitter: 0.05 }),                       // 腹甲
      boxG(1.72, 0.64, 0.92, 0, 0.86, 0, IRON, { jitter: 0.05 }),                       // 胸甲
      boxG(1.56, 0.3, 0.86, 0, 1.24, 0.02, GOLD_TRIM, { jitter: 0.08 }),               // 上胸金纹
      boxG(1.32, 0.82, 0.16, 0, 0.8, -0.52, IRON_DARK),                                // 背板
      boxG(0.66, 0.36, 0.74, 1.12, 1.2, 0, IRON, { rz: -0.3, jitter: 0.05 }),           // 右肩甲双层
      boxG(0.42, 0.24, 0.5, 1.42, 0.98, 0.02, GOLD_TRIM, { rz: -0.5 }),
      boxG(0.66, 0.36, 0.74, -1.12, 1.2, 0, IRON, { rz: 0.3, jitter: 0.05 }),           // 左肩甲双层
      boxG(0.42, 0.24, 0.5, -1.42, 0.98, 0.02, GOLD_TRIM, { rz: 0.5 }),
      boxG(0.2, 0.3, 0.06, 0, 0.9, 0.48, GOLD_TRIM),                                   // 胸口纹章
    ], bodyMat));

    // 头（枢轴 y 1.5：颈 + 残破头盔（开放顶＋冠碎＋颌甲）+ 一件 = 1 mesh）——鬃毛自破顶倾泻
    this.head.position.set(0, 1.5, 0.03);
    this.head.add(part([
      boxG(0.36, 0.24, 0.36, 0, -0.1, 0, SKIN),                                        // 颈
      boxG(0.58, 0.3, 0.62, 0, 0.14, 0.02, IRON, { jitter: 0.06 }),                     // 盔檐
      boxG(0.46, 0.36, 0.42, 0, -0.12, 0.09, SKIN, { jitter: 0.08 }),                   // 面
      boxG(0.15, 0.42, 0.46, 0.27, -0.08, 0.06, IRON_DARK),                            // 颌甲 ×2
      boxG(0.15, 0.42, 0.46, -0.27, -0.08, 0.06, IRON_DARK),
      boxG(0.2, 0.26, 0.2, 0.16, 0.36, -0.05, IRON_DARK, { rz: 0.3 }),                  // 残冠断尖 ×3（破顶）
      boxG(0.18, 0.18, 0.18, -0.14, 0.34, -0.08, IRON_DARK, { rz: -0.4 }),
      boxG(0.14, 0.3, 0.14, 0, 0.4, 0.12, GOLD_TRIM, { rz: 0.1 }),
      boxG(0.08, 0.2, 0.08, 0.34, 0.22, 0, IRON_DARK, { rz: -0.9 }),                    // 侧角残根 ×2
      boxG(0.08, 0.2, 0.08, -0.34, 0.22, 0, IRON_DARK, { rz: 0.9 }),
    ], bodyMat));
    // 双瞳（重力紫辉·加色，一件 = 1 mesh，无阴影）
    this.head.add(part([
      boxG(0.1, 0.05, 0.03, 0.11, 0.12, 0.31, GRAVITY_GLOW),
      boxG(0.1, 0.05, 0.03, -0.11, 0.12, 0.31, GRAVITY_GLOW),
    ], this.eyeMat, false));

    // 红鬃（一件 = 1 mesh）：破盔而出的赤发巨绺，后披及背 + 双肩前垂缕
    this.hairG.position.set(0, 0.16, -0.16);
    this.hairG.add(part([
      boxG(0.62, 0.95, 0.3, 0, -0.5, -0.32, HAIR, { rx: 0.18, jitter: 0.1 }),           // 主绺（后披）
      boxG(0.52, 0.55, 0.36, 0, 0.18, -0.2, HAIR_DARK, { rx: 0.3, jitter: 0.1 }),       // 顶绺（自破顶涌出）
      boxG(0.16, 0.7, 0.14, 0.3, -0.3, -0.3, HAIR_DARK, { rz: 0.35, jitter: 0.12 }),    // 侧绺 ×3
      boxG(0.16, 0.55, 0.14, -0.3, -0.25, -0.3, HAIR_DARK, { rz: -0.35, jitter: 0.12 }),
      boxG(0.14, 0.42, 0.12, 0, -0.62, -0.28, HAIR, { jitter: 0.12 }),
      boxG(0.13, 0.85, 0.1, 0.38, -0.55, 0.12, HAIR, { rz: 0.5, jitter: 0.12 }),        // 肩前垂缕 ×2
      boxG(0.13, 0.85, 0.1, -0.38, -0.55, 0.12, HAIR, { rz: -0.5, jitter: 0.12 }),
    ], bodyMat));
    this.head.add(this.hairG);
    this.torso.add(this.head);

    // 双臂 + 碎星大剑（一臂一剑各一件）：巨剑前下曳——垂剑时剑尖恰好拄地（拖剑）
    const buildSword = (): THREE.Group => {
      const g = new THREE.Group();
      g.position.set(0, -1.34, 0.12);
      g.rotation.x = 0.62;
      g.add(part([
        boxG(0.1, 0.3, 0.1, 0, 0, 0, IRON_DARK),                                       // 柄
        boxG(0.15, 0.12, 0.15, 0, 0.2, 0, GOLD_TRIM),                                  // 柄头
        boxG(0.56, 0.09, 0.16, 0, -0.18, 0, GOLD_TRIM),                                // 护手
        boxG(0.32, 2.1, 0.07, 0, -1.28, 0, STEEL, { jitter: 0.04 }),                    // 剑身
        boxG(0.34, 1.7, 0.02, 0, -1.1, 0.045, GRAVITY_DEEP),                           // 剑缘紫辉条 ×2（重力淬锋）
        boxG(0.34, 1.7, 0.02, 0, -1.1, -0.045, GRAVITY_DEEP),
        boxG(0.26, 0.34, 0.06, 0, -2.5, 0, STEEL),                                     // 剑尖收锋
      ], this.swordMat));
      return g;
    };
    this.armR.position.set(1.06, 1.06, 0);
    this.armR.add(part([
      boxG(0.44, 0.62, 0.5, 0, -0.3, 0, IRON, { jitter: 0.05 }),                        // 上臂
      boxG(0.38, 0.58, 0.42, 0, -0.86, 0.03, IRON_DARK, { jitter: 0.05 }),              // 前臂
      boxG(0.44, 0.32, 0.48, 0, -1.24, 0.05, IRON),                                    // 铁手套
    ], bodyMat));
    this.armR.add(buildSword());
    this.torso.add(this.armR);
    this.armL.position.set(-1.06, 1.06, 0);
    this.armL.add(part([
      boxG(0.44, 0.62, 0.5, 0, -0.3, 0, IRON, { jitter: 0.05 }),
      boxG(0.38, 0.58, 0.42, 0, -0.86, 0.03, IRON_DARK, { jitter: 0.05 }),
      boxG(0.44, 0.32, 0.48, 0, -1.24, 0.05, IRON),
    ], bodyMat));
    this.armL.add(buildSword());
    this.torso.add(this.armL);

    // 召唤碎星大弓（snipe 显形；加色弓体 + 弦，一件 = 1 mesh，无阴影）
    this.bow.position.set(0, -1.3, 0.42);
    this.bow.add(part([
      boxG(0.07, 0.8, 0.07, 0, 0.75, 0.1, GRAVITY_GLOW, { rz: 0.35 }),                  // 上弓臂
      boxG(0.07, 0.8, 0.07, 0, -0.75, 0.1, GRAVITY_GLOW, { rz: -0.35 }),                // 下弓臂
      boxG(0.09, 0.16, 0.09, 0, 0, 0.16, GRAVITY_GLOW),                                 // 握把
      boxG(0.02, 1.72, 0.02, 0, 0, -0.12, GRAVITY),                                     // 弦
    ], this.bowMat, false));
    this.bow.visible = false;
    this.armL.add(this.bow);

    this.root.add(this.body);
    this.body.add(this.torso);
  }

  protected override chestPart(): THREE.Object3D { return this.torso; }
  protected override headPart(): THREE.Object3D { return this.head; }

  // ---------------- 姿态应用 ----------------
  protected override applyPose(): void {
    const p = this.pose;
    this.root.rotation.y = this.yaw + p.spin;
    this.body.position.set(0, p.y - p.crouch * 0.34, p.reach);
    this.torso.rotation.set(p.lean, p.twist, 0);
    this.head.rotation.x = p.nod;
    this.armR.rotation.set(-p.rLift, 0, -p.rSwing);
    this.armL.rotation.set(-p.lLift, -0.12, p.lSwing);
    this.legR.rotation.x = -p.crouch * 0.55;               // 无膝枢轴：整腿随蹲伏前倾
    this.legL.rotation.x = -p.crouch * 0.4;
    this.hairG.rotation.x = 0.06 + Math.sin(performance.now() * 0.0021) * 0.035 + p.lean * 0.3 + p.nod * 0.25;   // 鬃毛随俯仰/风摆
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
    // 岩石第二发补发：act 起点 +0.55s（active 0.25 ⇒ 落在 rec 段 t≈0.3；与战斗时间同源，暂停不脱钩）
    if (m.name === "radahnRocks" && sub !== "tel") {
      const ta = sub === "act" ? t : t + m.active;
      while (this.rockFired < 2 && ta >= this.rockFired * 0.55) this.fireRock(this.rockFired);
    }
    // 重力拽引（wiki Gravity Pull）：tel 段缓吸 / act 段猛拽——直接写回玩家位置（update 传入活引用），顿帧 dt=0 冻结
    if (m.name === "radahnPull") {
      if (sub === "tel" && t > m.startup * 0.35) this.pullPlayer(2.2, 3.2);
      else if (sub === "act") this.pullPlayer(6.0, 2.7);
    }
    // 拖剑旋风：tel 段持续吸引（自身为心的重力井）
    if (m.name === "radahnVortex" && sub === "tel" && t > 0.25) this.pullPlayer(3.2, 3.4);
    // 陨石回归（战斗内复用）：深蹲 → 升空压顶（位移+欺诈悬停）→ 坠砸 → 落地跪伏
    if (m.name === "radahnMeteor") {
      if (sub === "tel") {
        if (t < m.startup * 0.35) { this.lerpPose(STANCE, MW, smooth(t / (m.startup * 0.35))); return; }
        const k = clamp01((t - m.startup * 0.35) / (m.startup * 0.65));
        this.root.position.copy(this.moveFrom).addScaledVector(this.moveDir, this.moveLen * smooth(k));
        this.lerpPose(MW, MUP, smooth(k));
        this.pose.y = Math.sin(Math.min(1, k) * Math.PI / 2) * 5.5;                   // 升至顶点后悬停（须在 lerp 之后）
        if (Math.random() < 0.7) this.gravDust.burst(this.root.position.clone().setY(0.5 + Math.random() * 2), 2, 2.2, 0.8, 0.3);
        return;
      }
      if (sub === "act") {
        this.lerpPose(MUP, MDIVE, seg(t, 0, m.active));
        this.pose.y = 5.5 * Math.max(0, 1 - t / m.active);                             // 陨星直坠钉地（须在 lerp 之后）
        this.meteorFx(t, m);
        return;
      }
      this.lerpPose(MLAND, STANCE, smooth(seg(t, m.recovery * 0.25, m.recovery)));     // 落地大硬直（惩罚窗口）
      return;
    }
    const wind: Pose = { ...STANCE }, strike: Pose = { ...STANCE };
    switch (m.name) {
      case "radahnVortex": Object.assign(wind, VW); Object.assign(strike, VK); break;
      case "radahnPull":   Object.assign(wind, PW); Object.assign(strike, PK); break;
      case "radahnRocks":  Object.assign(wind, RW); Object.assign(strike, RK); break;
      case "radahnSnipe":  Object.assign(wind, SW); Object.assign(strike, SK); break;
      case "radahnArrowRain": Object.assign(wind, AW); Object.assign(strike, AK); break;
      case "radahnGravityWave": Object.assign(wind, WW); Object.assign(strike, WK); break;
    }
    if (sub === "tel") {
      this.lerpPose(STANCE, wind, smooth(seg(t, m.startup * 0.45, m.startup)));
    } else if (sub === "act") {
      if (m.name === "radahnCross") this.crossPose(t, m);
      else if (m.name === "radahnTriple") this.triplePose(t, m);
      else if (m.name === "radahnVortex") {
        const k = smooth(clamp01(t / m.active));
        this.lerpPose(VW, VK, k);
        this.pose.spin = Math.PI * 2 * k;                                             // 拖剑整圈旋斩
      } else this.lerpPose(wind, strike, seg(t, 0, m.active));
    } else {
      this.lerpPose(strike, STANCE, smooth(seg(t, m.recovery * 0.35, m.recovery)));
      if (m.name === "radahnVortex") this.pose.spin = 0;                              // 2π≡0：收招直接归零
    }
    void total;
  }

  /** 交叉斩判定段姿态：两拍与引擎判定时刻对齐（首段 active*0.4=0.30，其后 0.35s）——大开→合剪→再剪深 */
  private crossPose(t: number, m: MoveDef): void {
    const firstAt = m.active * 0.4;
    const ph = clamp01((t - firstAt) / Math.max(0.01, m.active - firstAt)) * 2;
    const idx = Math.min(1, Math.floor(ph));
    const s = smooth(clamp01(ph - idx));
    this.lerpPose(idx === 0 ? XW : X1, idx === 0 ? X1 : X2, s);
  }

  /** 三连判定段姿态：三拍与判定时刻对齐（首段 0.68，其后每 0.5s），右/左单斩变奏 + 双剑下劈收尾 */
  private triplePose(t: number, m: MoveDef): void {
    const firstAt = m.active * 0.4;
    const ph = clamp01((t - firstAt) / (m.active - firstAt)) * 3;
    const idx = Math.min(2, Math.floor(ph));
    const s = smooth(clamp01(ph - idx));
    const w = idx === 0 ? T1W : idx === 1 ? T2W : T3W;
    const k = idx === 0 ? T1K : idx === 1 ? T2K : T3K;
    this.lerpPose(w, k, s);
  }

  /** 重力拽引：把玩家沿 Boss 方向拖近（rate m/s，至 stop m 止）——update 传入的 playerPos 是玩家位置活引用，直接写回 */
  private pullPlayer(rate: number, stop: number): void {
    const toB = PULL_TMP.subVectors(this.root.position, this.playerLive);
    toB.y = 0;
    const d = toB.length();
    if (d <= stop) return;
    const step = Math.min(rate * Math.max(0, this.lastDt), d - stop);
    this.playerLive.addScaledVector(toB.normalize(), step);
    if (Math.random() < 0.5) this.gravDust.burst(this.playerLive.clone().setY(0.6), 2, 1.1, 0.5, 0.2);   // 拽引尘涡
  }

  /** 陨石落点表现：紫色巨冲击环 + 焦斑 + 尘爆（与命中判定解耦——打中/躲开都应砸出陨坑） */
  private meteorFx(t: number, m: MoveDef): void {
    if (this.fxStep !== 0 || t < m.active * 0.45) return;
    this.fxStep = 1;
    this.vfx.ring(this.root.position, 6.0, GRAVITY);
    this.vfx.scorch(this.root.position.clone().addScaledVector(new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)), 1.2), 3.0, GRAVITY_DEEP);
    this.vfx.dust.burst(this.root.position.clone().setY(0.3), 16, 3.4, 0.8);
    this.gravDust.burst(this.root.position.clone().setY(1.2), 22, 4.2, 1.2, 0.6);
    AU.slamShock();
    this.host.shake(0.75);
  }

  // ---------------- 拉塔恩专属覆盖点 ----------------
  /** 接管玩家位置活引用（重力拽引写回）+ 帧末驱动重力紫尘池与大弓显形 */
  override update(dt: number, playerPos: THREE.Vector3, playerIframed: boolean): void {
    this.lastDt = dt;
    this.playerLive = playerPos;
    super.update(dt, playerPos, playerIframed);
    this.updateAura(dt);
  }

  /** 重力紫尘推进 + 大弓显形缓动（snipe 出手即显/收招即隐）+ P2 周身重力浮尘 */
  private updateAura(dt: number): void {
    this.gravDust.update(dt);
    let bowTarget = 0;
    if (this.state === "combat" && this.move?.name === "radahnSnipe" && (this.sub === "tel" || this.sub === "act")) bowTarget = 1;
    this.bowShow += (bowTarget - this.bowShow) * Math.min(1, dt * 14);
    this.bow.visible = this.bowShow > 0.04;
    this.bowMat.opacity = this.bowShow * 0.85;
    if (this.bowShow > 0.05 && this.bowShow < 0.96 && Math.random() < dt * 22) {
      this.bow.getWorldPosition(AURA_TMP);
      this.gravDust.burst(AURA_TMP, 2, 1.0, 0.7, 0.4);                                 // 凝弓紫尘
    }
    if (this.phase === 2 && this.state !== "statue" && Math.random() < dt * 7) {
      this.gravDust.burst(this.chestWorld(AURA_TMP), 1, 0.5, 1.5, 0.3);                // P2 周身紫尘缕缕
    }
  }

  /** 唤醒：双剑前拄石像 2.5s 缓缓直身 + 抖尘，落定嘶吼 */
  protected override updateRising(dt: number): void {
    this.t += dt;
    this.lerpPose(STATUE, STANCE, smooth(clamp01(this.t / 2.5)));
    if (Math.random() < dt * 7) {
      this.vfx.dust.burst(this.root.position, 3, 2.2, 0.7);
      this.gravDust.burst(this.chestWorld(), 1, 1, 0.9, 0.3);
    }
    if (this.t > 0.45 && this.t - dt <= 0.45) this.host.onBossReveal();
    if (this.t >= 2.5) { this.state = "combat"; this.sub = "idle"; this.t = 0; AU.roar(); }
  }

  /** 唤醒瞬间：起身音 + 尘爆 */
  protected override onAwaken(): void {
    AU.rise();
    this.vfx.dust.burst(this.root.position.clone().setY(0.8), 12, 2.5, 0.8);
  }

  /** 紫瞳/剑缘呼吸 / 剑光按判定段补画 / 二阶段与濒死狂暴数值一次性写入 */
  protected override updateVisuals(): void {
    const now = performance.now();
    const p2 = this.phase === 2;
    const flick = 1 + Math.sin(now * 0.018) * 0.15;
    let eye = (this.state === "statue" ? 0.35 : p2 ? 2.0 : 0.95) + Math.sin(now * 0.004) * 0.2;
    if (this.state === "transform") eye += seg(this.t, 0, 0.55) * 1.6;                 // 变身点燃
    if (this.enraged) eye += 0.8;                                                      // 濒死狂暴：瞳灼
    this.eyeMat.opacity = Math.min(1, Math.max(0, eye * 0.5));
    this.swordMat.emissiveIntensity = (p2 ? 1.5 : 0.3) * (this.enraged ? 1.5 : 1) * flick;
    // 剑光：交叉斩/三连每段一道（hitFired 无条件按节拍推进，躲开也照画；首段与命中同帧）
    if (this.state === "combat" && this.sub === "act" && this.move &&
      (this.move.name === "radahnCross" || this.move.name === "radahnTriple")) {
      while (this.slashFired < this.hitFired) {
        this.slashFired++;
        this.vfx.slash(this.chestWorld(), this.yaw, this.move.range * 0.82,
          this.move.name === "radahnTriple" && this.slashFired === 3, p2 ? GRAVITY_GLOW : SLASH_COOL);
      }
    }
    // 拖剑旋风：每判定段一道全周紫光
    if (this.state === "combat" && this.sub === "act" && this.move?.name === "radahnVortex") {
      while (this.slashFired < this.hitFired) {
        this.slashFired++;
        this.vfx.slash(this.chestWorld().setY(1.1), this.yaw + (this.slashFired - 1) * 0.3, this.move.range * 0.9, true, GRAVITY_GLOW);
      }
    }
    if (p2 && !this.p2Applied) this.applyPhase2Moves();
    if (p2 && !this.enraged && this.hp <= this.maxHp * ENRAGE_AT) this.applyEnrage();
  }

  /** 二阶段：原有招式前摇 ×0.88 / 伤害 ×1.12（狂暴化前奏——wiki：重力魔力全开） */
  private applyPhase2Moves(): void {
    this.p2Applied = true;
    for (const m of Object.values(MOVES_RADAHN)) {
      if (m.phase2Only) continue;
      m.startup = P1_BASE[m.name].startup * 0.88;
      m.dmg = Math.round(P1_BASE[m.name].dmg * 1.12);
    }
  }

  /** 濒死狂暴（≤18%）：前摇 ×0.8 / 伤害 ×1.2 / 步速转向 +35%/+30%（wiki：低血量显著加速） */
  private applyEnrage(): void {
    this.enraged = true;
    for (const m of Object.values(MOVES_RADAHN)) {
      if (m.phase2Only) continue;
      m.startup = P1_BASE[m.name].startup * 0.8;
      m.dmg = Math.round(P1_BASE[m.name].dmg * 1.2);
    }
    this.cfg.walkSpeed = BASE_WALK * 1.35;
    this.cfg.turnRate = BASE_TURN * 1.3;
  }

  private restorePhase1Moves(): void {
    this.p2Applied = false;
    this.enraged = false;
    for (const m of Object.values(MOVES_RADAHN)) {
      if (m.phase2Only) continue;
      m.startup = P1_BASE[m.name].startup;
      m.dmg = P1_BASE[m.name].dmg;
    }
    this.cfg.walkSpeed = BASE_WALK;
    this.cfg.turnRate = BASE_TURN;
  }

  /** 大步横移步态（低频大幅——巨躯骑姿般的横移压迫） */
  protected override onIdleWalk(): void {
    const w = performance.now() * 0.0055;
    this.pose.y = Math.abs(Math.sin(w)) * 0.09 - 0.03;
    this.pose.lean = 0.12 + Math.sin(w * 2) * 0.03;
    this.pose.twist = -0.06 + Math.sin(w) * 0.05;
  }

  /** 位移基准与段计数复位：陨石朝玩家位前压（不越过） */
  protected override onMoveStart(m: MoveDef, toPlayer: THREE.Vector3, dist: number): void {
    this.moveFrom.copy(this.root.position);
    this.slashFired = 0;
    this.rockFired = 0;
    this.fxStep = 0;
    this.moveLen = 0;
    if (m.name === "radahnMeteor") {
      this.moveDir.copy(toPlayer).setY(0).normalize();
      this.moveLen = Math.min(m.lunge ?? 0, Math.max(0, dist - 1.5));
    }
  }

  /** 判定段开始：投射物发射 / 拽引汇聚环 */
  protected override onMoveActive(m: MoveDef): void {
    if (m.name === "radahnSnipe") this.fireSnipe();
    else if (m.name === "radahnArrowRain") this.fireRain();
    else if (m.name === "radahnGravityWave") this.fireWave();
    else if (m.name === "radahnVortex") {
      this.vfx.ring(this.root.position, 4.6, GRAVITY);                                 // 重力井汇聚环
      this.gravDust.burst(this.root.position.clone().setY(1.4), 14, 2.8, 0.9, 0.5);
      this.vfx.dust.burst(this.root.position.clone().setY(0.25), 8, 2.4, 0.7);
    }
  }

  /** 岩石投掷（抛物线：自 2.2m 高、drop 1.4——第二发 +0.35m 高与 ±0.12 偏航变奏） */
  private fireRock(i: number): void {
    this.rockFired++;
    const toP = new THREE.Vector3().subVectors(this.playerLive, this.root.position);
    toP.y = 0;
    const yaw = toP.length() > 0.01 ? Math.atan2(toP.x, toP.z) : this.yaw;
    const origin = this.chestWorld().setY(2.2 + i * 0.35);
    this.host.fireProjectile?.(origin, yaw + (i ? 0.12 : 0), ROCK_PROJ);
    this.gravDust.burst(origin, 6, 1.8, 0.6, 0.4);
    AU.whoosh(0.8);
  }

  /** 碎星之矢：大弓满弦释放——高速巨箭平飞（1.8m 全程在命中带），箭出同帧弓光 */
  private fireSnipe(): void {
    const toP = new THREE.Vector3().subVectors(this.playerLive, this.root.position);
    toP.y = 0;
    const yaw = toP.length() > 0.01 ? Math.atan2(toP.x, toP.z) : this.yaw;
    const origin = this.chestWorld().setY(1.8);
    this.host.fireProjectile?.(origin, yaw, ARROW_PROJ);
    this.vfx.slash(origin, yaw, 1.6, false, GRAVITY_GLOW);
    this.gravDust.burst(origin, 8, 2, 0.5, 0.3);
  }

  /** 碎星箭雨：5 矢扇面 ±0.32rad 自 3.0m 高抛落（扇形射弹——横滚穿缝隙） */
  private fireRain(): void {
    const toP = new THREE.Vector3().subVectors(this.playerLive, this.root.position);
    toP.y = 0;
    const yaw = toP.length() > 0.01 ? Math.atan2(toP.x, toP.z) : this.yaw;
    const origin = this.chestWorld().setY(3.0);
    for (const off of [-0.32, -0.16, 0, 0.16, 0.32]) {
      this.host.fireProjectile?.(origin, yaw + off, RAIN_PROJ);
    }
    this.vfx.slash(origin, yaw, 1.8, true, GRAVITY_GLOW);
  }

  /** 重力波：双剑砸地放出行波（大半径慢速平推）+ 地面紫痕 */
  private fireWave(): void {
    const toP = new THREE.Vector3().subVectors(this.playerLive, this.root.position);
    toP.y = 0;
    const yaw = toP.length() > 0.01 ? Math.atan2(toP.x, toP.z) : this.yaw;
    this.host.fireProjectile?.(this.chestWorld().setY(0.7), yaw, WAVE_PROJ);
    this.vfx.ring(this.root.position, 2.2, GRAVITY);
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    this.vfx.scorch(this.root.position.clone().addScaledVector(fwd, 2.5), 1.8, GRAVITY);
    AU.slamShock();
    this.host.shake(0.4);
  }

  /** 重招风声更闷 */
  protected override activeWhooshVolume(m: MoveDef): number {
    return m.name === "radahnCross" || m.name === "radahnVortex" || m.name === "radahnMeteor" || m.name === "radahnGravityWave" ? 0.6
      : m.name === "radahnTriple" || m.name === "radahnPull" || m.name === "radahnRocks" ? 0.8 : 1;
  }

  /** 破绽：巨躯前倾垮伏，双剑拖荡触地 */
  protected override updateStaggerPose(): void {
    this.lerpPose(STANCE, { ...STANCE, lean: 0.68, crouch: 0.45, y: -0.34, nod: 0.4, rLift: 0.3, rSwing: 0.5, lLift: 0.3, lSwing: -0.5 }, Math.min(1, this.t * 4.5));
  }

  /** 踉跄（不可弹反——仅结构性姿态位） */
  protected override updateParriedPose(): void {
    this.lerpPose(STANCE, { ...STANCE, lean: -0.45, crouch: 0.3, y: -0.3, nod: -0.22, rLift: -0.85, rSwing: 0.35, lLift: -0.85, lSwing: -0.35 }, Math.min(1, this.t * 8));
  }

  /** 变身＝「升空→陨石坠落回归」（wiki 二阶段开场）：
   *  0–0.55 深蹲聚引（重力紫尘汇聚）→ 0.55–1.1 重力喷射升空（y 0→9）
   *  → 1.1–1.75 高空横移至玩家上空（落点此刻锁定——之后跑位可躲）→ 1.75–2.0 陨星直坠
   *  → 2.0 transformHitAt：砸地巨冲击波（基类同帧回调 onBossTransform 结算震波 + ring/shake）/ phase=2 / 紫爆
   *  → 2.0–2.7 落地跪伏缓起 → combat（P2 招式池开放 + 数值 buff） */
  protected override updateTransform(): void {
    const HIT = this.transformHitAt;
    if (this.t < 0.55) {
      this.lerpPose(STANCE, TF_CROUCH, smooth(this.t / 0.55));
      if (Math.random() < 0.6) this.gravDust.burst(this.chestWorld(), 2, 2.2, 0.8, 0.5);
    } else if (this.t < 1.1) {
      this.lerpPose(TF_CROUCH, TF_RISE, smooth(seg(this.t, 0.55, 1.1)));
      this.pose.y = seg(this.t, 0.55, 1.1) * 9;                                          // 升空高度须在 lerp 之后
      if (Math.random() < 0.8) this.gravDust.burst(this.root.position.clone().setY(0.5 + Math.random() * 2), 3, 2.6, 0.8, 0.3);   // 喷射尾迹
    } else if (this.t < 1.75) {
      if (!this.tfDrift) {                                    // 锁定落点（=此刻玩家位）——此后跑位即躲
        this.tfDrift = true;
        this.moveFrom.copy(this.root.position);
        this.tfTarget.copy(this.playerLive).setY(0);
      }
      this.root.position.lerpVectors(this.moveFrom, this.tfTarget, smooth(seg(this.t, 1.1, 1.75)));
      this.lerpPose(TF_RISE, TF_FALL, seg(this.t, 1.55, 1.75));
      this.pose.y = 9;
    } else if (this.t < HIT) {
      this.lerpPose(TF_RISE, TF_FALL, 1);
      this.pose.y = 9 * (1 - smooth(seg(this.t, 1.75, HIT)));                            // 陨星直坠
      if (Math.random() < 0.9) this.gravDust.burst(this.chestWorld(), 3, 3, 0.6, 0.4);   // 坠落尾焰
    } else {
      if (this.tfStep === 0) {                                 // 砸地帧：phase=2 + 陨坑紫爆（基类同帧出冲击环/震屏/震波回调）
        this.tfStep = 1;
        this.phase = 2;
        this.vfx.ring(this.root.position, 7, GRAVITY);
        this.vfx.scorch(this.root.position, 3.4, GRAVITY_DEEP);
        this.vfx.dust.burst(this.root.position.clone().setY(0.3), 18, 3.6, 0.9);
        this.gravDust.burst(this.root.position.clone().setY(1.2), 26, 4.5, 1.3, 0.6);
        AU.roar();
      }
      this.lerpPose(TF_FALL, TF_LAND, smooth(seg(this.t, HIT, HIT + 0.25)));
      if (this.t > HIT + 0.25) this.lerpPose(TF_LAND, STANCE, smooth(seg(this.t, HIT + 0.25, this.transformDur)));
    }
  }

  /** 死亡：巨躯前倾跪倒 + 余烬 + 重力散逸（最后一缕紫尘） */
  protected override updateDeath(dt: number): void {
    this.lerpPose(this.pose, { ...STANCE, lean: 1.15, y: -0.8, crouch: 0.55, nod: 0.5, rLift: 0.25, rSwing: 0.5, lLift: 0.25, lSwing: -0.5 }, dt * 2.6);
    if (Math.random() < dt * 20) this.vfx.embers.burst(this.chestWorld(), 3, 3, 1.2);
    if (Math.random() < dt * 5) this.gravDust.burst(this.chestWorld(), 2, 1.2, 1.6, 0.4);
  }

  protected override resetVisuals(): void {
    this.restorePhase1Moves();
    this.slashFired = 0;
    this.rockFired = 0;
    this.fxStep = 0;
    this.tfDrift = false;
    this.tfStep = 0;
    this.bowShow = 0;
    this.bow.visible = false;
    this.bowMat.opacity = 0;
    this.eyeMat.opacity = 0.5;
    this.swordMat.emissiveIntensity = 0.25;
    this.lerpPose(STANCE, STATUE, 1);
  }

  /** 二阶段/濒死狂暴改过共享招式表和移速时，销毁要还原（死亡重开不走 reset） */
  protected override releaseSharedState(): void {
    if (this.p2Applied || this.enraged) this.restorePhase1Moves();
  }

  /** 重力紫尘池挂在 scene 直下（不随 root），dispose 时需单独摘除并释放 GPU 资源 */
  protected override extraDispose(): void {
    this.gravDust.mesh.geometry.dispose();
    (this.gravDust.mesh.material as THREE.Material).dispose();
    this.gravDust.mesh.removeFromParent();
  }

  // ---------------- 选招（距离四档：超远箭狙压制 / 中远岩+雨+波 / 中近交叉+三连+旋风 / 贴身旋风+拽引） ----------------
  protected override pickMove(dist: number): MoveDef | null {
    const M = MOVES_RADAHN;
    const ready = (m: MoveDef) => (this.cds[m.name] ?? 0) <= 0 && (!m.phase2Only || this.phase === 2);
    // 超远（>9m）：开战远程压制——箭狙优先（标志）/ 岩石块次之；都未好则巨躯缓行逼近
    if (dist > 9) {
      if (ready(M.radahnSnipe)) return M.radahnSnipe;
      if (ready(M.radahnRocks)) return M.radahnRocks;
      return null;
    }
    // 中远（5.2–9m）：抛物线岩 / P2 箭雨扇面+行波+陨石 / 旋风拽入
    if (dist > 5.2) {
      const far: [MoveDef, number][] = [
        [M.radahnRocks, 3],
        [M.radahnSnipe, 1.5],
        [M.radahnArrowRain, this.phase === 2 ? 3.5 : 0],
        [M.radahnGravityWave, this.phase === 2 ? 3 : 0],
        [M.radahnMeteor, this.phase === 2 ? 2.5 : 0],
        [M.radahnVortex, dist <= 7 ? 1.5 : 0],                                          // 拽引令中距也不安全
      ];
      return this.pickWeighted(far.filter(([m, w]) => w > 0 && ready(m)));
    }
    // 中近 / 贴身
    const pool: [MoveDef, number][] = dist < 3.0 ? [
      [M.radahnVortex, 4.5],                                                            // 贴身解围：吸引+全周旋斩
      [M.radahnCross, 3.5],
      [M.radahnPull, 2.5],                                                              // 拽近设定技
      [M.radahnTriple, 2],
    ] : [
      [M.radahnCross, 3],
      [M.radahnTriple, 3],
      [M.radahnVortex, 2.5],
      [M.radahnMeteor, this.phase === 2 ? 2 : 0],
      [M.radahnGravityWave, this.phase === 2 ? 1.5 : 0],
    ];
    // 投射物招（proj 字段）不吃近战 range 闸——其距离带已在权重里
    const cands = pool.filter(([m, w]) => w > 0 && ready(m) && (m.proj || dist < m.range * 0.95));
    return this.pickWeighted(cands);
  }

  private pickWeighted(cands: [MoveDef, number][]): MoveDef | null {
    if (!cands.length) return null;
    const sum = cands.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * sum;
    for (const [m, w] of cands) { r -= w; if (r <= 0) return m; }
    return cands[0][0];
  }
}

/** 拽引/取位临时量（避免每帧分配） */
const PULL_TMP = new THREE.Vector3();
const AURA_TMP = new THREE.Vector3();
