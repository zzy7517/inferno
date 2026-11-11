/**
 * T5 尺度探针基线（docs/design/m4-level-flow.md 五、实现切票 → 验收探针 T5）
 *
 * 产出 web/e2e/scale-baseline.json：两场景「步程秒 / draw calls / 三角形 / 可走面积」现状值，
 * 供 T3/T4 扩建后对比与 CI 防回归（4.2 性能预算的顶点基线也由此回填）。
 *
 * 采样口径：
 *  - 步程：不真按键走（无头端渲染慢、rAF 节流不可靠），而是在 page.evaluate 里以
 *    60Hz 固定步长直驱 player.pos 沿 spawn→雾门→Boss 房中心位移 6.2 m/s（对齐 player.ts 跑速）。
 *    TS 私有字段（player/anchors/fog/renderer）不挡运行时访问，经 window.__game 直取。
 *  - DC/三角形：renderer.info.render.calls / .triangles 保存的是最近一帧的值，
 *    连续采 30 帧取中位数与最大值（整机口径，含玩家/Boss/粒子，对应 4.2「整机 ≤90」预算）。
 *  - 可走面积：按 anchors 推导——走廊矩形（corridorMinX→fogGate.x，宽 2×1.45 出自
 *    game.ts clampWorld 的 z±1.45）+ Boss 房圆（r = arenaRadius−0.9，同为 clampWorld 口径）。
 *
 * 断言宽松：基线阶段只记录不卡死（expect(true) 占位）；
 * TODO 处即 T3/T4 扩建后要改紧的预算断言，届时删掉占位、放开注释即可。
 */
import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 跑速（m/s）——对齐 src/player.ts 的奔跑速度；扩建后步程预算 40–60s 即按此速换算 */
const WALK_SPEED = 6.2;
/** 模拟步频：60Hz 固定步长，与游戏逻辑帧率同量级，不依赖无头端真实 rAF 频率 */
const SIM_HZ = 60;
/** DC/三角形采样帧数：取中位数抗偶发抖动，最大值对预算红线 */
const RENDER_SAMPLE_FRAMES = 30;

const SCENES = ["cemetery", "highwall", "stormveil"] as const;
type SceneId = (typeof SCENES)[number];

interface SceneBaseline {
  walk: {
    spawnToGateSeconds: number;
    gateToCenterSeconds: number;
    totalSeconds: number;
    pathMeters: number;
    finalErrorM: number;
  };
  render: {
    drawCallsMedian: number;
    drawCallsMax: number;
    trianglesMedian: number;
    trianglesMax: number;
    fpsApprox: number;
  };
  area: {
    corridorLengthM: number;
    corridorWidthM: number;
    corridorAreaM2: number;
    arenaRadiusM: number;
    arenaAreaM2: number;
    totalWalkableM2: number;
  };
  anchors: {
    spawn: [number, number, number];
    fogGate: [number, number, number];
    bossArena: [number, number, number];
    arenaRadius: number;
    corridorMinX: number;
  };
}

/** Playwright 的 TS 加载器 ESM/CJS 因 package type 而异，双路解析 e2e 目录 */
function e2eDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return join(process.cwd(), "e2e");
  }
}

const results: Partial<Record<SceneId, SceneBaseline>> = {};

/** 等待 window.__game 挂载（boot 异步加载 GLB 后才 new Game） */
async function waitForGame(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(() => {
    const g = (window as unknown as { __game?: { renderer?: unknown } }).__game;
    return !!g?.renderer;
  }, undefined, { timeout: 30_000 });
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

for (const scene of SCENES) {
  test(`尺度基线：${scene}`, async ({ page }) => {
    if (scene === "stormveil") {
      // game.ts 的 ?scene= 仅注册 highwall：城垣经注入旧档（vordt 败→迁移解锁城垣与 stormveil:E）
      // 后篝火旅行直达（T7 验收同路径；步程/面积为 anchors 直线口径，之字坡实走见 T7 探针）
      await page.addInitScript(() => {
        localStorage.setItem("inferno.progress.v1", JSON.stringify({
          defeated: ["gundyr", "vordt"],
          unlockedScenes: ["cemetery", "highwall"],
          zoneUnlocks: ["cemetery:A", "highwall:B"],
          shortcuts: [], litBonfires: ["cemetery", "highwall"], lastBonfire: "highwall",
          souls: 0, attempts: {}, bloodstain: null,
          stats: { deaths: 1, soulRegains: 0, parries: 0, ripostes: 0 },
        }));
      });
      await page.goto("/");
      await waitForGame(page);
      await page.evaluate(() => {
        (window as unknown as { __game: { travelTo: (s: "cemetery" | "highwall" | "stormveil") => void } }).__game.travelTo("stormveil");
      });
    } else {
      await page.goto(`/?scene=${scene}`);
      await waitForGame(page);
    }

    // ---- 1) 步程计时：spawn → 雾门 → Boss 房中心，直驱 player.pos 逐帧 6.2 m/s ----
    const walk = await page.evaluate(({ speed, hz }) => {
      const g = (window as unknown as {
        __game: {
          anchors: { spawn: { x: number; z: number }; fogGate: { x: number; z: number }; bossArena: { x: number; z: number } };
          player: { pos: { set: (x: number, y: number, z: number) => void } };
          fog: { solid: boolean };
        };
      }).__game;
      const a = g.anchors;
      // 视作「已 E 跨入雾门」的状态：否则 clampWorld 会把 x 钳回 gateX−0.4，直跑进不了 Boss 房
      g.fog.solid = false;

      const step = speed / hz;
      const wps = [
        { x: a.spawn.x, z: a.spawn.z },
        { x: a.fogGate.x, z: 0 },
        { x: a.bossArena.x, z: a.bossArena.z },
      ];
      const pos = { x: a.spawn.x, z: a.spawn.z };
      g.player.pos.set(pos.x, 0, pos.z);

      const legMeters: number[] = [];
      let legDist = 0;
      let totalMeters = 0;
      let i = 0;
      let ticks = 0;
      const maxTicks = hz * 600; // 10 min 硬上限防死循环
      while (i < wps.length - 1 && ticks < maxTicks) {
        const t = wps[i + 1];
        const dx = t.x - pos.x;
        const dz = t.z - pos.z;
        const d = Math.hypot(dx, dz);
        if (d <= step) {
          pos.x = t.x;
          pos.z = t.z;
          legMeters.push(legDist + d); // 本段全程（else 分支已逐帧累计进 totalMeters）
          totalMeters += d; // 只补最后不足一步的余量，避免整段重复计数
          legDist = 0;
          i++;
        } else {
          pos.x += (dx / d) * step;
          pos.z += (dz / d) * step;
          legDist += step;
          totalMeters += step;
        }
        g.player.pos.set(pos.x, 0, pos.z); // 逐帧驱动，供游戏 clamp/镜头真实跟随
        ticks++;
      }
      return {
        spawnToGateSeconds: (legMeters[0] ?? 0) / speed,
        gateToCenterSeconds: (legMeters[1] ?? 0) / speed,
        totalSeconds: totalMeters / speed,
        pathMeters: totalMeters,
        finalErrorM: Math.hypot(pos.x - a.bossArena.x, pos.z - a.bossArena.z),
      };
    }, { speed: WALK_SPEED, hz: SIM_HZ });

    // ---- 2) draw calls / 三角形：连续采样 RENDER_SAMPLE_FRAMES 帧（值即最近一帧的渲染统计）----
    const render = await page.evaluate(frames => new Promise<{
      calls: number[];
      triangles: number[];
      frameMs: number[];
    }>(resolve => {
      const info = (window as unknown as {
        __game: { renderer: { info: { render: { calls: number; triangles: number } } } };
      }).__game.renderer.info.render;
      const calls: number[] = [];
      const triangles: number[] = [];
      const frameMs: number[] = [];
      let last = performance.now();
      let n = 0;
      const tick = (): void => {
        const now = performance.now();
        frameMs.push(now - last);
        last = now;
        calls.push(info.calls);
        triangles.push(info.triangles);
        if (++n >= frames) resolve({ calls, triangles, frameMs });
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }), RENDER_SAMPLE_FRAMES);

    const renderStats = {
      drawCallsMedian: median(render.calls),
      drawCallsMax: Math.max(...render.calls),
      trianglesMedian: median(render.triangles),
      trianglesMax: Math.max(...render.triangles),
      fpsApprox: Math.round(1000 / median(render.frameMs.slice(1))),
    };

    // ---- 3) 可走面积：按 anchors 推导（口径同 game.ts clampWorld）----
    const area = await page.evaluate(() => {
      const a = (window as unknown as {
        __game: {
          anchors: {
            spawn: { x: number; y: number; z: number };
            fogGate: { x: number; y: number; z: number };
            bossArena: { x: number; y: number; z: number };
            arenaRadius: number;
            corridorMinX: number;
          };
        };
      }).__game.anchors;
      const corridorLengthM = a.fogGate.x - a.corridorMinX;
      const corridorWidthM = 1.45 * 2; // clampWorld 走廊 z∈[−1.45,1.45]
      const arenaRadiusM = a.arenaRadius - 0.9; // clampWorld Boss 房可走半径
      const corridorAreaM2 = corridorLengthM * corridorWidthM;
      const arenaAreaM2 = Math.PI * arenaRadiusM * arenaRadiusM;
      const v3 = (p: { x: number; y: number; z: number }): [number, number, number] => [p.x, p.y, p.z];
      return {
        corridorLengthM,
        corridorWidthM,
        corridorAreaM2,
        arenaRadiusM,
        arenaAreaM2,
        totalWalkableM2: corridorAreaM2 + arenaAreaM2,
        anchors: {
          spawn: v3(a.spawn),
          fogGate: v3(a.fogGate),
          bossArena: v3(a.bossArena),
          arenaRadius: a.arenaRadius,
          corridorMinX: a.corridorMinX,
        },
      };
    });

    results[scene] = {
      walk: {
        spawnToGateSeconds: +walk.spawnToGateSeconds.toFixed(2),
        gateToCenterSeconds: +walk.gateToCenterSeconds.toFixed(2),
        totalSeconds: +walk.totalSeconds.toFixed(2),
        pathMeters: +walk.pathMeters.toFixed(1),
        finalErrorM: +walk.finalErrorM.toFixed(3),
      },
      render: {
        drawCallsMedian: Math.round(renderStats.drawCallsMedian),
        drawCallsMax: Math.round(renderStats.drawCallsMax),
        trianglesMedian: Math.round(renderStats.trianglesMedian),
        trianglesMax: Math.round(renderStats.trianglesMax),
        fpsApprox: renderStats.fpsApprox,
      },
      area: {
        corridorLengthM: +area.corridorLengthM.toFixed(2),
        corridorWidthM: +area.corridorWidthM.toFixed(2),
        corridorAreaM2: +area.corridorAreaM2.toFixed(1),
        arenaRadiusM: +area.arenaRadiusM.toFixed(2),
        arenaAreaM2: +area.arenaAreaM2.toFixed(1),
        totalWalkableM2: +area.totalWalkableM2.toFixed(1),
      },
      anchors: area.anchors,
    };

    const r = results[scene]!;

    // ---- 基线断言：宽松（只验证探针管线产出有限数值，不卡预算）----
    // 探针自检：数值有限、模拟确实走到 Boss 房中心（<1m，远小于走廊宽）
    expect(Number.isFinite(r.walk.totalSeconds)).toBe(true);
    expect(r.walk.finalErrorM).toBeLessThan(1);
    expect(r.render.drawCallsMax).toBeGreaterThan(0);
    expect(r.render.trianglesMax).toBeGreaterThan(0);
    expect(r.area.totalWalkableM2).toBeGreaterThan(0);

    // TODO(T3/T4 扩建后改紧)：主线直跑步程 40–60s（m4 §5 验收：墓地 A 区 [20,30]s、高墙 B 区 [40,60]s）
    // expect(r.walk.totalSeconds).toBeGreaterThanOrEqual(40);
    // expect(r.walk.totalSeconds).toBeLessThanOrEqual(60);
    expect(true).toBe(true); // 基线阶段占位：只记录不卡死

    // TODO(扩建后改紧)：整机 draw calls ≤90、场景本体 ≤45（m4 §4.2 预算；本探针为整机口径）
    // expect(r.render.drawCallsMax).toBeLessThanOrEqual(90);
    expect(true).toBe(true); // 基线阶段占位：只记录不卡死

    // TODO(扩建后改紧)：几何顶点 ≤15 万/场景（m4 §4.2；三角形≈顶点/2 量级参考）
    // expect(r.render.trianglesMax).toBeLessThanOrEqual(150_000);
    expect(true).toBe(true); // 基线阶段占位：只记录不卡死
  });
}

test.afterAll(() => {
  const out = join(e2eDir(), "scale-baseline.json");
  const payload = {
    generatedAt: new Date().toISOString(),
    note: "T5 尺度探针基线。步程=60Hz 固定步长驱动 player.pos @6.2m/s（spawn→雾门→Boss房中心）；DC/三角形=renderer.info 30帧采样（整机口径）；面积=anchors 推导（clampWorld 口径）。stormveil 自 T7 起纳入（旧档注入+篝火旅行；直线口径，之字坡实走 132.5m≈21.4s 见 T7 探针）。扩建后据此对比回归，CI 预算断言见 scale.spec.ts 内 TODO。",
    walkSpeedMs: WALK_SPEED,
    scenes: results,
  };
  writeFileSync(out, JSON.stringify(payload, null, 2) + "\n");
  // eslint-disable-next-line no-console -- 基线表输出到测试日志，便于人工核对
  console.log(`[T5] baseline written: ${out}`);
});
