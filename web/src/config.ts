/** Inferno M1 配置：帧数据、数值、手感档案（调校台热调的数据源） */

export interface MoveDef {
  name: string; label: string;
  startup: number; active: number; recovery: number;
  dmg: number; range: number; arc: number;   // 弧度
  lunge?: number;                            // 前摇→判定前冲距离
  parryable: boolean;
  grab?: boolean;                            // 不可格挡
  shock?: number;                            // 落地冲击环半径
  cd: number;
  phase2Only?: boolean;
  chain?: string;                            // 后续连段候选
  feel?: string;                             // 命中玩家的手感档案 key（FEEL）
  hits?: number;                             // 多段判定段数（默认 1；监视者三连斩=3）
  hitInterval?: number;                      // 段间隔 s（默认 0.45）
  knockUp?: number;                          // 击飞初速 m/s（监视者上挑）
  proj?: { speed: number; radius: number; life?: number };  // 投射物（沙力万暗月矢）
  frost?: { mul: number; dur: number };      // 命中附带冰霜减速（玻尔多冰息/践踏）
}

/** 手感档案（combat-feel.md 五层级）：一次命中的多通道反馈参数，调校台热调 */
export interface FeelDef {
  hitstop: number;      // 顿帧 s
  shake: number;        // 震屏幅
  sparks: number;       // 火花粒子数
  sparkSpeed: number;   // 火花初速
  knockback: number;    // 受方击退距离
  sfx: SfxName;         // 音效组（AU 方法名）
}
export type SfxName = "hitStone" | "hitLight" | "hitHeavy" | "blockHit" | "parry" | "riposte";

export const P = {
  hp: 100, stamina: 100,
  walk: 3.4, sprint: 6.2, playerRadius: 0.45,
  rollCost: 24, r1Cost: 16, r2Cost: 28, parryCost: 14,
  r1Dmg: [12, 12, 18], r1Poise: [12, 12, 18],
  r2DmgBase: 24, r2Poise: 30, riposteDmg: 95,
  blockChip: 0.15, blockDrainMul: 1.35,
  estusHeal: 0.45, estusMax: 3,
  staminaRegen: 30, regenDelay: 0.55, regenBlock: 8,
  bufferWindow: 0.25,
};

export const BOSS = {
  hp: 650, radius: 1.0,
  poiseMax: 100, poiseDecay: 8, staggerDur: 2.5, staggerMul: 1.5,
  parriedDur: 2.0,
  phase2At: 0.55,           // HP 比例阈值
  walkSpeed: 2.6, turnRate: 3.4,
  name: "灰烬审判者古达",
};

/** 镜头：默认全自动（触控板友好）——移动跟背 + 锁定双人取景 + 开战自动锁定；按 V 进自由视角（鼠标指针锁定） */
export const CAM = {
  yaw: -Math.PI / 2,     // 初始朝向：看向 +X（走廊→Boss 方向），W 即前进
  pitch: 0.36,
  followLerp: 2.6,       // 自动跟背缓动强度
  manualGrace: 1.5,      // 自由视角退出后，多少秒内不自动回正
  lockLerp: 6,           // 锁定时镜头缓动强度
  lockPitch: 0.30,
  lockDistBase: 4.6,     // 锁定取景基础距离
  lockDistPerSep: 0.30,  // 距离随人/Boss 间距的增量系数
};

/** 一阶段 7 招 + 二阶段人性的沉淀 2 招（帧数据初值见 docs/design/m1-demo.md） */
export const MOVES: Record<string, MoveDef> = {
  thrust:     { name: "thrust", label: "直戳", startup: 0.55, active: 0.16, recovery: 0.85, dmg: 22, range: 3.6, arc: 0.9, lunge: 1.2, parryable: true, cd: 1.6, chain: "thrust2", feel: "bLight" },
  thrust2:    { name: "thrust2", label: "二连戳", startup: 0.35, active: 0.14, recovery: 0.9, dmg: 20, range: 3.4, arc: 0.9, lunge: 0.8, parryable: true, cd: 1.2, feel: "bLight" },
  sweep:      { name: "sweep", label: "横扫", startup: 0.70, active: 0.20, recovery: 0.95, dmg: 26, range: 4.4, arc: 2.6, parryable: true, cd: 3.2, feel: "bHeavy" },
  slam:       { name: "slam", label: "下劈", startup: 0.85, active: 0.14, recovery: 1.10, dmg: 34, range: 3.8, arc: 1.1, shock: 5.0, parryable: true, cd: 4.5, feel: "bHeavy" },
  jump:       { name: "jump", label: "跳劈", startup: 0.60, active: 0.15, recovery: 1.40, dmg: 38, range: 3.4, arc: 1.3, lunge: 7.0, parryable: true, cd: 6.0, feel: "bHeavy" },
  shoulder:   { name: "shoulder", label: "肩撞", startup: 0.40, active: 0.12, recovery: 0.70, dmg: 18, range: 2.4, arc: 1.0, lunge: 1.8, parryable: false, cd: 2.8, feel: "bLight" },
  grab:       { name: "grab", label: "抓技", startup: 0.70, active: 0.20, recovery: 1.20, dmg: 45, range: 2.0, arc: 0.8, parryable: false, grab: true, cd: 9.0, feel: "bHeavy" },
  serpSweep:  { name: "serpSweep", label: "沉淀横扫", startup: 0.80, active: 0.25, recovery: 1.00, dmg: 30, range: 5.5, arc: 3.0, parryable: true, cd: 3.8, phase2Only: true, feel: "bHeavy" },
  serpThrust: { name: "serpThrust", label: "沉淀突刺", startup: 0.70, active: 0.18, recovery: 0.90, dmg: 26, range: 8.0, arc: 0.7, lunge: 2.0, parryable: true, cd: 4.6, phase2Only: true, feel: "bHeavy" },
};

/** 手感档案初值：层级——普通命中 < 重击 < 削韧破绽 < 弹反 < 处决（数值基准 combat-feel.md 六通道表） */
export const FEEL: Record<string, FeelDef & { label: string }> = {
  pR1a:    { label: "轻击·一段", hitstop: 0.06, shake: 0.15, sparks: 12, sparkSpeed: 4, knockback: 0, sfx: "hitStone" },
  pR1b:    { label: "轻击·二段", hitstop: 0.06, shake: 0.15, sparks: 12, sparkSpeed: 4, knockback: 0, sfx: "hitStone" },
  pR1c:    { label: "轻击·三段", hitstop: 0.08, shake: 0.22, sparks: 16, sparkSpeed: 5, knockback: 0, sfx: "hitLight" },
  pR2:     { label: "蓄力重击", hitstop: 0.11, shake: 0.40, sparks: 26, sparkSpeed: 6, knockback: 0, sfx: "hitHeavy" },
  pRip:    { label: "处决",     hitstop: 0.25, shake: 0.70, sparks: 34, sparkSpeed: 7, knockback: 0, sfx: "riposte" },
  bLight:  { label: "受击·轻",  hitstop: 0.05, shake: 0.40, sparks: 10, sparkSpeed: 4, knockback: 0.4, sfx: "hitStone" },
  bHeavy:  { label: "受击·重",  hitstop: 0.09, shake: 0.55, sparks: 16, sparkSpeed: 5, knockback: 0.6, sfx: "hitHeavy" },
  block:   { label: "格挡",     hitstop: 0.04, shake: 0.20, sparks: 8,  sparkSpeed: 3, knockback: 0.15, sfx: "blockHit" },
  parry:   { label: "弹反",     hitstop: 0.10, shake: 0.35, sparks: 30, sparkSpeed: 7, knockback: 0, sfx: "parry" },
  stagger: { label: "削韧破绽", hitstop: 0.12, shake: 0.50, sparks: 24, sparkSpeed: 6, knockback: 0, sfx: "parry" },
};

export const COLORS = {
  bg: 0x0d1016, fog: 0x0d1016,
  moon: 0x9db4d8, ember: 0xff8c3a, gold: 0xe6c37a,
  stone: 0x3d4046, stoneDark: 0x2c2f35, ground: 0x1e2126, groundPath: 0x272322,
  hp: "#9b3b32", stamina: "#7a8f4a", steel: 0x8f99a3,
};
