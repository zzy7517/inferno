/** Boss #7「恶兆王蒙格特」（艾尔登法环·王城罗德尔守门人，玛尔基特真身，同人改编，帧数据对照 fextralife wiki 忠实校正）
 * 通用机制（状态机/削韧破绽/弹反/多段判定/击飞/冷却/走近追踪/阶段转换）全在 BossBase（boss-base.ts），
 * 本文件只保留蒙格特专属：
 * - MOVES_MORGOTT/FEEL_MORGOTT 模块加载即并入 config 总表（调校台/存档自动收录，不改现有文件）
 * - 黄金魅影武器体系（玛尔基特同源但更王气）：金锤/王之剑（黄金魅影大剑）emissive 半透明网格凭空显形；
 *   二阶段拔出「蒙格特咒剑」（血焰巨剑，右手常驻）——wiki：诅咒爆发后以咒剑 + 血焰系攻击迎战
 * - 一阶段（读招考试·杖系）：王杖三连（2-4 段变奏：40% 接金锤下砸收尾 / 被绕背改尾刀）/ 横扫尾刀 /
 *   延迟下砸地板波（蓄势静止骗提前翻滚）/ 投掷魅影匕首（扇形三连，二阶段五连）/ 跳跃扑杀（悬停→砸地金波）
 * - 二阶段（hp≤60%）：变身演出「拄杖伏身咳喘（诅咒上涌）→ 起身拔咒剑 → 横斩金爆」；
 *   咒剑大剑三连（长发金色残影拖尾）/ 诅咒喷吐（扇形扫射）/ 血焰突斩（前冲双斩）/
 *   「王者之证」大范围黄金冲击波（1.6s 大前摇·高伤害·全额跑出 7m 才躲得开的读招大题）
 * - 二阶段血焰附魔强化普攻：一阶段招式 前摇 ×0.9 / 伤害 ×1.15 / 匕首扇面扩为五连
 * - 招式间安全踱步 + 突然变奏（wiki：节奏多变读招考试——匕首后概率接跃扑 / 三连后概率接下砸）
 * - 性能纪律：纯几何 + 顶点色合并网格（本体 16 mesh ≤20 dc），无 PointLight（全 emissive 呼吸）
 * 配色纪律：全局冷灰咒体 + 预言金光 0xd8b36a 家族 + 血焰暗红 0x9b3b32（=COLORS.hp 同族），无高饱和色。
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { MOVES, FEEL, MoveDef, FeelDef } from "./config";
import { Vfx, Particles } from "./vfx";
import { AU } from "./audio";
import { BossBase, BossStats, clamp01, smooth, seg, angleWithin, pickWeighted } from "./boss-base";
import type { AttackVolume, BossHost } from "./boss-base";
import type { ProjDef } from "./projectile";

export type { BossState, BossHost } from "./boss-base";

// ---------------- 主题色（冷灰咒体 + 预言金光唯一强调色 + 二阶段血焰暗红） ----------------
const GOLD = 0xd8b36a;        // 预言金光 / 魅影武器（金锤/王之剑/匕首）统一辉光
const GOLD_SLASH = 0xcfc4a4;  // 杖风轨迹（灰金，一阶段）
const GOLD_DEEP = 0xb99a55;   // 王冠残环 / 杖身符文（顶点色层）
const BLOOD = 0x9b3b32;       // 血焰暗红（=COLORS.hp 同族，二阶段咒剑/诅咒喷吐）
const SKIN = 0x8a7d6b;        // 灰褐皮肤（恶兆咒体，玛尔基特同源）
const SKIN_DARK = 0x6b6053;
const ROBE = 0x37332d;        // 破布长袍
const ROBE_DARK = 0x28251f;
const CLOAK = 0x333a42;       // 褪色王披（冷灰蓝，王气层）
const WOOD = 0x4a3d2c;        // 咒杖木色
const STEEL = 0x565c66;       // 钝钢（袖中咒刃、尾刃）

/** 魅影匕首投射物：速度 12.5，drop 每秒下坠 0.9 制造抛物线弹道，life 1.7s ≈ 21m 射程后自散 */
const DAGGER_PROJ: ProjDef = { speed: 12.5, radius: 0.4, dmg: 14, feelKey: "moMagic", life: 1.7, color: GOLD, drop: 0.9 };

/** 跃扑选招上限：冲程 7.5m + 接触余量 2m。再远落点够不着，改为踱步（8.5m 仍在圈内，探针能强制选出）。 */
const POUNCE_REACH = 9.5;
/** 连续同一招的权重系数。必须 > 0：冷却把其余招锁死时，这一招仍要能被选中。 */
const REPEAT_W = 0.4;
/** 王者之证判定帧金环外圈（proofNova）。命中圆跟这圈走；内圈血环只叠色，不再打一次。 */
const PROOF_RING = 7.0;

// ---------------- 帧数据（键名 morgott 前缀 / 手感键 mo 开头；fextralife wiki 忠实校正） ----------------
export const MOVES_MORGOTT: Record<string, MoveDef> = {
  // 王杖三连（Staff Combo·2-4 段变奏）：3 段判定节奏 0.5s；多段时间轴第 k 段在
  // min(active*0.4 + k*0.5, active)，active ≥ 1.67 才能三段全触发 → 取 1.7（0.68/1.18/1.68）。
  // 变奏：近身 40% 接延迟下砸收尾＝第 4 段（chain 杖→锤武器切换）；被绕背则改横扫尾刀脱身
  morgottCombo: {
    name: "morgottCombo", label: "王杖三连", startup: 0.38, active: 1.7, recovery: 0.9,
    dmg: 13, range: 3.3, arc: 1.7, hits: 3, hitInterval: 0.5, chain: "morgottSlam",
    parryable: true, cd: 4.0, feel: "moLight",
  },
  // 横扫尾刀（Tail Swipe）：贴身/绕背脱身用，全周判定 + 小击飞（knockUp 由 player.applyHit 抛物线消费）
  morgottTail: {
    name: "morgottTail", label: "横扫尾刀", startup: 0.42, active: 0.22, recovery: 0.95,
    dmg: 21, range: 3.2, arc: 6.28, knockUp: 3.2, parryable: false, cd: 6.0, feel: "moHeavy",
  },
  // 延迟下砸（读招考试招牌）：前段举锤，中段停住骗提前翻滚，末段才加力砸下。
  // 冲击环与判定帧对齐；后摇 1.5s，收势先钉 0.7s。startup 不缩短。
  morgottSlam: {
    name: "morgottSlam", label: "下砸地板波", startup: 1.15, active: 0.16, recovery: 1.5,
    dmg: 32, range: 3.7, arc: 1.3, parryable: true, cd: 6.5, feel: "moHeavy",
  },
  // 投掷魅影匕首（Holy Daggers·扇形）：中远距；近战判定禁用（range 0.2 同玛尔基特咒刃），
  // 伤害由 DAGGER_PROJ 承载；一次性扇形撒布（一阶段 3 连扇面 ±0.16 / 二阶段 5 连 ±0.32）；
  // 玩家趁机逼近则 40% 接跳跃扑杀（chain）＝wiki「投掷后接跃空突进」的突然变奏
  morgottDaggers: {
    name: "morgottDaggers", label: "投掷魅影匕首", startup: 0.55, active: 0.20, recovery: 0.95,
    dmg: 14, range: 0.2, arc: 0.9, parryable: false, cd: 5.2, chain: "morgottPounce",
    proj: { speed: 12.5, radius: 0.4, life: 1.7 }, feel: "moMagic",
  },
  // 跳跃扑杀：深蹲 → 前扑升空 → 顶点悬停（金尘聚锤）→ 砸地。够得着约 9.5m，更远不空扑。
  // 落地后摇 1.55s，收势先钉 0.7s，是打空后的惩罚窗口。
  morgottPounce: {
    name: "morgottPounce", label: "跳跃扑杀", startup: 0.65, active: 0.16, recovery: 1.55,
    dmg: 34, range: 3.7, arc: 1.4, lunge: 7.5, parryable: true, cd: 7.5, feel: "moHeavy",
  },
  // 咒剑大剑三连（二阶段·王之剑）：拔出蒙格特咒剑后左手召出黄金魅影大剑，
  // 3 段大弧度斩（节奏 0.48s；0.7/1.18/1.66），每段长发金色残影拖尾（updateVisuals 补画双残影）
  morgottGreatsword: {
    name: "morgottGreatsword", label: "咒剑大剑三连", startup: 0.5, active: 1.75, recovery: 1.15,
    dmg: 17, range: 4.0, arc: 2.3, hits: 3, hitInterval: 0.48, parryable: true,
    phase2Only: true, cd: 5.5, feel: "moHeavy",
  },
  // 诅咒喷吐（Cursed Spew·扇形）：仰首蓄咒 → 前俯左右横扫喷出扇形诅咒焰，
  // 4 段判定节奏 0.3s（0.62/0.92/1.22/1.52）＋持续血焰粒子扫射（wiki 诅咒系扇形吐息）
  morgottCurseSpew: {
    name: "morgottCurseSpew", label: "诅咒喷吐", startup: 0.85, active: 1.55, recovery: 1.2,
    dmg: 8, range: 6.2, arc: 1.5, hits: 4, hitInterval: 0.3, parryable: false,
    phase2Only: true, cd: 7.5, feel: "moBlood",
  },
  // 血焰突斩（Cursed-Blood Chase）：咒剑淬血后仰蓄势 → 前冲大斜斩 → 回身反斩（2 段判定 0.24/0.58），
  // 前冲 4.5m 惩罚中距站桩（wiki Cursed-Blood Slice Chase）
  morgottBloodChase: {
    name: "morgottBloodChase", label: "血焰突斩", startup: 0.7, active: 0.6, recovery: 1.25,
    dmg: 22, range: 4.1, arc: 2.5, hits: 2, hitInterval: 0.34, lunge: 4.5, parryable: false,
    phase2Only: true, cd: 8.0, feel: "moBlood",
  },
  // 王者之证（读招大题）：startup 保持 1.6s，不要收成反应测试。拄剑聚气（金尘旋进 + 地面威胁环）
  // → 判定帧金爆（全周 6.5m·伤害 42）。后摇 1.7s。cd 15s，全场少见。
  morgottKingsProof: {
    name: "morgottKingsProof", label: "王者之证", startup: 1.6, active: 0.3, recovery: 1.7,
    dmg: 42, range: 6.5, arc: 6.28, parryable: false, phase2Only: true, cd: 15.0, feel: "moProof",
  },
};
Object.assign(MOVES, MOVES_MORGOTT);

// ---------------- 手感档案（恶兆王：钝木杖 + 黄金魅影 + 血焰咒剑） ----------------
export const FEEL_MORGOTT: Record<string, FeelDef & { label: string }> = {
  moLight: { label: "蒙格特·杖击",   hitstop: 0.05, shake: 0.40, sparks: 10, sparkSpeed: 4, knockback: 0.35, sfx: "hitStone" },
  moHeavy: { label: "蒙格特·重击",   hitstop: 0.09, shake: 0.55, sparks: 16, sparkSpeed: 5, knockback: 0.60, sfx: "hitHeavy" },
  moMagic: { label: "魅影匕首·命中", hitstop: 0.08, shake: 0.45, sparks: 14, sparkSpeed: 5, knockback: 0.50, sfx: "hitHeavy" },
  moBlood: { label: "血焰·命中",     hitstop: 0.08, shake: 0.50, sparks: 14, sparkSpeed: 5, knockback: 0.55, sfx: "hitHeavy" },
  moProof: { label: "王者之证·震波", hitstop: 0.16, shake: 0.75, sparks: 22, sparkSpeed: 6, knockback: 0.90, sfx: "hitHeavy" },
};
Object.assign(FEEL, FEEL_MORGOTT);

export const MORGOTT_STATS: BossStats & { name: string; radius: number } = {
  name: "恶兆王蒙格特", radius: 1.0,
  hp: 880,                        // 原作 10399 按本项目 Boss 血量档（7 位 Boss 最高档）折算
  poiseMax: 95, poiseDecay: 9,    // 原作 Stance 80——恶兆王身板稍硬（第 7 位守关人）
  staggerDur: 2.3, staggerMul: 1.5,
  parriedDur: 1.6,                // 原作需三次弹反才出处决——我们一次，窗口较玛尔基特略宽补偿
  phase2At: 0.6,                  // hp < 60% 诅咒爆发拔咒剑（wiki）
  walkSpeed: 3.4, turnRate: 4.0,  // 王城之王：比玛尔基特更挺拔更快（wiki：最快的 Boss 之一）
};

/** 二阶段血焰附魔（一阶段招式 前摇 ×0.9 / 伤害 ×1.15）的一阶段基线——
 *  模块级快照，多实例/reset 往返安全（仿玛尔基特；phase2Only 招式按二阶段功率设计，不吃附魔） */
const P1_BASE: Record<string, { startup: number; dmg: number }> = {};
for (const m of Object.values(MOVES_MORGOTT)) P1_BASE[m.name] = { startup: m.startup, dmg: m.dmg };

// ---------------- 姿态（Pose）：挺拔恶兆王 + 持杖右臂 / 魅影左臂 / 尾枢轴 / 左腿（抬腿劈锤） ----------------
interface Pose {
  y: number; lean: number; twist: number; crouch: number; reach: number;
  rLift: number; rSwing: number;   // 右臂（咒杖/咒剑）：lift 正=前戳 负=上举；swing 正=向左抡
  lLift: number; lSwing: number;   // 左臂（魅影匕首/王之剑，镜像）
  nod: number;                     // 头部俯仰（正=低头）
  spin: number;                    // 整体附加旋转
  tail: number;                    // 尾枢轴摆角（横扫尾刀）
  legL: number;                    // 左腿抬起（下砸前摇）
}
const STANCE: Pose = { y: 0, lean: 0.10, twist: -0.05, crouch: 0, reach: 0, rLift: 0.30, rSwing: 0.14, lLift: 0.20, lSwing: -0.18, nod: 0.10, spin: 0, tail: 0, legL: 0 };
const STATUE: Pose = { ...STANCE, y: -0.42, lean: 0.42, crouch: 0.48, nod: 0.58, rLift: -0.08, rSwing: 0.04, lLift: 0.06, lSwing: -0.1, legL: 0.55 };  // 跪王拄杖（王座前石像）
// 王杖三连三拍（拍内 wind→strike；与判定时刻 0.68/1.18/1.68 对齐；第三拍大开大合收势）
const C1W: Pose = { ...STANCE, twist: 0.55, rLift: -0.9, rSwing: -0.75, nod: 0.08 };
const C1K: Pose = { ...STANCE, twist: -0.4, rLift: 0.55, rSwing: 0.9, lean: 0.22 };
const C2W: Pose = { ...STANCE, twist: -0.45, rLift: -0.6, rSwing: 0.8, lLift: -0.35, lSwing: 0.3 };
const C2K: Pose = { ...STANCE, twist: 0.4, rLift: 0.5, rSwing: -0.95, lean: 0.18, lLift: 0.25, lSwing: -0.4 };
const C3W: Pose = { ...STANCE, twist: 0.7, rLift: -0.35, rSwing: -1.1, lLift: -0.9, lSwing: 0.75 };
const C3K: Pose = { ...STANCE, twist: -0.75, rLift: 0.35, rSwing: 1.25, lean: 0.26, crouch: 0.1, lLift: 0.75, lSwing: -1.05 };
// 横扫尾刀：缩身蓄势（尾后卷）→ 全周甩尾
const TW: Pose = { ...STANCE, crouch: 0.28, lean: 0.32, tail: -1.9, twist: 0.38 };
const TK: Pose = { ...STANCE, crouch: 0.16, lean: 0.18, tail: 1.9, twist: -0.48 };
// 延迟下砸：举锤（SW）→ 停住 → 末段加到极限（SW_TOP）→ 判定帧砸到地（SK）
const SW: Pose = { ...STANCE, crouch: 0.2, lean: -0.1, rLift: -2.4, rSwing: 0.5, lLift: -1.15, lSwing: -0.35, nod: -0.16, legL: 0.9 };
const SW_TOP: Pose = { ...SW, crouch: 0.28, lean: -0.2, rLift: -2.72, nod: -0.32, legL: 1.1 };
const SK: Pose = { ...STANCE, crouch: 0.38, lean: 0.5, rLift: 1.1, rSwing: 0.05, nod: 0.3, reach: 0.4, y: -0.18 };
// 投掷魅影匕首：左臂高举聚刃 → 甩发扇形
const DW: Pose = { ...STANCE, twist: -0.42, lLift: -1.65, lSwing: 0.55, lean: -0.06, nod: 0.1, rLift: 0.2, rSwing: 0.3 };
const DK: Pose = { ...STANCE, twist: 0.25, lLift: 1.0, lSwing: -0.2, lean: 0.28, reach: 0.3, nod: 0.02 };
// 跳跃扑杀：深蹲蓄势 → 腾空前扑悬停（欺诈延迟：最高点停一瞬）→ 召锤砸地钉落
const PW: Pose = { ...STANCE, crouch: 0.52, lean: 0.28, y: -0.32, nod: 0.28, rLift: -1.5, rSwing: 0.4 };
const PH: Pose = { ...STANCE, crouch: 0.4, lean: 0.1, nod: 0.16, rLift: -2.45, rSwing: 0.25 };
const PK: Pose = { ...STANCE, crouch: 0.42, lean: 0.52, rLift: 1.05, rSwing: 0.05, nod: 0.3, reach: 0.5, y: -0.16 };
// 咒剑大剑三连三拍（王之剑：大开大合，弧度比杖三连更大；第三拍双手交叠下斩）
const G1W: Pose = { ...STANCE, twist: 0.75, rLift: -1.15, rSwing: -0.95, lLift: -1.0, lSwing: 0.85, nod: 0.04 };
const G1K: Pose = { ...STANCE, twist: -0.6, rLift: 0.6, rSwing: 1.15, lean: 0.3, lLift: 0.4, lSwing: -0.5 };
const G2W: Pose = { ...STANCE, twist: -0.7, rLift: -0.85, rSwing: 1.0, lLift: -1.2, lSwing: -0.9 };
const G2K: Pose = { ...STANCE, twist: 0.65, rLift: 0.55, rSwing: -1.3, lean: 0.26, lLift: 0.5, lSwing: 0.55, crouch: 0.1 };
const G3W: Pose = { ...STANCE, twist: 0.85, rLift: -1.6, rSwing: -0.5, lLift: -1.5, lSwing: 0.5, crouch: 0.14, nod: -0.08 };
const G3K: Pose = { ...STANCE, twist: -0.55, rLift: 0.9, rSwing: 0.3, lean: 0.5, crouch: 0.24, lLift: 0.7, lSwing: -0.3, reach: 0.5, y: -0.14 };
// 诅咒喷吐：仰首蓄咒（喉间血光）→ 前俯横扫喷扇（twist 在 movePose 内叠加扫角）
const SPW: Pose = { ...STANCE, crouch: 0.14, lean: -0.18, nod: -0.42, rLift: -0.5, rSwing: 0.35, lLift: -0.4, lSwing: -0.3 };
const SPK: Pose = { ...STANCE, crouch: 0.26, lean: 0.4, nod: 0.38, reach: 0.35, rLift: 0.3, rSwing: 0.2, lLift: 0.25, lSwing: -0.2 };
// 血焰突斩：后仰蓄势（咒剑淬血）→ 前冲大斜斩 → 回身反斩（两拍与判定 0.24/0.58 对齐）
const BCW: Pose = { ...STANCE, twist: 0.6, lean: -0.14, crouch: 0.18, rLift: -1.3, rSwing: -0.8, nod: -0.06 };
const BC1K: Pose = { ...STANCE, twist: -0.5, lean: 0.42, crouch: 0.2, rLift: 0.7, rSwing: 1.2, reach: 0.5, nod: 0.2 };
const BC2K: Pose = { ...STANCE, twist: 0.7, lean: 0.3, crouch: 0.14, rLift: 0.5, rSwing: -1.25, lLift: 0.4, lSwing: 0.5, nod: 0.14 };
// 王者之证：快速落成拄剑，再把整段 1.6s 用来加深跪姿聚气（KP_CHARGE）→ 判定帧拔剑（KPK）
const KPW: Pose = { ...STANCE, y: -0.2, lean: 0.24, crouch: 0.28, nod: 0.5, rLift: 0.15, rSwing: 0.1, lLift: -0.25, lSwing: -0.15 };
const KP_CHARGE: Pose = { ...KPW, y: -0.36, lean: 0.42, crouch: 0.54, nod: 0.84, rLift: 0.5, lLift: -0.58, reach: 0.1 };
const KPK: Pose = { ...STANCE, y: 0.12, lean: -0.2, crouch: 0.08, nod: -0.3, rLift: -1.9, rSwing: 0.9, lLift: -1.7, lSwing: -0.85 };
// 变身演出四段：拄杖伏身咳喘（诅咒上涌）→ 起身拔咒剑 → 横斩金爆（震波时刻＝transformHitAt）→ 收剑立王姿
const TF_GATHER: Pose = { ...STANCE, y: -0.34, crouch: 0.4, lean: 0.44, nod: 0.5, rLift: 0.1, rSwing: 0.3, lLift: 0.05, lSwing: -0.2 };
const TF_DRAW: Pose = { ...STANCE, lean: -0.14, nod: -0.24, rLift: -2.5, rSwing: 0.3, lLift: -0.7, lSwing: -0.5 };
const TF_SLASH: Pose = { ...STANCE, twist: -0.8, lean: 0.3, crouch: 0.12, rLift: 0.6, rSwing: 1.4, nod: 0.1 };
const TF_STAND: Pose = { ...STANCE, lean: 0.06, nod: 0.04, rLift: 0.26, rSwing: 0.1, lLift: 0.16, lSwing: -0.12 };

export class Morgott extends BossBase {
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
  private staffG = new THREE.Group();
  private hammerG = new THREE.Group();
  private gswordG = new THREE.Group();
  private bladeG = new THREE.Group();
  /** 刃的两端，钉在对应武器网格的长轴上。 */
  private staffHilt = new THREE.Object3D();
  private staffTip = new THREE.Object3D();
  private hammerHilt = new THREE.Object3D();
  private hammerTip = new THREE.Object3D();
  private gswordHilt = new THREE.Object3D();
  private gswordTip = new THREE.Object3D();
  private bladeHilt = new THREE.Object3D();
  private bladeTip = new THREE.Object3D();
  private tailHilt = new THREE.Object3D();
  private tailTip = new THREE.Object3D();
  private mouth = new THREE.Object3D();             // 诅咒喷吐起点（颌前）
  private eyeMat!: THREE.MeshStandardMaterial;    // 双眼（预言金光）
  private crownMat!: THREE.MeshStandardMaterial;  // 王冠残环 + 额前预言印记 + 杖身符环（金辉呼吸）
  private hammerMat!: THREE.MeshStandardMaterial; // 魅影金锤（显形时 emissive）
  private gswordMat!: THREE.MeshStandardMaterial; // 王之剑·黄金魅影大剑
  private bladeMat!: THREE.MeshStandardMaterial;  // 蒙格特咒剑（血色窄刃，emissive 仍是 BLOOD）
  private gold!: Particles;                       // 金尘粒子池（召唤凝聚 / 二阶段披身 / 王者之证聚气）
  private blood!: Particles;                      // 血焰粒子池（诅咒喷吐 / 血焰突斩 / 咒剑余焰）

  private pose: Pose = { ...STATUE };
  private playerPos = new THREE.Vector3(0, 0, 5); // pickMove 的绕背检测用（update 时缓存）
  private moveFrom = new THREE.Vector3();         // 位移类招基准
  private moveDir = new THREE.Vector3(0, 0, 1);
  private moveLen = 0;
  private slashFired = 0;                         // 已补画刀光/喷扇的判定段数（与 hitFired 对齐）
  private fxStep = 0;                             // 落点表现步进（金锤/跃扑/王者之证金爆）
  private hammerShow = 0;                         // 魅影金锤显形度 0..1（updateVisuals 缓动）
  private gswordShow = 0;                         // 王之剑显形度 0..1
  private bladeShow = 0;                          // 咒剑显形度 0..1（二阶段常驻）
  private p2Applied = false;                      // 二阶段附魔是否已写入共享表
  private prevTfT = 0;                            // 变身演出上一帧 t（金爆帧跨帧判定）
  private frameDt = 0;                            // 本帧游戏 dt（顿帧/暂停/慢放为 0 或被缩放；粒子跟它，不跟墙钟）
  private lastMove = "";                          // 上一招：连续同招降权，系数恒 > 0
  private telU = 0;                               // 前摇进度，聚气节拍跨帧用

  constructor(scene: THREE.Scene, vfx: Vfx, pos: THREE.Vector3, host: BossHost, facing = -Math.PI / 2) {
    super(scene, vfx, pos, host, MORGOTT_STATS, facing);
    this.gold = new Particles(scene, 140, { size: 0.05, color: GOLD, additive: true, gravity: -0.2 });
    this.blood = new Particles(scene, 120, { size: 0.06, color: BLOOD, additive: true, gravity: -0.15 });
    this.transformHitAt = 1.9;    // 变身演出：伏身咳喘(0.8 拔咒剑) → 起身举剑 → 1.9s 横斩金爆震波
    this.transformDur = 3.0;
    this.assemble();
  }

  // ---------------- 外观：挺拔恶兆王（肩宽 ~1.0 / 高 ~3.0，褪色王披 + 王冠残环 + 双角 + 金瞳）
  // 性能纪律：纯几何 + 顶点色 → mergeGeometries 合并为 16 个 mesh（≤20 dc）；无 PointLight，全 emissive 呼吸 ----------------
  protected override buildBody(): void {
    // 共享顶点色材质（一处实例，多 mesh 复用）
    const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.02, flatShading: true });
    this.eyeMat = new THREE.MeshStandardMaterial({ color: 0x120d06, roughness: 0.5, emissive: GOLD, emissiveIntensity: 0.8 });
    this.crownMat = new THREE.MeshStandardMaterial({ color: GOLD_DEEP, emissive: GOLD, emissiveIntensity: 0.5, roughness: 0.4, metalness: 0.4, flatShading: true });
    this.hammerMat = new THREE.MeshStandardMaterial({ color: 0xcbb277, emissive: GOLD, emissiveIntensity: 0, roughness: 0.35, metalness: 0.5, flatShading: true, transparent: true, opacity: 0.92 });
    this.gswordMat = new THREE.MeshStandardMaterial({ color: 0xd6bd82, emissive: GOLD, emissiveIntensity: 0, roughness: 0.3, metalness: 0.55, flatShading: true, transparent: true, opacity: 0.9 });
    this.bladeMat = new THREE.MeshStandardMaterial({ color: BLOOD, emissive: BLOOD, emissiveIntensity: 0, roughness: 0.45, metalness: 0.5, flatShading: true });

    // 顶点色盒子工厂：旋转 → 平移 → 灌色（merge 前统一带 color 属性）
    const c = new THREE.Color();
    const box = (w: number, h: number, d: number, color: number, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry => {
      const g = new THREE.BoxGeometry(w, h, d);
      if (rx || ry || rz) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
      g.translate(x, y, z);
      c.setHex(color);
      const n = g.attributes.position.count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
      g.setAttribute("color", new THREE.BufferAttribute(col, 3));
      return g;
    };
    const cyl = (rt: number, rb: number, h: number, color: number, x = 0, y = 0, z = 0): THREE.BufferGeometry => {
      const g = new THREE.CylinderGeometry(rt, rb, h, 6);
      g.translate(x, y, z);
      c.setHex(color);
      const n = g.attributes.position.count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
      g.setAttribute("color", new THREE.BufferAttribute(col, 3));
      return g;
    };
    const merge = (geos: THREE.BufferGeometry[], parent: THREE.Object3D, mat: THREE.Material = bodyMat): THREE.Mesh => {
      const m = new THREE.Mesh(mergeGeometries(geos)!, mat);
      m.castShadow = true;
      parent.add(m);
      return m;
    };
    // 两端钉在已有网格的长轴上，不改尺寸。近原点的一端记为护手。
    const pinBlade = (parent: THREE.Object3D, hilt: THREE.Object3D, tip: THREE.Object3D): void => {
      const mesh = parent.children.find(o => (o as THREE.Mesh).isMesh) as THREE.Mesh | undefined;
      const geo = mesh?.geometry;
      if (!geo) { parent.add(hilt, tip); return; }
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bb = geo.boundingBox;
      if (!bb) { parent.add(hilt, tip); return; }
      const size = new THREE.Vector3();
      const mid = new THREE.Vector3();
      bb.getSize(size);
      bb.getCenter(mid);
      const axis = (["x", "y", "z"] as const).reduce((a, b) => size[a] >= size[b] ? a : b);
      const lo = mid.clone();
      const hi = mid.clone();
      lo[axis] = bb.min[axis];
      hi[axis] = bb.max[axis];
      if (lo.lengthSq() <= hi.lengthSq()) { hilt.position.copy(lo); tip.position.copy(hi); }
      else { hilt.position.copy(hi); tip.position.copy(lo); }
      parent.add(hilt, tip);
    };

    // 枯瘦双腿（袍下若隐若现）——髋枢轴 + 膝枢轴（crouch 弯折 / legL 抬左腿）——腿根 y 1.58（挺拔高大）
    for (const [leg, shin, sx] of [[this.legR, this.shinR, 0.17], [this.legL, this.shinL, -0.17]] as [THREE.Group, THREE.Group, number][]) {
      leg.position.set(sx, 1.58, 0);
      merge([box(0.17, 0.7, 0.2, SKIN_DARK, 0, -0.35, 0)], leg);                 // 大腿
      shin.position.set(0, -0.7, 0);
      merge([box(0.13, 0.64, 0.15, SKIN_DARK, 0, -0.32, 0.01), box(0.16, 0.09, 0.32, SKIN_DARK, 0, -0.64, 0.08)], shin);
      leg.add(shin);
      this.body.add(leg);
    }
    // 骨盆 + 绳腰带 + 破布长袍下摆（阶梯四层 + 摆缘破布条六片）——整层合并为 1 mesh
    merge([
      box(0.44, 0.28, 0.32, SKIN_DARK, 0, 1.6, 0),
      box(0.5, 0.09, 0.38, ROBE_DARK, 0, 1.5, 0),
      box(0.08, 0.18, 0.06, ROBE_DARK, 0.17, 1.44, 0.21),
      box(0.56, 0.34, 0.42, ROBE, 0, 1.34, 0),
      box(0.66, 0.34, 0.5, ROBE, 0, 1.04, 0),
      box(0.78, 0.34, 0.58, ROBE_DARK, 0, 0.74, 0),
      box(0.9, 0.3, 0.66, ROBE_DARK, 0, 0.48, 0.02),
    ], this.body);
    const rags: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.4;
      rags.push(box(0.1, 0.34 + (i % 3) * 0.08, 0.03, ROBE_DARK, Math.sin(a) * 0.46, 0.34, Math.cos(a) * 0.46, 0, a, 0));
    }
    merge(rags, this.body);
    // 尾：节间收细，末端换成竖刃。根面 z=0、刃尖 z=-1.16，节心压在 y=-0.082，标记仍钉在根和刃尖。
    this.tailG.position.set(0, 1.5, -0.2);
    const tailY = -0.082;
    merge([
      box(0.15, 0.13, 0.18, SKIN_DARK, 0, tailY, -0.09),                       // 节
      box(0.055, 0.05, 0.055, ROBE_DARK, 0, tailY, -0.195),                     // 节间收细
      box(0.125, 0.11, 0.16, SKIN, 0, tailY, -0.295),
      box(0.048, 0.044, 0.05, ROBE_DARK, 0, tailY, -0.395),
      box(0.11, 0.095, 0.15, SKIN_DARK, 0, tailY, -0.49),
      box(0.042, 0.038, 0.048, ROBE_DARK, 0, tailY, -0.585),
      box(0.095, 0.082, 0.14, SKIN, 0, tailY, -0.675),
      box(0.036, 0.032, 0.05, ROBE_DARK, 0, tailY, -0.765),
      box(0.028, 0.10, 0.08, STEEL, 0, tailY, -0.81),                           // 刃根
      box(0.028, 0.26, 0.18, STEEL, 0, tailY, -0.93),                           // 扁刃
      box(0.014, 0.14, 0.10, STEEL, 0, tailY, -1.05),
      box(0.012, 0.05, 0.08, STEEL, 0, tailY, -1.12),                           // 刃尖，端面 z=-1.16
    ], this.tailG);
    pinBlade(this.tailG, this.tailHilt, this.tailTip);
    this.body.add(this.tailG);

    // 躯干（宽肩挺拔）——底座 y 1.72；褪色王披（披肩 + 背后长氅）
    this.torso.position.y = 1.72;
    merge([
      box(0.4, 0.32, 0.28, SKIN_DARK, 0, 0.04, 0),                               // 腹
      box(0.5, 0.42, 0.32, ROBE, 0, 0.4, 0),                                     // 胸（袍裹）
      box(0.44, 0.26, 0.34, CLOAK, 0, 0.66, 0.01),                               // 上层（王披）
      box(0.36, 0.4, 0.07, SKIN_DARK, 0, 0.42, -0.18),                           // 背脊隆起
      box(0.62, 0.95, 0.05, CLOAK, 0, 0.02, -0.24),                              // 背后长氅
      box(0.5, 0.6, 0.045, ROBE_DARK, 0, -0.38, -0.28),                          // 氅内衬
      box(0.026, 0.4, 0.026, ROBE_DARK, 0.09, 0.3, 0.16),                        // 胸前垂绳 + 骨符
      box(0.026, 0.4, 0.026, ROBE_DARK, -0.09, 0.3, 0.16),
      box(0.07, 0.1, 0.04, SKIN_DARK, 0, 0.12, 0.18),
    ], this.torso);
    const mantle: THREE.BufferGeometry[] = [];                                    // 王披披肩（双层）
    for (const s of [-1, 1]) {
      mantle.push(box(0.32, 0.16, 0.38, CLOAK, s * 0.38, 0.7, 0, 0, 0, -s * 0.3));
      mantle.push(box(0.2, 0.11, 0.28, ROBE_DARK, s * 0.46, 0.56, 0.02, 0, 0, -s * 0.5));
    }
    merge(mantle, this.torso);

    // 头：恶兆颅（瘦长）+ 后掠双角 + 金瞳；王冠残环 + 额前预言印记（crownMat 金辉呼吸）
    this.head.position.set(0, 0.88, 0.03);
    merge([
      box(0.24, 0.32, 0.28, SKIN, 0, 0, 0),                                      // 颅
      box(0.19, 0.13, 0.22, SKIN_DARK, 0, -0.19, 0.02),                          // 颌
      box(0.21, 0.1, 0.06, SKIN_DARK, 0, 0.07, 0.13),                            // 眉骨
      box(0.06, 0.34, 0.06, SKIN_DARK, 0.13, 0.26, -0.06, -0.55, 0, -0.55),      // 后掠双角（两节）
      box(0.06, 0.34, 0.06, SKIN_DARK, -0.13, 0.26, -0.06, -0.55, 0, 0.55),
      box(0.045, 0.3, 0.045, SKIN_DARK, 0.23, 0.48, -0.16, -1.0, 0, -0.75),
      box(0.045, 0.3, 0.045, SKIN_DARK, -0.23, 0.48, -0.16, -1.0, 0, 0.75),
    ], this.head);
    merge([                                                                      // 双眼（金瞳，emissive 呼吸）
      box(0.055, 0.04, 0.02, 0xffffff, 0.06, 0.06, 0.155),
      box(0.055, 0.04, 0.02, 0xffffff, -0.06, 0.06, 0.155),
    ], this.head, this.eyeMat);
    const crown: THREE.BufferGeometry[] = [box(0.06, 0.09, 0.02, GOLD_DEEP, 0, 0.2, 0.145)];  // 额前预言印记（斜置菱形→竖片）
    for (let i = 0; i < 7; i++) {                                                // 王冠残环：7 节金环 + 一段缺口（残）
      const a = 0.42 + (i / 6) * (Math.PI * 1.72);                               // 覆盖 ~310°，余下缺口
      const tall = i % 3 === 1;
      crown.push(box(0.05, tall ? 0.16 : 0.09, 0.05, GOLD_DEEP,
        Math.sin(a) * 0.165, 0.3 + (tall ? 0.03 : 0), Math.cos(a) * 0.165, 0, a, 0));
    }
    merge(crown, this.head, this.crownMat);
    this.mouth.position.set(0, -0.14, 0.16);                                 // 颌前，喷吐从这里出来
    this.head.add(this.mouth);
    this.torso.add(this.head);

    // 右臂 + 王杖（一阶段）：木杆和金杖头分开，杖头是冠球加十字，不再是玛尔基特的木叉。
    // 外包盒锁在 y=-1.5 / y=1.247，和原来一样长；杖头比杆宽，但仍短于全长，标记留在杖头尖和杆尾。
    this.armR.position.set(0.38, 0.62, 0);
    merge([
      box(0.12, 0.52, 0.14, SKIN_DARK, 0, -0.23, 0),
      box(0.1, 0.48, 0.12, SKIN, 0, -0.62, 0.02),
      box(0.11, 0.13, 0.13, SKIN_DARK, 0, -0.93, 0.04),                          // 枯爪握持
    ], this.armR);
    this.staffG.position.set(0, -1.0, 0.06);
    this.staffG.rotation.x = 0.16;                                               // 杖尾后曳
    merge([
      cyl(0.024, 0.038, 2.08, WOOD, 0, -0.460, 0),                               // 木杆，底 -1.500，顶伸进金座
      box(0.056, 0.044, 0.056, GOLD_DEEP, 0, -1.478, 0),                         // 杆尾金箍，底面仍在 -1.500
      box(0.050, 0.18, 0.050, ROBE_DARK, 0, 0.02, 0),                            // 握柄缠布
      box(0.062, 0.026, 0.062, GOLD_DEEP, 0, -0.86, 0),                          // 杆身金环（还在木杆上）
      box(0.058, 0.024, 0.058, GOLD_DEEP, 0, -0.22, 0),
      box(0.13, 0.07, 0.13, GOLD_DEEP, 0, 0.600, 0),                             // 金座，杖头从这里才开始
      cyl(0.030, 0.040, 0.06, GOLD_DEEP, 0, 0.665, 0),                           // 颈，把球和杆断开
      cyl(0.062, 0.034, 0.08, GOLD, 0, 0.735, 0),                                // 冠球
      cyl(0.100, 0.062, 0.10, GOLD, 0, 0.825, 0),
      cyl(0.048, 0.100, 0.07, GOLD, 0, 0.910, 0),
      cyl(0, 0.022, 0.36, GOLD, 0, 1.067, 0),                                    // 十字立锋，尖在 1.247
      box(0.26, 0.034, 0.034, GOLD, 0, 1.020, 0),                                // 十字横臂
      box(0.034, 0.034, 0.16, GOLD_DEEP, 0, 1.020, 0),
    ], this.staffG);
    pinBlade(this.staffG, this.staffHilt, this.staffTip);
    this.armR.add(this.staffG);
    // 蒙格特咒剑（二阶段右手常驻）：窄血刃，短剑格，尖收到 y=-1.423。比左手黄金大剑窄一截，整把走 BLOOD。
    this.bladeG.position.set(0, -1.02, 0.1);
    this.bladeG.rotation.x = 0.22;
    merge([
      box(0.034, 0.050, 0.034, BLOOD, 0, 0.075, 0),                              // 柄头，顶 0.100
      box(0.024, 0.18, 0.024, BLOOD, 0, -0.030, 0),                              // 细柄
      box(0.26, 0.032, 0.038, BLOOD, 0, -0.125, 0),                              // 剑格，明显宽于窄刃
      box(0.018, 0.08, 0.018, BLOOD, 0.12, -0.165, 0, 0, 0, -0.65),              // 格端下垂
      box(0.018, 0.08, 0.018, BLOOD, -0.12, -0.165, 0, 0, 0, 0.65),
      box(0.036, 0.08, 0.016, BLOOD, 0, -0.180, 0),                              // 剑颈
      box(0.064, 0.74, 0.014, BLOOD, 0, -0.580, 0),                              // 窄刃
      box(0.020, 0.74, 0.020, BLOOD, 0, -0.580, 0),                              // 细脊
      box(0.034, 0.22, 0.012, BLOOD, 0, -1.050, 0),                              // 收锋
      cyl(0.014, 0, 0.32, BLOOD, 0, -1.263, 0),                                  // 尖，底 -1.423
    ], this.bladeG, this.bladeMat);
    pinBlade(this.bladeG, this.bladeHilt, this.bladeTip);
    this.bladeG.visible = false;
    this.armR.add(this.bladeG);
    // 魅影金锤：细柄 + 厚锤头。柄尾 y=-0.44、锤面 y=0.56。锤头的宽、厚都短于这根全长，标记才还在柄尾和锤面。
    this.hammerG.position.set(0, -1.06, 0.18);
    merge([
      box(0.04, 0.50, 0.04, 0xcbb277, 0, -0.190, 0),                             // 细柄，底 -0.440
      box(0.14, 0.09, 0.14, 0xcbb277, 0, 0.090, 0),                              // 颈
      box(0.76, 0.42, 0.60, 0xcbb277, 0, 0.310, 0),                              // 厚锤头
      box(0.90, 0.10, 0.74, 0xcbb277, 0, 0.300, 0),                              // 锤腰箍，把头从杆上切开
      box(0.60, 0.08, 0.48, 0xcbb277, 0, 0.520, 0),                              // 打击面，顶 0.560
    ], this.hammerG, this.hammerMat);
    pinBlade(this.hammerG, this.hammerHilt, this.hammerTip);
    this.hammerG.visible = false;
    this.armR.add(this.hammerG);
    this.torso.add(this.armR);

    // 左臂 + 枯爪 + 袖中咒刃（投掷位）+ 王之剑（宽刃黄金大剑，剑格和尖都比右手咒剑大一圈）
    this.armL.position.set(-0.38, 0.62, 0);
    const clawGeos: THREE.BufferGeometry[] = [
      box(0.12, 0.5, 0.14, SKIN_DARK, 0, -0.22, 0),
      box(0.1, 0.46, 0.12, SKIN, 0, -0.6, 0.02),
      box(0.1, 0.11, 0.11, SKIN_DARK, 0, -0.87, 0.04),
    ];
    for (let i = 0; i < 3; i++) clawGeos.push(box(0.02, 0.15, 0.03, SKIN_DARK, -0.03 + i * 0.03, -0.97, 0.06, 0.5 + i * 0.12, 0, 0));
    clawGeos.push(box(0.035, 0.42, 0.015, STEEL, 0.01, -0.78, 0.1, 0.35, 0, 0));  // 袖中咒刃（钝钢）
    merge(clawGeos, this.armL);
    this.gswordG.position.set(0, -0.98, 0.1);
    this.gswordG.rotation.x = 0.2;
    merge([
      box(0.078, 0.064, 0.078, 0xd6bd82, 0, 0.068, 0),                           // 柄头，顶 0.100
      box(0.048, 0.24, 0.048, 0xd6bd82, 0, -0.060, 0),                           // 握柄
      box(0.76, 0.06, 0.09, 0xd6bd82, 0, -0.200, 0),                             // 宽剑格
      box(0.14, 0.10, 0.11, 0xd6bd82, 0, -0.200, 0),                             // 格心
      box(0.046, 0.20, 0.046, 0xd6bd82, 0.36, -0.240, 0, 0, 0, -0.55),           // 格端下垂，搭在剑格上
      box(0.046, 0.20, 0.046, 0xd6bd82, -0.36, -0.240, 0, 0, 0, 0.55),
      box(0.12, 0.14, 0.045, 0xd6bd82, 0, -0.300, 0),                            // 剑颈，窄于刃
      box(0.34, 0.52, 0.038, 0xd6bd82, 0, -0.620, 0),                            // 宽刃
      box(0.09, 0.52, 0.056, 0xd6bd82, 0, -0.620, 0),                            // 脊
      box(0.22, 0.42, 0.032, 0xd6bd82, 0, -1.060, 0),
      box(0.06, 0.42, 0.046, 0xd6bd82, 0, -1.060, 0),
      box(0.11, 0.28, 0.024, 0xd6bd82, 0, -1.400, 0),                            // 收锋
      cyl(0.048, 0, 0.42, 0xd6bd82, 0, -1.680, 0),                               // 尖，底 -1.890
    ], this.gswordG, this.gswordMat);
    pinBlade(this.gswordG, this.gswordHilt, this.gswordTip);
    this.gswordG.visible = false;
    this.armL.add(this.gswordG);
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
    this.legL.rotation.x = -p.crouch * 0.48 - p.legL;                             // 抬左腿（下砸前摇）
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

  /** 重招后摇：受击姿态先钉住 0.7s（打得进去），再缓回站姿。不缩短 recovery 本身。 */
  private holdHeavy(from: Pose, m: MoveDef, t: number): void {
    const pinned = Math.min(0.7, Math.max(0, m.recovery - 0.22));
    this.lerpPose(from, STANCE, smooth(seg(t, pinned, m.recovery)));
  }

  /** 三拍连段姿态：拍与引擎判定时刻对齐（首段 active*0.4，其后每 hitInterval）；
   *  ws/ks 为各拍 wind→strike 位型（王杖三连 / 咒剑大剑三连共用） */
  private trioPose(t: number, m: MoveDef, ws: Pose[], ks: Pose[]): void {
    const firstAt = m.active * 0.4;
    const ph = clamp01((t - firstAt) / Math.max(0.01, m.active - firstAt)) * 3;
    const idx = Math.min(2, Math.floor(ph));
    this.lerpPose(ws[idx], ks[idx], smooth(clamp01(ph - idx)));
  }

  protected override movePose(m: MoveDef, sub: string, t: number, total: number): void {
    if (m.name === "morgottPounce") {
      // 深蹲 → 前扑升到顶点 → 悬停（高度锁死；旧式 sin 只在前摇最后一帧到顶，悬停不存在）→ 判定帧砸地
      const crouchEnd = m.startup * 0.34;
      const riseEnd = m.startup * 0.68;
      if (sub === "tel") {
        if (t <= crouchEnd) {
          this.root.position.copy(this.moveFrom);
          this.lerpPose(STANCE, PW, smooth(clamp01(t / Math.max(0.01, crouchEnd))));
        } else if (t <= riseEnd) {
          const k = smooth(seg(t, crouchEnd, riseEnd));
          this.root.position.copy(this.moveFrom).addScaledVector(this.moveDir, this.moveLen * k);
          this.lerpPose(PW, PH, k);
          this.pose.y = Math.sin(k * Math.PI / 2) * 1.75;
          if (this.frameDt > 0 && Math.random() < this.frameDt * 24) {
            this.vfx.dust.burst(this.root.position.clone().setY(0.2), 2, 2, 0.6);
          }
        } else {
          this.root.position.copy(this.moveFrom).addScaledVector(this.moveDir, this.moveLen);
          this.lerpPose(PH, PH, 1);
          const h = seg(t, riseEnd, m.startup);
          this.pose.y = 1.75 + Math.sin(h * Math.PI) * 0.05;                   // 顶点轻浮，收在 1.75 与下砸衔接
        }
        return;
      }
      if (sub === "act") {
        const hitAt = Math.max(0.01, m.active * 0.4);                          // 与基类首段判定同一时刻落地
        const k = t <= hitAt ? smooth(clamp01(t / hitAt)) : 1;
        this.lerpPose(PH, PK, k);
        this.pose.y = 1.75 + (PK.y - 1.75) * k;
        this.hammerImpact(t, m, 5.5);
        return;
      }
      this.holdHeavy(PK, m, t);
      return;
    }
    if (m.name === "morgottSlam") {
      // 前 40% 举锤，中段停住骗滚，末 18% 才加到极限；判定帧锤已落地
      if (sub === "tel") {
        const raiseEnd = m.startup * 0.4;
        const release = m.startup * 0.82;
        if (t <= raiseEnd) {
          this.lerpPose(STANCE, SW, smooth(clamp01(t / Math.max(0.01, raiseEnd))));
        } else if (t <= release) {
          const hold = clamp01((t - raiseEnd) / Math.max(0.01, release - raiseEnd));
          this.lerpPose(SW, SW_TOP, hold * 0.12);
        } else {
          const k = smooth(seg(t, release, m.startup));
          this.lerpPose(SW, SW_TOP, 0.12 + 0.88 * k);
        }
        return;
      }
      if (sub === "act") {
        const hitAt = Math.max(0.01, m.active * 0.4);
        this.lerpPose(SW_TOP, SK, t <= hitAt ? smooth(clamp01(t / hitAt)) : 1);
        this.hammerImpact(t, m, 3.7);
        return;
      }
      this.holdHeavy(SK, m, t);
      return;
    }
    if (m.name === "morgottCurseSpew") {
      // 诅咒喷吐专属：仰首蓄咒 → 前俯横扫喷扇（twist 从 -0.55 扫到 0.55，扇形覆盖 arc 1.5）
      if (sub === "tel") {
        this.lerpPose(STANCE, SPW, smooth(Math.min(1, t / (m.startup * 0.6))));
        return;
      }
      if (sub === "act") {
        const k = smooth(seg(t, 0, m.active));
        this.lerpPose(SPW, SPK, k);
        this.pose.twist = -0.55 + k * 1.1;
        return;
      }
      this.holdHeavy(SPK, m, t);
      return;
    }
    if (m.name === "morgottBloodChase") {
      // 血焰突斩专属：后仰蓄势 → 末 45% 前冲 → act 两拍（0.24/0.58）前冲大斜斩 + 回身反斩
      if (sub === "tel") {
        this.lerpPose(STANCE, BCW, smooth(Math.min(1, t / (m.startup * 0.55))));
        const k = smooth(clamp01((t - m.startup * 0.55) / (m.startup * 0.45)));
        if (k > 0) this.root.position.copy(this.moveFrom).addScaledVector(this.moveDir, this.moveLen * k);
        return;
      }
      if (sub === "act") {
        const firstAt = m.active * 0.4;
        const ph = clamp01((t - firstAt) / Math.max(0.01, m.active - firstAt)) * 2;
        const idx = Math.min(1, Math.floor(ph));
        this.lerpPose(idx === 0 ? BCW : BC1K, idx === 0 ? BC1K : BC2K, smooth(clamp01(ph - idx)));
        return;
      }
      this.holdHeavy(BC2K, m, t);
      return;
    }
    if (m.name === "morgottKingsProof") {
      // 1.6s 不缩短：快速落成拄剑，其余时间加深跪姿（聚气在 telegraph）。判定帧才拔剑金爆。
      if (sub === "tel") {
        const plantEnd = m.startup * 0.22;
        if (t <= plantEnd) this.lerpPose(STANCE, KPW, smooth(clamp01(t / Math.max(0.01, plantEnd))));
        else {
          const g = clamp01((t - plantEnd) / Math.max(0.01, m.startup - plantEnd));
          this.lerpPose(KPW, KP_CHARGE, g * g);
        }
        return;
      }
      if (sub === "act") {
        const hitAt = Math.max(0.01, m.active * 0.4);
        this.lerpPose(KP_CHARGE, KPK, t <= hitAt ? smooth(clamp01(t / hitAt)) : 1);
        this.proofNova(t, m.active);
        return;
      }
      this.holdHeavy(KPK, m, t);
      return;
    }
    // 通用 wind→strike（尾刀/匕首）+ 三拍连段（王杖/咒剑大剑）
    const wind: Pose = { ...STANCE }, strike: Pose = { ...STANCE };
    switch (m.name) {
      case "morgottTail":
        Object.assign(wind, TW); Object.assign(strike, TK);
        break;
      case "morgottDaggers":
        Object.assign(wind, DW); Object.assign(strike, DK);
        break;
    }
    if (sub === "tel") {
      this.lerpPose(STANCE, m.name === "morgottCombo" ? C1W : m.name === "morgottGreatsword" ? G1W : wind,
        smooth(seg(t, m.startup * 0.45, m.startup)));
    } else if (sub === "act") {
      if (m.name === "morgottCombo") this.trioPose(t, m, [C1W, C2W, C3W], [C1K, C2K, C3K]);
      else if (m.name === "morgottGreatsword") this.trioPose(t, m, [G1W, G2W, G3W], [G1K, G2K, G3K]);
      else this.lerpPose(wind, strike, seg(t, 0, m.active));
    } else {
      const end: Pose = m.name === "morgottCombo" ? C3K : m.name === "morgottGreatsword" ? G3K : strike;
      if (m.name === "morgottTail" || m.name === "morgottGreatsword") this.holdHeavy(end, m, t);
      else this.lerpPose(end, STANCE, smooth(seg(t, m.recovery * 0.35, m.recovery)));
    }
    void total;
  }

  /** 金色落点表现：冲击环与基类首段判定（active*0.4）同帧。打中/躲开都砸出坑。 */
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

  /** 王者之证金爆：与首段判定同帧。前摇里的聚气才是可读时钟，爆炸不抢在挥砍之前。 */
  private proofNova(t: number, active: number): void {
    if (this.fxStep !== 0 || t < active * 0.4) return;
    this.fxStep = 1;
    const c = this.root.position.clone();
    this.vfx.ring(c, PROOF_RING, GOLD);
    this.vfx.ring(c.clone().setY(0.05), 5.2, BLOOD);
    this.vfx.scorch(c, 3.6, GOLD);
    this.gold.burst(c.clone().setY(1.4), 40, 6.5, 1.6, 0.8);
    this.blood.burst(c.clone().setY(1.0), 18, 4, 1.2, 0.5);
    AU.slamShock();
    AU.roar();
    this.host.shake(0.85);
  }

  // ---------------- 蒙格特专属覆盖点 ----------------
  /** 缓存玩家位置（pickMove 的绕背检测拿不到 playerPos，只在 update 入口有）；
   *  帧末按帧 dt 驱动魅影武器显形缓动（墙钟会在快速步进/暂停时失真，帧 dt 恒稳） */
  override update(dt: number, playerPos: THREE.Vector3, playerIframed: boolean): void {
    this.frameDt = dt;                                                     // 必须在 super 之前：updateVisuals 要用本帧 dt
    this.playerPos.copy(playerPos);
    super.update(dt, playerPos, playerIframed);
    this.updateSummons(dt);
  }

  /** 魅影武器显形：金锤——延迟下砸前摇后半段渐显 / 跳跃扑杀出手即显；
   *  王之剑——咒剑大剑三连 tel+act（左手凭空召出）；咒剑——二阶段常驻（变身 0.8s 拔出） */
  private updateSummons(dt: number): void {
    const now = performance.now();
    let hammerTarget = 0, gswordTarget = 0, bladeTarget = 0;
    if (this.phase === 2 && this.state !== "statue") bladeTarget = 1;
    if (this.state === "transform") {
      bladeTarget = this.t >= 0.8 ? 1 : 0;
    } else if (this.state === "combat" && this.move) {
      const n = this.move.name;
      const telA = this.sub === "tel", actA = this.sub === "act";
      if (n === "morgottSlam") {
        hammerTarget = telA && this.t >= this.move.startup * 0.16 ? 1 : actA ? 1 : 0;
      } else if (n === "morgottPounce") {
        hammerTarget = telA || actA ? 1 : 0;
      } else if (n === "morgottGreatsword") {
        gswordTarget = telA || actA ? 1 : 0;
      }
    }
    const slamTel = this.state === "combat" && this.sub === "tel" && this.move?.name === "morgottSlam";
    this.hammerShow += (hammerTarget - this.hammerShow) * Math.min(1, dt * (slamTel ? 16 : 9));
    this.gswordShow += (gswordTarget - this.gswordShow) * Math.min(1, dt * 12);
    this.bladeShow += (bladeTarget - this.bladeShow) * Math.min(1, dt * 6);     // 拔剑较缓（仪式感）
    const mv = this.state === "combat" ? this.move : null;
    const windU = mv && this.sub === "tel" ? clamp01(this.t / Math.max(0.01, mv.startup)) : 0;
    const hammerHot = !!mv && (mv.name === "morgottSlam" || mv.name === "morgottPounce") && this.sub === "tel";
    const proofHot = !!mv && mv.name === "morgottKingsProof" && this.sub === "tel";
    const show = this.hammerShow;
    this.hammerG.visible = show > 0.04;
    this.hammerMat.emissiveIntensity = show * (1.3 + (hammerHot ? windU * 1.7 : 0) + Math.sin(now * 0.02) * 0.25);
    this.hammerMat.opacity = 0.55 + show * 0.37;
    const gshow = this.gswordShow;
    this.gswordG.visible = gshow > 0.04;
    this.gswordMat.emissiveIntensity = gshow * (1.35 + Math.sin(now * 0.022) * 0.3);
    this.gswordMat.opacity = 0.5 + gshow * 0.4;
    this.bladeG.visible = this.bladeShow > 0.04;
    this.staffG.visible = this.phase === 1 && this.hammerShow < 0.2;            // 二阶段杖隐剑出；金锤显形时杖让位
    this.bladeMat.emissiveIntensity = this.bladeShow * (1.1 + (proofHot ? windU * 2.4 : 0) + Math.sin(now * 0.016) * 0.3);
    if (show > 0.05 && show < 0.96 && Math.random() < dt * 22) {
      this.hammerG.getWorldPosition(SUMMON_TMP);
      this.gold.burst(SUMMON_TMP, 2, 1.1, 0.9, 0.4);                            // 凝聚金尘
    }
    if (gshow > 0.05 && gshow < 0.96 && Math.random() < dt * 26) {
      this.gswordG.getWorldPosition(SUMMON_TMP);
      this.gold.burst(SUMMON_TMP, 3, 1.2, 0.9, 0.4);
    }
  }

  /** 唤醒：跪王石像 2.2s → 抬身（守关人起身，王冠金辉点燃） */
  protected override updateRising(dt: number): void {
    this.t += dt;
    this.lerpPose(STATUE, STANCE, smooth(clamp01(this.t / 2.2)));
    if (Math.random() < dt * 8) this.vfx.dust.burst(this.root.position, 2, 2, 0.6);
    if (this.t > 0.5 && this.t - dt <= 0.5) this.host.onBossReveal();
    if (this.t >= 2.2) { this.state = "combat"; this.sub = "idle"; this.t = 0; }
  }

  /** 重前摇视觉钟：金尘旋进已有粒子池，不新建网格。frameDt 为 0 时停住（顿帧/暂停）。 */
  private telegraph(): void {
    if (this.state !== "combat" || this.sub !== "tel" || !this.move) {
      this.telU = 0;
      return;
    }
    const m = this.move;
    const u = clamp01(this.t / Math.max(0.01, m.startup));
    const prev = this.telU;
    // 顿帧时不推进节拍、不喷粒子，但辉光留在当前刻度，避免充能被打闪一下
    if (this.frameDt > 0) this.telU = u;
    if (m.name === "morgottKingsProof") {
      this.eyeMat.emissiveIntensity += u * 2.4;
      this.crownMat.emissiveIntensity += u * 1.8;
      if (this.frameDt <= 0) return;
      const px = this.root.position.x, pz = this.root.position.z;
      this.emitGather(px, 1.2, pz, 28 + u * 90, 1.15 + (1 - u) * 2.6);
      this.emitRing(12 + u * 26, 1.6 + u * 4.2);
      this.pulseAt(prev, u, [0.3, 0.55, 0.8], px, 1.05, pz);
    } else if (m.name === "morgottSlam") {
      this.crownMat.emissiveIntensity += u * 0.45;
      if (this.frameDt <= 0) return;
      this.hammerG.getWorldPosition(SUMMON_TMP);
      const x = SUMMON_TMP.x, y = SUMMON_TMP.y, z = SUMMON_TMP.z;
      this.emitGather(x, y, z, 14 + u * 40, 1.3);
      this.pulseAt(prev, u, [0.42], x, y, z);
    } else if (m.name === "morgottPounce") {
      this.crownMat.emissiveIntensity += u * 0.4;
      if (this.frameDt <= 0 || u <= 0.5) return;
      this.hammerG.getWorldPosition(SUMMON_TMP);
      const x = SUMMON_TMP.x, y = SUMMON_TMP.y, z = SUMMON_TMP.z;
      this.emitGather(x, y, z, 16 + u * 34, 1.05);
      this.pulseAt(prev, u, [0.68], x, y, z);
    }
  }

  private emitGather(tx: number, ty: number, tz: number, rate: number, radius: number): void {
    const dt = Math.min(this.frameDt, 0.05);
    if (dt <= 0) return;
    const expect = dt * rate;
    let n = Math.floor(expect);
    if (Math.random() < expect - n) n++;
    if (n > 4) n = 4;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const rad = radius * (0.35 + Math.random() * 0.65);
      const y = Math.max(0.05, ty - 1.1 + Math.random() * 1.8);
      const x = tx + Math.sin(a) * rad;
      const z = tz + Math.cos(a) * rad;
      const dx = tx - x, dy = ty - y, dz = tz - z;
      const len = Math.hypot(dx, dy, dz) || 1;
      const sp = 1.7 + Math.random() * 1.8;
      this.gold.spawn(x, y, z, (dx / len) * sp, (dy / len) * sp + 0.25, (dz / len) * sp, 0.42 + Math.random() * 0.32);
    }
  }

  private emitRing(rate: number, radius: number): void {
    const dt = Math.min(this.frameDt, 0.05);
    if (dt <= 0 || Math.random() > dt * rate) return;
    const a = Math.random() * Math.PI * 2;
    this.gold.spawn(
      this.root.position.x + Math.sin(a) * radius, 0.1, this.root.position.z + Math.cos(a) * radius,
      0, 0.55 + Math.random() * 0.7, 0, 0.5,
    );
  }

  private pulseAt(prev: number, u: number, marks: number[], x: number, y: number, z: number): void {
    for (const mark of marks) {
      if (prev < mark && u >= mark) {
        WISP_TMP.set(x, y, z);
        this.gold.burst(WISP_TMP, 9, 1.5, 0.48, 1.25);
      }
    }
  }

  /** 金瞳/王冠金辉呼吸 / 魅影武器显形缓动 / 刀光·喷扇按判定段补画 / 二阶段血焰附魔 + 数值 buff 一次性写入 */
  protected override updateVisuals(): void {
    const now = performance.now();
    // 跟游戏 dt：顿帧/暂停时停住，慢放时与前摇同一口时钟。墙钟会在这些时候把聚气播完。
    const dt = Math.min(0.05, Math.max(0, this.frameDt));
    this.gold.update(dt);
    this.blood.update(dt);
    const p2 = this.phase === 2;
    const flick = 1 + Math.sin(now * 0.018) * 0.15;
    let eye = (this.state === "statue" ? 0.28 : p2 ? 1.9 : 0.8) + Math.sin(now * 0.004) * 0.2;
    if (this.state === "transform") eye += seg(this.t, 0, 0.8) * 1.6;           // 变身点燃
    this.eyeMat.emissiveIntensity = Math.max(0, eye);
    this.crownMat.emissiveIntensity = (p2 ? 1.4 : 0.5) * flick;                 // 王冠残环呼吸
    // 二阶段血焰披身：周身金尘 + 咒剑血焰缕缕
    if (p2 && this.state !== "statue") {
      if (Math.random() < dt * 9) this.gold.burst(this.chestWorld(), 1, 0.5, 1.5, 0.3);
      if (this.bladeShow > 0.5 && Math.random() < dt * 7) {
        this.bladeG.getWorldPosition(SUMMON_TMP);
        this.blood.burst(SUMMON_TMP, 1, 0.6, 1.0, 0.5);
      }
    }
    this.telegraph();
    // 刀光/喷扇补画（hitFired 无条件按节拍推进，躲开也照画；首段与命中同帧）
    if (this.state === "combat" && this.sub === "act" && this.move) {
      const m = this.move;
      if (m.name === "morgottCombo") {
        while (this.slashFired < this.hitFired) {
          this.slashFired++;
          this.vfx.slash(this.chestWorld(), this.yaw + (this.slashFired === 2 ? 0.2 : -0.15),
            m.range * 0.85, this.slashFired === 3, p2 ? GOLD : GOLD_SLASH);     // 血焰附魔后金光
        }
      } else if (m.name === "morgottGreatsword") {
        while (this.slashFired < this.hitFired) {                               // 王之剑：主斩 + 长发金色残影双拖尾
          this.slashFired++;
          const at = this.chestWorld();
          this.vfx.slash(at, this.yaw + (this.slashFired === 2 ? -0.25 : 0.15), m.range * 0.92, true, GOLD);
          this.vfx.slash(at.clone().setY(1.15), this.yaw + 0.45, m.range * 0.78, true, GOLD_SLASH);
          this.vfx.slash(at.clone().setY(0.9), this.yaw - 0.5, m.range * 0.62, false, GOLD_SLASH);
          this.gold.burst(at, 10, 4, 1.0, 0.5);
        }
      } else if (m.name === "morgottCurseSpew") {
        while (this.slashFired < this.hitFired) {                               // 喷扇：血焰扇弧按段交替扫角
          this.slashFired++;
          const at = this.chestWorld().setY(1.25);
          this.vfx.slash(at, this.yaw + (this.slashFired % 2 ? 0.22 : -0.22), m.range * 0.88, true, BLOOD);
          this.blood.burst(at, 8, 3.5, 0.9, 0.4);
        }
        if (Math.random() < dt * 40) {                                          // 持续扫射：定向血焰粒子流
          const fwd = SPRAY_TMP.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
          const mouth = this.chestWorld().setY(1.5);
          for (let k = 0; k < 2; k++) {
            const s = 3.5 + Math.random() * 2, lat = (Math.random() - 0.5) * 2.6;
            this.blood.spawn(mouth.x + fwd.x * 0.5, mouth.y, mouth.z + fwd.z * 0.5,
              fwd.x * s + -fwd.z * lat, 0.6 + Math.random() * 0.8, fwd.z * s + fwd.x * lat, 0.8);
          }
        }
      } else if (m.name === "morgottBloodChase") {
        while (this.slashFired < this.hitFired) {
          this.slashFired++;
          this.vfx.slash(this.chestWorld(), this.yaw + (this.slashFired === 1 ? 0.2 : -0.3), m.range * 0.88, true, BLOOD);
          this.blood.burst(this.chestWorld(), 8, 3, 0.8, 0.5);
        }
      }
    }
    // 二阶段血焰附魔：一次性改写共享帧数据表（reset 还原；phase2Only 招按二阶段功率设计，不吃附魔）
    if (p2 && !this.p2Applied) this.applyPhase2Moves();
  }

  /** 二阶段血焰附魔：一阶段招式 前摇 ×0.9、伤害 ×1.15（王认真起来） */
  private applyPhase2Moves(): void {
    this.p2Applied = true;
    for (const m of Object.values(MOVES_MORGOTT)) {
      if (m.phase2Only) continue;
      m.startup = P1_BASE[m.name].startup * 0.9;
      m.dmg = Math.round(P1_BASE[m.name].dmg * 1.15);
    }
  }
  private restorePhase1Moves(): void {
    this.p2Applied = false;
    for (const m of Object.values(MOVES_MORGOTT)) {
      m.startup = P1_BASE[m.name].startup;
      m.dmg = P1_BASE[m.name].dmg;
    }
  }

  /** 挺拔王步（低频起伏 + 微前倾摆动） */
  protected override onIdleWalk(): void {
    const w = performance.now() * 0.0085;
    this.pose.y = Math.abs(Math.sin(w)) * 0.035 - 0.012;
    this.pose.lean = 0.10 + Math.sin(w * 2) * 0.03;
  }

  /** 位移基准与段计数复位：跳跃扑杀前扑 / 血焰突斩前冲（不越过玩家） */
  protected override onMoveStart(m: MoveDef, toPlayer: THREE.Vector3, dist: number): void {
    this.moveFrom.copy(this.root.position);
    this.slashFired = 0;
    this.fxStep = 0;
    this.moveLen = 0;
    this.telU = 0;
    this.lastMove = m.name;
    if (m.name !== "morgottPounce" && m.name !== "morgottBloodChase") return;
    this.moveDir.copy(toPlayer).setY(0);
    if (this.moveDir.lengthSq() < 1e-8) this.moveDir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    else this.moveDir.normalize();                                             // 重叠时 normalize(0) 会把落点写成 NaN
    const stop = m.name === "morgottPounce" ? 1.3 : 1.5;
    this.moveLen = Math.min(m.lunge ?? 0, Math.max(0, dist - stop));
  }

  /** 判定段开始：投掷魅影匕首扇形齐发（一阶段 3 连 / 二阶段 5 连）/ 尾刀全周轨迹（躲开也照画） */
  protected override onMoveActive(m: MoveDef): void {
    if (m.name === "morgottDaggers") {
      const n = this.phase === 2 ? 5 : 3;
      const origin = this.chestWorld().setY(1.75);
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * 0.16;                                   // 扇面 ±0.16 / ±0.32
        this.host.fireProjectile?.(origin, this.yaw + off, DAGGER_PROJ);
        if (i % 2 === 0) this.vfx.slash(origin, this.yaw + off, 0.9, false, GOLD);
      }
      this.gold.burst(origin, 6, 2, 0.7, 0.5);
    } else if (m.name === "morgottTail") {
      this.vfx.slash(this.chestWorld().setY(0.7), this.yaw, m.range * 0.9, true, this.phase === 2 ? GOLD : GOLD_SLASH);
      this.vfx.dust.burst(this.root.position.clone().setY(0.25), 8, 2.4, 0.7);
    }
  }

  /** 碰到武器才算打中。喷吐只挪起点；飞刀身子不判；王者之证跟金环，锤砸不再叠一圈。 */
  protected override attackVolume(m: MoveDef): AttackVolume | null {
    switch (m.name) {
      case "morgottCombo":
        return { kind: "blade", hilt: this.staffHilt, tip: this.staffTip, pad: 0.2 };
      case "morgottTail":
        return { kind: "blade", hilt: this.tailHilt, tip: this.tailTip, pad: 0.085 };
      case "morgottSlam":
      case "morgottPounce":
        return { kind: "blade", hilt: this.hammerHilt, tip: this.hammerTip, pad: 0.2 };
      case "morgottGreatsword":
        return { kind: "blade", hilt: this.gswordHilt, tip: this.gswordTip, pad: 0.08 };
      case "morgottBloodChase":
        return { kind: "blade", hilt: this.bladeHilt, tip: this.bladeTip, pad: 0.08 };
      case "morgottCurseSpew": {
        const p = this.mouth.getWorldPosition(HIT_TMP);
        return { kind: "cone", x: p.x, z: p.z, yaw: this.yaw, range: m.range, arc: m.arc };
      }
      case "morgottKingsProof":
        return { kind: "disk", x: this.root.position.x, z: this.root.position.z, r: PROOF_RING };
      case "morgottDaggers":
        return { kind: "none" };
      default:
        return null;
    }
  }

  /** 重招风声更闷 */
  protected override activeWhooshVolume(m: MoveDef): number {
    return m.name === "morgottSlam" || m.name === "morgottPounce" || m.name === "morgottKingsProof" || m.name === "morgottGreatsword" ? 0.6
      : m.name === "morgottTail" || m.name === "morgottCurseSpew" || m.name === "morgottBloodChase" ? 0.8 : 1;
  }

  /** 破绽：王身前倾垮伏，咒杖/咒剑垂荡 */
  protected override updateStaggerPose(): void {
    this.lerpPose(STANCE, { ...STANCE, lean: 0.55, crouch: 0.42, y: -0.32, nod: 0.42, rLift: 0.15, rSwing: 0.45, lLift: 0.15, lSwing: -0.4, tail: 0.5 }, Math.min(1, this.t * 5));
  }

  /** 弹反踉跄：后仰 + 双臂上荡（parriedDur 1.6，处决窗口比玛尔基特略宽） */
  protected override updateParriedPose(): void {
    this.lerpPose(STANCE, { ...STANCE, lean: -0.45, crouch: 0.3, y: -0.36, nod: -0.22, rLift: -0.85, rSwing: 0.35, lLift: -0.85, lSwing: -0.35, tail: -0.5 }, Math.min(1, this.t * 8));
  }

  /** 变身即攻击演出（wiki 诅咒爆发）：拄杖伏身咳喘（诅咒上涌）→ 0.8s 起身拔咒剑（杖隐剑出）→
   *  举剑聚能 → 1.9s 横斩金爆（基类同帧出冲击环/震屏/震波回调）→ 收剑立王姿
   *  （金瞳/王冠/血焰附魔数值由 updateVisuals 跟随 phase 写入） */
  protected override updateTransform(): void {
    if (this.t >= 0.8 && this.phase === 1) {
      this.phase = 2;
      this.gold.burst(this.chestWorld(), 26, 4, 1.5, 0.7);
      AU.roar();
    }
    if (this.t < 0.8) {
      this.lerpPose(STANCE, TF_GATHER, smooth(this.t / 0.8));
      if (this.frameDt > 0 && Math.random() < this.frameDt * 7.2) this.blood.burst(this.chestWorld(), 2, 1.2, 1.0, 0.8);  // 咳喘血焰（按 60fps 的 0.12/帧折算）
    } else if (this.t < 1.5) {
      this.lerpPose(TF_GATHER, TF_DRAW, smooth(seg(this.t, 0.8, 1.5)));
    } else if (this.t < this.transformHitAt) {
      this.lerpPose(TF_DRAW, TF_SLASH, smooth(seg(this.t, 1.5, this.transformHitAt)));
    } else {
      if (this.prevTfT < this.transformHitAt) {                                 // 横斩金爆帧（基类同帧出冲击环/震波回调）
        this.gold.burst(this.root.position.clone().setY(1.0), 22, 5, 1.4, 0.7);
        this.vfx.ring(this.root.position, 6.5, GOLD);
        this.vfx.slash(this.chestWorld(), this.yaw, 5.5, true, GOLD);
        this.blood.burst(this.root.position.clone().setY(1.2), 12, 3.5, 1.2, 0.6);
      }
      this.lerpPose(TF_SLASH, TF_STAND, smooth(seg(this.t, this.transformHitAt, this.transformHitAt + 0.4)));
      if (this.t > this.transformHitAt + 0.4) {
        this.lerpPose(TF_STAND, STANCE, smooth(seg(this.t, this.transformHitAt + 0.4, this.transformDur)));
      }
    }
    this.prevTfT = this.t;
  }

  /** 死亡：前倾垮塌 + 余烬 + 金尘与血焰同散（王陨） */
  protected override updateDeath(dt: number): void {
    this.lerpPose(this.pose, { ...STANCE, lean: 1.2, y: -0.85, crouch: 0.55, nod: 0.55, rLift: 0.25, rSwing: 0.55, lLift: 0.25, lSwing: -0.55, tail: 0.6 }, dt * 3.5);
    if (Math.random() < dt * 20) this.vfx.embers.burst(this.chestWorld(), 3, 3, 1.2);
    if (Math.random() < dt * 6) this.gold.burst(this.chestWorld(), 1, 0.8, 1.4, 0.4);
    if (Math.random() < dt * 4) this.blood.burst(this.chestWorld(), 1, 0.7, 1.2, 0.4);
  }

  protected override resetVisuals(): void {
    this.restorePhase1Moves();
    this.fxStep = 0;
    this.slashFired = 0;
    this.prevTfT = 0;
    this.lastMove = "";
    this.telU = 0;
    this.frameDt = 0;
    this.hammerShow = 0;
    this.gswordShow = 0;
    this.bladeShow = 0;
    this.hammerG.visible = false;
    this.gswordG.visible = false;
    this.bladeG.visible = false;
    this.staffG.visible = true;
    this.eyeMat.emissiveIntensity = 0.8;
    this.crownMat.emissiveIntensity = 0.5;
    this.bladeMat.emissiveIntensity = 0;
    this.lerpPose(STANCE, STATUE, 1);
  }

  /** 二阶段改过共享招式表时，销毁（死亡重开不走 reset）要还原，避免下一场一阶段就吃到附魔数值 */
  protected override releaseSharedState(): void {
    if (this.p2Applied) this.restorePhase1Moves();
  }

  /** 粒子池挂在 scene 直下（不随 root），dispose 时需单独摘除并释放 GPU 资源 */
  protected override extraDispose(): void {
    for (const p of [this.gold, this.blood]) {
      p.mesh.geometry.dispose();
      (p.mesh.material as THREE.Material).dispose();
      p.mesh.removeFromParent();
    }
  }

  /** 王杖三连收招：绕背改横扫尾刀，正面仍 40% 接下砸 */
  protected override pickChain(m: MoveDef, dist: number, toPlayer: THREE.Vector3): MoveDef | null {
    if (m.name === "morgottCombo" && dist < 3) {
      const dirYaw = Math.atan2(toPlayer.x, toPlayer.z);
      if (!angleWithin(this.yaw, dirYaw, 2.2)) {
        const tail = MOVES_MORGOTT.morgottTail;
        if ((this.cds[tail.name] ?? 0) <= 0 && Math.random() < 0.4 && dist < tail.range) return tail;
        return null;
      }
    }
    return super.pickChain(m, dist, toPlayer);
  }

  /** 这一招现在出手打得到。跃扑另有 9.5m 上限；前冲招按真实落点余距，而不是站桩射程。 */
  private moveReaches(m: MoveDef, dist: number): boolean {
    if (m.proj) return true;
    if (m.name === "morgottPounce") return dist <= POUNCE_REACH;
    const lunge = m.lunge ?? 0;
    if (lunge > 0) {
      const stop = m.name === "morgottBloodChase" ? 1.5 : 1.3;
      const gap = dist - Math.min(lunge, Math.max(0, dist - stop));
      return gap <= m.range + 0.45;
    }
    return dist < m.range * 0.95;
  }

  // ---------------- 选招（读招考试权重：绕背尾刀 / 贴身尾刀+突斩 / 中距杖压+延迟下砸 / 远距匕首扇+跃扑压制；
  //     二阶段加大剑三连与王者之证读招大题） ----------------
  protected override pickMove(dist: number): MoveDef | null {
    const M = MOVES_MORGOTT;
    const ready = (m: MoveDef) => (this.cds[m.name] ?? 0) <= 0 && (!m.phase2Only || this.phase === 2);
    const choose = (list: [MoveDef, number][]): MoveDef | null => {
      const cands: [MoveDef, number][] = [];
      for (const [m, w] of list) {
        if (w <= 0 || !ready(m) || !this.moveReaches(m, dist)) continue;
        // 降权而不是剔除：只剩这一招时（探针封锁其余冷却）仍然选得到
        cands.push([m, m.name === this.lastMove ? w * REPEAT_W : w]);
      }
      if (!cands.length) return null;
      return pickWeighted(cands) ?? cands[0][0];
    };
    const toP = TO_P.set(this.playerPos.x - this.root.position.x, 0, this.playerPos.z - this.root.position.z);
    const dirYaw = Math.atan2(toP.x, toP.z);
    const behind = dist < 3.0 && toP.lengthSq() > 0.04 && !angleWithin(this.yaw, dirYaw, 2.2);
    // 绕背优先甩尾。刚甩过则交给降权抽选，避免背后只剩尾刀时选不出来。
    if (behind && ready(M.morgottTail) && this.lastMove !== M.morgottTail.name) return M.morgottTail;
    const p2 = this.phase === 2;
    if (dist > 6) {
      return choose([
        [M.morgottDaggers, 3],
        [M.morgottPounce, dist <= POUNCE_REACH ? 2.5 : 0],
        [M.morgottBloodChase, p2 && dist <= 9 ? 2 : 0],
      ]);
    }
    if (dist < 2.4) {
      return choose([
        [M.morgottTail, 4],
        [M.morgottCombo, 3.2],
        [M.morgottBloodChase, p2 ? 1.6 : 0],
        [M.morgottCurseSpew, p2 && dist >= 1.6 ? 1.6 : 0],
      ]);
    }
    return choose([
      [M.morgottTail, behind ? 4 : 0],                                        // 刚用过尾刀时，中距绕背仍能再选到
      [M.morgottCombo, 3],
      [M.morgottGreatsword, p2 ? 3.5 : 0],
      [M.morgottSlam, 2.5],
      [M.morgottPounce, dist >= 2.6 && dist <= POUNCE_REACH ? 2 : 0],
      [M.morgottDaggers, dist >= 4.5 ? 1.5 : 0],
      [M.morgottCurseSpew, p2 && dist >= 2.6 ? 2.5 : 0],
      [M.morgottBloodChase, p2 ? 2 : 0],
      [M.morgottKingsProof, p2 && dist >= 1.8 && dist <= 5.8 ? 1.4 : 0],
    ]);
  }

}

/** 魅影武器凝聚金尘 / 聚气金尘 / 喷扇定向流的取位临时量（避免每帧分配） */
const SUMMON_TMP = new THREE.Vector3();
const HIT_TMP = new THREE.Vector3();
const WISP_TMP = new THREE.Vector3();
const SPRAY_TMP = new THREE.Vector3();
const TO_P = new THREE.Vector3();
