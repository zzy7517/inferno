/** Boss #5「接肢葛瑞克」（艾尔登法环·史东薇尔城主）：畸高臃肿的接肢贵族
  * 通用机制（状态机/削韧破绽/弹反/多段判定/击飞/冷却/走近追踪）全在 BossBase（boss-base.ts），
  * 本文件只保留葛瑞克专属：MOVES_GODRICK/FEEL_GODRICK（模块加载即并入 config 总表——调校台/存档自动收录，不改现有文件）、
  * 接肢外观与 Pose 系统（躯干伸出的三条嫁接手臂 + 金发王冠 + 主手巨斧，~70 mesh，暗金+腐绿+铁灰）、
  * 二阶段「斩臂接龙」：hp≤60% 挥斧自断左臂（斧刃碰到会被误伤 / 断臂期间减伤 / 削韧不清空——fextralife 权威锚点）
  * → 龙头手臂接上 → 嘶吼震波（"Forefathers, one and all… bear witness!"），进 P2 后第一招固定横扫龙焰。
  * 忠实度锚点（fextralife wiki）：Stance 105、全程不可弹反、P1 打击+标准 / P2 附加火属性（本作无属性表，以龙焰视觉承载）。
  * HP 6080 按本作 Boss 尺度（roster 620–780，≈1:7.8）折算为 780；魂 20000 属注册表接线（主线程）。
  */
import * as THREE from "three";
import { MOVES, FEEL, MoveDef, FeelDef, P } from "./config";
import { Vfx } from "./vfx";
import { AU } from "./audio";
import { BossBase, BossStats, clamp01, smooth, seg, pickWeighted as pickByWeight } from "./boss-base";
import type { AttackVolume, BossHost } from "./boss-base";
import { strikeContact } from "./weapon-hit";
import { mountBoss, getBossGltf } from "./boss-gltf";

export type { BossState, BossHost } from "./boss-base";

// ---------------- 主题色（暗金纹章 + 腐绿接肢肉 + 铁灰甲；躯体色板在 Blender 脚本里） ----------------
const AXE_SLASH = 0xe8d9a8;   // 巨斧金辉刀光
const FLAME = 0xff7a2a;       // 龙焰（P2）

// ---------------- 帧数据（P1 巨斧+接肢臂 7 招 + P2 龙系 3 招；全程不可弹反——wiki 锚点） ----------------
export const MOVES_GODRICK: Record<string, MoveDef> = {
  // 巨斧横扫（Axe Swing 系）：大范围高伤，前摇长——延迟欺诈是葛瑞克招牌（和玛尔基特同源）
  godrickCleave: {
    name: "godrickCleave", label: "巨斧横扫", startup: 0.70, active: 0.16, recovery: 1.05,
    dmg: 30, range: 4.6, arc: 2.8, parryable: false, cd: 4.0, feel: "gHeavy",
  },
  // 斧两连+臂抓三段（Axe Swing + Arm Swing）：第 k 段在 min(active*0.4+k*0.40, active)；
  // active 1.4 ⇒ 0.56/0.96/1.36（末段余量 0.04，三段全触发）
  godrickAxeCombo: {
    name: "godrickAxeCombo", label: "斧臂三连", startup: 0.42, active: 1.4, recovery: 1.10,
    dmg: 11, range: 3.6, arc: 1.8, hits: 3, hitInterval: 0.40,
    parryable: false, cd: 4.5, feel: "gCombo",
  },
  // 接肢臂抓取（P1 Grab）：近身不可格挡。前摇先把爪扬起，命中落在爪伸直的那一帧（active*0.4，knockUp 5）。
  // 按地只做收招表演，不再补第二段伤害——抓中之后是后摇惩罚窗，而不是抓+摔无缝真连。
  godrickGrab: {
    name: "godrickGrab", label: "接肢臂抓取", startup: 0.85, active: 0.55, recovery: 1.40,
    dmg: 16, range: 2.6, arc: 0.9, knockUp: 5, grab: true,
    parryable: false, cd: 8.5, feel: "gGrab",
  },
  // 旧「接肢摔」帧数据留在表里（调校台可见），结算已并回抓取本体，避免二次上抛/真连
  godrickGrabSlam: {
    name: "godrickGrabSlam", label: "接肢摔", startup: 0.05, active: 0.10, recovery: 0.20,
    dmg: 14, range: 2.6, arc: 1.2, grab: true, parryable: false, cd: 1.0, feel: "gGrab",
  },
  // 斧突刺（Axe Lunge）：斧收身后长前摇——双脚离地小跳是唯一预兆（tel 末 15% 加 hop）→ 长距离前刺扎地
  godrickLunge: {
    name: "godrickLunge", label: "斧突刺", startup: 1.00, active: 0.18, recovery: 1.10,
    dmg: 26, range: 5.2, arc: 0.8, lunge: 3.5, parryable: false, cd: 6.5, feel: "gHeavy",
  },
  // 狂乱五连（Fury Swings）：举斧到面前收势（长前摇骗取消）→ 逆时针/顺时针快/逆挑/两记下劈；
  // active 2.85 ⇒ 段时刻 1.14/1.56/1.98/2.40/2.82（末段余量 0.03）。表内"段间停顿"用均匀 0.42 近似——引擎单 hitInterval
  godrickFury: {
    name: "godrickFury", label: "狂乱五连", startup: 0.85, active: 2.85, recovery: 1.30,
    dmg: 10, range: 3.8, arc: 2.2, hits: 5, hitInterval: 0.42,
    parryable: false, cd: 8.0, feel: "gCombo",
  },
  // 旋斧（Stormcaller 近似）：全周 6.28 + 自身位移 2m（tel 段消费，不越过玩家）
  godrickSpin: {
    name: "godrickSpin", label: "旋斧", startup: 0.65, active: 0.35, recovery: 1.00,
    dmg: 24, range: 4.4, arc: 6.28, lunge: 2.0, parryable: false, cd: 5.5, feel: "gHeavy",
  },
  // 风暴呼啸（Stormcaller 风压）：中距 4 段 × 0.25s 连续小伤（active 1.3 ⇒ 0.52/0.77/1.02/1.27，末段余量 0.03）；
  // 击退向量放大由手感档案 gGust 承载（knockback 0.95 全 Boss 最大，4 段累计推出 ~3.8m）
  godrickWindGust: {
    name: "godrickWindGust", label: "风暴呼啸", startup: 0.70, active: 1.30, recovery: 1.10,
    dmg: 7, range: 7.0, arc: 0.9, hits: 4, hitInterval: 0.25,
    parryable: false, cd: 7.0, feel: "gGust",
  },
  // ---- P2 龙系（phase2Only，不吃 P2 buff） ----
  // 横扫龙焰（Sweeping Flame）：P2 开场固定技（硬性规则——进 P2 第一招必是它）；
  // 前摇先扬龙首，吐息才覆盖正面判定锥（±arc/2）。4 段 × 0.30s，
  // active 1.6 ⇒ 0.64/0.94/1.24/1.54（余量 0.06）；火面铺满整条锥，和命中同一区域
  godrickFlame: {
    name: "godrickFlame", label: "横扫龙焰", startup: 0.90, active: 1.60, recovery: 1.25,
    dmg: 8, range: 6.5, arc: 1.4, hits: 4, hitInterval: 0.30,
    parryable: false, cd: 6.5, phase2Only: true, feel: "gFlame",
  },
  // 龙首擒抱（P2 Grab）：前摇张嘴扬首，扑击留在前摇后段 → 嘴伸直的那一帧才咬（active*0.4）
  // 按地是收招，不再补摔伤。knockUp 5.5 落地后仍留得住 ≥0.7s 惩罚窗
  godrickDragonGrab: {
    name: "godrickDragonGrab", label: "龙首擒抱", startup: 1.05, active: 0.60, recovery: 1.45,
    dmg: 20, range: 3.0, arc: 1.0, knockUp: 5.5, grab: true, lunge: 2.0,
    parryable: false, cd: 10.0, phase2Only: true, feel: "gGrab",
  },
  // 我命尔跪！（I Command Thee Kneel!）：前摇先把斧扬过顶，再两连快砸（引擎段 0.92/1.27）→ 停顿
  // → 第三砸（2.05s，环与伤害同为 5.2m）。前两砸的环对齐基类 range+0.45，避免环外吃伤
  godrickKneel: {
    name: "godrickKneel", label: "我命尔跪！", startup: 0.80, active: 2.30, recovery: 1.20,
    dmg: 16, range: 3.0, arc: 6.28, hits: 2, hitInterval: 0.35,
    parryable: false, cd: 9.0, phase2Only: true, feel: "gHeavy",
  },
  // 断臂横伤（内部）：斩臂演出 0.5s 自断瞬间，靠近 boss 的玩家被挥落的巨斧误伤（wiki：靠近会被伤到）
  godrickSelfSever: {
    name: "godrickSelfSever", label: "断臂横伤", startup: 0.05, active: 0.10, recovery: 0.10,
    dmg: 12, range: 2.8, arc: 6.28, parryable: false, cd: 1.0, feel: "gHeavy",
  },
};
Object.assign(MOVES, MOVES_GODRICK);

// ---------------- 手感档案（巨躯重斧 Boss：顿帧沉、击退猛；gGust 风压=击退向量放大本体） ----------------
export const FEEL_GODRICK: Record<string, FeelDef & { label: string }> = {
  gCombo: { label: "葛瑞克·连击", hitstop: 0.06, shake: 0.40, sparks: 10, sparkSpeed: 4,   knockback: 0.35, sfx: "hitStone" },
  gHeavy: { label: "葛瑞克·巨斧", hitstop: 0.10, shake: 0.60, sparks: 16, sparkSpeed: 5,   knockback: 0.60, sfx: "hitHeavy" },
  gGrab:  { label: "接肢·抓取",   hitstop: 0.09, shake: 0.55, sparks: 12, sparkSpeed: 4.5, knockback: 0.30, sfx: "hitHeavy" },
  gGust:  { label: "风暴·风压",   hitstop: 0.02, shake: 0.15, sparks: 4,  sparkSpeed: 2.5, knockback: 0.95, sfx: "hitStone" },  // 4 跳连击不做屏震轰炸（仿 vFrost）
  gFlame: { label: "龙焰·段",     hitstop: 0.03, shake: 0.20, sparks: 6,  sparkSpeed: 3,   knockback: 0.15, sfx: "hitStone" },
};
Object.assign(FEEL, FEEL_GODRICK);

export const GODRICK_STATS: BossStats & { name: string; radius: number } = {
  name: "接肢葛瑞克", radius: 1.1,
  hp: 780,                            // wiki 6080 ÷ 本作 Boss 尺度 ~7.8（roster 620–780）
  poiseMax: 105, poiseDecay: 9,       // Stance 105（wiki 精确值）；恢复慢——巨躯韧厚
  staggerDur: 2.3, staggerMul: 1.5, parriedDur: 2.0,
  phase2At: 0.6,                      // wiki：≤60% HP 自断左臂（渐磨通道）；一刀打空血走 onLethal——双通道同一演出
  walkSpeed: 2.4, turnRate: 2.2,      // 臃肿巨躯：缓行、转向钝
};

/** 二阶段：前摇 ×0.92（削 8%，不得再叠到 ≥10%）、伤害 ×1.2。一律相对这份基线写，禁止从当前值连乘。 */
const P2_STARTUP_SCALE = 0.92;
const P2_DMG_SCALE = 1.2;
/** 斧突刺冲完后斧刃够得到的中心距。更远时基类 range+0.45 会在斧尖之前判中。 */
const LUNGE_REACH = 3.3;
/** 龙口扑击后咬得到的中心距（短于 range 3 + 基类 0.45）。 */
const DRAGON_BITE_REACH = 2.2;
/** 月刃胶囊厚度，盖住刃宽。 */
const AXE_PAD = 0.35;
/** 接肢臂半宽，沿肩到爪尖。 */
const ARM_PAD = 0.18;
/** 龙头半宽，从颈到吻尖。 */
const DRAGON_PAD = 0.22;
const VOL_AT = new THREE.Vector3();
/** 一阶段基线。buff 写在共享表上，旗标在实例上——实例丢了表还在，所以还原看表本身而不只看旗标。 */
const P1_BASE: Record<string, { startup: number; dmg: number }> = {};
for (const m of Object.values(MOVES_GODRICK)) if (!m.phase2Only) P1_BASE[m.name] = { startup: m.startup, dmg: m.dmg };

// ---------------- 姿态（Pose）：斧臂（右）/左臂（P1 接肢臂 → P2 龙臂共用肩枢轴） ----------------
interface GPose {
  y: number; lean: number; twist: number; crouch: number; reach: number;
  rLift: number; rSwing: number;   // 右臂（巨斧）：lift 正=前甩 负=上举；swing 正=向左抡
  lLift: number; lSwing: number;   // 左臂（接肢臂/龙臂，镜像）
  nod: number;                     // 头部俯仰（正=低头）
  spin: number;                    // 整体附加旋转（旋斧转体）
  jaw: number;                     // P2 龙嘴开合（0 闭 / 1 大张）
}
const STANCE: GPose = { y: 0, lean: 0.14, twist: -0.08, crouch: 0.05, reach: 0, rLift: 0.35, rSwing: 0.15, lLift: 0.25, lSwing: -0.2, nod: 0.12, spin: 0, jaw: 0 };
const STATUE: GPose = { ...STANCE, lean: 0.2, crouch: 0.18, y: -0.12, nod: 0.55, rLift: 0.52, rSwing: 0.05 };   // 巨斧拄地垂首伫立
// 巨斧横扫：右侧大开大合。角度加大，拍子不变——抡起来刃面要转过身前
const CLW: GPose = { ...STANCE, twist: 0.95, rLift: -1.9, rSwing: -1.25, lean: -0.16, crouch: 0.12, nod: -0.05 };
const CLK: GPose = { ...STANCE, twist: -1.15, rLift: 1.0, rSwing: 1.7, lean: 0.42, reach: 0.48, crouch: 0.1 };
// 斧臂三连三拍（拍内 wind→strike；1 右劈 / 2 左回抡 / 3 左臂横抓——对应判定 0.56/0.96/1.36）
const A1W: GPose = { ...STANCE, twist: 0.7, rLift: -1.4, rSwing: -1.1, nod: 0.08 };
const A1K: GPose = { ...STANCE, twist: -0.65, rLift: 0.85, rSwing: 1.2, lean: 0.28 };
const A2W: GPose = { ...STANCE, twist: -0.7, rLift: -1.55, rSwing: 1.1, nod: 0.08 };
const A2K: GPose = { ...STANCE, twist: 0.75, rLift: 0.9, rSwing: -1.3, lean: 0.26 };
const A3W: GPose = { ...STANCE, twist: 0.35, lLift: -0.9, lSwing: 0.5, lean: -0.05, rLift: 0.2 };
const A3K: GPose = { ...STANCE, lLift: 1.1, lSwing: -0.3, lean: 0.45, reach: 0.5, crouch: 0.15 };
// 狂乱五连五拍（对应判定 1.14/1.56/1.98/2.40/2.82）：逆时针 / 顺时针快 / 逆挑 / 下劈 / 再下劈
const F1W: GPose = { ...STANCE, twist: 0.8, rLift: -1.35, rSwing: -1.5 };
const F1K: GPose = { ...STANCE, twist: -0.95, rLift: 0.75, rSwing: 1.6, lean: 0.28 };
const F2W: GPose = { ...STANCE, twist: -0.8, rLift: -1.15, rSwing: 1.25 };
const F2K: GPose = { ...STANCE, twist: 0.9, rLift: 0.8, rSwing: -1.6, lean: 0.24 };
const F3W: GPose = { ...STANCE, twist: 0.4, rLift: -0.65, rSwing: -1.1, crouch: 0.15 };
const F3K: GPose = { ...STANCE, rLift: -2.15, rSwing: 0.35, lean: -0.18, y: 0.14, nod: -0.15 };   // 逆挑：斧走立圆
const F4W: GPose = { ...STANCE, twist: 0.35, rLift: -2.35, rSwing: 0.18, lean: -0.22, nod: 0.1 };
const F4K: GPose = { ...STANCE, rLift: 1.05, rSwing: 0.3, lean: 0.5, crouch: 0.22 };
const F5W: GPose = { ...STANCE, twist: -0.22, rLift: -2.05, rSwing: -0.3, lean: -0.16 };
const F5K: GPose = { ...STANCE, rLift: 1.15, rSwing: 0.4, lean: 0.62, crouch: 0.32, nod: 0.35 };
// 斧突刺：斧收身后长蓄（延迟欺诈）→ 前刺扎地；tel 末段 hop（双脚离地）在 movePose 附加
const LUW: GPose = { ...STANCE, twist: 0.75, rLift: 0.22, rSwing: -1.0, crouch: 0.24, lean: 0.06, nod: 0.22 };
const LUK: GPose = { ...STANCE, twist: -0.15, rLift: 1.75, rSwing: 0.08, lean: 0.55, reach: 0.62, crouch: 0.18 };
// 接肢臂抓取（P1）：前摇扬爪 → 伸直（命中与 knockUp 同帧）→ 高举 → 按地（纯演出，不再补伤）
const GRW: GPose = { ...STANCE, crouch: 0.28, twist: 0.4, lLift: -1.3, lSwing: -0.4, lean: 0.1 };
const GR1: GPose = { ...STANCE, lLift: 1.2, lSwing: 0.1, lean: 0.4, reach: 0.6, crouch: 0.18, twist: 0.15 };
const GR2: GPose = { ...STANCE, lLift: -2.3, lSwing: -0.1, lean: -0.18, y: 0.1, nod: -0.15 };
const GR3: GPose = { ...STANCE, lLift: 1.4, lSwing: 0.15, lean: 0.55, crouch: 0.3, nod: 0.3 };
// 龙首擒抱（P2）：张嘴嘶吼长延迟 → 前扑咬 → 举 → 摔+火息（jaw 贯穿）
const DGW: GPose = { ...STANCE, lLift: -1.5, lSwing: 0.4, lean: -0.22, nod: -0.2, jaw: 1.0, rLift: 0.5, twist: -0.2 };
const DG1: GPose = { ...STANCE, lLift: 1.3, lSwing: 0.05, lean: 0.42, reach: 0.65, crouch: 0.2, jaw: 0.9 };
const DG2: GPose = { ...STANCE, lLift: -2.2, lSwing: -0.1, lean: -0.15, y: 0.12, nod: -0.2, jaw: 1.0 };
const DG3: GPose = { ...STANCE, lLift: 1.5, lSwing: 0.2, lean: 0.6, crouch: 0.32, nod: 0.35, jaw: 0.2 };
// 旋斧：双臂收拢蓄势 → 张臂转体（spin 整圈）
const SPW: GPose = { ...STANCE, crouch: 0.22, twist: 0.4, rLift: -0.7, rSwing: 0.7, lLift: -0.5, lSwing: -0.5, nod: 0.12 };
const SPK: GPose = { ...STANCE, rSwing: -1.75, lSwing: 1.7, rLift: 0.72, lLift: 0.6, lean: 0.12 };
// 风暴呼啸：双臂交扣胸前吸气 → 双掌前推（风压持续）
const GUW: GPose = { ...STANCE, crouch: 0.25, lean: -0.15, nod: 0.2, rLift: -0.9, rSwing: 0.6, lLift: -0.9, lSwing: -0.6 };
const GUK: GPose = { ...STANCE, rLift: 1.3, lLift: 1.3, rSwing: 0.1, lSwing: -0.1, lean: 0.3, reach: 0.5 };
// 横扫龙焰：龙臂抡到身右蓄焰张嘴 → 自右向左横扫吐息（lSwing 0.9 → -0.9 在 movePose 线性驱动）
const FLW: GPose = { ...STANCE, lLift: -1.5, lSwing: 0.9, lean: -0.2, nod: -0.12, jaw: 0.7, rLift: 0.5 };
const FLK: GPose = { ...FLW, lSwing: -0.9, lLift: -1.4, jaw: 0.25, lean: 0.22, nod: 0.05 };
// 我命尔跪！：斧头朝下高举（斧刃垂地）→ 两连快砸 → 缓缓再举（停顿的恐惧）→ 第三砸（最深一跪）
const KNW: GPose = { ...STANCE, rLift: -2.55, rSwing: 0.1, lean: -0.26, nod: -0.28, y: 0.16, crouch: 0.08 };
const KN1: GPose = { ...STANCE, rLift: 1.15, lean: 0.55, crouch: 0.36, nod: 0.35 };
const KN2: GPose = { ...STANCE, rLift: -1.55, lean: -0.1, crouch: 0.12, nod: 0.05 };
const KN3: GPose = { ...STANCE, rLift: 1.25, lean: 0.78, crouch: 0.55, y: -0.28, nod: 0.5, rSwing: 0.25 };
// 斩臂接龙演出：仰天自白（"Forefathers, one and all… bear witness!"）→ 挥斧斩断左臂 → 跪伏剧痛 → 举龙臂嘶吼
const REEL: GPose = { ...STANCE, lean: -0.35, y: 0.1, nod: -0.35, rLift: -1.2, lLift: -1.2, crouch: 0.1 };
const CHOP: GPose = { ...STANCE, lean: 0.38, nod: 0.4, rLift: 1.35, rSwing: -1.2, twist: 0.5, crouch: 0.24 };   // 斧劈向自己左臂
const AGONY: GPose = { ...STANCE, lean: 0.5, crouch: 0.45, y: -0.34, nod: 0.55, rLift: 0.2, lLift: 0.2 };
const BRANDISH: GPose = { ...STANCE, lean: -0.16, y: 0.12, nod: -0.3, lLift: -2.2, lSwing: 0.25, jaw: 1.0, rLift: 0.6 };

export class Godrick extends BossBase {
  private body = new THREE.Group();
  private torso = new THREE.Group();
  private head = new THREE.Group();
  private legR = new THREE.Group();
  private legL = new THREE.Group();
  private shinR = new THREE.Group();
  private shinL = new THREE.Group();
  private armR = new THREE.Group();            // 右臂（巨斧）
  private armL = new THREE.Group();            // 左肩枢轴：P1 接肢臂 / P2 龙臂共用（演出换装切子组可见性）
  private fleshArm = new THREE.Group();        // P1 左接肢臂（斩臂后隐藏）
  private dragon = new THREE.Group();          // P2 龙头手臂（接上后显示）
  private jawLower = new THREE.Group();        // 龙下颚（jaw 开合）
  private stump!: THREE.Mesh;                  // 断臂残端（斩臂后显示、接龙后隐藏）
  private graftArms: THREE.Object3D[] = [];      // 躯干伸出的三条嫁接手臂（updateVisuals 蠕动）
  private graftBase: { x: number; z: number }[] = [];
  private axeHead = new THREE.Object3D();      // 月刃腹心：刀光贴着刃，不从胸口铺开
  private axeHilt = new THREE.Object3D();      // 握把
  private axeTip = new THREE.Object3D();       // 月刃外缘
  private armHilt = new THREE.Object3D();      // 接肢臂肩
  private armTip = new THREE.Object3D();       // 爪尖
  private dragonHilt = new THREE.Object3D();   // 龙颈（二阶段才显示，标记仍钉在龙头上）
  private dragonTip = new THREE.Object3D();    // 吻尖
  private gustFrom = new THREE.Object3D();     // 胸口：风暴锥的起点
  private maw = new THREE.Object3D();          // 龙口外沿：龙焰从这里喷出
  private eyeMat!: THREE.MeshStandardMaterial;
  private flameMat!: THREE.MeshStandardMaterial;   // P2 龙口内焰
  private flameLight!: THREE.PointLight;

  private pose: GPose = { ...STATUE };
  private playerPos = new THREE.Vector3(0, 0, 5);   // 第三砸距离、断臂刃判定用（update 入口缓存）
  private moveFrom = new THREE.Vector3();           // 位移类招（旋斧/突刺/龙扑）基准
  private moveDir = new THREE.Vector3(0, 0, 1);
  private moveLen = 0;
  private slashFired = 0;                           // 已补画刀光的判定段数（与 hitFired 对齐）
  private flameFired = 0;                           // 已补画火痕的龙焰段数
  private slamFired = 0;                            // 按地演出是否已播（不再补伤害）
  private kneelFired = 0;                           // 三连砸的落点表现步进（1/2/3 砸）
  private tfxStep = 0;                              // 斩臂接龙演出步进（1 断臂、2 接龙、3 嘶吼）
  private p2Applied = false;                        // 二阶段数值 buff 是否已写入共享表
  private p2OpenerPending = false;                  // P2 开场固定技：横扫龙焰（wiki 硬性规则）
  private lastMove = "";                            // 上一招名：同招再选时降权

  constructor(scene: THREE.Scene, vfx: Vfx, pos: THREE.Vector3, host: BossHost, facing = -Math.PI / 2) {
    super(scene, vfx, pos, host, GODRICK_STATS, facing);
    this.transformHitAt = 1.9;    // 斩臂接龙时序：0.5 断臂 / 1.3 接龙 / 1.9 嘶吼震波 / 2.5 落定
    this.transformDur = 2.5;
    this.assemble();
  }


  // ---------------- 外观：接肢贵族由 Blender 管线出（tools/blender/build_bosses.py）。
  // 挂点局部变换 = 组常量 × k(1.1526)，mountBoss 抄回各组后 applyPose 一行不改。
  // 斧/接肢爪/龙头的判定标记与月刃腹心都钉在 GLB 里；嫁接臂蠕动仍按游戏侧基准角。 ----------------
  protected override buildBody(): void {
    const rig = mountBoss(getBossGltf("godrick"), {
      body: this.body, torso: this.torso, head: this.head,
      legR: this.legR, shinR: this.shinR, legL: this.legL, shinL: this.shinL,
      armR: this.armR, armL: this.armL, flesh: this.fleshArm,
      dragon: this.dragon, jaw: this.jawLower,
    }, [
      "weapon-hilt", "weapon-tip", "axe-head",
      "weapon2-hilt", "weapon2-tip",
      "maw-hilt", "maw-tip", "maw", "gust",
    ]);
    this.axeHilt = rig.node("weapon-hilt");
    this.axeTip = rig.node("weapon-tip");
    this.axeHead = rig.node("axe-head");
    this.armHilt = rig.node("weapon2-hilt");
    this.armTip = rig.node("weapon2-tip");
    this.dragonHilt = rig.node("maw-hilt");
    this.dragonTip = rig.node("maw-tip");
    this.maw = rig.node("maw");
    this.gustFrom = rig.node("gust");
    this.eyeMat = rig.mat("godrick-eye");
    this.flameMat = rig.mat("godrick-flame");
    this.stump = rig.mesh("stump");                     // 断臂残端
    this.stump.visible = false;
    this.graftArms = [rig.node("graft0"), rig.node("graft1"), rig.node("graft2")];
    this.graftBase = [{ x: -1.15, z: -0.42 }, { x: -1.25, z: 0.48 }, { x: -0.38, z: 0.06 }];
    this.flameLight = new THREE.PointLight(FLAME, 0, 6, 2);
    this.flameLight.position.copy(this.maw.position);
    this.dragon.add(this.flameLight);
    this.dragon.visible = false;
    // 关节层级仍由代码搭（Blender 侧同构，网格已挂到各组上）
    this.legR.add(this.shinR);
    this.legL.add(this.shinL);
    this.body.add(this.legR, this.legL, this.torso);
    this.torso.add(this.head, this.armR, this.armL, this.stump);
    this.armL.add(this.fleshArm, this.dragon);
    this.dragon.add(this.jawLower);
    this.root.add(this.body);
  }

  protected override chestPart(): THREE.Object3D { return this.torso; }
  protected override headPart(): THREE.Object3D { return this.head; }

  /** 斧和龙头碰到才算。风暴从胸口、龙焰从龙嘴，range/arc 仍用招式上的数。跪地用已经在画的环。 */
  protected override attackVolume(m: MoveDef): AttackVolume | null {
    const axe: AttackVolume = { kind: "blade", hilt: this.axeHilt, tip: this.axeTip, pad: AXE_PAD };
    const arm: AttackVolume = { kind: "blade", hilt: this.armHilt, tip: this.armTip, pad: ARM_PAD };
    const head: AttackVolume = { kind: "blade", hilt: this.dragonHilt, tip: this.dragonTip, pad: DRAGON_PAD };
    switch (m.name) {
      case "godrickCleave":
      case "godrickLunge":
      case "godrickSpin":
      case "godrickSelfSever":
        return axe;
      case "godrickAxeCombo":
        // 段 0、1 是右斧（A1/A2），段 2 是左接肢臂（A3）
        return this.hitFired >= 2 ? arm : axe;
      case "godrickFury":
        // F1–F5 都只抡右斧：逆时针、顺时针、逆挑、下劈、再下劈。没有接肢臂那一拍
        return axe;
      case "godrickGrab":
      case "godrickGrabSlam":
        return arm;
      case "godrickDragonGrab":
        return head;
      case "godrickWindGust": {
        const p = this.gustFrom.getWorldPosition(VOL_AT);
        return { kind: "cone", x: p.x, z: p.z, yaw: this.yaw, range: m.range, arc: m.arc };
      }
      case "godrickFlame": {
        const p = this.maw.getWorldPosition(VOL_AT);
        return { kind: "cone", x: p.x, z: p.z, yaw: this.yaw, range: m.range, arc: m.arc };
      }
      case "godrickKneel":
        // 前两段引擎判定对上 near 环；第三砸 5.2 仍在 kneelFx，不从这里再打一次
        return { kind: "disk", x: this.root.position.x, z: this.root.position.z, r: this.kneelRing(this.hitFired, m) };
      default:
        return null;
    }
  }

  /** 我命尔跪正在画的环。前两砸 range+0.45，第三砸 5.2。 */
  private kneelRing(step: number, m: MoveDef): number {
    return step >= 2 ? 5.2 : m.range + 0.45;
  }

  /** 断臂那一斧：刃碰到才算。演出不走战斗判定，这里用同一对护手/尖。 */
  private axeContact(): THREE.Vector3 | null {
    const a = this.axeHilt.getWorldPosition(new THREE.Vector3());
    const b = this.axeTip.getWorldPosition(new THREE.Vector3());
    const hit = strikeContact(this.playerPos.x, this.playerPos.z, P.playerRadius, {
      now: { ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z },
      prev: null,
      pad: AXE_PAD,
    });
    return hit ? new THREE.Vector3(hit.x, hit.y, hit.z) : null;
  }

  // ---------------- 姿态应用 ----------------
  protected override applyPose(): void {
    const p = this.pose;
    this.root.rotation.y = this.yaw + p.spin;
    this.body.position.set(0, p.y - p.crouch * 0.34, p.reach);
    this.torso.rotation.set(p.lean, p.twist, 0);
    this.head.rotation.x = p.nod;
    this.armR.rotation.set(-p.rLift, 0, -p.rSwing);
    this.armL.rotation.set(-p.lLift, -0.12, p.lSwing);
    this.jawLower.rotation.x = 0.06 + p.jaw * 0.85;   // 张大才露出牙和口内焰；P1 龙颚隐藏，无副作用
    // 蹲伏/跪伏：前腿弓、后腿屈
    this.legR.rotation.x = -p.crouch * 0.7;
    this.shinR.rotation.x = p.crouch * 1.3;
    this.legL.rotation.x = -p.crouch * 0.55;
    this.shinL.rotation.x = p.crouch * 0.95;
  }

  private lerpPose(a: GPose, b: GPose, k: number): void {
    const p = this.pose;
    p.y = a.y + (b.y - a.y) * k; p.lean = a.lean + (b.lean - a.lean) * k;
    p.twist = a.twist + (b.twist - a.twist) * k; p.crouch = a.crouch + (b.crouch - a.crouch) * k;
    p.reach = a.reach + (b.reach - a.reach) * k;
    p.rLift = a.rLift + (b.rLift - a.rLift) * k; p.rSwing = a.rSwing + (b.rSwing - a.rSwing) * k;
    p.lLift = a.lLift + (b.lLift - a.lLift) * k; p.lSwing = a.lSwing + (b.lSwing - a.lSwing) * k;
    p.nod = a.nod + (b.nod - a.nod) * k; p.spin = a.spin + (b.spin - a.spin) * k;
    p.jaw = a.jaw + (b.jaw - a.jaw) * k;
  }

  protected override movePose(m: MoveDef, sub: string, t: number, total: number): void {
    const wind: GPose = { ...STANCE }, strike: GPose = { ...STANCE };
    switch (m.name) {
      case "godrickCleave":
        Object.assign(wind, CLW); Object.assign(strike, CLK);
        break;
      case "godrickLunge":
        Object.assign(wind, LUW); Object.assign(strike, LUK);
        break;
      case "godrickSpin":
        Object.assign(wind, SPW); Object.assign(strike, SPK);
        break;
      case "godrickWindGust":
        Object.assign(wind, GUW); Object.assign(strike, GUK);
        break;
      case "godrickFlame":
        Object.assign(wind, FLW); Object.assign(strike, FLK);
        break;
      case "godrickGrab":
        Object.assign(wind, GRW); Object.assign(strike, GR3);
        break;
      case "godrickDragonGrab":
        Object.assign(wind, DGW); Object.assign(strike, DG3);
        break;
      case "godrickKneel":
        Object.assign(wind, KNW); Object.assign(strike, KN3);
        break;
      case "godrickAxeCombo":
        Object.assign(strike, A3K);
        break;
      case "godrickFury":
        Object.assign(strike, F5K);
        break;
    }
    if (sub === "tel") {
      // 龙焰 / 下砸 / 抓取：整段前摇先扬到顶点并停住，命中留在 act
      if (m.name === "godrickFlame" || m.name === "godrickKneel" || m.name === "godrickGrab" || m.name === "godrickDragonGrab") {
        const k = clamp01(t / (m.startup * 0.75));
        this.lerpPose(STANCE, wind, 1 - (1 - k) * (1 - k));
      } else {
        this.lerpPose(STANCE, wind, smooth(seg(t, m.startup * 0.45, m.startup)));
      }
      // 斧突刺的延迟欺诈：前 85% 死寂蓄势，末 15% 双脚离地小跳（唯一预兆）
      if (m.name === "godrickLunge" && t > m.startup * 0.85) {
        this.pose.y += Math.sin((t - m.startup * 0.85) / (m.startup * 0.15) * Math.PI) * 0.14;
      }
      // 位移段：旋斧/突刺在前摇后 70% 走完；龙扑等龙首扬起之后再扑，避免人还没看见嘴就贴脸
      if (this.moveLen !== 0) {
        const start = m.name === "godrickDragonGrab" ? 0.72 : 0.30;
        const k = smooth(clamp01((t - m.startup * start) / (m.startup * (1 - start))));
        this.root.position.copy(this.moveFrom).addScaledVector(this.moveDir, this.moveLen * k);
      }
    } else if (sub === "act") {
      if (m.name === "godrickAxeCombo") this.comboPose(t, m);
      else if (m.name === "godrickFury") this.furyPose(t, m);
      else if (m.name === "godrickGrab") this.grabPose(t, false);
      else if (m.name === "godrickDragonGrab") this.grabPose(t, true);
      else if (m.name === "godrickKneel") this.kneelPose(t, m);
      else if (m.name === "godrickSpin") {
        const k = smooth(clamp01(t / m.active));
        this.lerpPose(wind, strike, k);
        this.pose.spin = Math.PI * 2 * k;        // 恰好整一圈
      } else if (m.name === "godrickWindGust") {
        this.lerpPose(wind, strike, seg(t, 0, m.active * 0.3));
        const w = Math.sin(performance.now() * 0.03) * 0.05;   // 持续风压的震颤
        this.pose.rLift += w; this.pose.lLift += w;
      } else if (m.name === "godrickFlame") {
        // 龙臂仍自右向左摆；火从首段判定前才铺满整条锥（和基类的固定弧一致，不把火只画在一侧）
        const k = seg(t, 0, m.active);
        this.lerpPose(wind, { ...FLW, lSwing: 0.9 - 1.8 * k, lLift: -1.6, jaw: 1.0 }, k);
        if (t >= m.active * 0.35 && Math.random() < 0.85) this.flameSpray(1.5 + Math.random() * 4.6, (Math.random() - 0.5) * m.arc);
      } else this.lerpPose(wind, strike, seg(t, 0, m.active));
    } else {
      // 重招先在命中姿态上停约 0.7s，这段才是看得见的惩罚窗
      const hold = Math.min(0.7, Math.max(0, m.recovery - 0.22));
      this.lerpPose(strike, STANCE, smooth(seg(t, hold, m.recovery)));
      if (m.name === "godrickSpin") this.pose.spin = 0;        // 2π≡0：收招直接归零，不倒转
    }
    void total;
  }

  /** 斧臂三连判定段姿态：三拍与引擎判定时刻对齐（首段 active*0.4=0.56，其后每 0.40s），1/2 巨斧交替、3 左臂横抓 */
  private comboPose(t: number, m: MoveDef): void {
    const firstAt = m.active * 0.4;
    const ph = clamp01((t - firstAt) / (m.active - firstAt)) * 3;
    const idx = Math.min(2, Math.floor(ph));
    const s = smooth(clamp01(ph - idx));
    const w = idx === 0 ? A1W : idx === 1 ? A2W : A3W;
    const k = idx === 0 ? A1K : idx === 1 ? A2K : A3K;
    this.lerpPose(w, k, s);
  }

  /** 狂乱五连判定段姿态：五拍与引擎判定时刻对齐（首段 1.14，其后每 0.42s） */
  private furyPose(t: number, m: MoveDef): void {
    const firstAt = m.active * 0.4;
    const ph = clamp01((t - firstAt) / (m.active - firstAt)) * 5;
    const idx = Math.min(4, Math.floor(ph));
    const s = smooth(clamp01(ph - idx));
    const ws = [F1W, F2W, F3W, F4W, F5W];
    const ks = [F1K, F2K, F3K, F4K, F5K];
    this.lerpPose(ws[idx], ks[idx], s);
  }

  /** 抓取三拍：伸直（与基类首段判定 active*0.4 同帧）→ 举过顶 → 按地。按地只剩重量，不再补伤害。 */
  private grabPose(t: number, dragon: boolean): void {
    const m = dragon ? MOVES_GODRICK.godrickDragonGrab : MOVES_GODRICK.godrickGrab;
    const tBite = m.active * 0.4;
    const tSlam = Math.min(m.active * 0.72, tBite + 0.2);
    const w = dragon ? DGW : GRW;
    const p1 = dragon ? DG1 : GR1;
    const p2 = dragon ? DG2 : GR2;
    const p3 = dragon ? DG3 : GR3;
    if (t <= tBite) this.lerpPose(w, p1, smooth(clamp01(t / Math.max(0.05, tBite))));
    else if (t < tSlam) this.lerpPose(p1, p2, smooth((t - tBite) / (tSlam - tBite)));
    else this.lerpPose(p2, p3, smooth(clamp01((t - tSlam) / 0.12)));
    if (t >= tSlam) this.grabSlam(dragon);
  }

  /** 按地落点：尘、环、龙息。伤害已在伸直那一帧结算，这里不再打第二下。 */
  private grabSlam(dragon: boolean): void {
    if (this.slamFired !== 0) return;
    this.slamFired = 1;
    const at = this.root.position.clone().addScaledVector(new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)), 1.5).setY(0.15);
    this.vfx.dust.burst(at, 8, 2.6, 0.6);
    this.vfx.ring(at, 1.6);
    if (dragon) {
      this.vfx.scorch(at, 1.6, FLAME);
      this.vfx.embers.burst(at.clone().setY(0.5), 8, 2.8, 0.9);
    }
    AU.slamShock();
    this.host.shake(0.4);
  }

  /** 我命尔跪！：高举蓄势 → 砸1(0.92) → 快砸2(1.27) → 停顿缓举（恐惧窗口）→ 第三砸(2.05 手动判定+巨环)。
   *  落点表现按窗口首帧触发（kneelFx 步进闸），与引擎判定时刻 0.92/1.27 及手动第三砸 2.05 对齐 */
  private kneelPose(t: number, m: MoveDef): void {
    const ring = (step: number) => this.kneelRing(step, m);
    if (t < 0.92) this.lerpPose(KNW, KN1, smooth(seg(t, 0.7, 0.92)));
    else if (t < 1.27) { this.kneelFx(0, ring(0)); this.lerpPose(KN1, KN2, smooth(seg(t, 0.92, 1.02))); }
    else if (t < 2.05) { this.kneelFx(1, ring(1)); this.lerpPose(KN2, KNW, smooth(seg(t, 1.45, 2.05))); }
    else { this.kneelFx(2, ring(2)); this.lerpPose(KNW, KN3, smooth(seg(t, 2.05, 2.25))); }
  }

  /** 三连砸的落点表现 + 第三砸手动判定（引擎只发前两段 dmg；第三段走 host 总线，同 feel） */
  private kneelFx(step: number, radius: number): void {
    if (this.kneelFired !== step) return;
    this.kneelFired = step + 1;
    this.vfx.ring(this.root.position, radius);
    this.vfx.dust.burst(this.root.position.clone().setY(0.2), step === 2 ? 14 : 6, 3, 0.7);
    this.vfx.scorch(this.root.position.clone().addScaledVector(new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)), 1.8), radius * 0.55);
    AU.slamShock();
    this.host.shake(step === 2 ? 0.7 : 0.4);
    if (step === 2) {
      const m = MOVES_GODRICK.godrickKneel;
      const toP = this.playerPos.clone().sub(this.root.position); toP.y = 0;
      const d = toP.length();
      if (d <= radius) {   // 与这一砸的环同一半径（第三砸 5.2；前两砸不走这里）
        const dir = d > 0.001 ? toP.normalize() : new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        this.host.onBossHit(m.dmg, dir, this.chestWorld(), m);
      }
    }
  }

  /** 横扫龙焰的扫掠余烬：从龙口出发，沿扫掠角铺到原来的锥上 */
  private flameSpray(dist: number, off: number): void {
    const yaw = this.yaw + off;
    const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const side = new THREE.Vector3(fwd.z, 0, -fwd.x);
    const mouth = this.maw.getWorldPosition(new THREE.Vector3());
    const at = mouth.clone().addScaledVector(fwd, dist).addScaledVector(side, (Math.random() - 0.5) * 0.85);
    const fall = clamp01(dist / 6.5);
    at.y = mouth.y + (0.4 + Math.random() * 0.45 - mouth.y) * fall;
    this.vfx.embers.burst(at, 2, 1.6, 1.0);
  }

  // ---------------- 葛瑞克专属覆盖点 ----------------
  /** 缓存玩家位置（grabSlam/kneelFx/断臂误伤的距离判定在 movePose/updateTransform 内，update 入口才有 playerPos） */
  override update(dt: number, playerPos: THREE.Vector3, playerIframed: boolean): void {
    this.playerPos.copy(playerPos);
    super.update(dt, playerPos, playerIframed);
    // 破绽/抓取收招之后若没人把姿态拉回站立，会一直保持垮跪或转体
    if (this.state === "combat" && this.sub === "idle") {
      this.settleIdlePose(1 - Math.exp(-12 * dt));
      this.applyPose();
    }
  }

  /** 站立：各通道回到 STANCE。走近时再叠沉重步态；二阶段嘴保持微张呼吸。 */
  private settleIdlePose(k: number): void {
    this.lerpPose(this.pose, STANCE, k);
    this.pose.spin = 0;
    const toP = this.playerPos.clone().sub(this.root.position); toP.y = 0;
    if (toP.length() > 3) {
      const w = performance.now() * 0.007;
      this.pose.y = Math.abs(Math.sin(w)) * 0.06 - 0.02;
      this.pose.lean = 0.14 + Math.sin(w * 2) * 0.02;
    }
    if (this.phase === 2) this.pose.jaw = 0.12 + Math.sin(performance.now() * 0.005) * 0.06;
  }

  /** 断臂演出期间减伤（wiki：severing 期间获得减伤加成）——削韧照常（换阶段不清空 Stance 积累） */
  override takeHit(dmg: number, poise: number): { died: boolean; staggered: boolean } {
    return super.takeHit(this.state === "transform" ? dmg * 0.5 : dmg, poise);
  }

  /** 唤醒：垂斧石像 2.6s 缓缓直身 + 抖尘，落定嘶吼 */
  protected override updateRising(dt: number): void {
    this.t += dt;
    this.lerpPose(STATUE, STANCE, smooth(clamp01(this.t / 2.6)));
    if (Math.random() < dt * 7) this.vfx.dust.burst(this.root.position, 3, 2, 0.7);
    if (this.t > 0.5 && this.t - dt <= 0.5) this.host.onBossReveal();
    if (this.t >= 2.6) {
      this.state = "combat"; this.sub = "idle"; this.t = 0;
      AU.roar();
    }
  }

  /** 唤醒瞬间：起身音 + 尘爆 */
  protected override onAwaken(): void {
    AU.rise();
    this.vfx.dust.burst(this.root.position.clone().setY(0.8), 12, 2.5, 0.8);
  }

  /** 金眼呼吸 / 嫁接臂蠕动 / P2 龙焰口辉 / 刀光·火痕按判定段补画 / 二阶段数值 buff 一次性写入 */
  protected override updateVisuals(): void {
    const now = performance.now();
    const p2 = this.phase === 2;
    const eye = (this.state === "statue" ? 0.35 : p2 ? 2.0 : 0.9) + Math.sin(now * 0.004) * 0.2;
    this.eyeMat.emissiveIntensity = Math.max(0, eye);
    // 嫁接手臂蠕动：各臂异相位小幅抽搐（接肢的"活物感"）
    for (let i = 0; i < this.graftArms.length; i++) {
      const g = this.graftArms[i];
      const base = this.graftBase[i];
      if (!base) continue;
      g.rotation.x = base.x + Math.sin(now * 0.003 + i * 2.1) * 0.08;
      g.rotation.z = base.z + Math.cos(now * 0.0024 + i * 1.7) * 0.06;
    }
    // P2 龙焰：口内焰闪烁 + 点灯 + 待机微张嘴呼吸
    const flick = 1 + Math.sin(now * 0.02) * 0.15;
    this.flameMat.emissiveIntensity = p2 ? 1.7 * flick : 0;
    this.flameLight.intensity = p2 ? 3.4 * flick : 0;
    if (p2 && this.state === "combat" && this.sub === "idle") this.pose.jaw = 0.12 + Math.sin(now * 0.005) * 0.06;
    // 刀光：近战多段每段一光（hitFired 无条件按节拍推进，躲开也照画；首段与命中同帧）。弧心在刃腹，半径只罩月刃
    if (this.state === "combat" && this.sub === "act" && this.move &&
      (this.move.name === "godrickCleave" || this.move.name === "godrickAxeCombo" || this.move.name === "godrickFury")) {
      while (this.slashFired < this.hitFired) {
        this.slashFired++;
        const wide = this.move.arc > 2 || this.move.name === "godrickFury";
        this.vfx.slash(this.axeHead.getWorldPosition(new THREE.Vector3()), this.yaw, wide ? 1.25 : 0.9, wide, AXE_SLASH);
      }
    }
    // 龙焰火痕：每判定段铺满正面锥（命中也是这整条锥，不是摆臂的单侧）
    if (this.state === "combat" && this.sub === "act" && this.move?.name === "godrickFlame") {
      while (this.flameFired < this.hitFired) {
        this.flameFired++;
        // 判定是固定正面锥，火痕铺满锥而不是只烧当前摆臂的那一侧
        for (const off of [-0.45, 0, 0.45]) {
          const fwd = new THREE.Vector3(Math.sin(this.yaw + off), 0, Math.cos(this.yaw + off));
          this.vfx.scorch(this.root.position.clone().addScaledVector(fwd, 4.0).setY(0.05), 1.35, FLAME);
        }
        this.vfx.embers.burst(this.maw.getWorldPosition(new THREE.Vector3()), 6, 3, 0.9);
      }
    }
    // 风暴呼啸：持续风流尘（自中心向前吹）
    if (this.state === "combat" && this.sub === "act" && this.move?.name === "godrickWindGust" && Math.random() < 0.7) {
      const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      this.vfx.dust.burst(this.root.position.clone().addScaledVector(fwd, 1.8 + Math.random() * 3.5).setY(0.3 + Math.random() * 0.9), 2, 1.6, 0.6);
    }
    // 二阶段数值：phase===2 才写入；离开二阶段或共享表残留 buff 时还原到 P1_BASE
    this.syncPhaseMoves();
  }

  /** 共享表是否整表处于二阶段公式（实例旗标丢了也能认出来） */
  private phaseTableIsBuffed(): boolean {
    let seen = 0;
    let buffed = 0;
    for (const m of Object.values(MOVES_GODRICK)) {
      if (m.phase2Only) continue;
      const b = P1_BASE[m.name];
      if (!b) continue;
      seen++;
      const startupBuff = Math.abs(m.startup - b.startup * P2_STARTUP_SCALE) < 1e-4;
      const dmgBuff = m.dmg === Math.round(b.dmg * P2_DMG_SCALE);
      if (startupBuff && dmgBuff) buffed++;
    }
    return seen > 0 && buffed === seen;
  }

  private syncPhaseMoves(): void {
    if (this.phase === 2) {
      if (!this.p2Applied) this.applyPhase2Moves();
      return;
    }
    if (this.p2Applied || this.phaseTableIsBuffed()) this.restorePhase1Moves();
  }

  /** 二阶段：原有招式 dmg×1.2、前摇×0.92（相对基线，不连乘；P2 龙系三招不吃 buff） */
  private applyPhase2Moves(): void {
    this.p2Applied = true;
    for (const m of Object.values(MOVES_GODRICK)) {
      if (m.phase2Only) continue;
      const b = P1_BASE[m.name];
      if (!b) continue;
      m.startup = b.startup * P2_STARTUP_SCALE;
      m.dmg = Math.round(b.dmg * P2_DMG_SCALE);
    }
  }
  private restorePhase1Moves(): void {
    this.p2Applied = false;
    for (const m of Object.values(MOVES_GODRICK)) {
      if (m.phase2Only) continue;
      const b = P1_BASE[m.name];
      if (!b) continue;
      m.startup = b.startup;
      m.dmg = b.dmg;
    }
  }

  /** 步态由 update 末尾的 settleIdlePose 统一写，避免这里只改 y/lean 把垮跪姿态留住 */
  protected override onIdleWalk(): void { }

  /** 位移基准与段计数复位：旋斧 2m / 斧突刺 3.5m / 龙扑 2m（均不越过玩家）；P2 开场固定技标记清算 */
  protected override onMoveStart(m: MoveDef, toPlayer: THREE.Vector3, dist: number): void {
    this.moveFrom.copy(this.root.position);
    this.slashFired = 0;
    this.flameFired = 0;
    this.slamFired = 0;
    this.kneelFired = 0;
    this.moveLen = 0;
    this.lastMove = m.name;
    if (m.name === "godrickFlame") this.p2OpenerPending = false;   // 开场固定技已出
    if (m.name === "godrickSpin" || m.name === "godrickLunge" || m.name === "godrickDragonGrab") {
      const keep = m.name === "godrickDragonGrab" ? 1.0 : 1.2;
      const reach = m.name === "godrickLunge" ? LUNGE_REACH : m.name === "godrickDragonGrab" ? DRAGON_BITE_REACH : m.range;
      this.moveDir.copy(toPlayer).setY(0);
      if (this.moveDir.lengthSq() > 1e-6) this.moveDir.normalize();
      else this.moveDir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      this.yaw = Math.atan2(this.moveDir.x, this.moveDir.z);   // 斧口/龙口与冲刺同一方向
      const travel = Math.min(m.lunge ?? 0, Math.max(0, dist - keep));
      // 冲完仍超出武器能碰到的距离就原地不出位移：否则 range+0.45 会在空挥上造成伤害
      this.moveLen = dist - travel <= reach ? travel : 0;
    }
  }

  /** 重招风声更闷 */
  protected override activeWhooshVolume(m: MoveDef): number {
    return m.name === "godrickCleave" || m.name === "godrickSpin" || m.name === "godrickKneel" ? 0.6 : m.name === "godrickWindGust" ? 0.8 : 1;
  }

  /** 破绽：巨躯前倾垮跪、双臂垂荡 */
  protected override updateStaggerPose(): void {
    this.lerpPose(STANCE, { ...STANCE, lean: 0.7, crouch: 0.45, y: -0.35, nod: 0.4, rLift: 0.3, rSwing: 0.5, lLift: 0.3, lSwing: -0.5 }, Math.min(1, this.t * 5));
  }

  /** 踉跄（不可弹反——仅削韧破绽/抓取硬直后的姿态变化） */
  protected override updateParriedPose(): void {
    this.lerpPose(STANCE, { ...STANCE, lean: -0.5, crouch: 0.3, y: -0.3, nod: -0.25, rLift: -0.9, rSwing: 0.3, lLift: -0.7 }, Math.min(1, this.t * 8));
  }

  /** 斩臂接龙演出（transform 状态，基类 1.9s 同刻回调 onBossTransform 震波）：
   *  0–0.35 仰天自白（"Forefathers, one and all… bear witness!"）
   *  0.35–0.5 挥斧劈向自己左臂 → 0.5 断臂（残端露出/血尘/斧刃碰到才误伤 godrickSelfSever）
   *  0.5–1.3 跪伏剧痛（期间减伤 ×0.5，见 takeHit）→ 1.3 龙头手臂接上
   *  1.3–1.9 举龙臂张嘴 → 1.9 嘶吼震波（phase=2 / hp 回 30% / P2 开场固定技挂起）→ 2.5 落定
   */
  protected override updateTransform(): void {
    if (this.t < 0.35) {
      this.lerpPose(STANCE, REEL, smooth(this.t / 0.35));
    } else if (this.t < 0.5) {
      this.lerpPose(REEL, CHOP, smooth(seg(this.t, 0.35, 0.5)));   // 斧劈向自己左臂
    } else if (this.t < 1.3) {
      if (this.tfxStep === 0) {
        this.tfxStep = 1;
        this.fleshArm.visible = false;          // 断左臂
        this.stump.visible = true;              // 残端露出
        const at = this.armL.getWorldPosition(new THREE.Vector3());
        this.vfx.sparks.burst(at, 14, 4, 0.5, 0.4);
        this.vfx.dust.burst(at, 6, 2, 0.7);
        AU.hitHeavy();
        this.host.shake(0.4);
        // 挥落的巨斧刃碰到才误伤（wiki：自断演出靠近受伤）
        const point = this.axeContact();
        if (point) {
          const sv = MOVES_GODRICK.godrickSelfSever;
          const toP = this.playerPos.clone().sub(this.root.position); toP.y = 0;
          const d = toP.length();
          const dir = d > 0.001 ? toP.normalize() : new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
          this.host.onBossHit(sv.dmg, dir, point, sv);
        }
      }
      this.lerpPose(CHOP, AGONY, smooth(seg(this.t, 0.5, 1.1)));
    } else if (this.t < 1.9) {
      if (this.tfxStep === 1) {
        this.tfxStep = 2;
        this.stump.visible = false;             // 残端被龙颈覆盖
        this.dragon.visible = true;             // 龙头手臂接上
        const at = this.armL.getWorldPosition(new THREE.Vector3());
        this.vfx.embers.burst(at, 10, 3, 1.0);
        this.vfx.sparks.burst(at, 10, 3.5, 0.45, 0.6);
        AU.transform();
      }
      this.lerpPose(AGONY, BRANDISH, smooth(seg(this.t, 1.3, 1.9)));
    } else {
      if (this.tfxStep === 2) {
        this.tfxStep = 3;
        this.phase = 2;                          // 龙焰/数值 buff 由 updateVisuals 跟随 phase 写入
        this.hp = Math.max(this.hp, this.maxHp * 0.3);   // 血回 30%（打空血路径=复活；60% 路径只补不扣）
        this.p2OpenerPending = true;             // P2 开场固定技：横扫龙焰
        AU.roar();
        this.vfx.dust.burst(this.root.position.clone().setY(0.4), 14, 3, 0.8);
        this.vfx.embers.burst(this.chestWorld(), 10, 3.5, 1.2);
      }
      this.lerpPose(BRANDISH, STANCE, smooth(seg(this.t, 1.9, 2.5)));
    }
  }

  /** 一阶段致死拦截：入 transform 演「斩臂接龙」；演出期间（含回血后的收尾段）继续挨打免死。
   *  削韧不清空（wiki：换阶段保留 Stance 积累） */
  protected override onLethal(): boolean {
    if (this.state === "transform") return true;    // 演出中 hp 被钳 0 也不死（白打也得看完）
    if (this.phase !== 1) return false;             // 二阶段正常死亡
    this.state = "transform"; this.sub = "idle"; this.t = 0;
    this.move = null;
    this.transformHitAt = 1.9; this.transformDur = 2.5;
    AU.transform();
    return true;
  }

  /** 死亡：巨躯前倾垮塌 + 余烬 */
  protected override updateDeath(dt: number): void {
    this.lerpPose(this.pose, { ...STANCE, lean: 1.25, y: -0.85, crouch: 0.55, nod: 0.55, rLift: 0.3, lLift: 0.3 }, dt * 3);
    if (Math.random() < dt * 20) this.vfx.embers.burst(this.chestWorld(), 3, 3, 1.2);
  }

  /** 复位：演出时序还原（resetVisuals 还原外观/数值） */
  override reset(): void {
    super.reset();
    this.transformHitAt = 1.9;
    this.transformDur = 2.5;
  }

  protected override releaseSharedState(): void {
    this.restorePhase1Moves();
  }

  protected override resetVisuals(): void {
    this.restorePhase1Moves();
    this.tfxStep = 0;
    this.p2OpenerPending = false;
    this.fleshArm.visible = true;
    this.stump.visible = false;
    this.dragon.visible = false;
    this.flameMat.emissiveIntensity = 0;
    this.flameLight.intensity = 0;
    this.eyeMat.emissiveIntensity = 0.9;
    this.slashFired = 0;
    this.flameFired = 0;
    this.slamFired = 0;
    this.kneelFired = 0;
    this.lastMove = "";
    this.pose.spin = 0;
    this.lerpPose(STANCE, STATUE, 1);
  }

  /** 冲刺结束后的间距。keep：停在身前，避免穿进玩家。 */
  private gapAfterDash(dist: number, lunge: number, keep: number): number {
    const travel = Math.min(lunge, Math.max(0, dist - keep));
    return dist - travel;
  }

  /** 同招连续第二次权重降到 0.3；池里只剩它时仍会出。 */
  private pickWeighted(pool: [MoveDef, number][], dist: number, useRange: boolean): MoveDef | null {
    const ready = (m: MoveDef) => (this.cds[m.name] ?? 0) <= 0 && (!m.phase2Only || this.phase === 2);
    const cands = pool.filter(([m, w]) => w > 0 && ready(m) && (!useRange || dist < m.range * 0.95));
    if (!cands.length) return null;
    const wgt = (m: MoveDef, w: number) => m.name === this.lastMove ? w * 0.3 : w;
    const weighted: [MoveDef, number][] = cands.map(([m, w]) => [m, wgt(m, w)]);
    return pickByWeight(weighted) ?? cands[cands.length - 1][0];
  }

  // ---------------- 选招（葛瑞克权重：距离分档——远/中/贴身三带 + P2 开场固定技） ----------------
  protected override pickMove(dist: number): MoveDef | null {
    const M = MOVES_GODRICK;
    // P2 开场固定技：横扫龙焰（wiki 硬性规则——进 P2 第一招必是它，无视距离分档）
    if (this.p2OpenerPending) {
      this.cds[M.godrickFlame.name] = 0;
      return M.godrickFlame;
    }
    // 远档（>5.5m）：风压或斧突刺。突刺只在冲完后斧刃够得到时出；否则走近，不空挥。
    if (dist > 5.5) {
      const lungeOk = this.gapAfterDash(dist, M.godrickLunge.lunge ?? 0, 1.2) <= LUNGE_REACH;
      return this.pickWeighted([
        [M.godrickWindGust, dist < M.godrickWindGust.range * 0.95 ? 3 : 0],
        [M.godrickLunge, lungeOk ? 3 : 0],
      ], dist, false);
    }
    const dragonOk = this.phase === 2 && this.gapAfterDash(dist, M.godrickDragonGrab.lunge ?? 0, 1.0) <= DRAGON_BITE_REACH;
    // 贴身（≤2.2m）：抓取解围权重最高 / 龙首擒抱（够得到才进池）/ 旋斧
    const pool: [MoveDef, number][] = dist <= 2.2 ? [
      [M.godrickGrab, 4],
      [M.godrickDragonGrab, dragonOk ? 3.5 : 0],
      [M.godrickSpin, 3],
      [M.godrickAxeCombo, 2],
      [M.godrickKneel, this.phase === 2 ? 1.5 : 0],
    ] : [
      [M.godrickCleave, 3],
      [M.godrickAxeCombo, 2.5],
      [M.godrickFury, 2.5],
      [M.godrickSpin, dist >= 2.6 ? 1.5 : 0],
      [M.godrickKneel, this.phase === 2 && dist >= 1.6 && dist <= 2.85 ? 2.5 : 0],
      [M.godrickFlame, this.phase === 2 && dist >= 2.6 && dist <= 5.5 ? 2.5 : 0],
    ];
    return this.pickWeighted(pool, dist, true);
  }
}
