/** Boss #5「恶兆妖鬼玛尔基特」（艾尔登法环·宁姆格福守门人，同人改编，帧数据对照 fextralife wiki 忠实校正）
 * 通用机制（状态机/削韧破绽/弹反/多段判定/击飞/冷却/走近追踪/阶段转换）全在 BossBase（boss-base.ts），
 * 本文件只保留玛尔基特专属：
 * - MOVES_MARGIT/FEEL_MARGIT 模块加载即并入 config 总表（调校台/存档自动收录，不改现有文件）
 * - 金色召唤武器体系（身份标识）：金锤/金剑 emissive 半透明网格在招式开始时凭空显形（hammerShow/swordShow 缓动）
 * - 咒刃经 host.fireProjectile → game 侧 Projectiles 池；二连发惩罚中远距站桩/喝药贪刀（wiki：常在玩家回血时投掷）
 * - 命中贴武器：咒杖、金锤、咒剑、袖刃各钉在自己的网格两端；尾巴沿尾节；投掷咒刃身子不打人
 * - 欺诈性延迟前摇：杖背藏先收到背后骗提前翻滚，命中前再短举过头才砸/旋；近身单砸 / 远身前冲双旋（运行时按距离分支）
 * - 匕首退击（先斩、再后跳、再投刃）、跃空刺（悬停→下刺，落地才判定，9.5m 外不跳）、绕背尾扫（冷却内不强制）
 * - 连段按站位延长：杖剑三连近身 40% 接金锤收尾（chain=杖→剑→锤武器切换），咒刃后接突进挥击；段间隔留翻滚窗
 * - 二阶段（hp≤65%）：变身即攻击演出「召锤扛肩→正面横扫→高跃→落锤冲击波」，之后金光披身：
 *   前摇 ×0.88 / 伤害 ×1.15 / 咒刃三连发 / 锤跃举锤悬停后砸（落点才判定）；弹反收益降一档（parriedDur 1.45）
 * 配色纪律：全局冷灰咒体 + 预言金光 0xd8b46a 点缀，无高饱和色。
 */
import * as THREE from "three";
import { MOVES, FEEL, MoveDef, FeelDef } from "./config";
import { Vfx, Particles } from "./vfx";
import { AU } from "./audio";
import { BossBase, BossStats, clamp01, smooth, seg, angleWithin, pickWeighted as pickByWeight } from "./boss-base";
import type { AttackVolume, BossHost } from "./boss-base";
import type { ProjDef } from "./projectile";
import { mountBoss, getBossGltf } from "./boss-gltf";

export type { BossState, BossHost } from "./boss-base";

// ---------------- 主题色（冷灰咒体 + 预言金光唯一强调色；躯体色板在 Blender 脚本里） ----------------
const GOLD = 0xd8b46a;        // 预言金光 / 召唤武器（巨锤/直剑/咒刃）统一辉光
const GOLD_SLASH = 0xcfc4a4;  // 杖风轨迹（灰金，一阶段）

/** 咒刃投射物：速度 12，drop 每秒下坠 1.1 制造抛物线弹道，life 1.6s ≈ 19m 射程后自散 */
const DAGGER_PROJ: ProjDef = { speed: 12, radius: 0.4, dmg: 14, feelKey: "mMagic", life: 1.6, color: GOLD, drop: 1.1 };

/** 多段间隔：玩家受击硬直 0.4s，翻滚无敌约从 0.44s 起。短于这个缝就是真连。 */
const HIT_GAP = 0.62;
/** 远身双旋 active：首段在 active*0.4，次段 +HIT_GAP，且次段必须 < active（否则基类钳到末帧）。 */
const WINDUP_FAR_ACTIVE = 1.12;
/** 近身单砸 active：接触帧仍是 active*0.4，砸实后立刻进后摇。 */
const WINDUP_NEAR_ACTIVE = 0.32;
const HAMMER_APEX = 1.75;
const STAB_APEX = 1.55;
/** 跃空刺出手上限。lunge 7、落点留 1.2：9.5m 静止目标余距 2.5 ≤ range 3.4 + 基类容差 0.45。再远走近。 */
const LEAP_REACH = 9.5;

// ---------------- 帧数据（键名 margit 前缀 / 手感键 m 开头；fextralife wiki 忠实校正） ----------------
export const MOVES_MARGIT: Record<string, MoveDef> = {
  // 咒杖直击（Staff Stab）：直线前刺，可弹反；前冲 1.0m 在 movePose tel 段消费
  margitStaff: {
    name: "margitStaff", label: "咒杖直击", startup: 0.50, active: 0.16, recovery: 0.80,
    dmg: 20, range: 3.8, arc: 0.9, lunge: 1.0, parryable: true, cd: 2.2, feel: "mLight",
  },
  // 杖剑三连（Staff Swing 连击 + 召唤剑收尾）：3 段判定。
  // 第 k 段在 active*0.4 + k*HIT_GAP。active 2.15 → 0.86 / 1.48 / 2.10，段间隔 0.62s 留翻滚窗。
  // 近身 40% 接金锤收尾（chain）＝wiki「武器切换连段 杖→剑→锤」的近身延长风味；第三段为左手召唤金剑挥斩
  margitCombo: {
    name: "margitCombo", label: "杖剑三连", startup: 0.35, active: 2.15, recovery: 0.85,
    dmg: 12, range: 3.2, arc: 1.6, hits: 3, hitInterval: HIT_GAP, chain: "margitHammer",
    parryable: true, cd: 4.2, feel: "mLight",   // 仅首段可弹反由引擎保证（首段命中关窗）
  },
  // 杖背藏（Windup·招牌欺诈延迟）：背后藏杖长前摇 1.25s 骗提前翻滚，末段才短举过头。
  // 表内 active/hits 是远身双旋（两段 HIT_GAP，冲程落在第一段判定上）。近身单砸在 onMoveStart 改 hits=1、active 缩短。
  margitWindup: {
    name: "margitWindup", label: "杖背藏", startup: 1.25, active: WINDUP_FAR_ACTIVE, recovery: 1.05,
    dmg: 26, range: 4.4, arc: 2.4, hits: 2, hitInterval: HIT_GAP, lunge: 5.0,
    parryable: true, cd: 6.5, feel: "mHeavy",
  },
  // 召唤金锤（Hammer Slam）：长前摇 1.1s（后半段金锤显形），抬左腿→巨锤下劈，收招硬直 1.5s 可贪刀；
  // 砸地金色冲击环 + 震屏走 hammerImpact 自放（不走 MoveDef.shock 基类暖色路径，保证金光主题）
  margitHammer: {
    name: "margitHammer", label: "召唤金锤", startup: 1.1, active: 0.16, recovery: 1.5,
    dmg: 34, range: 3.6, arc: 1.2, parryable: true, cd: 6.0, feel: "mHeavy",
  },
  // 锤跃（Hammer Leap·二阶段）：先举锤再起跳悬停，落地那一帧才进判定。二阶段前摇仍 ×0.88，基线留够可读
  margitHammerLeap: {
    name: "margitHammerLeap", label: "锤跃", startup: 0.62, active: 0.22, recovery: 1.5,
    dmg: 36, range: 4.6, arc: 1.6, lunge: 3.0, parryable: false, cd: 8.0,
    phase2Only: true, feel: "mHeavy",
  },
  // 投掷咒刃（Dagger Throw）：中远距；近战判定禁用（range 0.2 同沙力万暗月矢——人/Boss 推挤最小间距永不满足），
  // 伤害由 DAGGER_PROJ 承载；二连发（二阶段三连发），后续弹在 movePose 内按战斗时间补发；
  // 玩家若趁机逼近则 40% 接咒杖突进挥击（chain）＝wiki「投掷后可接突进」
  margitDaggers: {
    name: "margitDaggers", label: "投掷咒刃", startup: 0.55, active: 0.20, recovery: 0.95,
    dmg: 14, range: 0.2, arc: 0.9, parryable: false, cd: 5.5, chain: "margitStaff",
    proj: { speed: 12, radius: 0.4, life: 1.6 }, feel: "mMagic",
  },
  // 匕首退击（Dagger Retreat）：先斩（还在贴身距离内）→ 后跳 1.5m → 再投咒刃。位移在收招，不在判定前
  margitRetreat: {
    name: "margitRetreat", label: "匕首退击", startup: 0.30, active: 0.14, recovery: 0.80,
    dmg: 14, range: 2.6, arc: 2.2, parryable: false, cd: 7.0, feel: "mLight",
  },
  // 横扫尾击（Tail Swipe）：贴身/绕背脱身用，小半径全周判定 + 小击飞（knockUp 由 player.applyHit 抛物线消费）
  // arc 用 2π：写成 6.28 时半角 3.14 < π，正后方（绕背的正中）会漏出判定
  // 击飞约 0.39s + 落地硬直 0.4s，后摇 1.45s 才能在玩家落地后还留下约 0.7s 惩罚窗
  margitTail: {
    name: "margitTail", label: "横扫尾击", startup: 0.45, active: 0.22, recovery: 1.45,
    dmg: 22, range: 3.0, arc: Math.PI * 2, knockUp: 3.5, parryable: false, cd: 6.5, feel: "mHeavy",
  },
  // 跃空刺（Leaping Stab）：远距起跳，空中悬停一瞬 → 向下突刺；落地硬直 1.6s 是最大惩罚窗口（wiki）
  margitLeap: {
    name: "margitLeap", label: "跃空刺", startup: 0.70, active: 0.16, recovery: 1.60,
    dmg: 30, range: 3.4, arc: 1.0, lunge: 7.0, parryable: true, cd: 7.5, feel: "mHeavy",
  },
};
Object.assign(MOVES, MOVES_MARGIT);

// ---------------- 手感档案（咒物妖鬼：钝木杖 + 金光咒刃） ----------------
export const FEEL_MARGIT: Record<string, FeelDef & { label: string }> = {
  mLight: { label: "玛尔基特·杖击", hitstop: 0.05, shake: 0.40, sparks: 10, sparkSpeed: 4, knockback: 0.35, sfx: "hitStone" },
  mHeavy: { label: "玛尔基特·重击", hitstop: 0.09, shake: 0.55, sparks: 16, sparkSpeed: 5, knockback: 0.60, sfx: "hitHeavy" },
  mMagic: { label: "咒刃·命中",     hitstop: 0.08, shake: 0.45, sparks: 14, sparkSpeed: 5, knockback: 0.50, sfx: "hitHeavy" },
};
Object.assign(FEEL, FEEL_MARGIT);

export const MARGIT_STATS: BossStats & { name: string; radius: number } = {
  name: "恶兆妖鬼玛尔基特", radius: 0.95,
  hp: 650,                        // 原作 4174 按本项目 Boss 血量档（620-720）折算
  poiseMax: 80, poiseDecay: 9,    // 原作 Stance 80——削韧偏脆，但↓
  staggerDur: 2.2, staggerMul: 1.5,
  parriedDur: 1.45,               // 弹反收益降一档（原作需两次弹反才出处决，我们一次——窗口收紧补偿）
  phase2At: 0.65,                 // hp < 65% 预言金光披身（wiki；台词 60% 前后）
  walkSpeed: 3.2, turnRate: 3.8,  // 枯瘦高大但佝偻缓行
};

/** 二阶段 buff（全部前摇 ×0.88 / 全招伤害 ×1.15）的一阶段基线——模块级快照，多实例/reset 往返安全（仿 sulyvahn） */
const P1_BASE: Record<string, { startup: number; dmg: number }> = {};
for (const m of Object.values(MOVES_MARGIT)) P1_BASE[m.name] = { startup: m.startup, dmg: m.dmg };

// ---------------- 姿态（Pose）：佝偻咒体 + 持杖右臂 / 投刃左臂 / 尾枢轴 / 左腿（抬腿劈锤） ----------------
interface Pose {
  y: number; lean: number; twist: number; crouch: number; reach: number;
  rLift: number; rSwing: number;   // 右臂（持杖）：lift 正=前戳 负=上举；swing 正=向左抡
  lLift: number; lSwing: number;   // 左臂（咒刃/召唤剑，镜像）
  nod: number;                     // 头部俯仰（正=低头）
  spin: number;                    // 整体附加旋转
  tail: number;                    // 尾枢轴摆角（横扫尾击）
  legL: number;                    // 左腿抬起（金锤下劈前摇）
}
const STANCE: Pose = { y: 0, lean: 0.17, twist: -0.08, crouch: 0, reach: 0, rLift: 0.34, rSwing: 0.16, lLift: 0.22, lSwing: -0.2, nod: 0.14, spin: 0, tail: 0, legL: 0 };
const STATUE: Pose = { ...STANCE, lean: 0.42, crouch: 0.3, nod: 0.55, rLift: -0.05, rSwing: 0.05, lLift: 0.05, lSwing: -0.08 };  // 佝偻拄杖伫立
// 杖剑三连三拍（拍内 wind→strike；与判定时刻 active*0.4 + k*0.5 对齐；第三拍左手召唤金剑横收）
const C1W: Pose = { ...STANCE, twist: 0.6, rLift: -0.95, rSwing: -0.8, nod: 0.1 };
const C1K: Pose = { ...STANCE, twist: -0.45, rLift: 0.6, rSwing: 0.95, lean: 0.24 };
const C2W: Pose = { ...STANCE, twist: -0.5, rLift: -0.65, rSwing: 0.85, lLift: -0.4, lSwing: 0.3 };
const C2K: Pose = { ...STANCE, twist: 0.45, rLift: 0.55, rSwing: -1.0, lean: 0.2, lLift: 0.3, lSwing: -0.4 };
const C3W: Pose = { ...STANCE, twist: 0.75, rLift: -0.4, rSwing: -1.15, lLift: -1.0, lSwing: 0.8 };
const C3K: Pose = { ...STANCE, twist: -0.8, rLift: 0.4, rSwing: 1.3, lean: 0.28, crouch: 0.12, lLift: 0.8, lSwing: -1.1 };
// 杖背藏（欺诈前摇）：杖收到背后静止（wind＝蓄好型后僵住骗翻滚）→ 爆发双旋（strike）；近身分支改下砸（HW2）
const WUW: Pose = { ...STANCE, twist: 0.7, rLift: -0.55, rSwing: -1.25, lean: 0.05, crouch: 0.18, nod: 0.24 };
const WUK: Pose = { ...STANCE, twist: -0.9, rLift: 0.7, rSwing: 1.35, lean: 0.3, crouch: 0.1 };
const WUK2: Pose = { ...WUK, twist: 0.85, rSwing: -1.35, lean: 0.34 }; // 远身双旋第二段
const WU2W: Pose = { ...STANCE, twist: 0.55, rLift: -1.7, rSwing: -0.4, lean: -0.06, crouch: 0.2, nod: -0.1 };
const WU2K: Pose = { ...STANCE, twist: -0.2, rLift: 1.05, rSwing: 0.1, lean: 0.55, crouch: 0.4, nod: 0.3, reach: 0.4, y: -0.22 };
// 金锤：抬左腿高举过顶（金光显形，侧摆让扛锤位从前方可见）→ 劈落砸地
const HW: Pose = { ...STANCE, crouch: 0.2, lean: -0.12, rLift: -2.35, rSwing: 0.5, lLift: -1.2, lSwing: -0.35, nod: -0.18, legL: 0.95 };
const HK: Pose = { ...STANCE, crouch: 0.4, lean: 0.52, rLift: 1.15, rSwing: 0.05, nod: 0.3, reach: 0.4, y: -0.2 };
// 咒刃：左臂高举后甩发
const DW: Pose = { ...STANCE, twist: -0.45, lLift: -1.7, lSwing: 0.55, lean: -0.08, nod: 0.1, rLift: 0.2, rSwing: 0.3 };
const DK: Pose = { ...STANCE, twist: 0.25, lLift: 1.0, lSwing: -0.2, lean: 0.3, reach: 0.3, nod: 0.02 };
// 匕首退击：横斩 → 后跳（位移）→ 甩投
const RTW: Pose = { ...STANCE, twist: 0.5, rLift: -0.7, rSwing: -0.7, crouch: 0.14 };
const RTK: Pose = { ...STANCE, twist: -0.55, rLift: 0.55, rSwing: 1.0, lean: 0.22, crouch: 0.1 };
// 尾击：缩身蓄势（尾后卷）→ 全周甩尾
const TW: Pose = { ...STANCE, crouch: 0.3, lean: 0.35, tail: -1.9, twist: 0.4 };
const TK: Pose = { ...STANCE, crouch: 0.18, lean: 0.2, tail: 1.9, twist: -0.5 };
// 跃空刺：深蹲蓄势 → 腾空前扑悬停 → 下刺钉地
const LWIND: Pose = { ...STANCE, crouch: 0.55, lean: 0.3, y: -0.35, nod: 0.3, rLift: -1.5, rSwing: 0.4 };
const LHOVER: Pose = { ...STANCE, crouch: 0.42, lean: 0.12, nod: 0.18, rLift: -1.9, rSwing: 0.25 };
const LSTAB: Pose = { ...STANCE, crouch: 0.34, lean: 0.6, rLift: 1.3, rSwing: 0.05, nod: 0.34, reach: 0.62, y: -0.12 };
// 锤跃：急蹲 → 高跳腾空 → 落锤
const HLW: Pose = { ...STANCE, crouch: 0.5, lean: 0.24, y: -0.3, nod: 0.26, rLift: -2.4, rSwing: 0.2 };
const HLAIR: Pose = { ...STANCE, crouch: 0.45, lean: 0.06, rLift: -2.5, rSwing: 0.3, nod: 0.1 };
const HLSLAM: Pose = { ...STANCE, crouch: 0.44, lean: 0.54, rLift: 1.1, rSwing: 0.05, nod: 0.3, reach: 0.5, y: -0.18 };
// 变身演出四段：召锤扛肩 → 正面横扫 → 高跃 → 落锤砸地（冲击波时刻＝transformHitAt）
const TF_GATHER: Pose = { ...STANCE, crouch: 0.36, y: -0.32, lean: 0.4, nod: 0.42, rLift: -1.05, rSwing: 0.5, lLift: -1.05, lSwing: -0.5 };
const TF_CARRY: Pose = { ...STANCE, lean: -0.12, nod: -0.16, rLift: -1.95, rSwing: 0.55, lLift: -0.5, lSwing: -0.4 };
const TF_SWEEP: Pose = { ...STANCE, twist: -0.75, rLift: 0.55, rSwing: 1.35, lean: 0.32, crouch: 0.14 };
const TF_AIR: Pose = { ...STANCE, y: 0.5, crouch: 0.42, lean: 0.08, rLift: -2.4, rSwing: 0.3, nod: 0.12 };
const TF_SLAM: Pose = { ...STANCE, crouch: 0.44, lean: 0.55, rLift: 1.1, rSwing: 0.05, nod: 0.3, reach: 0.45, y: -0.2 };

export class Margit extends BossBase {
  private body = new THREE.Group();
  private torso = new THREE.Group();
  private head = new THREE.Group();
  private legR = new THREE.Group();
  private legL = new THREE.Group();
  private shinR = new THREE.Group();
  private shinL = new THREE.Group();
  private armR = new THREE.Group();
  private armL = new THREE.Group();
  private tailG = new THREE.Group();
  private hammerG = new THREE.Group();
  private swordG = new THREE.Group();
  // 刃的两端，钉在对应网格上（空物体，不改外观尺寸）
  private staffHilt = new THREE.Object3D();
  private staffTip = new THREE.Object3D();
  private hammerHilt = new THREE.Object3D();
  private hammerTip = new THREE.Object3D();
  private swordHilt = new THREE.Object3D();
  private swordTip = new THREE.Object3D();
  private sleeveHilt = new THREE.Object3D();
  private sleeveTip = new THREE.Object3D();
  private tailHilt = new THREE.Object3D();
  private tailTip = new THREE.Object3D();
  private eyeMat!: THREE.MeshStandardMaterial;    // 双眼（预言金光）
  private runeMat!: THREE.MeshStandardMaterial;   // 额前预言印记 + 杖身金符文
  private hammerMat!: THREE.MeshStandardMaterial; // 召唤金锤（显形时 emissive）
  private swordMat!: THREE.MeshStandardMaterial;  // 召唤金剑（Carian 直剑风味）
  private goldLight!: THREE.PointLight;           // 额前预言光
  private hammerLight!: THREE.PointLight;         // 金锤随行光
  private robe: THREE.Mesh[] = [];                // 长袍下摆阶梯层
  private rags: THREE.Mesh[] = [];                // 下摆破布条（updateVisuals 摆动）
  private gold!: Particles;                       // 金尘粒子池（召唤凝聚 / 二阶段披身）

  private pose: Pose = { ...STATUE };
  private playerPos = new THREE.Vector3(0, 0, 5); // pickMove 的绕背检测用（update 时缓存）
  private moveFrom = new THREE.Vector3();         // 位移类招基准
  private moveDir = new THREE.Vector3(0, 0, 1);
  private moveLen = 0;
  private windupFar = false;                      // 杖背藏运行时分支：远身前冲双旋 / 近身砸地
  private lastMoveName = "";                      // 同招连续降权
  private slashFired = 0;                         // 已补画杖光的判定段数（与 hitFired 对齐）
  private daggerFired = 0;                        // 已发出的咒刃数
  private daggerTotal = 2;                        // 本轮连发总数（二阶段 3）
  private fxStep = 0;                             // 落点表现步进（金锤/杖背藏近砸）
  private hammerShow = 0;                         // 金锤显形度 0..1（updateVisuals 缓动）
  private swordShow = 0;                          // 金剑显形度 0..1
  private p2Applied = false;                      // 二阶段数值 buff 是否已写入共享表
  private prevTfT = 0;                            // 变身演出上一帧 t（落锤帧跨帧判定）
  private lastVisT = 0;                           // 金尘池推进用真实 dt

  constructor(scene: THREE.Scene, vfx: Vfx, pos: THREE.Vector3, host: BossHost, facing = -Math.PI / 2) {
    super(scene, vfx, pos, host, MARGIT_STATS, facing);
    this.gold = new Particles(scene, 120, { size: 0.05, color: GOLD, additive: true, gravity: -0.2 });
    this.lastVisT = performance.now();
    this.transformHitAt = 1.55;   // 变身演出：召锤(0.55 金光披身)→扛肩→横扫→高跃→1.55s 落锤冲击波
    this.transformDur = 2.9;
    this.assemble();
  }


  // ---------------- 外观：恶兆躯体由 Blender 管线出（tools/blender/build_bosses.py）。
  // 挂点局部变换与上面的组常量一致，mountBoss 抄回各组后 applyPose 一行不改；
  // 判定标记（杖/锤/剑/袖刃/尾）钉在 GLB 里，招式代码仍按名字取。 ----------------
  protected override buildBody(): void {
    const rig = mountBoss(getBossGltf("margit"), {
      body: this.body, torso: this.torso, head: this.head,
      legR: this.legR, shinR: this.shinR, legL: this.legL, shinL: this.shinL,
      armR: this.armR, armL: this.armL,
      tail: this.tailG, hammer: this.hammerG, sword: this.swordG,
    }, [
      "weapon-hilt", "weapon-tip", "weapon2-hilt", "weapon2-tip",
      "hammer-hilt", "hammer-tip", "sword-hilt", "sword-tip",
      "tail-hilt", "tail-tip",
    ]);
    this.staffHilt = rig.node("weapon-hilt");
    this.staffTip = rig.node("weapon-tip");
    this.sleeveHilt = rig.node("weapon2-hilt");
    this.sleeveTip = rig.node("weapon2-tip");
    this.hammerHilt = rig.node("hammer-hilt");
    this.hammerTip = rig.node("hammer-tip");
    this.swordHilt = rig.node("sword-hilt");
    this.swordTip = rig.node("sword-tip");
    this.tailHilt = rig.node("tail-hilt");
    this.tailTip = rig.node("tail-tip");
    this.eyeMat = rig.mat("margit-eye");
    this.runeMat = rig.mat("margit-gold");
    this.hammerMat = rig.mat("margit-hammer");
    this.swordMat = rig.mat("margit-sword");
    this.robe = [0, 1, 2, 3].map(i => rig.mesh(`robe${i}`));        // 长袍下摆阶梯层
    this.rags = [0, 1, 2, 3, 4, 5].map(i => rig.mesh(`rag${i}`));   // 下摆破布条
    this.goldLight = new THREE.PointLight(GOLD, 0.7, 5, 2);
    this.goldLight.position.set(0, 0.16, 0.3);
    this.head.add(this.goldLight);
    this.hammerLight = new THREE.PointLight(GOLD, 0, 4, 2);
    this.hammerLight.position.set(0, 0.32, 0);
    this.hammerG.add(this.hammerLight);
    this.hammerG.visible = false;
    this.swordG.visible = false;
    // 关节层级仍由代码搭（Blender 侧同构，网格已挂到各组上）
    this.legR.add(this.shinR);
    this.legL.add(this.shinL);
    this.body.add(this.legR, this.legL, this.torso, this.tailG);
    this.torso.add(this.head, this.armR, this.armL);
    this.armR.add(this.hammerG);
    this.armL.add(this.swordG);
    this.root.add(this.body);
  }

  protected override chestPart(): THREE.Object3D { return this.torso; }
  protected override headPart(): THREE.Object3D { return this.head; }

  /**
   * 每一拍用这一下真正挥出去的东西。
   * 金锤/锤跃/杖背藏近砸的冲击环只在落点画坑，伤害本来就只有挥下那一拍，不再加圆。
   * 杖剑三连前两段是咒杖，第三段才换左手咒剑。切过去的那一帧基类还没开始查这一段。
   */
  protected override attackVolume(m: MoveDef): AttackVolume | null {
    switch (m.name) {
      case "margitStaff":
      case "margitWindup":
      case "margitLeap":
        return { kind: "blade", hilt: this.staffHilt, tip: this.staffTip, pad: 0.2 };
      case "margitCombo":
        return this.comboUsesSword(m)
          ? { kind: "blade", hilt: this.swordHilt, tip: this.swordTip, pad: 0.08 }
          : { kind: "blade", hilt: this.staffHilt, tip: this.staffTip, pad: 0.2 };
      case "margitHammer":
      case "margitHammerLeap":
        return { kind: "blade", hilt: this.hammerHilt, tip: this.hammerTip, pad: 0.2 };
      case "margitRetreat":
        return { kind: "blade", hilt: this.sleeveHilt, tip: this.sleeveTip, pad: 0.04 };
      case "margitTail":
        return { kind: "blade", hilt: this.tailHilt, tip: this.tailTip, pad: 0.08 };
      case "margitDaggers":
        return { kind: "none" };
      default:
        return null;
    }
  }

  /** 第三段从 active*0.4 + 2*段间隔 开始。用招式上已有的间隔，不另写一个数。 */
  private comboUsesSword(m: MoveDef): boolean {
    const interval = m.hitInterval ?? HIT_GAP;
    const thirdAt = Math.min(m.active * 0.4 + 2 * interval, m.active);
    return this.hitFired >= 2 || this.t >= thirdAt;
  }

  // ---------------- 姿态应用 ----------------
  protected override applyPose(): void {
    const p = this.pose;
    this.root.rotation.y = this.yaw + p.spin;
    this.body.position.set(0, p.y - p.crouch * 0.3, p.reach);
    this.torso.rotation.set(p.lean, p.twist, 0);
    this.head.rotation.x = p.nod;
    this.armR.rotation.set(-p.rLift, 0, -p.rSwing);
    this.armL.rotation.set(-p.lLift, -0.12, p.lSwing);
    this.legR.rotation.x = -p.crouch * 0.62;
    this.shinR.rotation.x = p.crouch * 1.2;
    this.legL.rotation.x = -p.crouch * 0.48 - p.legL;                         // 抬左腿（金锤前摇）
    this.shinL.rotation.x = p.crouch * 0.9 + p.legL * 0.55;
    this.tailG.rotation.y = p.tail;
  }

  private lerpPose(a: Pose, b: Pose, k: number): void {
    const p = this.pose;
    p.y = a.y + (b.y - a.y) * k; p.lean = a.lean + (b.lean - a.lean) * k;
    p.twist = a.twist + (b.twist - a.twist) * k; p.crouch = a.crouch + (b.crouch - a.crouch) * k;
    p.reach = a.reach + (b.reach - a.reach) * k;
    p.rLift = a.rLift + (b.rLift - a.rLift) * k; p.rSwing = a.rSwing + (b.rSwing - a.rSwing) * k;
    p.lLift = a.lLift + (b.lLift - a.lLift) * k; p.lSwing = a.lSwing + (b.lSwing - a.lSwing) * k;
    p.nod = a.nod + (b.nod - a.nod) * k; p.spin = a.spin + (b.spin - a.spin) * k;
    p.tail = a.tail + (b.tail - a.tail) * k; p.legL = a.legL + (b.legL - a.legL) * k;
  }

  /** 基类首段判定在 active*0.4。接触姿态在这一刻走完：之前举着，落点才吃伤害。 */
  private contactK(t: number, active: number): number {
    return smooth(clamp01(t / Math.max(0.04, active * 0.4)));
  }

  protected override movePose(m: MoveDef, sub: string, t: number, total: number): void {
    // 咒刃后续补发：act 起点 +0.32s/发（active 0.2 ⇒ 第 2/3 发落在 rec 段；tel 段不参与——首发归 onMoveActive；
    // 与战斗时间同源，暂停不脱钩）
    if (m.name === "margitDaggers" && sub !== "tel" && this.daggerFired < this.daggerTotal) {
      const ta = sub === "act" ? t : t + m.active;
      while (this.daggerFired < this.daggerTotal && ta >= 0.32 * this.daggerFired) {
        this.fireDagger(this.daggerFired);
      }
    }
    if (m.name === "margitLeap") {
      // 跃空刺：深蹲 → 前扑升到顶点悬停 → 下刺在判定帧钉地（不再整段慢慢扎，命中时人还在半空）
      if (sub === "tel") {
        this.lerpPose(STANCE, LWIND, smooth(Math.min(1, t / (m.startup * 0.3))));
        const k = clamp01(seg(t, m.startup * 0.3, m.startup * 0.9));
        const ks = smooth(k);
        if (k > 0) {
          this.root.position.copy(this.moveFrom).addScaledVector(this.moveDir, this.moveLen * ks);
          this.lerpPose(LWIND, LHOVER, ks);
          this.pose.y = Math.sin(Math.min(1, k) * Math.PI / 2) * STAB_APEX; // 升到顶点后悬停不落
          if (k < 0.1) this.vfx.dust.burst(this.root.position.clone().setY(0.2), 2, 2, 0.6);
        }
        return;
      }
      if (sub === "act") {
        const k = this.contactK(t, m.active);
        this.lerpPose(LHOVER, LSTAB, k);
        this.pose.y = STAB_APEX * (1 - k) + LSTAB.y * k;                    // 判定帧才着地
        return;
      }
      this.lerpPose(LSTAB, STANCE, smooth(seg(t, m.recovery * 0.25, m.recovery)));   // 落地大硬直（惩罚窗口）
      return;
    }
    if (m.name === "margitHammerLeap") {
      // 锤跃：先举锤，再跳向落点并停在最高点；下落与判定同帧，前摇里不再先落地
      const upAt = m.startup * 0.34;
      if (sub === "tel") {
        if (t < upAt) {
          this.lerpPose(STANCE, HLW, smooth(t / Math.max(0.04, upAt)));
        } else {
          const k = smooth(seg(t, upAt, m.startup));
          this.lerpPose(HLW, HLAIR, k);
          this.pose.y = Math.sin(Math.min(1, k) * Math.PI / 2) * HAMMER_APEX;
          const travel = smooth(Math.min(1, k / 0.82));                      // 末段悬停，让落点可读
          this.root.position.copy(this.moveFrom).addScaledVector(this.moveDir, this.moveLen * travel);
          if (k > 0 && k < 0.12) this.vfx.dust.burst(this.root.position.clone().setY(0.2), 3, 2.2, 0.5);
        }
        return;
      }
      if (sub === "act") {
        const k = this.contactK(t, m.active);
        this.lerpPose(HLAIR, HLSLAM, k);
        this.pose.y = HAMMER_APEX * (1 - k) + HLSLAM.y * k;
        this.hammerImpact(t, m, 5.5);
        return;
      }
      this.lerpPose(HLSLAM, STANCE, smooth(seg(t, m.recovery * 0.25, m.recovery)));
      return;
    }
    if (m.name === "margitWindup") {
      // 杖背藏：前段杖收到背后僵住骗翻滚，末段才短举过头。冲程/下砸都发生在判定帧。
      const raiseAt = m.startup * 0.68;
      if (sub === "tel") {
        if (t < raiseAt) {
          this.lerpPose(STANCE, WUW, smooth(Math.min(1, t / (m.startup * 0.36))));
        } else {
          this.lerpPose(WUW, WU2W, smooth(seg(t, raiseAt, m.startup)));
        }
        return;
      }
      if (sub === "act") {
        if (this.windupFar) {
          const t0 = m.active * 0.4;
          const t1 = Math.min(t0 + (m.hitInterval ?? HIT_GAP), m.active);
          const travel = smooth(clamp01(t / Math.max(0.04, t0)));
          this.root.position.copy(this.moveFrom).addScaledVector(this.moveDir, this.moveLen * travel);
          if (t <= t0) this.lerpPose(WU2W, WUK, smooth(clamp01(t / Math.max(0.04, t0))));
          else this.lerpPose(WUK, WUK2, smooth(clamp01((t - t0) / Math.max(0.04, t1 - t0))));
          const gold = this.phase === 2 ? GOLD : GOLD_SLASH;
          if (this.slashFired < 1 && t >= t0) {
            this.slashFired = 1;
            this.vfx.slash(this.chestWorld(), this.yaw + 0.2, m.range * 0.85, true, gold);
          }
          if (this.slashFired < 2 && t >= t1) {
            this.slashFired = 2;
            this.vfx.slash(this.chestWorld(), this.yaw - 0.2, m.range * 0.8, true, gold);
          }
        } else {
          this.lerpPose(WU2W, WU2K, this.contactK(t, m.active));
          this.hammerImpact(t, m, 3.6);
        }
        return;
      }
      this.lerpPose(this.windupFar ? WUK2 : WU2K, STANCE, smooth(seg(t, m.recovery * 0.3, m.recovery)));
      return;
    }
    if (m.name === "margitHammer") {
      // 召锤：前 62% 举过顶，后段停在最高点，act 的判定帧才劈落
      if (sub === "tel") {
        const raiseEnd = m.startup * 0.62;
        this.lerpPose(STANCE, HW, t < raiseEnd ? smooth(t / Math.max(0.04, raiseEnd)) : 1);
        return;
      }
      if (sub === "act") {
        this.lerpPose(HW, HK, this.contactK(t, m.active));
        this.hammerImpact(t, m, 5.0);
        return;
      }
      this.lerpPose(HK, STANCE, smooth(seg(t, m.recovery * 0.3, m.recovery)));
      return;
    }
    if (m.name === "margitRetreat") {
      // 先斩再跳：判定在原地，后跳和咒刃放到收招，避免人已经退出射程刀才落下
      if (sub === "tel") {
        this.lerpPose(STANCE, RTW, smooth(clamp01(t / Math.max(0.04, m.startup))));
        return;
      }
      if (sub === "act") {
        this.lerpPose(RTW, RTK, this.contactK(t, m.active));
        return;
      }
      const hopEnd = m.recovery * 0.42;
      const hop = smooth(clamp01(t / Math.max(0.04, hopEnd)));
      this.root.position.copy(this.moveFrom).addScaledVector(this.moveDir, this.moveLen * hop);
      this.lerpPose(RTK, STANCE, smooth(seg(t, hopEnd, m.recovery)));
      this.pose.y += Math.sin(hop * Math.PI) * 0.32;                         // 后跳弧，落地后再投
      if (this.daggerFired === 0 && t >= hopEnd) this.fireDagger(0);
      return;
    }
    const wind: Pose = { ...STANCE }, strike: Pose = { ...STANCE };
    switch (m.name) {
      case "margitStaff":
        wind.twist = 0.5; wind.rLift = -0.7; wind.rSwing = -0.5; wind.crouch = 0.16; wind.lean = 0.1;
        strike.twist = -0.25; strike.rLift = 1.25; strike.rSwing = 0.1; strike.reach = 0.5; strike.lean = 0.4; strike.crouch = 0.12;
        break;
      case "margitCombo":
        Object.assign(wind, C1W); Object.assign(strike, C3K);
        break;
      case "margitDaggers":
        Object.assign(wind, DW); Object.assign(strike, DK);
        break;
      case "margitTail":
        Object.assign(wind, TW); Object.assign(strike, TK);
        break;
    }
    if (sub === "tel") {
      // 尾扫要把整段前摇用来蓄尾；其他招仍留出前半段的静止，避免所有前摇都在动
      const windAt = m.name === "margitTail" ? m.startup * 0.08 : m.startup * 0.45;
      this.lerpPose(STANCE, wind, smooth(seg(t, windAt, m.startup)));
      if (this.moveLen !== 0) {
        const k = smooth(clamp01((t - m.startup * 0.3) / (m.startup * 0.7)));
        this.root.position.copy(this.moveFrom).addScaledVector(this.moveDir, this.moveLen * k);
      }
    } else if (sub === "act") {
      if (m.name === "margitCombo") this.comboPose(t, m);
      else this.lerpPose(wind, strike, this.contactK(t, m.active));
      if (m.name === "margitTail" && this.slashFired === 0 && t >= m.active * 0.4) {
        this.slashFired = 1;
        this.vfx.slash(this.chestWorld().setY(0.7), this.yaw, m.range * 0.9, true, this.phase === 2 ? GOLD : GOLD_SLASH);
        this.vfx.dust.burst(this.root.position.clone().setY(0.25), 8, 2.4, 0.7);
      }
    } else {
      this.lerpPose(strike, STANCE, smooth(seg(t, m.recovery * 0.35, m.recovery)));
    }
    void total;
  }

  /** 杖剑三连：每一拍在该段判定帧砍实。两拍之间先收回蓄力再砍，避免判定落在抬手姿势上。 */
  private comboPose(t: number, m: MoveDef): void {
    const interval = m.hitInterval ?? HIT_GAP;
    const n = Math.min(3, m.hits ?? 3);
    const winds = [C1W, C2W, C3W];
    const strikes = [C1K, C2K, C3K];
    const at = (k: number) => Math.min(m.active * 0.4 + k * interval, m.active);
    let idx = 0;
    for (let k = 0; k < n; k++) {
      if (t <= at(k) || k === n - 1) { idx = k; break; }
    }
    const start = idx === 0 ? 0 : at(idx - 1);
    const u = clamp01((t - start) / Math.max(0.04, at(idx) - start));
    if (idx === 0) {
      this.lerpPose(winds[0], strikes[0], smooth(u));
      return;
    }
    if (u < 0.45) this.lerpPose(strikes[idx - 1], winds[idx], smooth(u / 0.45));
    else this.lerpPose(winds[idx], strikes[idx], smooth((u - 0.45) / 0.55));
  }

  /** 金色落点表现：冲击环 + 金斑 + 震屏（金锤/锤跃/杖背藏近砸共用；与命中判定解耦——打中/躲开都应砸出坑） */
  private hammerImpact(t: number, m: MoveDef, radius: number): void {
    if (this.fxStep !== 0 || t < m.active * 0.4) return;
    this.fxStep = 1;
    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const at = this.root.position.clone().addScaledVector(fwd, 2.0).setY(0.1);
    this.vfx.ring(this.root.position, radius, GOLD);
    this.vfx.scorch(at, radius * 0.52, GOLD);
    this.vfx.dust.burst(at, 12, 3.2, 0.8);
    this.gold.burst(at.clone().setY(0.8), 14, 3.5, 1.1, 0.6);
    AU.slamShock();
    this.host.shake(0.65);
  }

  // ---------------- 玛尔基特专属覆盖点 ----------------
  /** 缓存玩家位置（pickMove 的绕背检测拿不到 playerPos，只在 update 入口有）；
   *  帧末按帧 dt 驱动召唤武器显形缓动（墙钟会在快速步进/暂停时失真，帧 dt 恒稳） */
  override update(dt: number, playerPos: THREE.Vector3, playerIframed: boolean): void {
    this.playerPos.copy(playerPos);
    super.update(dt, playerPos, playerIframed);
    this.updateSummons(dt);
  }

  /** 召唤武器显形：金锤——举锤时渐显（咒力凝聚）/ 锤跃在悬停前摇里凝出 / 变身演出全程；
   *  金剑——杖剑三连 tel+act（左手召剑收尾）。半透明凭空浮现 → 凝成实体，凝聚时抽金尘 */
  private updateSummons(dt: number): void {
    const now = performance.now();
    let hammerTarget = 0, swordTarget = 0;
    if (this.state === "transform") {
      hammerTarget = 1;
    } else if (this.state === "combat" && this.move) {
      const n = this.move.name;
      if (n === "margitHammer") {
        hammerTarget = this.sub === "act" || (this.sub === "tel" && this.t >= this.move.startup * 0.12) ? 1 : 0;
      } else if (n === "margitHammerLeap") {
        hammerTarget = this.sub === "tel" || this.sub === "act" ? 1 : 0;
      } else if (n === "margitCombo") {
        swordTarget = this.sub === "tel" || this.sub === "act" ? 1 : 0;
      }
    }
    const hammerRate = 9;
    this.hammerShow += (hammerTarget - this.hammerShow) * Math.min(1, dt * hammerRate);
    this.swordShow += (swordTarget - this.swordShow) * Math.min(1, dt * 12);
    const show = this.hammerShow;
    this.hammerG.visible = show > 0.04;
    this.hammerMat.emissiveIntensity = show * (1.3 + Math.sin(now * 0.02) * 0.25);
    this.hammerMat.opacity = 0.55 + show * 0.37;
    this.hammerLight.intensity = show * 2.8 * (1 + Math.sin(now * 0.018) * 0.15);
    const sshow = this.swordShow;
    this.swordG.visible = sshow > 0.04;
    this.swordMat.emissiveIntensity = sshow * (1.2 + Math.sin(now * 0.022) * 0.25);
    this.swordMat.opacity = 0.5 + sshow * 0.4;
    if (show > 0.05 && show < 0.96 && Math.random() < dt * 22) {
      this.hammerG.getWorldPosition(SUMMON_TMP);
      this.gold.burst(SUMMON_TMP, 2, 1.1, 0.9, 0.4);                         // 凝聚金尘
    }
    if (sshow > 0.05 && sshow < 0.96 && Math.random() < dt * 22) {
      this.swordG.getWorldPosition(SUMMON_TMP);
      this.gold.burst(SUMMON_TMP, 2, 1.0, 0.8, 0.4);
    }
  }

  /** 唤醒：佝偻拄杖石像 1.9s → 抬身（守门人缓起，额间金光点燃） */
  protected override updateRising(dt: number): void {
    this.t += dt;
    this.lerpPose(STATUE, STANCE, smooth(clamp01(this.t / 1.9)));
    if (Math.random() < dt * 8) this.vfx.dust.burst(this.root.position, 2, 2, 0.6);
    if (this.t > 0.45 && this.t - dt <= 0.45) this.host.onBossReveal();
    if (this.t >= 1.9) { this.state = "combat"; this.sub = "idle"; this.t = 0; }
  }

  /** 金瞳/预言金光呼吸 / 长袍摆动 / 召唤武器显形缓动 / 杖光按判定段补画 / 二阶段金光披身 + 数值 buff 一次性写入 */
  protected override updateVisuals(): void {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastVisT) / 1000);
    this.lastVisT = now;
    this.gold.update(dt);
    const p2 = this.phase === 2;
    const flick = 1 + Math.sin(now * 0.018) * 0.15;
    let eye = (this.state === "statue" ? 0.3 : p2 ? 2.0 : 0.85) + Math.sin(now * 0.004) * 0.2;
    if (this.state === "transform") eye += seg(this.t, 0, 0.55) * 1.6;       // 变身点燃
    this.eyeMat.emissiveIntensity = Math.max(0, eye);
    let prop = p2 ? 2.2 : 0.7;
    if (this.state === "transform") prop += seg(this.t, 0, 0.55) * 2.2;
    this.goldLight.intensity = prop * flick;
    this.runeMat.emissiveIntensity = (p2 ? 1.3 : 0.35) * flick;
    for (let i = 0; i < this.robe.length; i++) {
      const s = this.robe[i];
      s.rotation.x = 0.03 + Math.sin(now * 0.0026 + i * 1.2) * 0.05 + this.pose.lean * 0.15;
      s.rotation.z = Math.sin(now * 0.0021 + i * 1.7) * 0.04;
    }
    for (let i = 0; i < this.rags.length; i++) {
      const s = this.rags[i];
      s.rotation.x = 0.12 + Math.sin(now * 0.003 + i * 2.1) * 0.1 + this.pose.lean * 0.2;
    }
    // 二阶段预言金光披身：周身金尘缕缕
    if (p2 && this.state !== "statue" && Math.random() < dt * 9) {
      this.gold.burst(this.chestWorld(), 1, 0.5, 1.5, 0.3);
    }
    // 杖光：杖剑三连每段一道（hitFired 无条件按节拍推进，躲开也照画；首段与命中同帧）
    if (this.state === "combat" && this.sub === "act" && this.move?.name === "margitCombo") {
      while (this.slashFired < this.hitFired) {
        this.slashFired++;
        this.vfx.slash(this.chestWorld(), this.yaw, this.move.range * 0.85, false,
          p2 || this.slashFired === 3 ? GOLD : GOLD_SLASH);                  // 第三段金剑金色
      }
    }
    // 二阶段数值 buff：一次性改写共享帧数据表（reset 还原）
    if (p2 && !this.p2Applied) this.applyPhase2Moves();
  }

  /** 二阶段：全部前摇 ×0.88、全招伤害 ×1.15（守门人认真起来） */
  private applyPhase2Moves(): void {
    this.p2Applied = true;
    for (const m of Object.values(MOVES_MARGIT)) {
      m.startup = P1_BASE[m.name].startup * 0.88;
      m.dmg = Math.round(P1_BASE[m.name].dmg * 1.15);
    }
  }
  private restorePhase1Moves(): void {
    this.p2Applied = false;
    for (const m of Object.values(MOVES_MARGIT)) {
      m.startup = P1_BASE[m.name].startup;
      m.dmg = P1_BASE[m.name].dmg;
    }
  }

  /** 佝偻跛行（低频起伏 + 前倾摆动） */
  protected override onIdleWalk(): void {
    const w = performance.now() * 0.008;
    this.pose.y = Math.abs(Math.sin(w)) * 0.04 - 0.014;
    this.pose.lean = 0.17 + Math.sin(w * 2) * 0.035;
  }

  /** 位移基准与段计数复位：直击戳步 / 杖背藏远身前冲（冲到第一段判定才到位）/ 跃空刺前扑 / 锤跃落点 / 匕首退击后跳 */
  protected override onMoveStart(m: MoveDef, toPlayer: THREE.Vector3, dist: number): void {
    this.lastMoveName = m.name;
    this.moveFrom.copy(this.root.position);
    this.slashFired = 0;
    this.daggerFired = 0;
    this.daggerTotal = this.phase === 2 ? 3 : 2;   // 二阶段咒刃三连发
    this.fxStep = 0;
    this.moveLen = 0;
    this.windupFar = false;
    // 尾扫要留在当前朝向（绕背才有意义）。其他招出手时把判定朝向对准玩家，避免前冲方向和扇形朝向拧着空挥。
    if (m.name !== "margitTail" && toPlayer.lengthSq() > 1e-6) {
      this.yaw = Math.atan2(toPlayer.x, toPlayer.z);
    }
    const aim = () => {
      if (toPlayer.lengthSq() > 1e-6) this.moveDir.copy(toPlayer).setY(0).normalize();
      else this.moveDir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    };
    if (m.name === "margitStaff") {
      aim();
      this.moveLen = Math.min(m.lunge ?? 0, Math.max(0, dist - 1.6));
    } else if (m.name === "margitWindup") {
      this.windupFar = dist > 3.2;                                          // wiki：近身砸地 / 远身前冲双旋
      if (this.windupFar) {
        m.hits = 2;
        m.active = WINDUP_FAR_ACTIVE;
        aim();
        this.moveLen = Math.min(m.lunge ?? 0, Math.max(0, dist - 1.2));
      } else {
        m.hits = 1;                                                          // 近身只砸一下，不把双旋的第二段钳进来
        m.active = WINDUP_NEAR_ACTIVE;
      }
    } else if (m.name === "margitLeap") {
      aim();
      this.moveLen = Math.min(m.lunge ?? 0, Math.max(0, dist - 1.2));
    } else if (m.name === "margitHammerLeap") {
      aim();
      this.moveLen = Math.min(m.lunge ?? 0, Math.max(0, dist - 1.6));
    } else if (m.name === "margitRetreat") {
      this.moveDir.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));        // 面向玩家后，沿面向反向后跳 1.5m
      this.moveLen = 1.5;
    }
  }

  /** 共享表上的杖背藏时序回到远身双旋。近身单砸只在该次出手期间改写。 */
  private restoreWindupTiming(): void {
    const w = MOVES_MARGIT.margitWindup;
    w.hits = 2;
    w.hitInterval = HIT_GAP;
    w.active = WINDUP_FAR_ACTIVE;
  }

  /** 判定段开始：咒刃首发。尾扫刀光跟判定帧走；退击的咒刃在后跳之后才投；双旋刀光也跟判定帧。 */
  protected override onMoveActive(m: MoveDef): void {
    if (m.name === "margitDaggers") this.fireDagger(this.daggerFired);
  }

  /** 咒刃发射：首发正向，后续交替偏航 ±0.14 扇形撒布；自胸口高 1.7 甩出 */
  private fireDagger(i: number): void {
    this.daggerFired++;
    const off = i === 0 ? 0 : i % 2 === 1 ? 0.14 : -0.14;
    const origin = this.chestWorld().setY(1.7);
    this.host.fireProjectile?.(origin, this.yaw + off, DAGGER_PROJ);
    this.vfx.slash(origin, this.yaw + off, 0.9, false, GOLD);
  }

  /** 重招风声更闷 */
  protected override activeWhooshVolume(m: MoveDef): number {
    return m.name === "margitHammer" || m.name === "margitHammerLeap" || m.name === "margitWindup" ? 0.6 : m.name === "margitTail" || m.name === "margitLeap" ? 0.8 : 1;
  }

  /** 破绽：佝偻咒体前倾垮伏，咒杖垂荡 */
  protected override updateStaggerPose(): void {
    this.lerpPose(STANCE, { ...STANCE, lean: 0.55, crouch: 0.42, y: -0.32, nod: 0.42, rLift: 0.15, rSwing: 0.45, lLift: 0.15, lSwing: -0.4, tail: 0.5 }, Math.min(1, this.t * 5));
  }

  /** 弹反踉跄：后仰 + 双臂上荡（窗口已收窄——parriedDur 1.45，处决要果断） */
  protected override updateParriedPose(): void {
    this.lerpPose(STANCE, { ...STANCE, lean: -0.45, crouch: 0.3, y: -0.36, nod: -0.22, rLift: -0.85, rSwing: 0.35, lLift: -0.85, lSwing: -0.35, tail: -0.5 }, Math.min(1, this.t * 8));
  }

  /** 变身即攻击演出（wiki）：蜷身召锤（0.55 金光披身）→ 扛肩 → 正面横扫 → 高跃 → 1.55s 落锤砸地出冲击波
   *  （基类在 transformHitAt 时刻回调 onBossTransform 交 game 侧结算震波伤害——贴脸会被横扫/落锤打中） */
  protected override updateTransform(): void {
    if (this.t >= 0.55 && this.phase === 1) {
      this.phase = 2;          // 金瞳/符文/披身金尘/召唤武器增辉由 updateVisuals 跟随 phase 写入
      this.gold.burst(this.chestWorld(), 26, 4, 1.5, 0.7);
    }
    if (this.t < 0.55) {
      this.lerpPose(STANCE, TF_GATHER, smooth(this.t / 0.55));
    } else if (this.t < 0.95) {
      this.lerpPose(TF_GATHER, TF_CARRY, smooth(seg(this.t, 0.55, 0.95)));
    } else if (this.t < 1.25) {
      this.lerpPose(TF_CARRY, TF_SWEEP, smooth(seg(this.t, 0.95, 1.25)));
    } else if (this.t < this.transformHitAt) {
      this.lerpPose(TF_SWEEP, TF_AIR, smooth(seg(this.t, 1.25, this.transformHitAt)));
      this.pose.y = seg(this.t, 1.25, this.transformHitAt) * 1.1;            // 跃起
    } else {
      if (this.prevTfT < this.transformHitAt) {                              // 落锤帧：金爆（基类同帧出冲击环/震屏/震波回调）
        this.gold.burst(this.root.position.clone().setY(0.8), 18, 4, 1.2, 0.6);
        this.vfx.ring(this.root.position, 5.5, GOLD);
      }
      const k = smooth(seg(this.t, this.transformHitAt, this.transformHitAt + 0.2));
      this.lerpPose(TF_AIR, TF_SLAM, k);
      this.pose.y = 1.1 + (TF_SLAM.y - 1.1) * k;                                 // 从跃起高度落下（lerp 会覆盖提前写入的 y）
      if (this.t > this.transformHitAt + 0.2) {
        this.lerpPose(TF_SLAM, STANCE, smooth(seg(this.t, this.transformHitAt + 0.2, this.transformDur)));
      }
    }
    this.prevTfT = this.t;
  }

  /** 死亡：前倾垮塌 + 余烬 + 最后一缕金尘散尽 */
  protected override updateDeath(dt: number): void {
    this.lerpPose(this.pose, { ...STANCE, lean: 1.2, y: -0.85, crouch: 0.55, nod: 0.55, rLift: 0.25, rSwing: 0.55, lLift: 0.25, lSwing: -0.55, tail: 0.6 }, dt * 3.5);
    if (Math.random() < dt * 20) this.vfx.embers.burst(this.chestWorld(), 3, 3, 1.2);
    if (Math.random() < dt * 6) this.gold.burst(this.chestWorld(), 1, 0.8, 1.4, 0.4);
  }

  protected override releaseSharedState(): void {
    if (this.p2Applied) this.restorePhase1Moves();
    this.restoreWindupTiming();
  }

  protected override resetVisuals(): void {
    this.restorePhase1Moves();
    this.fxStep = 0;
    this.slashFired = 0;
    this.daggerFired = 0;
    this.daggerTotal = 2;
    this.windupFar = false;
    this.lastMoveName = "";
    this.restoreWindupTiming();
    this.prevTfT = 0;
    this.hammerShow = 0;
    this.swordShow = 0;
    this.hammerG.visible = false;
    this.swordG.visible = false;
    this.hammerLight.intensity = 0;
    this.goldLight.intensity = 0.7;
    this.eyeMat.emissiveIntensity = 0.85;
    this.runeMat.emissiveIntensity = 0.35;
    this.lerpPose(STANCE, STATUE, 1);
  }

  /** 金尘粒子池挂在 scene 直下（不随 root），dispose 时需单独摘除并释放 GPU 资源 */
  protected override extraDispose(): void {
    this.gold.mesh.geometry.dispose();
    (this.gold.mesh.material as THREE.Material).dispose();
    this.gold.mesh.removeFromParent();
  }

  // ---------------- 选招（守门人权重：绕背尾扫 / 贴身退击+尾击 / 中距杖压+杖背藏 / 远距咒刃+跃空刺压制） ----------------
  protected override pickMove(dist: number): MoveDef | null {
    this.restoreWindupTiming();
    const M = MOVES_MARGIT;
    const ready = (m: MoveDef) => (this.cds[m.name] ?? 0) <= 0 && (!m.phase2Only || this.phase === 2);
    const toP = this.playerPos.clone().sub(this.root.position); toP.y = 0;
    const dirYaw = Math.atan2(toP.x, toP.z);
    // 绕背提高尾扫权重，但不在冷却结束的那一帧强制出手。冷却由 ready 守住。
    const behind = dist < 2.8 && toP.lengthSq() > 0.04 && !angleWithin(this.yaw, dirYaw, 2.2);
    if (dist > 6) {
      // 远档：咒刃压制（惩罚站桩/喝药）+ 跃空刺。超过 LEAP_REACH 不跳，走近再打。
      const far: [MoveDef, number][] = [
        [M.margitDaggers, 3],
        [M.margitLeap, dist <= LEAP_REACH ? 2.5 : 0],
      ];
      const farCands = far.filter(([m, w]) => w > 0 && ready(m));
      return this.pickWeighted(farCands);
    }
    const pool: [MoveDef, number][] = dist < 2.2 ? [
      [M.margitTail, behind ? 5.5 : 4.5],                                     // 绕背偏爱尾扫，贴身仍可脱身，但不是必出
      [M.margitStaff, 3],
      [M.margitCombo, 2.5],
      [M.margitRetreat, dist < 1.8 ? 2 : 0],                                  // 极贴身：斩→后跳→投刃
    ] : [
      [M.margitStaff, 3],
      [M.margitCombo, 3],
      [M.margitWindup, 2.5],                                                  // 招牌欺诈延迟
      [M.margitHammer, this.phase === 2 ? 3 : 2.5],                           // 二阶段更爱召锤（收尾技）
      [M.margitHammerLeap, this.phase === 2 && dist >= 2.5 ? 2 : 0],          // 二阶段锤跃：举锤悬停后砸
      [M.margitDaggers, dist >= 4.5 ? 1.5 : 0],                               // 中远缀咒刃骚扰
      [M.margitTail, behind ? 5.5 : 0],
    ];
    // 投射物不吃近战射程闸。带 lunge 的招用「射程 + 冲程」判断够不够得着，避免前冲技被原地射程误杀、或够不着还空挥。
    const inReach = (m: MoveDef) => !!m.proj || dist < m.range * 0.95 + (m.lunge ?? 0);
    const cands = pool.filter(([m, w]) => w > 0 && ready(m) && inReach(m));
    if (!cands.length) return null;
    return this.pickWeighted(cands);
  }

  private pickWeighted(cands: [MoveDef, number][]): MoveDef | null {
    if (!cands.length) return null;
    const hasAlt = cands.some(([m]) => m.name !== this.lastMoveName);
    let sum = 0;
    const weighted = cands.map(([m, w]) => {
      const adj = hasAlt && m.name === this.lastMoveName ? w * 0.2 : w;
      sum += adj;
      return [m, adj] as [MoveDef, number];
    });
    if (sum <= 0) return null;
    return pickByWeight(weighted) ?? weighted[0][0];
  }
}

/** 召唤武器凝聚金尘的取位临时量（避免每帧分配） */
const SUMMON_TMP = new THREE.Vector3();
