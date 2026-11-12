/** Boss #8「碎星拉塔恩」（艾尔登法环·盖利德红星，同人改编）：8 Boss 线墓地深处守关者（cemetery:D 碎星战场）
  * 通用机制（状态机/削韧破绽/弹反/多段判定/冷却/走近追踪/阶段转换）全在 BossBase（boss-base.ts），
  * 本文件只保留拉塔恩专属：MOVES_RADAHN/FEEL_RADAHN 模块加载即并入 config 总表（调校台/存档自动收录，不改现有文件）。
 * 视觉纪律（与既有 Boss 不同）：纯几何 + 顶点色 mergeGeometries 合批——本体十余 mesh + 1 粒子 Points，无 PointLight、无贴图；
 * 原作身量（褪色者按 1.8）：脚到盔顶 8.1、算上红发 11.7。肩极宽、胸厚，头夹在肩甲之间，腿分出大腿和小腿。
 * 双碎星大剑与碎星大弓随这具身子放大；弓仍是一件合批，只在射箭时显形。
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
import { BossBase, BossStats, clamp01, smooth, seg, pickWeighted as pickByWeight } from "./boss-base";
import type { AttackVolume, BossHost } from "./boss-base";
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
/** 旧方块网格在站立姿态下脚到盔顶 4.1108 米（发梢只到 4.35，没有披到原作的 11.7）。盔顶按原作收到 8.1。 */
const FORM_SCALE = 8.1 / 4.1108;
/** 旧刃握点到尖 2.67，方块刃约 3.92。刀光半径跟着放大后的刃走；打中与否仍看钉在握柄和剑尖上的标记。 */
const SWORD_VIS_SCALE = (3.92 / 2.67) * FORM_SCALE;
/** 发簇本地、乘 FORM_SCALE 之前的鬃尖。站立网格量过后再抬，使发梢世界高度落到 11.7。 */
const MANE_TIP = 2.10;

/** 投射物参数（发射走 host.fireProjectile，飞行/命中/消散由 game 侧 Projectiles 池负责）
 *  命中高度带 0.15–1.85（projectile.ts）：狙击箭平飞 1.8 全程在带内；岩/箭雨自高处抛落，入带段=威胁距离带 */
const ROCK_PROJ: ProjDef = { speed: 9, radius: 0.55, dmg: 18, feelKey: "rMagic", life: 2.2, color: GRAVITY_DEEP, drop: 1.4 };   // 自 2.2m 高抛落：威胁带 ~4.5–14.7m
const ARROW_PROJ: ProjDef = { speed: 17, radius: 0.35, dmg: 20, feelKey: "rMagic", life: 2.0, color: GRAVITY_GLOW };            // 碎星巨箭：平飞高速
const RAIN_PROJ: ProjDef = { speed: 8.5, radius: 0.4, dmg: 12, feelKey: "rMagic", life: 1.4, color: GRAVITY_GLOW, drop: 2.8 };  // 自 3.0m 高坠落：威胁带 ~5–8.5m
const WAVE_PROJ: ProjDef = { speed: 7.5, radius: 0.85, dmg: 18, feelKey: "rWave", life: 2.4, color: GRAVITY };                  // 地面行波：0.7m 平推全场
/** 箭雨扇面：步距 0.32rad，入带（约 8–9m）圆心距 ≈2.7m，大于命中直径 1.7m，缝里能走 */
const RAIN_SPREAD = [-0.64, -0.32, 0, 0.32, 0.64];

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
  // 陨石回归（Meteor Crash）：出手即锁定落点并铺紫尘 → 升空 → 判定帧贴地砸在同一点（lunge 12；跑位可躲）
  // + 紫色巨冲击波 + 击飞（knockUp 3）；落地大硬直 1.6s＝最大惩罚窗口
  radahnMeteor: {
    name: "radahnMeteor", label: "陨石回归", startup: 1.15, active: 0.22, recovery: 1.6,
    dmg: 34, range: 4.8, arc: 2.6, lunge: 12, knockUp: 3,
    parryable: false, cd: 9.0, phase2Only: true, feel: "rHeavy",
  },
  // 碎星箭雨（Arrow Rain·扇形射弹）：5 矢扇面 ±0.64rad、步距 0.32（入带处圆心距 > 命中直径，缝可走）
  // 前摇举臂停住再撒矢——伤害是飞行物，不是前摇本身
  radahnArrowRain: {
    name: "radahnArrowRain", label: "碎星箭雨", startup: 1.05, active: 0.2, recovery: 1.1,
    dmg: 12, range: 0.2, arc: 0.9, proj: { speed: 8.5, radius: 0.4, life: 1.4 },
    parryable: false, cd: 8.0, phase2Only: true, feel: "rMagic",
  },
  // 重力波（Gravity Wave·地面行波）：双剑砸地放出一行波（大半径慢速平推，0.7m 高全程在命中带）
  // 前摇先在地面铺出路径紫尘，砸地帧才发射
  radahnGravityWave: {
    name: "radahnGravityWave", label: "重力波", startup: 1.05, active: 0.25, recovery: 1.0,
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

/** 阶段数值基线快照（含二阶段专属招——还原时整表写回，避免只还了一阶段招、专属招的运行时改动留下） */
const P1_BASE: Record<string, { startup: number; dmg: number }> = {};
for (const m of Object.values(MOVES_RADAHN)) P1_BASE[m.name] = { startup: m.startup, dmg: m.dmg };
const BASE_WALK = RADAHN_STATS.walkSpeed;
const BASE_TURN = RADAHN_STATS.turnRate;
const ENRAGE_AT = 0.18;                 // 濒死狂暴线（wiki：低血量显著加速）

// ---------------- 顶点色几何工具（同 scene-cemetery：非索引化 + 每面微扰 + merge 合批） ----------------
let seed = 20261112;
const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;

interface GOpt { rx?: number; ry?: number; rz?: number; jitter?: number; seg?: number }

const sc = (n: number): number => n * FORM_SCALE;

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

/** 圆台：+Y 为顶半径。肢体用它，避免再堆方块。 */
function cylG(rt: number, rb: number, h: number, x: number, y: number, z: number, color: number, opt: GOpt = {}): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(Math.max(0.012, rt), Math.max(0.012, rb), h, opt.seg ?? 8);
  if (opt.rx) g.rotateX(opt.rx);
  if (opt.ry) g.rotateY(opt.ry);
  if (opt.rz) g.rotateZ(opt.rz);
  g.translate(x, y, z);
  return paint(g, color, opt.jitter ?? 0);
}

/** 椭球。sx/sy/sz 是相对半径的比例，不跟 FORM_SCALE 再乘一次。 */
function sphG(r: number, x: number, y: number, z: number, color: number, sx = 1, sy = 1, sz = 1, opt: GOpt = {}): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, opt.seg ?? 8, 6);
  g.scale(sx, sy, sz);
  if (opt.rx) g.rotateX(opt.rx);
  if (opt.ry) g.rotateY(opt.ry);
  if (opt.rz) g.rotateZ(opt.rz);
  g.translate(x, y, z);
  return paint(g, color, opt.jitter ?? 0);
}

const LIMB_UP = new THREE.Vector3(0, 1, 0);
const LIMB_DIR = new THREE.Vector3();
const LIMB_Q = new THREE.Quaternion();
const LIMB_M = new THREE.Matrix4();

/** 两端收口的一绺：r0 在起点，r1 在终点。头发和弓臂都走这里，仍并进所属的那一个 Mesh。 */
function limbG(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r0: number, r1: number, color: number, jitter = 0): THREE.BufferGeometry {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.max(0.04, Math.hypot(dx, dy, dz));
  const g = new THREE.CylinderGeometry(Math.max(0.012, r1), Math.max(0.012, r0), len, 6);
  LIMB_DIR.set(dx, dy, dz).multiplyScalar(1 / len);
  LIMB_Q.setFromUnitVectors(LIMB_UP, LIMB_DIR);
  LIMB_M.makeRotationFromQuaternion(LIMB_Q);
  LIMB_M.setPosition((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
  g.applyMatrix4(LIMB_M);
  return paint(g, color, jitter);
}

/** 弓臂/弓梢/弦的一段：沿两点收成圆棍，两端各搭出一截，弯折处不裂开。 */
function spanG(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, thick: number, color: number): THREE.BufferGeometry {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.max(1e-4, Math.hypot(dx, dy, dz));
  const overlap = Math.min(sc(0.06), thick * 0.85) * 0.5;
  const ux = dx / len, uy = dy / len, uz = dz / len;
  const r = thick * 0.5;
  return limbG(x0 - ux * overlap, y0 - uy * overlap, z0 - uz * overlap, x1 + ux * overlap, y1 + uy * overlap, z1 + uz * overlap, r, r, color);
}

/** 反曲中线。t=0 握把上端，t=1 弓梢。X 外鼓后收回（正面的弧），Y 弓腹在前、梢回到弦侧，Z 朝上。尺寸跟身子走。 */
function bowLimbPoint(t: number, sign: 1 | -1): [number, number, number] {
  const z = sign * (0.24 + t * 1.46);
  const bulge = Math.sin(Math.PI * t) * (1 - t * 0.12) ** 1.1;
  const x = -1.08 * bulge + 0.18 * t * t;
  const y = -0.30 * bulge + 0.26 * t * t;
  return [sc(x), sc(y), sc(z)];
}

/** 合批建部件 Mesh：merge 后释放源几何（一件关节 = 1 draw call） */
function part(geoms: THREE.BufferGeometry[], mat: THREE.Material, shadow = true): THREE.Mesh {
  const merged = mergeGeometries(geoms, false)!;
  for (const g of geoms) g.dispose();
  const m = new THREE.Mesh(merged, mat);
  m.castShadow = shadow;
  return m;
}

// ---------------- 姿态（Pose）：双剑臂各自 lift/swing（同沙力万双持范式）。大腿、小腿分开，蹲伏时膝向前折 ----------------
interface Pose {
  y: number; lean: number; twist: number; crouch: number; reach: number;
  rLift: number; rSwing: number;   // 右剑臂：lift 正=前甩 负=上举；swing 正=向左抡
  lLift: number; lSwing: number;   // 左剑臂（镜像）
  nod: number;                     // 头部俯仰（正=低头）
  spin: number;                    // 整体附加旋转（拖剑旋风整圈）
}
const STANCE: Pose = { y: 0, lean: 0.12, twist: -0.06, crouch: 0.04, reach: 0, rLift: 0.26, rSwing: 0, lLift: 0.26, lSwing: 0, nod: 0.1, spin: 0 };
const STATUE: Pose = { ...STANCE, lean: 0.3, crouch: 0.16, y: -0.1, nod: 0.55, rLift: 0.5, rSwing: 0.05, lLift: 0.5, lSwing: -0.05 };   // 双剑前拄垂首伫立
// 交叉斩：双剑大开 → 交错剪过两拍（与判定 0.30/0.65 对齐，时间比例不动）
// swing 同号才是真正的镜像开合；异号会让两条臂同向滚，两剑并成一块
const XW: Pose = { ...STANCE, twist: 0.02, rLift: 0.2, lLift: 0.2, rSwing: -1.2, lSwing: -1.2, lean: -0.12, crouch: 0.05 };
const X1: Pose = { ...STANCE, twist: -0.1, rLift: 0.88, lLift: 0.42, rSwing: 1.5, lSwing: 1.5, lean: 0.26, crouch: 0.1, reach: 0.08 };
const X2: Pose = { ...STANCE, twist: -0.18, rLift: 1.05, lLift: 0.7, rSwing: 1.7, lSwing: 1.7, lean: 0.4, crouch: 0.16, reach: 0.2 };
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
  private shinR = new THREE.Group();
  private shinL = new THREE.Group();
  private armR = new THREE.Group();
  private swordR = { hilt: new THREE.Object3D(), tip: new THREE.Object3D() };
  private swordL = { hilt: new THREE.Object3D(), tip: new THREE.Object3D() };
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
  private aimYaw = 0;                              // 出手时锁定的瞄准（飞行物不再跟到出手帧）
  private impact = new THREE.Vector3();            // 战斗内陨石落点（与 root / 冲击环同一点）
  private impactLive = false;
  private volleyFired = false;                     // 箭雨/重力波/巨箭：一招只发射一次
  private lastPick = "";                           // 同招连续降权（权重仍 > 0，远档不会选空）

  constructor(scene: THREE.Scene, vfx: Vfx, pos: THREE.Vector3, host: BossHost, facing = -Math.PI / 2) {
    super(scene, vfx, pos, host, RADAHN_STATS, facing);
    this.gravDust = new Particles(scene, 160, { size: 0.06, color: GRAVITY, additive: true, gravity: -0.12 });
    this.transformHitAt = 2.0;    // 升空 0.55–1.1 → 高空锁点横移 1.1–1.75 → 坠落 1.75–2.0 → 2.0s 陨石砸地冲击波
    this.transformDur = 2.7;
    this.assemble();
  }

  // ---------------- 外观：盔顶 8.1 / 发梢 11.7（褪色者按 1.8）。肩极宽，头夹在肩甲之间 ----------------
  // 腿、躯干、头、发、臂各合批；膝单独一件才能弯。双剑、弓随 FORM_SCALE 放大。无贴图、无 PointLight。
  protected override buildBody(): void {
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.9, metalness: 0.15, flatShading: true });
    this.swordMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.4, metalness: 0.55, flatShading: true,
      emissive: GRAVITY, emissiveIntensity: 0.25,
    });
    this.eyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    this.bowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const cyl = (rt: number, rb: number, h: number, x: number, y: number, z: number, color: number, opt: GOpt = {}) =>
      cylG(sc(rt), sc(rb), sc(h), sc(x), sc(y), sc(z), color, opt);
    const egg = (r: number, x: number, y: number, z: number, color: number, sx = 1, sy = 1, sz = 1, opt: GOpt = {}) =>
      sphG(sc(r), sc(x), sc(y), sc(z), color, sx, sy, sz, opt);
    const lock = (a: [number, number, number], b: [number, number, number], r0: number, r1: number, color: number) =>
      limbG(sc(a[0]), sc(a[1]), sc(a[2]), sc(b[0]), sc(b[1]), sc(b[2]), sc(r0), sc(r1), color, 0.1);

    // 髋仍在旧枢轴乘 FORM_SCALE 的高度上，脚底才和放大前一样贴地。大腿粗、膝圆、小腿收细。
    for (const [leg, shin, sx] of [[this.legR, this.shinR, 0.5], [this.legL, this.shinL, -0.5]] as [THREE.Group, THREE.Group, number][]) {
      leg.name = "radahnLeg";
      leg.position.set(sc(sx), sc(1.95), 0);
      leg.add(part([
        cyl(0.34, 0.22, 1.02, 0, -0.52, 0.01, IRON, { jitter: 0.06 }),                 // 大腿，上粗下收到膝
        egg(0.27, 0, -1.06, 0.03, IRON_DARK, 1.08, 0.82, 1.12),                        // 膝
      ], bodyMat));
      shin.position.set(0, sc(-1.08), sc(0.04));
      shin.add(part([
        cyl(0.17, 0.12, 0.72, 0, -0.36, 0.01, IRON_DARK, { jitter: 0.05 }),            // 小腿，比大腿细一圈
        egg(0.2, 0, -0.77, 0.16, IRON, 1.15, 0.42, 2.05),                              // 足，扁而长，脚底贴地
      ], bodyMat));
      leg.add(shin);
      this.body.add(leg);
    }

    // 躯干一件：厚胸、窄颈，肩甲高到耳侧，把头夹在中间。
    this.torso.position.y = sc(2.0);
    this.torso.add(part([
      egg(0.48, 0, -0.05, 0, IRON_DARK, 1.18, 0.5, 0.98),                               // 骨盆
      cyl(0.64, 0.68, 0.1, 0, 0.14, 0.04, GOLD_TRIM),                                   // 束带
      cyl(0.11, 0.045, 0.5, 0.3, -0.32, 0.3, IRON_DARK, { rx: 0.42, rz: 0.22 }),        // 战裙，收成尖
      cyl(0.11, 0.045, 0.5, -0.3, -0.32, 0.3, IRON_DARK, { rx: 0.42, rz: -0.22 }),
      cyl(0.09, 0.04, 0.42, 0, -0.28, 0.38, IRON_DARK, { rx: 0.22 }),
      egg(0.52, 0, 0.4, 0.06, IRON, 1.28, 0.7, 1.18, { jitter: 0.04 }),                 // 腹
      egg(0.66, 0, 0.96, 0.1, IRON, 1.38, 0.84, 1.24, { jitter: 0.05 }),                // 胸，又宽又厚
      egg(0.34, 0, 1.4, 0.04, IRON, 1.02, 0.52, 0.92),                                  // 上胸收到颈
      egg(0.48, 0, 0.82, -0.5, IRON_DARK, 1.22, 0.98, 0.6),                             // 背甲
      cyl(0.15, 0.2, 0.36, 0, 1.55, 0.1, SKIN),                                         // 颈
      egg(0.58, 1.12, 1.32, 0.02, IRON, 1.2, 0.72, 0.95, { jitter: 0.05 }),             // 右肩甲，把头夹在中间，顶低于盔
      egg(0.16, 1.48, 1.38, 0.1, GOLD_TRIM, 1, 0.55, 0.75),
      egg(0.58, -1.12, 1.32, 0.02, IRON, 1.2, 0.72, 0.95, { jitter: 0.05 }),            // 左肩甲
      egg(0.16, -1.48, 1.38, 0.1, GOLD_TRIM, 1, 0.55, 0.75),
      cyl(0.12, 0.12, 0.05, 0, 1.0, 0.94, GOLD_TRIM, { rx: Math.PI / 2 }),              // 胸口纹章
    ], bodyMat));

    // 头夹在两肩之间：盔顶是这具身子的 8.1 米，不是肩甲。
    this.head.name = "radahnHead";
    this.head.position.set(0, sc(1.526), sc(0.1));
    const headMesh = part([
      cyl(0.15, 0.18, 0.22, 0, -0.12, 0, SKIN),                                         // 颈
      egg(0.22, 0, 0.0, 0.1, SKIN, 1.02, 1.08, 0.96, { jitter: 0.06 }),                 // 面，探出盔缘
      egg(0.16, 0, -0.12, 0.08, SKIN, 1.05, 0.62, 0.9),                                 // 颌
      egg(0.34, 0, 0.16, -0.1, IRON, 1.08, 1.08, 1.02, { jitter: 0.05 }),               // 残盔，顶就是头顶
      egg(0.1, 0.24, -0.02, 0.06, IRON_DARK, 0.7, 1.15, 1.1),                           // 颊甲
      egg(0.1, -0.24, -0.02, 0.06, IRON_DARK, 0.7, 1.15, 1.1),
      limbG(sc(0), sc(0.28), sc(-0.02), sc(0.1), sc(0.5), sc(0.02), sc(0.08), sc(0.02), IRON_DARK, 0.08),
      limbG(sc(0), sc(0.26), sc(-0.04), sc(-0.12), sc(0.46), sc(-0.02), sc(0.07), sc(0.02), IRON_DARK, 0.08),
      limbG(sc(0), sc(0.3), sc(0.02), sc(0), sc(0.52), sc(0.06), sc(0.06), sc(0.015), GOLD_TRIM, 0.06),
    ], bodyMat);
    headMesh.name = "radahnHeadMesh";
    this.head.add(headMesh);
    // 双瞳（重力紫辉·加色，一件 = 1 mesh，无阴影）
    this.head.add(part([
      sphG(sc(0.045), sc(0.09), sc(0.08), sc(0.33), GRAVITY_GLOW, 1.15, 0.7, 0.55),
      sphG(sc(0.045), sc(-0.09), sc(0.08), sc(0.33), GRAVITY_GLOW, 1.15, 0.7, 0.55),
    ], this.eyeMat, false));

    // 红鬃一件：向上披到 11.7，也顺着背披下来。
    this.hairG.name = "radahnHair";
    this.hairG.position.set(0, sc(0.22), sc(-0.08));
    const tip = MANE_TIP;
    const hairMesh = part([
      lock([0, 0.02, 0], [0.02, tip * 0.52, -0.22], 0.28, 0.14, HAIR),
      lock([0.02, tip * 0.52, -0.22], [0.06, tip, -0.62], 0.14, 0.03, HAIR),
      lock([-0.16, 0.0, 0.02], [-0.4, tip * 0.74, -0.48], 0.16, 0.035, HAIR_DARK),
      lock([0.18, 0.0, 0.02], [0.46, tip * 0.7, -0.44], 0.15, 0.03, HAIR),
      lock([0, -0.02, -0.04], [0.04, -0.72, -0.3], 0.2, 0.09, HAIR),                    // 后披
      lock([0.04, -0.72, -0.3], [0, -1.6, -0.38], 0.09, 0.025, HAIR_DARK),
      lock([-0.16, -0.04, -0.02], [-0.28, -1.2, -0.24], 0.12, 0.025, HAIR_DARK),
      lock([0.18, -0.04, 0], [0.34, -1.1, -0.18], 0.11, 0.025, HAIR),
      lock([0.24, 0.0, 0.06], [0.7, -0.62, 0.12], 0.1, 0.025, HAIR),                    // 搭上肩甲
      lock([-0.24, 0.0, 0.06], [-0.7, -0.62, 0.12], 0.1, 0.025, HAIR),
    ], bodyMat);
    hairMesh.name = "radahnHairMesh";
    this.hairG.add(hairMesh);
    this.head.add(this.hairG);
    this.torso.add(this.head);

    // 双臂 + 碎星大剑（一臂一剑各一件，仍各 1 mesh）：宽刃前下曳，垂剑时剑尖贴地。
    // 剑格宽于刃、剑尖单独收锋；左右外张并前后错开，避免并成一块。
    const buildSword = (side: 1 | -1): THREE.Group => {
      const g = new THREE.Group();
      const x = (n: number) => side * n;
      const b = (w: number, h: number, d: number, px: number, py: number, pz: number, color: number, opt: GOpt = {}) =>
        boxG(sc(w), sc(h), sc(d), sc(px), sc(py), sc(pz), color, opt);
      g.position.set(x(sc(0.02)), sc(-1.24), sc(0.12) + x(sc(0.05)));
      g.rotation.set(-1.08, x(0.38), x(0.2));           // 负俯仰＝剑尖朝前下方；偏航/滚转把两刃撑开
      g.add(part([
        b(0.2, 0.16, 0.2, 0, 0.28, 0, GOLD_TRIM),                                   // 柄头
        b(0.12, 0.36, 0.12, 0, 0.02, 0, IRON_DARK),                                 // 柄
        b(1.18, 0.16, 0.28, 0, -0.26, 0, GOLD_TRIM),                                // 剑格（明显宽于刃）
        b(0.14, 0.28, 0.16, x(0.52), -0.08, 0, GOLD_TRIM, { rz: x(-0.6) }),         // 格端上翘
        b(0.12, 0.22, 0.14, x(-0.5), -0.1, 0, IRON, { rz: x(0.45) }),
        b(0.2, 0.24, 0.1, 0, -0.48, 0, IRON_DARK),                                  // 剑颈，隔开剑格和宽刃
        b(0.88, 1.45, 0.1, x(0.05), -1.4, 0, STEEL, { jitter: 0.05, rz: x(0.03) }), // 宽刃上段
        b(0.14, 1.3, 0.04, x(0.05), -1.38, 0.055, IRON_DARK),                       // 血槽
        b(0.14, 1.3, 0.04, x(0.05), -1.38, -0.055, IRON_DARK),
        b(0.68, 1.2, 0.09, x(0.16), -2.55, 0, STEEL, { jitter: 0.05, rz: x(0.08) }), // 宽刃下段，向外弯
        b(0.94, 1.35, 0.02, x(0.05), -1.36, 0.07, GRAVITY_GLOW),                    // 剑缘紫辉（emissive × 顶点色）
        b(0.94, 1.35, 0.02, x(0.05), -1.36, -0.07, GRAVITY_GLOW),
        b(0.74, 1.1, 0.018, x(0.16), -2.52, 0.06, GRAVITY),
        b(0.74, 1.1, 0.018, x(0.16), -2.52, -0.06, GRAVITY),
        b(0.26, 0.5, 0.06, x(0.24), -3.35, 0.01, STEEL, { rz: x(0.1) }),           // 剑尖收窄
        b(0.12, 0.34, 0.04, x(0.28), -3.74, 0.01, STEEL, { rz: x(0.12) }),         // 尖锋，和宽刃断开一截
        b(0.16, 0.42, 0.016, x(0.25), -3.32, 0.045, GRAVITY_GLOW, { rz: x(0.1) }),
        b(0.16, 0.42, 0.016, x(0.25), -3.32, -0.02, GRAVITY_GLOW, { rz: x(0.1) }),
      ], this.swordMat));
      const mark = side === 1 ? this.swordR : this.swordL;
      mark.hilt.position.set(0, sc(0.02), 0);             // 握柄中段
      // 尖锋那只盒子先绕 Z 再平移，标记钉在转完之后的下角，不钉在盒子中心
      const corner = new THREE.Vector3(x(-0.06), -0.17, 0);
      corner.applyAxisAngle(new THREE.Vector3(0, 0, 1), x(0.12));
      mark.tip.position.set(sc(x(0.28) + corner.x), sc(-3.74 + corner.y), sc(0.01));
      g.add(mark.hilt, mark.tip);
      return g;
    };
    const armGeoms = () => [
      cyl(0.26, 0.17, 0.68, 0, -0.36, 0, IRON, { jitter: 0.05 }),                      // 上臂，肩粗肘细
      egg(0.19, 0, -0.7, 0.02, IRON_DARK, 1.05, 0.75, 1.05),                           // 肘
      cyl(0.15, 0.12, 0.48, 0, -0.98, 0.03, IRON_DARK, { jitter: 0.05 }),              // 前臂
      egg(0.19, 0, -1.24, 0.06, IRON, 1.2, 0.68, 1.15),                                // 铁手套
    ];
    this.armR.position.set(sc(1.22), sc(1.14), sc(0.04));
    this.armR.add(part(armGeoms(), bodyMat));
    this.armR.add(buildSword(1));
    this.torso.add(this.armR);
    this.armL.position.set(sc(-1.22), sc(1.14), sc(0.04));
    this.armL.add(part(armGeoms(), bodyMat));
    this.armL.add(buildSword(-1));
    this.torso.add(this.armL);

    // 召唤碎星大弓（仍只在射箭时显形；反曲弓臂 + 弓梢 + 满弦，一件顶点色合批，无阴影）
    // 左臂本地：拉弓时 +Z 朝上、+X 朝身侧、+Y 朝射手。弓臂向 -X 鼓出，弦拉向身侧。尺寸跟身子走。
    this.bow.position.set(sc(-0.18), sc(-1.4), sc(0.05));
    const bowN = 10;
    const bowGeoms: THREE.BufferGeometry[] = [];
    for (let i = 0; i < bowN - 1; i++) {
      const t0 = i / (bowN - 1);
      const t1 = (i + 1) / (bowN - 1);
      const thick = sc(0.16 - ((t0 + t1) * 0.5) * 0.08);
      for (const sign of [1, -1] as const) {
        const a = bowLimbPoint(t0, sign);
        const b = bowLimbPoint(t1, sign);
        bowGeoms.push(spanG(a[0], a[1], a[2], b[0], b[1], b[2], thick, GRAVITY_GLOW));
      }
    }
    const upTip = bowLimbPoint(1, 1);
    const loTip = bowLimbPoint(1, -1);
    const upHorn: [number, number, number] = [upTip[0] + sc(0.12), upTip[1] + sc(0.22), upTip[2] + sc(0.16)];
    const loHorn: [number, number, number] = [upHorn[0], upHorn[1], -upHorn[2]];
    const nock: [number, number, number] = [sc(1.0), sc(0.55), 0];
    bowGeoms.push(
      spanG(upTip[0], upTip[1], upTip[2], upHorn[0], upHorn[1], upHorn[2], sc(0.05), GRAVITY_GLOW), // 上弓梢，探过弦槽
      spanG(loTip[0], loTip[1], loTip[2], loHorn[0], loHorn[1], loHorn[2], sc(0.05), GRAVITY_GLOW),
      spanG(upTip[0], upTip[1], upTip[2], nock[0], nock[1], nock[2], sc(0.05), GRAVITY),             // 满弦：两梢拉到身侧一点
      spanG(nock[0], nock[1], nock[2], loTip[0], loTip[1], loTip[2], sc(0.05), GRAVITY),
      sphG(sc(0.05), nock[0], nock[1], nock[2], GRAVITY),                                             // 拉弦点
      cylG(sc(0.09), sc(0.09), sc(0.68), 0, sc(-0.04), 0, GRAVITY_GLOW, { rx: Math.PI / 2 }),        // 握把（长轴沿 Z）
      cylG(sc(0.11), sc(0.11), sc(0.16), 0, sc(-0.04), 0, GRAVITY, { rx: Math.PI / 2 }),             // 缠把
      cylG(sc(0.03), sc(0.03), sc(0.26), sc(0.2), sc(0.02), sc(0.03), GRAVITY_GLOW, { rz: Math.PI / 2 }), // 箭台，朝弦
    );
    this.bow.add(part(bowGeoms, this.bowMat, false));
    this.bow.visible = false;
    this.armL.add(this.bow);

    this.root.add(this.body);
    this.body.add(this.torso);
  }

  protected override chestPart(): THREE.Object3D { return this.torso; }

  /** 挥砍贴着剑。三连先右、再左、最后两把一起。拉动和陨石是身边的圆。箭、岩石、重力波只算飞行物。 */
  protected override attackVolume(m: MoveDef): AttackVolume | null {
    const right = { hilt: this.swordR.hilt, tip: this.swordR.tip, pad: 0.45 };
    const left = { hilt: this.swordL.hilt, tip: this.swordL.tip, pad: 0.45 };
    const both: AttackVolume = { kind: "blade", ...right, also: [left] };
    if (m.name === "radahnCross" || m.name === "radahnVortex") return both;
    if (m.name === "radahnTriple") {
      if (this.hitFired <= 0) return { kind: "blade", ...right };
      if (this.hitFired === 1) return { kind: "blade", ...left };
      return both;
    }
    if (m.name === "radahnPull" || m.name === "radahnMeteor") {
      return { kind: "disk", x: this.root.position.x, z: this.root.position.z, r: m.range };
    }
    if (m.proj) return { kind: "none" };
    return null;
  }
  protected override headPart(): THREE.Object3D { return this.head; }

  // ---------------- 姿态应用 ----------------
  protected override applyPose(): void {
    const p = this.pose;
    this.root.rotation.y = this.yaw + p.spin;
    this.body.position.set(0, p.y - p.crouch * 0.34, p.reach);
    this.torso.rotation.set(p.lean, p.twist, 0);
    this.head.rotation.x = p.nod;
    this.armR.rotation.set(-p.rLift, 0, -p.rSwing);
    this.armL.rotation.set(-p.lLift, 0, p.lSwing);         // 与右臂镜像；额外偏航会把两剑拧到同一侧
    this.legR.rotation.x = -p.crouch * 0.5;                // 大腿前折
    this.legL.rotation.x = -p.crouch * 0.38;
    this.shinR.rotation.x = p.crouch * 0.92;               // 小腿折回，脚还落在身下
    this.shinL.rotation.x = p.crouch * 0.74;
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
    // 硬顶 2 发：movePose 每帧都会进来，计数器是唯一闸门
    if (m.name === "radahnRocks" && sub !== "tel") {
      const ta = sub === "act" ? t : t + m.active;
      while (this.rockFired < 2 && ta >= this.rockFired * 0.55) this.fireRock(this.rockFired);
    }
    // 重力拽引（wiki Gravity Pull）：tel 段缓吸 / act 段猛拽——直接写回玩家位置（update 传入活引用），顿帧 dt=0 冻结
    // 方向：玩家 → Boss（toB = boss - player）。不要改成推开。
    if (m.name === "radahnPull") {
      if (sub === "tel" && t > m.startup * 0.35) this.pullPlayer(2.2, 3.2);
      else if (sub === "act") this.pullPlayer(6.0, 2.7);
    }
    // 拖剑旋风：tel 段持续吸引（自身为心的重力井）
    if (m.name === "radahnVortex" && sub === "tel" && t > 0.25) this.pullPlayer(3.2, 3.4);
    // 陨石回归（战斗内复用）：落点紫尘贯穿前摇 → 升空压顶 → 判定帧贴地（与命中同一点）→ 落地跪伏
    if (m.name === "radahnMeteor") {
      if (sub === "tel" && this.impactLive) this.markPoint(this.impact, 0.85);
      if (sub === "tel") {
        if (t < m.startup * 0.35) { this.lerpPose(STANCE, MW, smooth(t / (m.startup * 0.35))); return; }
        const k = clamp01((t - m.startup * 0.35) / (m.startup * 0.65));
        const posK = t >= m.startup ? 1 : smooth(k);
        this.root.position.copy(this.moveFrom).addScaledVector(this.moveDir, this.moveLen * posK);
        this.root.position.y = 0;
        this.lerpPose(MW, MUP, smooth(k));
        this.pose.y = Math.sin(Math.min(1, k) * Math.PI / 2) * 5.5;                   // 升至顶点后悬停（须在 lerp 之后）
        if (Math.random() < 0.55) this.gravDust.burst(this.root.position.clone().setY(0.5 + Math.random() * 2), 2, 2.2, 0.8, 0.3);
        if (this.impactLive) this.orbitMark(this.impact, 3.2);
        return;
      }
      if (sub === "act") {
        // 基类首段判定在 active*0.4。坠落必须在这一帧贴地，冲击环打在同一个 root 上
        const hitAt = Math.max(0.04, m.active * 0.4);
        const k = clamp01(t / hitAt);
        const fall = k * k;
        this.lerpPose(MUP, MDIVE, k);
        this.pose.y = 5.5 * (1 - fall);
        if (k >= 1) {
          const land = clamp01((t - hitAt) / Math.max(0.01, m.active - hitAt));
          this.lerpPose(MDIVE, MLAND, land);
          this.pose.y = MLAND.y * land;
        }
        if (this.impactLive) {
          this.root.position.copy(this.impact);
          this.root.position.y = 0;
        }
        this.meteorFx(t, hitAt);
        return;
      }
      this.lerpPose(MLAND, STANCE, smooth(seg(t, m.recovery * 0.25, m.recovery)));     // 落地大硬直（惩罚窗口）
      return;
    }
    if (m.name === "radahnArrowRain" || m.name === "radahnGravityWave") {
      this.rangedTellPose(m, sub, t, m.name === "radahnArrowRain" ? AW : WW, m.name === "radahnArrowRain" ? AK : WK);
      return;
    }
    const wind: Pose = { ...STANCE }, strike: Pose = { ...STANCE };
    switch (m.name) {
      case "radahnVortex": Object.assign(wind, VW); Object.assign(strike, VK); break;
      case "radahnPull":   Object.assign(wind, PW); Object.assign(strike, PK); break;
      case "radahnRocks":  Object.assign(wind, RW); Object.assign(strike, RK); break;
      case "radahnSnipe":  Object.assign(wind, SW); Object.assign(strike, SK); break;
    }
    if (sub === "tel") {
      // 岩石/巨箭从第一帧就进入举臂，不再把前摇的前半段留在待机姿态
      const hold = m.name === "radahnRocks" || m.name === "radahnSnipe";
      const k = hold ? smooth(clamp01(t / (m.startup * 0.62))) : smooth(seg(t, m.startup * 0.45, m.startup));
      this.lerpPose(STANCE, wind, k);
      if (hold) this.previewAimLine(t, m.name === "radahnSnipe" ? 1.6 : 1.3);
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

  /** 箭雨/重力波：前 70% 把姿态收到蓄力并停住，出手帧才切到挥出。紫尘只预告，不发射 */
  private rangedTellPose(m: MoveDef, sub: string, t: number, wind: Pose, strike: Pose): void {
    if (sub === "tel") {
      const k = clamp01(t / (m.startup * 0.7));
      this.lerpPose(STANCE, wind, k * k);                                          // ease-in：蓄力先慢后实
      if (m.name === "radahnArrowRain") this.previewRain(t);
      else this.previewWave(t);
      return;
    }
    if (sub === "act") {
      this.lerpPose(wind, strike, seg(t, 0, m.active));
      return;
    }
    this.lerpPose(strike, STANCE, smooth(seg(t, m.recovery * 0.35, m.recovery)));
  }

  /** 落点紫尘（概率闸，避免每帧灌满粒子池）。不新建网格 */
  private markPoint(p: THREE.Vector3, chance: number): void {
    if (Math.random() > chance) return;
    this.gravDust.burst(MARK_TMP.copy(p).setY(0.18), 2, 1.5, 0.42, 0.18);
  }

  /** 箭雨车道：与发射扇面同一组偏航，先看见缝再看见箭 */
  private previewRain(t: number): void {
    const step = Math.floor(t * 7) % RAIN_SPREAD.length;
    const off = RAIN_SPREAD[step];
    const d = 5.5;
    MARK_TMP.set(
      this.root.position.x + Math.sin(this.aimYaw + off) * d,
      2.2,
      this.root.position.z + Math.cos(this.aimYaw + off) * d,
    );
    this.gravDust.burst(MARK_TMP, 2, 0.45, 0.32, 0.12);
    if (Math.random() < 0.45) this.gravDust.burst(this.chestWorld().setY(2.8), 1, 0.7, 0.3, 0.4);
  }

  /** 重力波路径：沿锁定朝向在地面点出一条线 */
  private previewWave(t: number): void {
    const step = Math.floor(t * 6) % 5;
    const d = 1.8 + step * 1.35;
    MARK_TMP.set(
      this.root.position.x + Math.sin(this.aimYaw) * d,
      0.2,
      this.root.position.z + Math.cos(this.aimYaw) * d,
    );
    this.gravDust.burst(MARK_TMP, 2, 0.55, 0.34, 0.12);
  }

  /** 巨箭瞄准线：弓前一串紫尘，方向与锁定 yaw 相同 */
  private previewAimLine(t: number, y: number): void {
    const step = Math.floor(t * 8) % 4;
    const d = 1.2 + step * 1.1;
    MARK_TMP.set(
      this.root.position.x + Math.sin(this.aimYaw) * d,
      y,
      this.root.position.z + Math.cos(this.aimYaw) * d,
    );
    this.gravDust.burst(MARK_TMP, 1, 0.35, 0.28, 0.1);
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

  /** 陨石落点表现：冲击环/焦斑打在锁定落点（与 root 重合），时刻对齐判定帧。打中或躲开都砸坑 */
  private meteorFx(t: number, hitAt: number): void {
    if (this.fxStep !== 0 || t < hitAt) return;
    this.fxStep = 1;
    const at = this.impactLive ? this.impact : this.root.position;
    this.vfx.ring(at, 6.0, GRAVITY);
    this.vfx.scorch(at, 3.0, GRAVITY_DEEP);
    this.vfx.dust.burst(MARK_TMP.copy(at).setY(0.3), 16, 3.4, 0.8);
    this.gravDust.burst(MARK_TMP.copy(at).setY(1.2), 22, 4.2, 1.2, 0.6);
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
    if (this.state === "combat" && this.sub === "tel" && this.move &&
      (this.move.name === "radahnArrowRain" || this.move.name === "radahnGravityWave" || this.move.name === "radahnMeteor" || this.move.name === "radahnSnipe")) {
      this.swordMat.emissiveIntensity += 0.9 * clamp01(this.t / Math.max(0.01, this.move.startup));
    }
    // 挥剑前摇同样在 startup 里渐亮，时间式不改，只把双剑招的增益加大
    if (this.state === "combat" && this.sub === "tel" && this.move &&
      (this.move.name === "radahnCross" || this.move.name === "radahnTriple" || this.move.name === "radahnVortex")) {
      this.swordMat.emissiveIntensity += 1.6 * clamp01(this.t / Math.max(0.01, this.move.startup));
    }
    // 剑光：交叉斩/三连每段一道（hitFired 无条件按节拍推进，躲开也照画；首段与命中同帧）
    if (this.state === "combat" && this.sub === "act" && this.move &&
      (this.move.name === "radahnCross" || this.move.name === "radahnTriple")) {
      while (this.slashFired < this.hitFired) {
        this.slashFired++;
        this.vfx.slash(this.chestWorld(), this.yaw, this.move.range * 0.82 * SWORD_VIS_SCALE,
          this.move.name === "radahnTriple" && this.slashFired === 3, p2 ? GRAVITY_GLOW : SLASH_COOL);
      }
    }
    // 拖剑旋风：每判定段一道全周紫光
    if (this.state === "combat" && this.sub === "act" && this.move?.name === "radahnVortex") {
      while (this.slashFired < this.hitFired) {
        this.slashFired++;
        this.vfx.slash(this.chestWorld().setY(1.1), this.yaw + (this.slashFired - 1) * 0.3, this.move.range * 0.9 * SWORD_VIS_SCALE, true, GRAVITY_GLOW);
      }
    }
    // 相位回到 1 却还带着二阶段/狂暴改写（只改了 phase 字段、死亡重开漏走 reset）时，把共享表还回去
    if (this.phase < 2 && (this.p2Applied || this.enraged)) this.restorePhase1Moves();
    if (p2 && this.state !== "dead" && !this.p2Applied) this.applyPhase2Moves();
    if (p2 && this.state !== "dead" && !this.enraged && this.hp > 0 && this.hp <= this.maxHp * ENRAGE_AT) this.applyEnrage();
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
      const b = P1_BASE[m.name];
      if (!b) continue;
      m.startup = b.startup;
      m.dmg = b.dmg;
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

  /** 位移基准与段计数复位：陨石朝玩家位前压（不越过），瞄准在出手帧锁定 */
  protected override onMoveStart(m: MoveDef, toPlayer: THREE.Vector3, dist: number): void {
    this.moveFrom.copy(this.root.position);
    this.slashFired = 0;
    this.rockFired = 0;
    this.volleyFired = false;
    this.fxStep = 0;
    this.moveLen = 0;
    this.impactLive = false;
    const face = toPlayer.lengthSq() > 1e-4 ? Math.atan2(toPlayer.x, toPlayer.z) : this.yaw;
    if (m.name === "radahnMeteor" || m.proj) {
      this.yaw = face;
      this.aimYaw = face;
    }
    if (m.name === "radahnMeteor") {
      this.moveDir.set(Math.sin(face), 0, Math.cos(face));
      this.moveLen = Math.min(m.lunge ?? 0, Math.max(0, dist - 1.5));
      this.impact.copy(this.moveFrom).addScaledVector(this.moveDir, this.moveLen);
      this.impact.y = 0;
      this.impactLive = true;
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

  /** 每发独立坐标：五矢若共用一个 Vector3，池子只要保留引用就会叠成一发并跟着最后一次改写飞走 */
  private spawnAt(y: number): THREE.Vector3 {
    const o = this.chestWorld();
    o.y = y;
    return o;
  }

  /** 岩石投掷（抛物线：自 2.2m 高、drop 1.4——第二发 +0.35m 高与 +0.12 偏航；瞄准锁在出手） */
  private fireRock(i: number): void {
    if (this.rockFired >= 2) return;
    this.rockFired++;
    const origin = this.spawnAt(2.2 + i * 0.35);
    this.host.fireProjectile?.(origin, this.aimYaw + (i ? 0.12 : 0), ROCK_PROJ);
    this.gravDust.burst(origin, 6, 1.8, 0.6, 0.4);
    AU.whoosh(0.8);
  }

  /** 碎星之矢：大弓满弦释放——高速巨箭沿锁定朝向平飞（1.8m 全程在命中带） */
  private fireSnipe(): void {
    if (this.volleyFired) return;
    this.volleyFired = true;
    const origin = this.spawnAt(1.8);
    this.host.fireProjectile?.(origin, this.aimYaw, ARROW_PROJ);
    this.vfx.slash(origin, this.aimYaw, 1.6, false, GRAVITY_GLOW);
    this.gravDust.burst(origin, 8, 2, 0.5, 0.3);
  }

  /** 碎星箭雨：5 矢扇面，每发单独原点，沿前摇预告过的偏航飞出 */
  private fireRain(): void {
    if (this.volleyFired) return;
    this.volleyFired = true;
    for (const off of RAIN_SPREAD) {
      const origin = this.spawnAt(3.0);
      origin.x += Math.sin(this.aimYaw + off) * 0.15;
      origin.z += Math.cos(this.aimYaw + off) * 0.15;
      this.host.fireProjectile?.(origin, this.aimYaw + off, RAIN_PROJ);
    }
    const flash = this.spawnAt(3.0);
    this.vfx.slash(flash, this.aimYaw, 1.8, true, GRAVITY_GLOW);
  }

  /** 重力波：沿前摇铺过的地面方向放出一行波（不是扇形弹幕） */
  private fireWave(): void {
    if (this.volleyFired) return;
    this.volleyFired = true;
    const origin = this.spawnAt(0.7);
    this.host.fireProjectile?.(origin, this.aimYaw, WAVE_PROJ);
    this.vfx.ring(this.root.position, 2.2, GRAVITY);
    const fwd = new THREE.Vector3(Math.sin(this.aimYaw), 0, Math.cos(this.aimYaw));
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
      this.lockCrash();                                          // 高空横移；俯冲姿态等到达后再开始，避免人还在滑、坑已经在别处
      const k = smooth(seg(this.t, 1.1, 1.75));
      this.root.position.lerpVectors(this.moveFrom, this.tfTarget, k);
      this.root.position.y = 0;
      this.lerpPose(TF_RISE, TF_RISE, 1);
      this.pose.y = 9;
      this.markPoint(this.tfTarget, 0.75);
      this.orbitMark(this.tfTarget, 3.1);
    } else if (this.t < HIT) {
      this.lockCrash();
      this.root.position.x = this.tfTarget.x;
      this.root.position.z = this.tfTarget.z;
      this.root.position.y = 0;                                   // 直坠钉在锁定点，不再边掉边滑
      this.lerpPose(TF_RISE, TF_FALL, smooth(seg(this.t, 1.75, HIT)));
      this.pose.y = 9 * (1 - smooth(seg(this.t, 1.75, HIT)));
      this.markPoint(this.tfTarget, 0.5);
      if (Math.random() < 0.9) this.gravDust.burst(this.chestWorld(), 3, 3, 0.6, 0.4);
    } else {
      if (!this.tfDrift) this.lockCrash();
      this.root.position.x = this.tfTarget.x;
      this.root.position.z = this.tfTarget.z;
      this.root.position.y = 0;                                   // 冲击波与坑都用这一帧的 root
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

  /** 变身陨石落点：只锁一次。水平坐标单独写回，避免把 root.y 带离地面 */
  private lockCrash(): void {
    if (this.tfDrift) return;
    this.tfDrift = true;
    this.moveFrom.copy(this.root.position);
    this.moveFrom.y = 0;
    this.tfTarget.copy(this.playerLive);
    this.tfTarget.y = 0;
  }

  /** 落点周围转一圈紫尘，标出砸击范围，不另加网格 */
  private orbitMark(p: THREE.Vector3, radius: number): void {
    const a = this.t * 2.6;
    MARK_TMP.set(p.x + Math.cos(a) * radius, 0.16, p.z + Math.sin(a) * radius);
    if (Math.random() < 0.65) this.gravDust.burst(MARK_TMP, 1, 0.35, 0.28, 0.08);
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
    this.volleyFired = false;
    this.fxStep = 0;
    this.impactLive = false;
    this.lastPick = "";
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
    const w = (m: MoveDef, weight: number) => (weight > 0 && ready(m) ? (m.name === this.lastPick ? weight * 0.32 : weight) : 0);
    // 超远（>9m）：只有箭狙/岩石。重复降权但不归零——只剩其中一招时仍然打得出
    if (dist > 9) {
      return this.pickWeighted([
        [M.radahnSnipe, w(M.radahnSnipe, 3)],
        [M.radahnRocks, w(M.radahnRocks, 2)],
      ]);
    }
    // 中远（5.2–9m）：抛物线岩 / P2 箭雨扇面+行波+陨石 / 旋风拽入
    if (dist > 5.2) {
      return this.pickWeighted([
        [M.radahnRocks, w(M.radahnRocks, 3)],
        [M.radahnSnipe, w(M.radahnSnipe, 1.5)],
        [M.radahnArrowRain, w(M.radahnArrowRain, this.phase === 2 ? 3.5 : 0)],
        [M.radahnGravityWave, w(M.radahnGravityWave, this.phase === 2 ? 3 : 0)],
        [M.radahnMeteor, w(M.radahnMeteor, this.phase === 2 ? 2.5 : 0)],
        [M.radahnVortex, w(M.radahnVortex, dist <= 7 ? 1.5 : 0)],                       // 拽引令中距也不安全
      ]);
    }
    // 中近 / 贴身。重近战后摇都 ≥0.8s，打完站得住脚
    const pool: [MoveDef, number][] = dist < 3.0 ? [
      [M.radahnVortex, w(M.radahnVortex, 4.5)],                                         // 贴身解围：吸引+全周旋斩
      [M.radahnCross, w(M.radahnCross, 3.5)],
      [M.radahnPull, w(M.radahnPull, 2.5)],
      [M.radahnTriple, w(M.radahnTriple, 2)],
    ] : [
      [M.radahnCross, w(M.radahnCross, 3)],
      [M.radahnTriple, w(M.radahnTriple, 3)],
      [M.radahnVortex, w(M.radahnVortex, 2.5)],
      [M.radahnMeteor, w(M.radahnMeteor, this.phase === 2 ? 2 : 0)],
      [M.radahnGravityWave, w(M.radahnGravityWave, this.phase === 2 ? 1.5 : 0)],
    ];
    // 投射物招（proj 字段）不吃近战 range 闸——其距离带已在权重里
    const cands = pool.filter(([m, weight]) => weight > 0 && (m.proj || dist < m.range * 0.95));
    return this.pickWeighted(cands);
  }

  private pickWeighted(cands: [MoveDef, number][]): MoveDef | null {
    const live = cands.filter(([, weight]) => weight > 0);
    if (!live.length) return null;
    const chosen = pickByWeight(live) ?? live[0][0];
    this.lastPick = chosen.name;
    return chosen;
  }
}

/** 拽引/取位临时量（避免每帧分配） */
const PULL_TMP = new THREE.Vector3();
const AURA_TMP = new THREE.Vector3();
const MARK_TMP = new THREE.Vector3();
