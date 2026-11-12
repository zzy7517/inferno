/**
 * 翻滚 NaN 回归守卫（2026-11 黑屏卡死事故）
 *
 * 事故：player.ts roll 分支 `Math.pow(1 - t/T, 0.6)` 在收尾帧 t 越过 T=0.7 时
 * 以负数为底 → NaN → player.pos 被毒化 → 相机 NaN → 渲染静默输出空场景
 * （无异常无报错），画面永久只剩 HUD。M1(3fd9dc1) 起每次翻滚必中，
 * 修复为 Math.max(0, …) 钳底。
 *
 * 本探针：连续 3 次方向翻滚后，断言 player.pos 与 camera.position 全部分量有限
 * 且确有位移（防空洞通过）。未修复代码上 pos 必为 NaN，探针必红。
 */
import { test, expect, type Page } from "@playwright/test";

/** 等待 window.__game 挂载（boot 异步加载 GLB 后才 new Game）——同 t4 探针 */
async function waitForGame(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const g = (window as unknown as { __game?: { renderer?: unknown } }).__game;
    return !!g?.renderer;
  }, undefined, { timeout: 30_000 });
}

/** 清小怪：避免翻滚冲进怪堆被打死，主循环停在死亡分支 */
async function clearMobs(page: Page): Promise<void> {
  await page.evaluate(() => { (window as unknown as { __game: { enemies: { clear: () => void } } }).__game.enemies.clear(); });
}

/** 等玩家状态到达 s（elapsed 无关，状态即信号；无头 SwiftShader 帧率低，给足超时） */
async function waitState(page: Page, s: string): Promise<void> {
  await page.waitForFunction(st => (window as unknown as { __game: { player: { state: string } } }).__game.player.state === st, s, { timeout: 15_000 });
}

const finite3 = (v: { x: number; y: number; z: number }): boolean =>
  Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

test("翻滚回归：连续翻滚后 pos/camera 保持有限（NaN 黑屏守卫）", async ({ page }) => {
  await page.goto("/?scene=cemetery&fresh=1");
  await waitForGame(page);
  await clearMobs(page);

  const start = await page.evaluate(() => {
    const p = (window as unknown as { __game: { player: { pos: { x: number; z: number } } } }).__game.player.pos;
    return { x: p.x, z: p.z };
  });

  // 3 次 W+空格 方向翻滚：每次确认状态机真正进出 roll（翻滚没触发就红——防空洞通过）
  for (let i = 0; i < 3; i++) {
    await page.keyboard.down("KeyW");
    await page.waitForFunction(prev => (window as unknown as { __game: { elapsed: number } }).__game.elapsed >= prev + 6 / 60,
      await page.evaluate(() => (window as unknown as { __game: { elapsed: number } }).__game.elapsed) as number,
      { timeout: 10_000 });
    await page.keyboard.press("Space");
    await waitState(page, "roll");
    await waitState(page, "idle");
    await page.keyboard.up("KeyW");
  }

  const after = await page.evaluate(() => {
    const g = (window as unknown as {
      __game: {
        player: { pos: { x: number; y: number; z: number } };
        camera: { position: { x: number; y: number; z: number } };
      };
    }).__game;
    return { pos: { ...g.player.pos }, cam: { ...g.camera.position } };
  });

  // 核心断言：翻滚后坐标与相机全部分量有限（未修复代码 pos 为 NaN → 相机 NaN → 黑屏）
  expect(finite3(after.pos)).toBe(true);
  expect(finite3(after.cam)).toBe(true);
  // 配套正向断言：确实翻滚出了位移（≥3 次翻滚应移动 ≥3m），证明上面不是恒真的空洞检查
  const moved = Math.hypot(after.pos.x - start.x, after.pos.z - start.z);
  expect(moved).toBeGreaterThan(3);
  console.log(`[roll-nan] 3 次翻滚位移 ${moved.toFixed(1)}m，pos/camera 均有限`);
});
