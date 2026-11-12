/** Boss #5「恶兆妖鬼玛尔基特」（艾尔登法环·宁姆格福守门人，同人改编，帧数据对照 fextralife wiki 忠实校正）
 * 通用机制（状态机/削韧破绽/弹反/多段判定/击飞/冷却/走近追踪/阶段转换）全在 BossBase（boss-base.ts），
 * 本文件只保留玛尔基特专属：
 * - MOVES_MARGIT/FEEL_MARGIT 模块加载即并入 config 总表（调校台/存档自动收录，不改现有文件）
 * - 金色召唤武器体系（身份标识）：金锤/金剑 emissive 半透明网格在招式开始时凭空显形（hammerShow/swordShow 缓动）
 * - 咒刃经 host.fireProjectile → game 侧 Projectiles 池；二连发惩罚中远距站桩/喝药贪刀（wiki：常在玩家回血时投掷）
 * - 欺诈性延迟前摇：杖背藏（Windup）拖到极限才爆发，近身砸地 / 远身前冲双旋（运行时按距离分支）
 * - 匕首退击（斩→后跳→投刃两段闪避）、跃空刺（悬停→下刺，落地大硬直=惩罚窗口）、绕背尾扫
 * - 连段按站位延长：杖剑三连近身 40% 接金锤收尾（chain=杖→剑→锤武器切换），咒刃后接突进挥击
 * - 二阶段（hp≤65%）：变身即攻击演出「召锤扛肩→正面横扫→高跃→落锤冲击波」，之后金光披身：
 *   前摇 ×0.88 / 伤害 ×1.15 / 咒刃三连发 / 无预警锤跃；弹反收益降一档（parriedDur 1.45）
 * 配色纪律：全局冷灰咒体 + 预言金光 0xd8b46a 点缀，无高饱和色。
 */
import * as THREE from "three";
import { MOVES, FEEL, MoveDef, FeelDef } from "./config";
import { Vfx, Particles } from "./vfx";
import { AU } from "./audio";
import { BossBase, BossStats, clamp01, smooth, seg, angleWithin } from "./boss-base";
import type { BossHost } from "./boss-base";
import type { ProjDef } from "./projectile";

export type { BossState, BossHost } from "./boss-base";

// ---------------- 主题色（冷灰咒体 + 预言金光唯一强调色） ----------------
const GOLD = 0xd8b46a;        // 预言金光 / 召唤武器（巨锤/直剑/咒刃）统一辉光
const GOLD_SLASH = 0xcfc4a4;  // 杖风轨迹（灰金，一阶段）
const SKIN = 0x8a7d6b;        // 灰褐皮肤（枯瘦咒体）
const SKIN_DARK = 0x6b6053;
const ROBE = 0x37332d;        // 破布长袍（灰褐粗布）
const ROBE_DARK = 0x28251f;
const WOOD = 0x4a3d2c;        // 咒杖木色

/** 咒刃投射物：速度 12，drop 每秒下坠 1.1 制造抛物线弹道，life 1.6s ≈ 19m 射程后自散 */
const DAGGER_PROJ: ProjDef = { speed: 12, radius: 0.4, dmg: 14, feelKey: "mMagic", life: 1.6, color: GOLD, drop: 1.1 };

// ---------------- 帧数据（键名 margit 前缀 / 手感键 m 开头；fextralife wiki 忠实校正） ----------------
export const MOVES_MARGIT: Record<string, MoveDef> = {
  // 咒杖直击（Staff Stab）：直线前刺，可弹反；前冲 1.0m 在 movePose tel 段消费
  margitStaff: {
    name: "margitStaff", label: "咒杖直击", startup: 0.50, active: 0.16, recovery: 0.80,
    dmg: 20, range: 3.8, arc: 0.9, lunge: 1.0, parryable: true, cd: 2.2, feel: "mLight",
  },
  // 杖剑三连（Staff Swing 连击 + 召唤剑收尾）：3 段判定，节奏 0.5s。
  // 多段时间轴：第 k 段在 min(active*0.4 + k*0.5, active)，active ≥ 1.67 才能三段全触发 → 取 1.7（0.68/1.18/1.68）。
  // 近身 40% 接金锤收尾（chain）＝wiki「武器切换连段 杖→剑→锤」的近身延长风味；第三段为左手召唤金剑挥斩
  margitCombo: {
    name: "margitCombo", label: "杖剑三连", startup: 0.35, active: 1.7, recovery: 0.85,
    dmg: 12, range: 3.2, arc: 1.6, hits: 3, hitInterval: 0.5, chain: "margitHammer",
    parryable: true, cd: 4.2, feel: "mLight",   // 仅首段可弹反由引擎保证（首段命中关窗）
  },
  // 杖背藏（Windup Attack·招牌欺诈延迟）：杖收到背后长前摇 1.25s（前 50% 就蓄好型然后静止骗提前翻滚），
  // 末 20% 才爆发：近身（<3.2m 运行时判定）砸地出环 / 远身前冲 5m 顺时针双旋斩（2 段判定 0.35s 间隔）
  margitWindup: {
    name: "margitWindup", label: "杖背藏", startup: 1.25, active: 0.30, recovery: 1.0,
    dmg: 26, range: 4.4, arc: 2.4, hits: 2, hitInterval: 0.35, lunge: 5.0,
    parryable: true, cd: 6.5, feel: "mHeavy",
  },
  // 召唤金锤（Hammer Slam）：长前摇 1.1s（后半段金锤显形），抬左腿→巨锤下劈，收招硬直 1.5s 可贪刀；
  // 砸地金色冲击环 + 震屏走 hammerImpact 自放（不走 MoveDef.shock 基类暖色路径，保证金光主题）
  margitHammer: {
    name: "margitHammer", label: "召唤金锤", startup: 1.1, active: 0.16, recovery: 1.5,
    dmg: 34, range: 3.6, arc: 1.2, parryable: true, cd: 6.0, feel: "mHeavy",
  },
  // 锤跃（Hammer Leap·二阶段）：无预警原地高跳 + 砸地金色冲击波；出手即显形（hammerShow 快速通道）
  margitHammerLeap: {
    name: "margitHammerLeap", label: "锤跃", startup: 0.40, active: 0.15, recovery: 1.5,
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
  // 匕首退击（Dagger Retreat）：贴身时斩一刀 → 后跳 1.5m → 投出咒刃（两段闪避节奏）；位移在 tel 段反向
  margitRetreat: {
    name: "margitRetreat", label: "匕首退击", startup: 0.30, active: 0.14, recovery: 0.80,
    dmg: 14, range: 2.6, arc: 2.2, parryable: false, cd: 7.0, feel: "mLight",
  },
  // 横扫尾击（Tail Swipe）：贴身/绕背脱身用，小半径全周判定 + 小击飞（knockUp 由 player.applyHit 抛物线消费）
  margitTail: {
    name: "margitTail", label: "横扫尾击", startup: 0.45, active: 0.22, recovery: 1.0,
    dmg: 22, range: 3.0, arc: 6.28, knockUp: 3.5, parryable: false, cd: 6.5, feel: "mHeavy",
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

  // ---------------- 外观：枯瘦高大咒物妖鬼（肩宽 ~0.9 / 高 ~2.9，佝偻 + 咒杖 + 破布长袍 + 双角 + 额前金光） ----------------
  protected override buildBody(): void {
    const skin = new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.95, metalness: 0.02, flatShading: true });
    const skinDark = new THREE.MeshStandardMaterial({ color: SKIN_DARK, roughness: 1, flatShading: true });
    const robe = new THREE.MeshStandardMaterial({ color: ROBE, roughness: 1, flatShading: true });
    const robeDark = new THREE.MeshStandardMaterial({ color: ROBE_DARK, roughness: 1, flatShading: true });
    const wood = new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.9, flatShading: true });
    const steel = new THREE.MeshStandardMaterial({ color: 0x565c66, roughness: 0.5, metalness: 0.5, flatShading: true });
    this.runeMat = new THREE.MeshStandardMaterial({ color: 0xb99a55, emissive: GOLD, emissiveIntensity: 0.35, roughness: 0.4, metalness: 0.3, flatShading: true });
    this.eyeMat = new THREE.MeshStandardMaterial({ color: 0x120d06, roughness: 0.5, emissive: GOLD, emissiveIntensity: 0.85 });
    this.hammerMat = new THREE.MeshStandardMaterial({ color: 0xcbb277, emissive: GOLD, emissiveIntensity: 0, roughness: 0.35, metalness: 0.5, flatShading: true, transparent: true, opacity: 0.92 });
    this.swordMat = new THREE.MeshStandardMaterial({ color: 0xd6bd82, emissive: GOLD, emissiveIntensity: 0, roughness: 0.3, metalness: 0.55, flatShading: true, transparent: true, opacity: 0.9 });

    const box = (w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z); m.castShadow = true;
      return m;
    };

    // 枯瘦双腿（袍下若隐若现）——髋枢轴 + 膝枢轴（crouch 弯折 / legL 抬左腿）——腿根 y 1.5（高大）
    for (const [leg, shin, sx] of [[this.legR, this.shinR, 0.16], [this.legL, this.shinL, -0.16]] as [THREE.Group, THREE.Group, number][]) {
      leg.position.set(sx, 1.5, 0);
      leg.add(box(0.15, 0.68, 0.18, skinDark, 0, -0.34, 0));                 // 大腿
      shin.position.set(0, -0.68, 0);
      shin.add(box(0.12, 0.62, 0.14, skinDark, 0, -0.31, 0.01));             // 小腿
      shin.add(box(0.15, 0.08, 0.3, skinDark, 0, -0.62, 0.07));              // 足
      leg.add(shin);
      this.body.add(leg);
    }
    // 骨盆 + 绳腰带（守门人的粗绳束腰）
    this.body.add(box(0.4, 0.26, 0.3, skinDark, 0, 1.52, 0));
    this.body.add(box(0.46, 0.08, 0.36, robeDark, 0, 1.42, 0));
    this.body.add(box(0.07, 0.16, 0.05, robeDark, 0.16, 1.36, 0.19));
    // 破布长袍下摆：阶梯四层 + 摆缘破布条六片（随步态摆动，见 updateVisuals）
    this.robe.push(
      box(0.52, 0.34, 0.4, robe, 0, 1.3, 0),
      box(0.62, 0.34, 0.48, robe, 0, 1.0, 0),
      box(0.74, 0.34, 0.56, robeDark, 0, 0.7, 0),
      box(0.86, 0.3, 0.64, robeDark, 0, 0.44, 0.02),
    );
    for (const s of this.robe) this.body.add(s);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.4;
      const strip = box(0.09, 0.32 + (i % 3) * 0.08, 0.03, robeDark, Math.sin(a) * 0.44, 0.32, Math.cos(a) * 0.44);
      strip.rotation.y = a;
      this.rags.push(strip);
      this.body.add(strip);
    }
    // 尾（袍下三节，横扫尾击时甩出）
    this.tailG.position.set(0, 1.44, -0.2);
    this.tailG.add(box(0.16, 0.16, 0.48, skinDark, 0, 0, -0.24));
    this.tailG.add(box(0.13, 0.13, 0.42, skinDark, 0, -0.08, -0.62));
    this.tailG.add(box(0.1, 0.1, 0.34, skinDark, 0, -0.2, -0.94));
    this.body.add(this.tailG);

    // 躯干（窄削佝偻）——底座 y 1.64
    this.torso.position.y = 1.64;
    this.torso.add(box(0.36, 0.3, 0.26, skinDark, 0, 0.05, 0));              // 腹
    this.torso.add(box(0.44, 0.4, 0.3, robe, 0, 0.38, 0));                   // 胸（袍裹）
    this.torso.add(box(0.4, 0.24, 0.32, robeDark, 0, 0.6, 0.01));            // 上层
    this.torso.add(box(0.34, 0.36, 0.06, skinDark, 0, 0.4, -0.17));          // 背脊（佝偻隆起）
    // 破烂肩布（非金属，咒体旅装）
    for (const s of [-1, 1]) {
      const p1 = box(0.24, 0.14, 0.3, robeDark, s * 0.3, 0.62, 0);
      p1.rotation.z = -s * 0.35;
      const p2 = box(0.16, 0.1, 0.24, robe, s * 0.38, 0.52, 0.02);
      p2.rotation.z = -s * 0.55;
      this.torso.add(p1, p2);
    }
    // 胸前垂绳（两股，挂一枚小骨符）
    this.torso.add(box(0.025, 0.4, 0.025, robeDark, 0.08, 0.3, 0.15));
    this.torso.add(box(0.025, 0.4, 0.025, robeDark, -0.08, 0.3, 0.15));
    this.torso.add(box(0.07, 0.1, 0.04, skinDark, 0, 0.12, 0.17));

    // 头：恶兆颅（瘦长）+ 后掠双角 + 金瞳 + 额前预言金光印记
    this.head.position.set(0, 0.82, 0.03);
    this.head.add(box(0.22, 0.3, 0.26, skin, 0, 0, 0));                      // 颅
    this.head.add(box(0.18, 0.12, 0.2, skinDark, 0, -0.18, 0.02));           // 颌
    this.head.add(box(0.2, 0.1, 0.06, skinDark, 0, 0.06, 0.12));             // 眉骨
    for (const ex of [-0.055, 0.055]) this.head.add(box(0.05, 0.035, 0.02, this.eyeMat, ex, 0.05, 0.145));
    const mark = box(0.06, 0.08, 0.02, this.runeMat, 0, 0.16, 0.135);        // 预言印记（斜置菱形）
    mark.rotation.z = Math.PI / 4;
    this.head.add(mark);
    for (const s of [-1, 1]) {                                               // 后掠双角（两节）
      const h1 = box(0.05, 0.3, 0.05, skinDark, s * 0.12, 0.22, -0.05);
      h1.rotation.set(-0.5, 0, -s * 0.5);
      const h2 = box(0.04, 0.26, 0.04, skinDark, s * 0.2, 0.42, -0.14);
      h2.rotation.set(-0.95, 0, -s * 0.7);
      this.head.add(h1, h2);
    }
    this.goldLight = new THREE.PointLight(GOLD, 0.7, 5, 2);
    this.goldLight.position.set(0, 0.16, 0.32);
    this.head.add(this.goldLight);
    this.torso.add(this.head);

    // 右臂 + 咒杖（长 2.3，握中段，顶端分叉咒枝 + 金符文环）
    this.armR.position.set(0.34, 0.6, 0);
    this.armR.add(box(0.11, 0.5, 0.13, skinDark, 0, -0.22, 0));
    this.armR.add(box(0.09, 0.46, 0.11, skin, 0, -0.6, 0.02));
    this.armR.add(box(0.1, 0.12, 0.12, skinDark, 0, -0.9, 0.04));            // 枯爪握持
    const staff = new THREE.Group();
    staff.position.set(0, -0.98, 0.06);
    staff.rotation.x = 0.16;                                                 // 杖尾后曳
    staff.add(box(0.055, 0.16, 0.055, robeDark, 0, 0.05, 0));                // 握柄缠布
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.05, 2.3, 6), wood);
    shaft.position.y = -0.22; shaft.castShadow = true;
    staff.add(shaft);
    const fork1 = box(0.035, 0.42, 0.035, wood, 0.06, 1.0, 0);
    fork1.rotation.z = -0.55;
    const fork2 = box(0.03, 0.34, 0.03, wood, -0.07, 0.95, 0);
    fork2.rotation.z = 0.6;
    staff.add(fork1, fork2);
    staff.add(box(0.075, 0.035, 0.075, this.runeMat, 0, 0.42, 0));           // 金符文环 ×2
    staff.add(box(0.07, 0.03, 0.07, this.runeMat, 0, 0.78, 0));
    staff.add(box(0.07, 0.09, 0.07, wood, 0.01, 0.12, 0.02));                // 瘤结
    this.armR.add(staff);
    // 召唤金锤（Giant-Crusher 风味）：挂右手，显形度 updateVisuals 缓动（hammerShow）
    this.hammerG.position.set(0, -1.02, 0.16);
    this.hammerG.add(box(0.055, 0.66, 0.055, wood, 0, -0.1, 0));             // 短柄
    this.hammerG.add(box(0.46, 0.34, 0.42, this.hammerMat, 0, 0.32, 0));     // 金锤头
    this.hammerG.add(box(0.5, 0.08, 0.46, this.hammerMat, 0, 0.14, 0));      // 锤颈箍
    this.hammerLight = new THREE.PointLight(GOLD, 0, 4, 2);
    this.hammerLight.position.set(0, 0.32, 0);
    this.hammerG.add(this.hammerLight);
    this.hammerG.visible = false;
    this.armR.add(this.hammerG);
    this.torso.add(this.armR);

    // 左臂 + 枯爪 + 袖中咒刃（投掷位）
    this.armL.position.set(-0.34, 0.6, 0);
    this.armL.add(box(0.11, 0.48, 0.13, skinDark, 0, -0.21, 0));
    this.armL.add(box(0.09, 0.44, 0.11, skin, 0, -0.57, 0.02));
    this.armL.add(box(0.1, 0.1, 0.11, skinDark, 0, -0.85, 0.04));
    for (let i = 0; i < 3; i++) {                                            // 三根枯爪
      const claw = box(0.02, 0.14, 0.03, skinDark, -0.03 + i * 0.03, -0.95, 0.06);
      claw.rotation.x = 0.5 + i * 0.12;
      this.armL.add(claw);
    }
    const heldBlade = box(0.035, 0.4, 0.015, steel, 0, -0.75, 0.1);          // 袖中咒刃（钝钢）
    heldBlade.rotation.x = 0.35;
    this.armL.add(heldBlade);
    // 召唤金剑（Carian 直剑风味）：挂左手，杖剑三连第三拍显形挥斩（swordShow）
    this.swordG.position.set(0, -0.92, 0.08);
    this.swordG.rotation.x = 0.2;
    this.swordG.add(box(0.05, 0.18, 0.05, robeDark, 0, 0, 0));               // 柄
    this.swordG.add(box(0.24, 0.04, 0.05, this.swordMat, 0, -0.12, 0));      // 护手
    this.swordG.add(box(0.07, 1.15, 0.022, this.swordMat, 0, -0.72, 0));     // 剑身
    this.swordG.add(box(0.045, 0.18, 0.018, this.swordMat, 0, -1.38, 0));    // 剑尖收锋
    this.swordG.visible = false;
    this.armL.add(this.swordG);
    this.torso.add(this.armL);

    this.root.add(this.body);
    this.body.add(this.torso);
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
      // 跃空刺专属：深蹲 → 前扑+升空 → 空中悬停（欺诈延迟：最高点停一瞬）→ act 段下刺钉地
      if (sub === "tel") {
        this.lerpPose(STANCE, LWIND, smooth(Math.min(1, t / (m.startup * 0.3))));
        const k = clamp01(seg(t, m.startup * 0.3, m.startup * 0.9));
        const ks = smooth(k);
        if (k > 0) {
          this.root.position.copy(this.moveFrom).addScaledVector(this.moveDir, this.moveLen * ks);
          this.lerpPose(LWIND, LHOVER, ks);
          this.pose.y = Math.sin(Math.min(1, k) * Math.PI / 2) * 1.55;       // 升到顶点后悬停不落（须在 lerp 之后）
          if (Math.random() < 0.4) this.vfx.dust.burst(this.root.position.clone().setY(0.2), 2, 2, 0.6);
        }
        return;
      }
      if (sub === "act") {
        this.lerpPose(LHOVER, LSTAB, seg(t, 0, m.active));
        this.pose.y = 1.55 * Math.max(0, 1 - t / m.active);                  // 下刺：整段钉到地（须在 lerp 之后）
        return;
      }
      this.lerpPose(LSTAB, STANCE, smooth(seg(t, m.recovery * 0.25, m.recovery)));   // 落地大硬直（惩罚窗口）
      return;
    }
    if (m.name === "margitHammerLeap") {
      // 锤跃专属（二阶段无预警）：急蹲 → 原地高跳（微前扑）→ 落锤金爆
      if (sub === "tel") {
        this.lerpPose(STANCE, HLW, smooth(Math.min(1, t / (m.startup * 0.5))));
        const k = smooth(seg(t, m.startup * 0.5, m.startup));
        if (k > 0) {
          this.root.position.copy(this.moveFrom).addScaledVector(this.moveDir, this.moveLen * k);
          this.lerpPose(HLW, HLAIR, k);
          this.pose.y = Math.sin(k * Math.PI) * 1.8;                          // 高跳抛物线（须在 lerp 之后）
        }
        return;
      }
      if (sub === "act") {
        this.lerpPose(HLAIR, HLSLAM, seg(t, 0, m.active));
        this.hammerImpact(t, m, 5.5);
        return;
      }
      this.lerpPose(HLSLAM, STANCE, smooth(seg(t, m.recovery * 0.25, m.recovery)));
      return;
    }
    if (m.name === "margitWindup") {
      // 杖背藏专属（欺诈延迟）：前 50% 蓄好型 → 僵住骗提前翻滚 → 末 20% 才爆发
      if (sub === "tel") {
        const near = !this.windupFar;
        const coil = near ? WU2W : WUW;
        this.lerpPose(STANCE, coil, smooth(Math.min(1, t / (m.startup * 0.5))));   // 蓄到位后静止
        if (!near) {
          const k = smooth(clamp01((t - m.startup * 0.78) / (m.startup * 0.22)));   // 远身：末 20% 爆发前冲
          if (k > 0) this.root.position.copy(this.moveFrom).addScaledVector(this.moveDir, this.moveLen * k);
        }
        return;
      }
      if (sub === "act") {
        if (this.windupFar) {
          // 远身：顺时针双旋斩（两拍与判定 0.12/0.30 对齐）
          const firstAt = m.active * 0.4;
          const ph = clamp01((t - firstAt) / Math.max(0.01, m.active - firstAt)) * 2;
          const idx = Math.min(1, Math.floor(ph));
          this.lerpPose(idx === 0 ? WUW : WUK, idx === 0 ? WUK : { ...WUK, twist: 0.85, rSwing: -1.35, lean: 0.34 }, smooth(clamp01(ph - idx)));
        } else {
          // 近身：收杖过头 → 砸地出环
          this.lerpPose(WU2W, WU2K, seg(t, 0, m.active));
          this.hammerImpact(t, m, 3.6);
        }
        return;
      }
      this.lerpPose(this.windupFar ? WUK : WU2K, STANCE, smooth(seg(t, m.recovery * 0.3, m.recovery)));
      return;
    }
    const wind: Pose = { ...STANCE }, strike: Pose = { ...STANCE };
    switch (m.name) {
      case "margitStaff":
        wind.twist = 0.5; wind.rLift = -0.7; wind.rSwing = -0.5; wind.crouch = 0.16; wind.lean = 0.1;
        strike.twist = -0.25; strike.rLift = 1.25; strike.rSwing = 0.1; strike.reach = 0.5; strike.lean = 0.4; strike.crouch = 0.12;
        break;
      case "margitHammer":
        Object.assign(wind, HW); Object.assign(strike, HK);
        break;
      case "margitDaggers":
        Object.assign(wind, DW); Object.assign(strike, DK);
        break;
      case "margitRetreat":
        Object.assign(wind, RTW); Object.assign(strike, RTK);
        break;
      case "margitTail":
        Object.assign(wind, TW); Object.assign(strike, TK);
        break;
    }
    if (sub === "tel") {
      this.lerpPose(STANCE, wind, smooth(seg(t, m.startup * 0.45, m.startup)));
      // 咒杖直击前戳步 / 匕首退击后跳（位移基准与方向在 onMoveStart 记录）
      if (this.moveLen !== 0) {
        const k = smooth(clamp01((t - m.startup * 0.3) / (m.startup * 0.7)));
        this.root.position.copy(this.moveFrom).addScaledVector(this.moveDir, this.moveLen * k);
      }
    } else if (sub === "act") {
      if (m.name === "margitCombo") this.comboPose(t, m);
      else this.lerpPose(wind, strike, seg(t, 0, m.active));
      if (m.name === "margitHammer") this.hammerImpact(t, m, 5.0);
    } else {
      this.lerpPose(strike, STANCE, smooth(seg(t, m.recovery * 0.35, m.recovery)));
    }
    void total;
  }

  /** 杖剑三连判定段姿态：三拍与引擎判定时刻对齐（首段 active*0.4=0.68，其后每 0.5s）；
   *  前两拍右杖抡、第三拍左手召唤金剑横收（杖→剑武器切换风味） */
  private comboPose(t: number, m: MoveDef): void {
    const firstAt = m.active * 0.4;
    const ph = clamp01((t - firstAt) / (m.active - firstAt)) * 3;
    const idx = Math.min(2, Math.floor(ph));
    const s = smooth(clamp01(ph - idx));
    const w = idx === 0 ? C1W : idx === 1 ? C2W : C3W;
    const k = idx === 0 ? C1K : idx === 1 ? C2K : C3K;
    this.lerpPose(w, k, s);
  }

  /** 金色落点表现：冲击环 + 金斑 + 震屏（金锤/锤跃/杖背藏近砸共用；与命中判定解耦——打中/躲开都应砸出坑） */
  private hammerImpact(t: number, m: MoveDef, radius: number): void {
    if (this.fxStep !== 0 || t < m.active * 0.5) return;
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

  /** 召唤武器显形：金锤——长前摇后半段渐显（咒力凝聚）/ 锤跃出手即显（无预警快速通道）/ 变身演出全程；
   *  金剑——杖剑三连 tel+act（左手召剑收尾）。半透明凭空浮现 → 凝成实体，凝聚时抽金尘 */
  private updateSummons(dt: number): void {
    const now = performance.now();
    let hammerTarget = 0, swordTarget = 0;
    if (this.state === "transform") {
      hammerTarget = 1;
    } else if (this.state === "combat" && this.move) {
      const n = this.move.name;
      if (n === "margitHammer") {
        hammerTarget = this.sub === "tel" ? (this.t >= this.move.startup * 0.45 ? 1 : 0) : this.sub === "act" ? 1 : 0;
      } else if (n === "margitHammerLeap") {
        hammerTarget = this.sub === "tel" || this.sub === "act" ? 1 : 0;
      } else if (n === "margitCombo") {
        swordTarget = this.sub === "tel" || this.sub === "act" ? 1 : 0;
      }
    }
    const hammerRate = this.move?.name === "margitHammerLeap" ? 14 : 9;
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

  /** 位移基准与段计数复位：直击戳步 / 杖背藏远身前冲（运行时分支）/ 跃空刺前扑 / 锤跃微前扑 / 匕首退击后跳（不越过玩家） */
  protected override onMoveStart(m: MoveDef, toPlayer: THREE.Vector3, dist: number): void {
    this.moveFrom.copy(this.root.position);
    this.slashFired = 0;
    this.daggerFired = 0;
    this.daggerTotal = this.phase === 2 ? 3 : 2;   // 二阶段咒刃三连发
    this.fxStep = 0;
    this.moveLen = 0;
    this.windupFar = false;
    if (m.name === "margitStaff") {
      this.moveDir.copy(toPlayer).setY(0).normalize();
      this.moveLen = Math.min(m.lunge ?? 0, Math.max(0, dist - 1.6));
    } else if (m.name === "margitWindup") {
      this.windupFar = dist > 3.2;                                          // wiki：近身砸地 / 远身前冲双旋
      if (this.windupFar) {
        this.moveDir.copy(toPlayer).setY(0).normalize();
        this.moveLen = Math.min(m.lunge ?? 0, Math.max(0, dist - 1.2));
      }
    } else if (m.name === "margitLeap") {
      this.moveDir.copy(toPlayer).setY(0).normalize();
      this.moveLen = Math.min(m.lunge ?? 0, Math.max(0, dist - 1.2));
    } else if (m.name === "margitHammerLeap") {
      this.moveDir.copy(toPlayer).setY(0).normalize();
      this.moveLen = Math.min(m.lunge ?? 0, Math.max(0, dist - 1.6));
    } else if (m.name === "margitRetreat") {
      this.moveDir.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));        // 沿面向反向后跳 1.5m
      this.moveLen = 1.5;
    }
  }

  /** 判定段开始：咒刃首发 / 匕首退击甩投 / 尾扫全周轨迹 / 杖背藏远身双旋宽弧 */
  protected override onMoveActive(m: MoveDef): void {
    if (m.name === "margitDaggers") {
      this.fireDagger(this.daggerFired);
    } else if (m.name === "margitRetreat") {
      this.fireDagger(0);                                                    // 后跳后追投一刀
    } else if (m.name === "margitTail") {
      this.vfx.slash(this.chestWorld().setY(0.7), this.yaw, m.range * 0.9, true, this.phase === 2 ? GOLD : GOLD_SLASH);
      this.vfx.dust.burst(this.root.position.clone().setY(0.25), 8, 2.4, 0.7);
    } else if (m.name === "margitWindup" && this.windupFar) {
      this.vfx.slash(this.chestWorld(), this.yaw + 0.2, m.range * 0.85, true, this.phase === 2 ? GOLD : GOLD_SLASH);
      this.vfx.slash(this.chestWorld().setY(1.1), this.yaw - 0.2, m.range * 0.8, true, GOLD_SLASH);
    }
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
  }

  protected override resetVisuals(): void {
    this.restorePhase1Moves();
    this.fxStep = 0;
    this.slashFired = 0;
    this.daggerFired = 0;
    this.daggerTotal = 2;
    this.windupFar = false;
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
    const M = MOVES_MARGIT;
    const ready = (m: MoveDef) => (this.cds[m.name] ?? 0) <= 0 && (!m.phase2Only || this.phase === 2);
    // 绕背优先甩尾（wiki Tail Swipe：身后来犯者）
    const toP = this.playerPos.clone().sub(this.root.position); toP.y = 0;
    const dirYaw = Math.atan2(toP.x, toP.z);
    if (dist < 2.8 && !angleWithin(this.yaw, dirYaw, 2.2) && ready(M.margitTail)) {
      return M.margitTail;
    }
    if (dist > 6) {
      // 远档：咒刃压制（惩罚站桩/喝药）+ 跃空刺突进（冲程 lunge 7 + 接触余量 ≈ 2.5，9.5 外够不着就踱步逼近）
      const far: [MoveDef, number][] = [
        [M.margitDaggers, 3],
        [M.margitLeap, dist <= 9.5 ? 2.5 : 0],
      ];
      const farCands = far.filter(([m, w]) => w > 0 && ready(m));
      return this.pickWeighted(farCands);
    }
    const pool: [MoveDef, number][] = dist < 2.2 ? [
      [M.margitTail, 4.5],                                                    // 贴身脱身优先
      [M.margitStaff, 3],
      [M.margitCombo, 2.5],
      [M.margitRetreat, dist < 1.8 ? 2 : 0],                                  // 极贴身：斩→后跳→投刃
    ] : [
      [M.margitStaff, 3],
      [M.margitCombo, 3],
      [M.margitWindup, 2.5],                                                  // 招牌欺诈延迟
      [M.margitHammer, this.phase === 2 ? 3 : 2.5],                           // 二阶段更爱召锤（收尾技）
      [M.margitHammerLeap, this.phase === 2 && dist >= 2.5 ? 2 : 0],          // 二阶段无预警锤跃
      [M.margitDaggers, dist >= 4.5 ? 1.5 : 0],                               // 中远缀咒刃骚扰
    ];
    // 投射物招（proj 字段）不吃近战 range 闸——其距离带已在权重里
    const cands = pool.filter(([m, w]) => w > 0 && ready(m) && (m.proj || dist < m.range * 0.95));
    if (!cands.length) return null;
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

/** 召唤武器凝聚金尘的取位临时量（避免每帧分配） */
const SUMMON_TMP = new THREE.Vector3();
