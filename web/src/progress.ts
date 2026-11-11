/** M2 魂循环进度：存档（localStorage `inferno.progress.v1`）+ 4 Boss 进度线
 * 进度线（design/m2-soul-loop.md）：古达 → 玻尔多(高墙) → 深渊监视者们 → 教宗沙力万
 * 解锁规则：击败 X 解锁下一位所在的场景传送；高墙篝火在击败玻尔多前为未点燃
 */
export type SceneId = "cemetery" | "highwall";

/** Boss 挑战顺序（跨场景总纲；雾门 Boss 由 bossForScene 按此推导） */
export const BOSS_ORDER = ["gundyr", "vordt", "watchers", "sulyvahn"] as const;
export type BossId = (typeof BOSS_ORDER)[number];

export const SCENE_NAME: Record<SceneId, string> = {
  cemetery: "灰烬墓地",
  highwall: "洛斯里克的高墙",
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
    litBonfires: ["cemetery"],
    lastBonfire: "cemetery",
    souls: 0,
    attempts: {},
    bloodstain: null,
    stats: { deaths: 0, soulRegains: 0, parries: 0, ripostes: 0 },
  };
}

export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return freshProgress();
    const p = JSON.parse(raw) as Partial<Progress>;
    const base = freshProgress();
    return { ...base, ...p, stats: { ...base.stats, ...p.stats } };
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

/** 击败结算：记 defeated、点亮高墙篝火（玻尔多）、解锁下一位所在场景 */
export function onDefeat(p: Progress, id: BossId, arenas: Record<string, SceneId>): void {
  if (!p.defeated.includes(id)) p.defeated.push(id);
  if (id === "vordt" && !p.litBonfires.includes("highwall")) p.litBonfires.push("highwall");
  const idx = BOSS_ORDER.indexOf(id);
  const next = BOSS_ORDER[idx + 1];
  if (next) {
    const arena = arenas[next];
    if (!p.unlockedScenes.includes(arena)) p.unlockedScenes.push(arena);
  }
}

/** 该场景雾门当前的 Boss：
 *  顺序中第一个「属于本场且未败且前置全败」者；
 *  若本场的下一位前置未满（顺序没到）→ 回退古达像（熟悉的地方，可再战）；
 *  全败 → 本场末位 Boss 常驻再战 */
export function bossForScene(p: Progress, arena: SceneId, arenas: Record<string, SceneId>): BossId {
  const fallback: BossId = arena === "highwall" ? "vordt" : "gundyr";
  const last: BossId = arena === "highwall" ? "vordt" : "sulyvahn";
  for (const id of BOSS_ORDER) {
    if (arenas[id] !== arena || p.defeated.includes(id)) continue;
    const idx = BOSS_ORDER.indexOf(id);
    const prereqMet = BOSS_ORDER.slice(0, idx).every(prev => p.defeated.includes(prev));
    return prereqMet ? id : fallback;
  }
  return last;
}
