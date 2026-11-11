/** M2 魂循环进度：存档（localStorage `inferno.progress.v1`）+ 6 Boss 进度线
 * 进度线 v1.1（design/m4-level-flow.md）：古达(墓地A) → 玻尔多(高墙B) → 玛尔基特(城垣E)
 *   → 葛瑞克(城垣E4·接肢教堂) → 深渊监视者们(墓地C·深处) → 教宗沙力万(高墙D·深处)
 * 解锁规则：击败玻尔多解锁城垣传送；玛尔基特胜开 E4；葛瑞克胜开墓地深处 C；监视者胜开高墙深处 D
 * 兼容：只加字段不改语义；defeated 按 id 存储，旧 4 Boss 档插入 margit/godrick 后天然续玩（城垣待探索）
 */
export type SceneId = "cemetery" | "highwall" | "stormveil";

/** Boss 挑战顺序（跨场景总纲；雾门 Boss 由 bossForScene 按此推导） */
export const BOSS_ORDER = ["gundyr", "vordt", "margit", "godrick", "watchers", "sulyvahn"] as const;
export type BossId = (typeof BOSS_ORDER)[number];

/** 各 Boss 驻守区域（场景:区域；T2 SceneAnchors v2 挂钩） */
export const ZONE_OF: Record<BossId, string> = {
  gundyr: "cemetery:A", vordt: "highwall:B",
  margit: "stormveil:E", godrick: "stormveil:E4",
  watchers: "cemetery:C", sulyvahn: "highwall:D",
};

/** 击败 X 后解锁 X 的下一 Boss 驻区（该区 Boss 变为可挑战） */
const ZONE_UNLOCK_ON_DEFEAT: Partial<Record<BossId, string>> = {
  vordt: "stormveil:E", margit: "stormveil:E4",
  godrick: "cemetery:C", watchers: "highwall:D",
};

export const SCENE_NAME: Record<SceneId, string> = {
  cemetery: "灰烬墓地",
  highwall: "洛斯里克的高墙",
  stormveil: "史东薇尔城垣",
};

/** 掉魂血渍（跨读档持久；再次死亡旧血渍消散——DS3 铁律） */
export interface Bloodstain {
  scene: SceneId;
  x: number;
  z: number;
  souls: number;
}

export interface Progress {
  defeated: BossId[];                        // 已击败（按顺序追加，幂等）
  unlockedScenes: SceneId[];                 // 可传送场景
  zoneUnlocks: string[];                     // 已解锁深层区域（ZONE_OF 语法；T2/T6 挂钩）
  shortcuts: string[];                       // 已开启捷径（T6：电梯/单向门 id）
  litBonfires: SceneId[];                    // 已点燃篝火（可设为重生点）
  lastBonfire: SceneId;                      // 当前重生点
  souls: number;                             // 当前魂量（死亡掉落前快照）
  attempts: Record<string, number>;          // 各 Boss 累计挑战次数
  bloodstain: Bloodstain | null;             // 场上血渍（可能在他乡）
  stats: { deaths: number; soulRegains: number; parries: number; ripostes: number };
}

const KEY = "inferno.progress.v1";

export function freshProgress(): Progress {
  return {
    defeated: [],
    unlockedScenes: ["cemetery"],
    zoneUnlocks: ["cemetery:A", "highwall:B"],
    shortcuts: [],
    litBonfires: ["cemetery"],
    lastBonfire: "cemetery",
    souls: 0,
    attempts: {},
    bloodstain: null,
    stats: { deaths: 0, soulRegains: 0, parries: 0, ripostes: 0 },
  };
}

/** 旧档迁移/击败结算共用的区域推导（幂等）：
 *  「到访」规则——击败过 X 则 X 的驻区必已开放（旧 v1.0 四 Boss 档续玩兼容）；
 *  「挑战权」规则——击败 X 则下一 Boss 驻区开门 */
function deriveZones(p: Progress): void {
  for (const id of p.defeated) {
    if (!p.zoneUnlocks.includes(ZONE_OF[id])) p.zoneUnlocks.push(ZONE_OF[id]);
    const next = ZONE_UNLOCK_ON_DEFEAT[id];
    if (next && !p.zoneUnlocks.includes(next)) p.zoneUnlocks.push(next);
  }
}

/** 旧档迁移：按 defeated 幂等补齐场景/区域解锁（v1.0 4 Boss 档 → 城垣待探索续玩） */
function migrate(p: Progress): void {
  for (const id of p.defeated) {
    if (id === "vordt" && !p.unlockedScenes.includes("stormveil")) p.unlockedScenes.push("stormveil");
  }
  deriveZones(p);
}

export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return freshProgress();
    const p = JSON.parse(raw) as Partial<Progress>;
    const base = freshProgress();
    const merged = { ...base, ...p, stats: { ...base.stats, ...p.stats } };
    migrate(merged);
    return merged;
  } catch {
    return freshProgress();
  }
}

export function saveProgress(p: Progress): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* 隐私模式等场景静默 */ }
}

export function clearProgress(): void {
  try { localStorage.removeItem(KEY); } catch { /* 同上 */ }
}

/** 击败结算：记 defeated、点亮高墙篝火（玻尔多）、解锁下一位所在场景与深层区域 */
export function onDefeat(p: Progress, id: BossId, arenas: Record<string, SceneId>): void {
  if (!p.defeated.includes(id)) p.defeated.push(id);
  if (id === "vordt" && !p.litBonfires.includes("highwall")) p.litBonfires.push("highwall");
  migrate(p);
  const idx = BOSS_ORDER.indexOf(id);
  const next = BOSS_ORDER[idx + 1];
  if (next) {
    const arena = arenas[next];
    if (!p.unlockedScenes.includes(arena)) p.unlockedScenes.push(arena);
  }
}

/** 该场景雾门当前的 Boss：
 *  顺序中第一个「属于本场且未败且前置全败」者；
 *  若本场的下一位前置未满（顺序没到）→ 回退本场首位（熟悉的地方，可再战）；
 *  全败 → 本场末位 Boss 常驻再战（城垣双 Boss：首位玛尔基特/末位葛瑞克） */
export function bossForScene(p: Progress, arena: SceneId, arenas: Record<string, SceneId>): BossId {
  const mine = BOSS_ORDER.filter(id => arenas[id] === arena);
  const fallback: BossId = mine[0] ?? "gundyr";
  const last: BossId = mine[mine.length - 1] ?? fallback;
  for (const id of mine) {
    if (p.defeated.includes(id)) continue;
    const idx = BOSS_ORDER.indexOf(id);
    const prereqMet = BOSS_ORDER.slice(0, idx).every(prev => p.defeated.includes(prev));
    return prereqMet ? id : fallback;
  }
  return last;
}
