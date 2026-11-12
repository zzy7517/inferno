/**
 * T4 高墙扩建验收探针（docs/design/m4-level-flow.md §3.2 / §5 验收）
 *
 * 覆盖：
 *  ① zones 分区表：B（走廊+玻尔多房）/ D（月坛走廊+沙力万房）西→东有序，
 *     id 与 progress.ZONE_OF（vordt→"highwall:B" / sulyvahn→"highwall:D"）对齐
 *  ② 逐区钳制：D 未解锁时推回 B 东界（衔接门 x=18 附近，clampWorld 上限≈B 房可走东缘 18.2）；
 *     解锁后可深入 D 廊道并抵达沙力万房圆心
 *  ③ B 区步程：spawn→雾门直跑 @6.2m/s ∈ [40,60] s（§1.3 大区复跑预算）
 *  ④ DC 预算：玻尔多房圆心采样（T5 同口径）——隐藏角色/清小怪后场景本体 ≤45；
 *     整机 ≤90（§4.2 红线；T5 基线整机 89，扩建须更省）
 *  ⑤ tsc 零错（另由 `npx tsc --noEmit` 在 CI/命令行保证）
 *  ⑥ 回归：?fresh=1 玻尔多雾门流程完好（E 跨入雾门 → E 拔出螺旋剑 → 开战）
 *
 * 采样口径与 e2e/scale.spec.ts（T5）一致：60Hz 固定步长直驱 player.pos；renderer.info 30 帧取中位。
 */
import { test, expect } from "@playwright/test";

const WALK_SPEED = 6.2;
const SIM_HZ = 60;
const BASE = "/?scene=highwall";

/** 等待 window.__game 挂载（boot 异步加载 GLB 后才 new Game） */
async function waitForGame(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(() => {
    const g = (window as unknown as { __game?: { renderer?: unknown } }).__game;
    return !!g?.renderer;
  }, undefined, { timeout: 30_000 });
}

/** 直驱 player.pos 沿路径点行进，返回各段距离（米）与总距离 */
async function drive(page: import("@playwright/test").Page, wps: { x: number; z: number }[], speed = WALK_SPEED): Promise<{ legs: number[]; total: number }> {
  return page.evaluate(({ wps, speed, hz }) => {
    const g = (window as unknown as {
      __game: { player: { pos: { set: (x: number, y: number, z: number) => void } } };
    }).__game;
    const step = speed / hz;
    const pos = { x: wps[0].x, z: wps[0].z };
    g.player.pos.set(pos.x, 0, pos.z);
    const legs: number[] = [];
    let leg = 0, total = 0, i = 0, ticks = 0;
    while (i < wps.length - 1 && ticks < hz * 600) {
      const t = wps[i + 1];
      const dx = t.x - pos.x, dz = t.z - pos.z;
      const d = Math.hypot(dx, dz);
      if (d <= step) {
        pos.x = t.x; pos.z = t.z;
        legs.push(leg + d); total += d; leg = 0; i++;
      } else {
        pos.x += (dx / d) * step; pos.z += (dz / d) * step;
        leg += step; total += step;
      }
      g.player.pos.set(pos.x, 0, pos.z);
      ticks++;
    }
    return { legs, total };
  }, { wps, speed, hz: SIM_HZ });
}

/** 传送并等待游戏帧推进后读回玩家位置（clampWorld 在主循环生效）。
 *  以 elapsed（每帧累加）为信号而非墙钟：无头 SwiftShader 帧率低且抖动，毫秒等待可能等不到帧。 */
async function teleport(page: import("@playwright/test").Page, x: number, z: number, frames = 8): Promise<{ x: number; z: number }> {
  await page.evaluate(({ x, z }) => {
    const g = (window as unknown as { __game: { player: { pos: { set: (a: number, b: number, c: number) => void } } } }).__game;
    g.player.pos.set(x, 0, z);
  }, { x, z });
  await page.waitForFunction(prev => {
    const e = (window as unknown as { __game: { elapsed: number } }).__game.elapsed;
    return e >= prev + frames / 60;
  }, await page.evaluate(() => (window as unknown as { __game: { elapsed: number } }).__game.elapsed) as number, { timeout: 10_000 }).catch(() => undefined);
  return page.evaluate(() => {
    const p = (window as unknown as { __game: { player: { pos: { x: number; z: number } } } }).__game.player.pos;
    return { x: +p.x.toFixed(3), z: +p.z.toFixed(3) };
  });
}

/** 探针便利：清掉布点小怪（场景流测试不测战斗；闲挂玩家会被廊道小怪击杀导致主循环停在死亡分支） */
async function clearMobs(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => { (window as unknown as { __game: { enemies: { clear: () => void } } }).__game.enemies.clear(); });
}

/** 等相机追上玩家（drive 阻塞 rAF 期间相机停在旧位；大地图上立即采样会量到中途视角） */
async function waitCameraSettled(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(() => {
    const g = (window as unknown as { __game: { camera: { position: { x: number } }; player: { pos: { x: number } } } }).__game;
    return g.camera.position.x > g.player.pos.x - 9 && g.camera.position.x < g.player.pos.x + 2;
  }, undefined, { timeout: 15_000 }).catch(() => undefined);
}

/** renderer.info 连续采样（中位数抗抖动） */
async function sampleRender(page: import("@playwright/test").Page, frames = 30): Promise<{ calls: number; triangles: number; fps: number }> {
  const r = await page.evaluate(frames => new Promise<{ calls: number[]; triangles: number[]; ms: number[] }>(resolve => {
    const info = (window as unknown as { __game: { renderer: { info: { render: { calls: number; triangles: number } } } } }).__game.renderer.info.render;
    const calls: number[] = [], triangles: number[] = [], ms: number[] = [];
    let last = performance.now(), n = 0;
    const tick = (): void => {
      const now = performance.now();
      ms.push(now - last); last = now;
      calls.push(info.calls); triangles.push(info.triangles);
      if (++n >= frames) resolve({ calls, triangles, ms });
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), frames);
  const med = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  return { calls: Math.round(med(r.calls)), triangles: Math.round(med(r.triangles)), fps: Math.round(1000 / med(r.ms.slice(1))) };
}

const lateProgress = JSON.stringify({
  defeated: ["gundyr", "vordt", "margit", "godrick", "watchers"],
  unlockedScenes: ["cemetery", "highwall", "stormveil"],
  zoneUnlocks: ["cemetery:A", "highwall:B", "stormveil:E", "stormveil:E4", "cemetery:C", "highwall:D"],
  shortcuts: [], litBonfires: ["cemetery", "highwall", "stormveil"],
  lastBonfire: "highwall", souls: 0, attempts: {}, bloodstain: null,
  stats: { deaths: 0, soulRegains: 0, parries: 0, ripostes: 0 },
});

test("① zones 分区表：B/D 各含走廊+竞技场，西→东有序，id 对齐 ZONE_OF", async ({ page }) => {
  await page.goto(`${BASE}&fresh=1`);
  await waitForGame(page);
  const z = await page.evaluate(() => {
    const a = (window as unknown as { __game: { anchors: { zones?: { id: string; kind: string; minX: number; maxX: number; half?: number; center?: { x: number; y: number; z: number }; r?: number }[]; corridorMinX: number; fogGate: { x: number }; bossArena: { x: number; z: number }; arenaRadius: number; spawn: { x: number; z: number } } } }).__game.anchors;
    return { zones: a.zones ?? [], corridorMinX: a.corridorMinX, gateX: a.fogGate.x, boss: [a.bossArena.x, a.bossArena.z], r: a.arenaRadius, spawn: [a.spawn.x, a.spawn.z] };
  });
  // B 走廊 + B 玻尔多房 + D 走廊 + D 沙力万房；id 与 progress.ZONE_OF 对齐
  expect(z.zones.map(s => s.id)).toEqual(["highwall:B", "highwall:B", "highwall:D", "highwall:D"]);
  expect(z.zones.map(s => s.kind)).toEqual(["corridor", "arena", "corridor", "arena"]);
  // 西→东有序
  for (let i = 1; i < z.zones.length; i++) expect(z.zones[i].minX).toBeGreaterThan(z.zones[i - 1].minX);
  // 走廊净宽 4.8m（§1.3：4–6m）
  expect(z.zones[0].half).toBe(2.4);
  expect(z.zones[2].half).toBe(2.4);
  // Boss 房 d24（§1.3 v1 目标）
  expect(z.zones[1].r).toBe(12);
  expect(z.zones[3].r).toBe(12);
  // 锚点一致性：走廊东口=雾门；legacy 场地=玻尔多房
  expect(z.zones[0].maxX).toBeCloseTo(z.gateX, 5);
  expect(z.boss[0]).toBeCloseTo(z.zones[1].center!.x, 5);
  expect(z.r).toBe(12);
  // 衔接链：B 走廊东口 = B 房可走西缘（center−r+0.9）；B 房东界 = D 走廊西口；D 走廊东口 = D 房可走西缘
  expect(z.zones[1].minX).toBeCloseTo(z.zones[1].center!.x - z.zones[1].r! + 0.9, 5);
  expect(z.zones[1].maxX).toBeCloseTo(z.zones[2].minX, 5);
  expect(z.zones[3].minX).toBeCloseTo(z.zones[3].center!.x - z.zones[3].r! + 0.9, 5);
  // B 走廊跨度（步程预算载体）
  expect(z.zones[0].maxX - z.zones[0].minX).toBeGreaterThanOrEqual(250);
});

test("⑥ 回归：fresh=1 玻尔多雾门流程完好（E 跨门 → E 拔剑 → 开战）", async ({ page }) => {
  await page.goto(`${BASE}&fresh=1`);
  await waitForGame(page);
  const gateX = await page.evaluate(() => (window as unknown as { __game: { anchors: { fogGate: { x: number } } } }).__game.anchors.fogGate.x);
  // 走到雾门前（雾门实心：单人墙把玩家拦在 gateX−0.4）
  await drive(page, [{ x: -276, z: 1.3 }, { x: gateX - 1.0, z: 0 }]);
  const held = await teleport(page, gateX + 2, 0, 6);
  expect(held.x).toBeLessThanOrEqual(gateX + 0.05);                      // 雾门未开：进不去
  const prompt1 = await page.evaluate(() => (window as unknown as { __game: { prompt: () => string | null } }).__game.prompt());
  expect(prompt1).toContain("跨入雾门");
  await page.keyboard.press("KeyE");
  await page.waitForFunction(() => {
    const g = (window as unknown as { __game: { fog: { solid: boolean }; flow: string } }).__game;
    return g.fog.solid === false && g.flow === "statue";
  }, undefined, { timeout: 5_000 });
  // 走到雕像前拔剑开战
  const bossPos = await page.evaluate(() => {
    const g = (window as unknown as { __game: { boss: { root: { position: { x: number; z: number } } } } }).__game;
    return { x: g.boss.root.position.x, z: g.boss.root.position.z };
  });
  await drive(page, [{ x: bossPos.x - 2.6, z: 0 }, { x: bossPos.x - 2.0, z: 0 }]);
  await page.waitForFunction(() => (window as unknown as { __game: { prompt: () => string | null } }).__game.prompt() === "E 拔出螺旋剑");
  await page.keyboard.press("KeyE");
  await page.waitForFunction(() => (window as unknown as { __game: { flow: string } }).__game.flow === "fight", undefined, { timeout: 5_000 });
  const bossX = await page.evaluate(() => (window as unknown as { __game: { boss: { root: { position: { x: number } } } } }).__game.boss.root.position.x);
  expect(Math.abs(bossX - 17.9)).toBeLessThan(0.5);                      // 玻尔多立于场心东侧（圆心 16.1 + 1.8）
});

test("③ B 区步程：spawn→雾门直跑 ∈ [40,60] s（@6.2 m/s）", async ({ page }) => {
  await page.goto(`${BASE}&fresh=1`);
  await waitForGame(page);
  const a = await page.evaluate(() => {
    const g = (window as unknown as { __game: { anchors: { spawn: { x: number; z: number }; fogGate: { x: number } }; fog: { solid: boolean } } }).__game;
    return { spawn: { x: g.anchors.spawn.x, z: g.anchors.spawn.z }, gate: g.anchors.fogGate.x };
  });
  const r = await drive(page, [{ x: a.spawn.x, z: a.spawn.z }, { x: a.gate, z: 0 }]);
  const spawnToGate = r.legs[0] / WALK_SPEED;
  console.log(`[T4] spawn→gate ${r.legs[0].toFixed(1)}m = ${spawnToGate.toFixed(1)}s`);
  expect(spawnToGate).toBeGreaterThanOrEqual(40);
  expect(spawnToGate).toBeLessThanOrEqual(60);
});

test("②a 逐区钳制（D 锁定）：推回 B 东界 + 走廊 z/西界钳制", async ({ page }) => {
  await page.goto(`${BASE}&fresh=1`);
  await waitForGame(page);
  await clearMobs(page);
  await page.evaluate(() => { (window as unknown as { __game: { fog: { solid: boolean } } }).__game.fog.solid = false; });
  const eastEdge = 18.2;                                                // B 房可走东缘（center 7.1 + r−0.9 = 18.2）
  for (const tx of [22, 30, 60]) {
    const p = await teleport(page, tx, 0, 8);
    expect(p.x).toBeLessThanOrEqual(eastEdge + 0.05);                   // 推回 B 东界（门 x=18，墙内无穿透）
  }
  const pz = await teleport(page, 30, 6, 8);                            // D 廊道 z 钳制（若被推回则处 B 房缘）
  expect(Math.abs(pz.z)).toBeLessThanOrEqual(2.45);
  const west = await teleport(page, -400, 0, 8);                        // B 走廊西界
  expect(west.x).toBeGreaterThanOrEqual(-282.01);
  const zc = await teleport(page, -100, 9, 8);                          // 走廊 z 钳制 ±2.4
  expect(zc.z).toBeCloseTo(2.4, 1);
});

test("②b 逐区钳制（D 解锁）：可进 D 区并抵达沙力万房心", async ({ page }) => {
  await page.addInitScript(p => localStorage.setItem("inferno.progress.v1", p), lateProgress);
  await page.goto(BASE);
  await waitForGame(page);
  await clearMobs(page);
  await page.evaluate(() => { (window as unknown as { __game: { fog: { solid: boolean } } }).__game.fog.solid = false; });
  const p30 = await teleport(page, 30, 0, 8);
  expect(p30.x).toBeGreaterThan(29.5);                                  // 可进 D 廊道
  const dz = await teleport(page, 40, 5, 8);
  expect(dz.z).toBeCloseTo(2.4, 1);                                     // D 廊道 z ±2.4
  // 直达沙力万房圆心
  const r = await drive(page, [{ x: 50, z: 0 }, { x: 99.1, z: 0 }]);
  const center = await teleport(page, 99.1, 0, 6);
  expect(Math.hypot(center.x - 99.1, center.z)).toBeLessThan(1.0);
  console.log(`[T4] D 区纵深 drive 50→99.1 = ${r.total.toFixed(1)}m`);
  // D 房东缘封口：传送超界推回可走圆（r−0.9 = 11.1 → x ≤ 85.2）
  const pe = await teleport(page, 120, 0, 8);
  expect(pe.x).toBeLessThanOrEqual(85.3);
});

test("④ DC 预算：场景本体 ≤45 / 整机 ≤90（玻尔多房心采样）", async ({ page }) => {
  await page.goto(`${BASE}&fresh=1`);
  await waitForGame(page);
  await clearMobs(page);
  await page.evaluate(() => { (window as unknown as { __game: { fog: { solid: boolean } } }).__game.fog.solid = false; });
  await drive(page, [{ x: -276, z: 1.3 }, { x: 7.1, z: 0 }]);           // T5 同口径：走完整主线后采样
  await waitCameraSettled(page);
  const whole = await sampleRender(page, 30);
  console.log(`[T4] 整机 DC=${whole.calls} tris=${whole.triangles} fps≈${whole.fps}`);
  expect(whole.calls).toBeLessThanOrEqual(90);                          // §4.2 红线（T5 基线 89：扩建后不得更费）
  // 场景本体口径：隐藏角色/Boss、清小怪（vfx 粒子池/雾门/篝火等游戏件仍在，略高于净场景）
  await page.evaluate(() => {
    const g = (window as unknown as {
      __game: {
        player: { root: { visible: boolean } };
        boss: { root: { visible: boolean } };
        enemies: { clear: () => void };
      };
    }).__game;
    g.player.root.visible = false;
    g.boss.root.visible = false;
    g.enemies.clear();
  });
  const sceneOnly = await sampleRender(page, 30);
  console.log(`[T4] 场景口径 DC=${sceneOnly.calls} tris=${sceneOnly.triangles} fps≈${sceneOnly.fps}`);
  expect(sceneOnly.calls).toBeLessThanOrEqual(45);                      // §4.2 场景本体预算
  expect(sceneOnly.triangles).toBeLessThanOrEqual(150_000);             // §4.2 顶点预算（三角形≈顶点/2 参考）
});
