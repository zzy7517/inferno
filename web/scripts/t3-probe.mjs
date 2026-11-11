/**
 * T3 墓地扩建验收探针（node 脚本直驱 chromium，非 playwright test）
 *
 * 断言（任务契约 ①-⑥）：
 *  ① zones 数组存在，A/C 两区 id 正确且西→东有序
 *  ② zones 钳制：未解锁 C 时传送到 C 区被推回 A 区东界-0.4；模拟 zoneUnlocks 后可进入且走廊/Boss房钳制生效
 *  ③ A 区步程 spawn→雾门 20-30s（60Hz 固定步长直驱 player.pos @6.2m/s，与 T5 口径一致）
 *  ④ 场景本体 DC（renderer.info.render.calls 30 帧中位数 − 角色/Boss 约 20）≤ 45
 *  ⑥ 旧流程回归：?fresh=1 开局 → 传送雾门西 E 跨雾 → boss.pull → flow=fight + travelTo 往返
 *  （⑤ tsc --noEmit 在 shell 侧单独跑）
 */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:5204";
const WALK_SPEED = 6.2;
const SIM_HZ = 60;

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  if (!ok) failures++;
};

const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleErrors = [];
  page.on("pageerror", e => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", m => { if (m.type() === "error") consoleErrors.push(`console.error: ${m.text()}`); });

  await page.goto(`${BASE}/?fresh=1`, { waitUntil: "load" });
  await page.waitForFunction(() => {
    const g = window.__game;
    return !!g?.renderer;
  }, undefined, { timeout: 30_000 });
  console.log("game booted.");

  // ---------------- ① zones 结构 ----------------
  const zones = await page.evaluate(() => {
    const a = window.__game.anchors;
    return (a.zones ?? []).map(z => ({ id: z.id, kind: z.kind, minX: z.minX, maxX: z.maxX, half: z.half ?? null, cx: z.center?.x ?? null, cz: z.center?.z ?? null, r: z.r ?? null }));
  });
  console.log("zones:", JSON.stringify(zones));
  const ids = new Set(zones.map(z => z.id));
  check("① zones 存在且 A/C 两区", zones.length >= 2 && ids.has("cemetery:A") && ids.has("cemetery:C") && ids.size === 2,
    `${zones.length} zones, ids=[${[...ids].join(",")}]`);
  const ordered = zones.every((z, i) => i === 0 || zones[i - 1].minX <= z.minX);
  check("① zones 西→东有序", ordered, `minX 序列=[${zones.map(z => z.minX).join(",")}]`);
  const cArena = zones.find(z => z.id === "cemetery:C" && z.kind === "arena");
  check("① C 区监视者竞技场中心/半径入 zones", !!cArena && cArena.r === 12,
    cArena ? `center=(${cArena.cx},${cArena.cz}) r=${cArena.r}` : "missing");
  const legacy = await page.evaluate(() => {
    const a = window.__game.anchors;
    return { spawn: [a.spawn.x, a.spawn.y, a.spawn.z], fogGateX: a.fogGate.x, bossArena: [a.bossArena.x, a.bossArena.z], arenaRadius: a.arenaRadius, corridorMinX: a.corridorMinX };
  });
  console.log("legacy anchors:", JSON.stringify(legacy));
  const aEast = Math.max(...zones.filter(z => z.id === "cemetery:A").map(z => z.maxX));
  const cWest = Math.min(...zones.filter(z => z.id === "cemetery:C").map(z => z.minX));
  check("① A/C 衔接（C 西界落在 A 东界墙缝 0.4m 内）", cWest <= aEast + 1e-6 && cWest >= aEast - 0.5, `A.maxX=${aEast} C.minX=${cWest}`);

  // ---------------- ④ 场景本体 DC（intro 口径；动态扣除角色与小怪——v2 角色 31 网格≈32DC、布点小怪视距内≈19DC，避免口径漂移） ----------------
  const render = await page.evaluate(frames => new Promise(resolve => {
    const g = window.__game, info = g.renderer.info.render;
    const calls = [];
    let n = 0;
    const hidden = [g.player.root, ...g.enemies.enemies.map(e => e.root)];
    for (const h of hidden) h.visible = false;
    const tick = () => {
      calls.push(info.calls);
      if (++n >= frames) { for (const h of hidden) h.visible = true; resolve({ calls }); }
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), 30);
  const dcMedian = median(render.calls);
  const sceneDc = dcMedian;
  console.log(`render(intro,场景本体): median=${dcMedian} max=${Math.max(...render.calls)}`);
  check("④ 场景本体 DC ≤45（隐藏角色/小怪口径，intro 采样）", sceneDc <= 45, `场景本体 ${sceneDc}`);

  // ---------------- ② 钳制：C 未解锁推回 / 解锁后可进 ----------------
  const clampProbe = await page.evaluate(cX => {
    const g = window.__game;
    const out = {};
    // 视作已跨雾门（fog.solid=false + prevPx 置东），单测 zones 墙
    g.fog.solid = false;
    // 未解锁：传送 C 区走廊中段
    g.prevPx = cX; g.player.pos.set(cX, 0, 0); g.clampWorld();
    out.lockedX = g.player.pos.x;
    // 解锁：模拟进度含 cemetery:C
    g.progress.zoneUnlocks.push("cemetery:C");
    g.prevPx = cX; g.player.pos.set(cX, 0, 0); g.clampWorld();
    out.unlockedCorridorX = g.player.pos.x;
    // 走廊 z 钳制
    g.prevPx = cX; g.player.pos.set(cX, 0, 9); g.clampWorld();
    out.corridorZ = g.player.pos.z;
    // C2 Boss 房径向钳制（圆外 0.2m 推回）
    const c2x = 57, c2r = 12;
    const bx = c2x + c2r - 0.2;
    g.prevPx = bx; g.player.pos.set(bx, 0, 0); g.clampWorld();
    out.arenaEdgeX = g.player.pos.x;
    // C2 圆心可站立
    g.prevPx = c2x; g.player.pos.set(c2x, 0, 0.5); g.clampWorld();
    out.arenaCenterX = g.player.pos.x;
    return out;
  }, 30);
  console.log("clamp:", JSON.stringify(clampProbe));
  check("② C 未解锁被推回 A 东界-0.4", Math.abs(clampProbe.lockedX - (aEast - 0.4)) < 0.05, `lockedX=${clampProbe.lockedX.toFixed(3)} 期望=${(aEast - 0.4).toFixed(3)}`);
  check("② 解锁后 C 走廊可进入", Math.abs(clampProbe.unlockedCorridorX - 30) < 0.05, `x=${clampProbe.unlockedCorridorX}`);
  check("② C 走廊 z 钳制 ±2.75", Math.abs(clampProbe.corridorZ - 2.75) < 0.01, `z=${clampProbe.corridorZ}`);
  check("② C2 竞技场径向钳制 r-0.9", Math.abs(clampProbe.arenaEdgeX - (57 + 12 - 0.9)) < 0.05, `edgeX=${clampProbe.arenaEdgeX.toFixed(3)} 期望=${(57 + 12 - 0.9).toFixed(3)}`);
  check("② C2 圆心可站立", Math.abs(clampProbe.arenaCenterX - 57) < 0.05, `x=${clampProbe.arenaCenterX}`);

  // ---------------- ③ A 区步程 spawn→雾门 ----------------
  const walk = await page.evaluate(({ speed, hz }) => {
    const g = window.__game;
    const a = g.anchors;
    const step = speed / hz;
    const tx = a.fogGate.x - 0.45, tz = 0;               // 雾门线西沿（未跨门）
    let x = a.spawn.x, z = a.spawn.z;
    let ticks = 0;
    const maxTicks = hz * 600;
    while (ticks < maxTicks) {
      const dx = tx - x, dz = tz - z;
      const d = Math.hypot(dx, dz);
      if (d <= step) { x = tx; z = tz; ticks++; break; }
      x += (dx / d) * step; z += (dz / d) * step;
      g.player.pos.set(x, 0, z);
      ticks++;
    }
    return { seconds: ticks / hz, meters: Math.hypot(a.spawn.x - tx, a.spawn.z - tz), endX: x, endZ: z };
  }, { speed: WALK_SPEED, hz: SIM_HZ });
  console.log("walk:", JSON.stringify(walk));
  check("③ A 区步程 spawn→雾门 ∈[20,30]s", walk.seconds >= 20 && walk.seconds <= 30,
    `${walk.seconds.toFixed(2)}s（${walk.meters.toFixed(1)}m @${WALK_SPEED}m/s）`);

  // ---------------- ⑥ 旧流程回归：开局古达雾门流程 ----------------
  const flow = await page.evaluate(() => {
    const g = window.__game;
    const out = {};
    out.bossId = g.bossId;
    // 传送雾门西侧 → E 跨雾
    g.prevPx = g.anchors.fogGate.x - 1;
    g.player.pos.set(g.anchors.fogGate.x - 1.0, 0, 0);
    g.interact();
    out.afterGate = { flow: g.flow, fogSolid: g.fog.solid };
    // 传送 Boss 像 → E 拔剑
    g.prevPx = g.boss.root.position.x;
    g.player.pos.set(g.boss.root.position.x - 1.2, 0, 0);
    g.interact();
    out.afterPull = { flow: g.flow, awake: g.boss.awake, state: g.boss.state };
    return out;
  });
  console.log("flow:", JSON.stringify(flow));
  check("⑥ 开局雾门 Boss=古达", flow.bossId === "gundyr", `bossId=${flow.bossId}`);
  check("⑥ E 跨雾门 → statue", flow.afterGate.flow === "statue" && !flow.afterGate.fogSolid, `flow=${flow.afterGate.flow}`);
  check("⑥ E 拔剑 → fight/combat", flow.afterPull.flow === "fight" && flow.afterPull.awake, `flow=${flow.afterPull.flow} awake=${flow.afterPull.awake} state=${flow.afterPull.state}`);

  // 战斗中整机 DC ≤130（v2 角色 31 网格后整机≈94 实测；守门防失控回归，角色网格合并优化见设计文档 TODO）
  const renderFight = await page.evaluate(frames => new Promise(resolve => {
    const info = window.__game.renderer.info.render;
    const calls = [];
    let n = 0;
    const tick = () => {
      calls.push(info.calls);
      if (++n >= frames) resolve({ calls });
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), 30);
  const fightMax = Math.max(...renderFight.calls);
  console.log(`render(fight): median=${median(renderFight.calls)} max=${fightMax}`);
  check("④ 战斗中整机 DC ≤130（含 v2 角色网格）", fightMax <= 130, `max=${fightMax}`);

  // 全程无页面错误（场景 update/构建回归信号）
  await page.waitForTimeout(600);
  check("⑥ 无页面错误/console.error", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | ") || "clean");

  // travelTo 往返泄漏冒烟：篝火菜单旅行管线 → 高墙 → 回墓地（dispose/rebuild 循环）
  const travel = await page.evaluate(() => new Promise(resolve => {
    const g = window.__game;
    g.travelTo("highwall");
    setTimeout(() => {
      g.travelTo("cemetery");
      setTimeout(() => {
        resolve({ ok: window.__game.sceneId === "cemetery", calls: window.__game.renderer.info.render.calls });
      }, 1500);
    }, 1500);
  }));
  console.log("travel:", JSON.stringify(travel));
  check("⑥ travelTo 往返重建成功", travel.ok, `sceneId=cemetery, 回程 calls=${travel.calls}`);

  await browser.close();
  console.log(failures === 0 ? "\nALL PROBES PASSED" : `\n${failures} PROBE(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
