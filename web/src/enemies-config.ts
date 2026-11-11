/** 小怪配置（docs/design/enemies.md）：招式帧数据 / 手感档案 / 数值表
 *  与 Boss 同构的调校台热调数据源：模块加载即 Object.assign 并入 config.MOVES / config.FEEL 总表，
 *  键名 hollow / squire / crow 前缀避免与 Boss 招式串味（对标 MOVES_VORDT 的命名空间纪律）。
 *  行为系统见 enemy.ts（EnemyBase + EnemyManager），本文件只有数据。
 */
import { MOVES, FEEL, MoveDef, FeelDef } from "./config";

export type EnemyKind = "hollow" | "squire" | "crow";

// ---------------- 招式表（帧数据单位秒；节拍 tel/act/rec 与 BossBase 同构） ----------------
export const MOVES_ENEMY: Record<string, MoveDef> = {
  // 活尸（灰烬墓地）：烂剑，慢而好读——教学读者
  hollowSlash:  { name: "hollowSlash",  label: "烂剑单挥", startup: 0.62, active: 0.14, recovery: 0.92, dmg: 14, range: 2.4, arc: 1.7, parryable: true, cd: 2.2, feel: "eHollow" },
  hollowDouble: { name: "hollowDouble", label: "烂剑二连", startup: 0.50, active: 0.44, recovery: 1.05, dmg: 10, range: 2.4, arc: 1.7, hits: 2, hitInterval: 0.24, parryable: true, cd: 3.6, feel: "eHollow" },
  // 教堂骑士侍从（高墙）：直剑+盾，纪律感连段；盾挡姿态 act 窗口内正面受击被弹开
  squireCombo:  { name: "squireCombo",  label: "直剑三连", startup: 0.42, active: 0.78, recovery: 1.00, dmg: 8,  range: 2.7, arc: 1.5, hits: 3, hitInterval: 0.22, parryable: true, cd: 4.2, feel: "eSquire" },
  squireGuard:  { name: "squireGuard",  label: "盾挡姿态", startup: 0.30, active: 1.70, recovery: 0.55, dmg: 0,  range: 0,   arc: 0,   parryable: false, cd: 5.5, feel: "eSquire" },
  // 咒腐乌鸦（高墙）：飞行单位，扑击贴身解围 / 俯冲远程突进
  crowPounce:   { name: "crowPounce",   label: "扑击",     startup: 0.42, active: 0.16, recovery: 0.80, dmg: 10, range: 2.3, arc: 1.3, lunge: 2.6, parryable: true, cd: 3.0, feel: "eCrow" },
  crowDive:     { name: "crowDive",     label: "俯冲",     startup: 0.50, active: 0.20, recovery: 1.05, dmg: 14, range: 2.6, arc: 0.9, lunge: 5.5, parryable: true, cd: 5.5, feel: "eCrow" },
};

// ---------------- 手感档案（combat-feel.md 层级：小怪受击 < Boss 轻击；eGuard 为打盾弹开） ----------------
export const FEEL_ENEMY: Record<string, FeelDef & { label: string }> = {
  eHollow: { label: "活尸·斩中",   hitstop: 0.05, shake: 0.35, sparks: 8,  sparkSpeed: 3.5, knockback: 0.35, sfx: "hitLight" },
  eSquire: { label: "侍从·剑中",   hitstop: 0.06, shake: 0.42, sparks: 10, sparkSpeed: 4,   knockback: 0.40, sfx: "hitLight" },
  eCrow:   { label: "乌鸦·爪中",   hitstop: 0.04, shake: 0.30, sparks: 6,  sparkSpeed: 3,   knockback: 0.30, sfx: "hitLight" },
  eGuard:  { label: "打盾弹开",    hitstop: 0.07, shake: 0.35, sparks: 14, sparkSpeed: 5,   knockback: 0,    sfx: "blockHit" },
};

// 模块加载即并入总表（同一批对象引用，调校台热调双向生效——与 MOVES_VORDT 同一纪律）
Object.assign(MOVES, MOVES_ENEMY);
Object.assign(FEEL, FEEL_ENEMY);

// ---------------- 数值表（EnemyBase 行为参数；调校台可整表替换） ----------------
export interface EnemyStats {
  kind: EnemyKind;
  label: string;
  hp: number;
  souls: number;          // 掉魂
  radius: number;         // 与玩家推挤半径 m
  hitY: number;           // 受击粒子锚点高度（相对 root）
  walkSpeed: number;      // 巡逻速度
  combatSpeed: number;    // 战斗逼近速度
  turnRate: number;       // rad/s
  aggroRange: number;     // 视距 m（玩家入此距离且在视锥内 → alert）
  fov: number;            // 视锥半角 rad（贴身 2.2m 内全向察觉）
  preferredDist: number;  // 战斗站距 m（小于则停步选招）
  patrol: number;         // 巡逻半径 m（0 = 站桩，侍从守位）
  hover?: number;         // 飞行悬停高度（crow）
  backstabDmg: number;    // 背刺一击伤害（= 3× 背刺基准，见 enemies.md）
  backstabArc: number;    // 背身判定半角 rad（默认 ±40°）
  backstabRange: number;  // 背刺触发距离 m
  guard?: boolean;        // 持盾：盾挡姿态 act 窗口正面受击被弹开（不掉血）
  guardMove?: string;     // 盾挡姿态对应的招式名
}

export const ENEMY_STATS: Record<EnemyKind, EnemyStats> = {
  // 活尸：脆（背刺 60 = 3×20 直接秒杀 hp40）、慢、巡逻
  hollow: {
    kind: "hollow", label: "活尸", hp: 40, souls: 50,
    radius: 0.42, hitY: 1.05,
    walkSpeed: 1.6, combatSpeed: 2.2, turnRate: 3.2,
    aggroRange: 8, fov: 1.15, preferredDist: 1.9, patrol: 2.5,
    backstabDmg: 60, backstabArc: 40 * Math.PI / 180, backstabRange: 1.2,
  },
  // 教堂骑士侍从：硬（hp90 背刺不秒）、站桩守位、盾挡弹开
  squire: {
    kind: "squire", label: "教堂骑士侍从", hp: 90, souls: 120,
    radius: 0.5, hitY: 1.25,
    walkSpeed: 1.4, combatSpeed: 2.0, turnRate: 2.4,
    aggroRange: 8, fov: 1.05, preferredDist: 2.1, patrol: 0,
    backstabDmg: 60, backstabArc: 40 * Math.PI / 180, backstabRange: 1.2,
    guard: true, guardMove: "squireGuard",
  },
  // 咒腐乌鸦：飞行（y≈1.2 悬停）、脆（背刺 45 = 3×15 秒杀 hp30）
  crow: {
    kind: "crow", label: "咒腐乌鸦", hp: 30, souls: 80,
    radius: 0.4, hitY: 0.15,
    walkSpeed: 2.4, combatSpeed: 3.0, turnRate: 4.5,
    aggroRange: 9, fov: 1.3, preferredDist: 3.4, patrol: 3,
    hover: 1.2,
    backstabDmg: 45, backstabArc: 40 * Math.PI / 180, backstabRange: 1.2,
  },
};

/** 场景布怪预设（game 接线 / 关卡脚本用；spawn 也接受裸 kind 字符串） */
export interface EnemySpawnSpec {
  kind: EnemyKind;
  facing?: number;   // 初始朝向 rad（yaw=atan2(x,z)，同角色约定）
  patrol?: number;   // 覆盖巡逻半径（默认取数值表）
}

/** 各场景推荐布点（示例集；关卡流程由主线程接线时取用/扩展） */
export const ENEMY_PRESETS: Record<string, EnemySpawnSpec[]> = {
  cemetery: [
    { kind: "hollow", facing: Math.PI / 2 },
    { kind: "hollow", facing: Math.PI / 2 },
  ],
  highwall: [
    { kind: "squire", facing: -Math.PI / 2 },
    { kind: "crow", facing: -Math.PI / 2 },
    { kind: "hollow", facing: -Math.PI / 2 },
  ],
};
