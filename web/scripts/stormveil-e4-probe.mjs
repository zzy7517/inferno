/**
 * E4 接肢教堂内景美术深加工验收探针（node 直驱 chromium，结构同 highwall-art-probe.mjs）
 *
 * 断言（任务契约）：
 *  ① anchors：出生/篝火/雾门不动。三间 Boss 房加大后，
 *     玛尔基特 c(13.5,0) r24、葛瑞克 c(62.5,0) r26、蒙格特 c(131,0) r31。
 *  ② 预算：场景本体 DC ≤45（stormveil 组可见渲染件口径；整机隐藏角色/小怪口径另附参考值）/
 *     三角形 ≤15 万 / PointLight ≤5（场景组内；game.ts 篝火不属场景本体）
 *  ③ travelTo 往返（城垣→墓地→城垣 ×2）mesh/geometry/texture/DC 稳态（dispose 无泄漏）
 *  ④ 构建耗时 <300ms（setupScene 直测，3 次取最小）
 *  ⑤ 无页面错误/console.error
 *  ⑥ E4/E5 节点位 720p 截图 ×7（暗廊/拱门玫瑰窗/中厅/后殿/祭坛/回望门洞），人工肉眼复查
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:5205";
const SHOT_DIR = process.env.SHOT_DIR ?? "/tmp/stormveil-e4-shots";

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

/** 隐藏角色/小怪/Boss 后采样 renderer.info（整机隐藏口径 + stormveil 组场景本体件数） */
const sampleRender = page => page.evaluate(frames => new Promise(resolve => {
  const g = window.__game, info = g.renderer.info;
  const calls = [], tris = [];
  const hidden = [g.player.root, g.boss.root, ...g.enemies.enemies.map(e => e.root)];
  for (const h of hidden) h.visible = false;
  let sceneRenderables = -1;
  const countVisible = o => {
    let n = 0;
    o.traverse(c => {
      if ((c.isMesh || c.isPoints) && c.visible) {
        let p = c, vis = true;
        while (p) { if (p.visible === false) { vis = false; break; } p = p.parent; }
        if (vis) n++;
      }
    });
    return n;
  };
  const tick = () => {
    calls.push(info.render.calls);
    tris.push(info.render.triangles);
    if (calls.length === 1) sceneRenderables = countVisible(g.scene.getObjectByName("stormveil"));
    if (calls.length >= frames) {
      for (const h of hidden) h.visible = true;
      resolve({ calls, tris, sceneRenderables, mem: { ...info.memory } });
    }
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}), 12);

/** 场景本体 PointLight 计数（"stormveil" 根组内；game.ts 篝火/Boss 灯不属场景本体） */
const countLights = page => page.evaluate(() => {
  let n = 0;
  window.__game.scene.getObjectByName("stormveil")?.traverse(o => { if (o.isPointLight) n++; });
  return n;
});

async function main() {
  const browser = await chromium.launch({
    args: ["--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleErrors = [];
  page.on("pageerror", e => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", m => { if (m.type() === "error") consoleErrors.push(`console.error: ${m.text()}`); });

  // 旧档注入：vordt+margit 败 → 城垣与 E4/E5 全解锁（E4 暗廊活尸布点同口径）
  await page.addInitScript(() => {
    localStorage.setItem("inferno.progress.v1", JSON.stringify({
      defeated: ["gundyr", "vordt", "margit"],
      unlockedScenes: ["cemetery", "highwall", "stormveil"],
      zoneUnlocks: ["cemetery:A", "highwall:B", "highwall:D", "stormveil:E", "stormveil:E4"],
      shortcuts: [], litBonfires: ["cemetery", "highwall", "stormveil"], lastBonfire: "stormveil",
      souls: 0, attempts: {}, bloodstain: null,
    }));
  });
  await page.goto(`${BASE}/?scene=stormveil`, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__game?.renderer, undefined, { timeout: 30_000 });
  console.log("game booted (scene=stormveil, E4/E5 unlocked).");

  // ---------------- ① anchors / zones 逐值断言 ----------------
  const anchors = await page.evaluate(() => {
    const a = window.__game.anchors;
    return {
      spawn: [a.spawn.x, a.spawn.y, a.spawn.z],
      bonfire: [a.bonfire.x, a.bonfire.y, a.bonfire.z],
      fogGate: [a.fogGate.x, a.fogGate.y, a.fogGate.z],
      bossArena: [a.bossArena.x, a.bossArena.y, a.bossArena.z],
      arenaRadius: a.arenaRadius,
      corridorMinX: a.corridorMinX,
      zones: (a.zones ?? []).map(z => ({ id: z.id, kind: z.kind, minX: z.minX, maxX: z.maxX, half: z.half ?? null, cx: z.center?.x ?? null, cz: z.center?.z ?? null, r: z.r ?? null })),
    };
  });
  console.log("anchors:", JSON.stringify(anchors));
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const M_OLD_C = 1.5, M_OLD_R = 12, M_R = 24;
  const M_WEST = M_OLD_C - (M_OLD_R - 0.9);
  const M_C = M_WEST + (M_R - 0.9);
  const M_EAST = M_C + (M_R - 0.9);
  const DX_M = M_EAST - (M_OLD_C + (M_OLD_R - 0.9));
  const G_OLD_C = 26.5, G_OLD_R = 14, G_R = 26;
  const G_WEST = G_OLD_C - (G_OLD_R - 0.9) + DX_M;
  const G_C = G_WEST + (G_R - 0.9);
  const G_EAST = G_C + (G_R - 0.9);
  const DX_G = G_EAST - (G_OLD_C + (G_OLD_R - 0.9) + DX_M);
  const T_OLD_C = 66, T_OLD_R = 14, T_R = 31;
  const T_WEST = T_OLD_C - (T_OLD_R - 0.9) + DX_M + DX_G;
  const T_C = T_WEST + (T_R - 0.9);
  check("① 出生/篝火/雾门不动，玛尔基特房心东移",
    eq(anchors.spawn, [-36.6, 0, 1.2]) && eq(anchors.bonfire, [-36.6, 0, 0]) && eq(anchors.fogGate, [-5, 0, 0]) &&
    eq(anchors.bossArena, [M_C, 0, 0]) && anchors.arenaRadius === M_R && anchors.corridorMinX === -37.5,
    `spawn=${anchors.spawn} fogGate=${anchors.fogGate} boss=${anchors.bossArena} r=${anchors.arenaRadius} minX=${anchors.corridorMinX}`);
  const zonesExp = [
    { id: "stormveil:E", kind: "corridor", minX: -38, maxX: -20.5, half: 11, cx: null, cz: null, r: null },
    { id: "stormveil:E", kind: "corridor", minX: -20.5, maxX: -8, half: 4.5, cx: null, cz: null, r: null },
    { id: "stormveil:E", kind: "corridor", minX: -8, maxX: -5, half: 2.2, cx: null, cz: null, r: null },
    { id: "stormveil:E", kind: "arena", minX: -5, maxX: M_EAST + 0.4, half: null, cx: M_C, cz: 0, r: M_R },
    { id: "stormveil:E4", kind: "corridor", minX: 12.4 + DX_M, maxX: 24 + DX_M, half: 4, cx: null, cz: null, r: null },
    { id: "stormveil:E4", kind: "arena", minX: 24 + DX_M, maxX: 42 + DX_M + DX_G, half: null, cx: G_C, cz: 0, r: G_R },
    { id: "stormveil:F", kind: "corridor", minX: G_EAST - 0.4, maxX: T_WEST, half: 2.6, cx: null, cz: null, r: null },
    { id: "stormveil:F", kind: "arena", minX: T_WEST, maxX: T_C + T_R, half: null, cx: T_C, cz: 0, r: T_R },
  ];
  check("① zones 与加大后的三间 Boss 房一致",
    eq(anchors.zones, zonesExp), `${anchors.zones.length} zones（期望 ${zonesExp.length}）`);

  // ---------------- ② 预算：场景本体 DC / 三角 / PointLight ----------------
  const r0 = await sampleRender(page);
  const dcWhole = Math.round(median(r0.calls)), triWhole = Math.round(median(r0.tris));
  console.log(`render: 场景本体件数=${r0.sceneRenderables} | 整机(隐藏角色) dc median=${dcWhole} max=${Math.max(...r0.calls)} | tri median=${triWhole} max=${Math.max(...r0.tris)} | mem=${JSON.stringify(r0.mem)}`);
  check("② 场景本体 DC ≤45（stormveil 组可见渲染件）", r0.sceneRenderables <= 45, `sceneRenderables=${r0.sceneRenderables}`);
  check("② 三角形 ≤15 万（整机隐藏口径，含 game.ts 件）", triWhole <= 150000, `tri=${triWhole}`);
  const pl0 = await countLights(page);
  check("② PointLight ≤5（场景本体）", pl0 <= 5, `PointLight=${pl0}`);

  // ---------------- ③ travelTo 往返稳态（先跑一轮入稳态，再对比相邻两轮） ----------------
  const hop = () => page.evaluate(() => new Promise(res => {
    const g = window.__game;
    g.travelTo("cemetery");
    setTimeout(() => { g.travelTo("stormveil"); setTimeout(res, 900); }, 900);
  }));
  await hop();
  const snapA = await page.evaluate(() => ({
    sceneId: window.__game.sceneId,
    meshes: (() => { let n = 0; window.__game.scene.traverse(o => { if (o.isMesh) n++; }); return n; })(),
    geometries: window.__game.renderer.info.memory.geometries,
    textures: window.__game.renderer.info.memory.textures,
  }));
  const rA = await sampleRender(page);
  await hop();
  const snapB = await page.evaluate(() => ({
    sceneId: window.__game.sceneId,
    meshes: (() => { let n = 0; window.__game.scene.traverse(o => { if (o.isMesh) n++; }); return n; })(),
    geometries: window.__game.renderer.info.memory.geometries,
    textures: window.__game.renderer.info.memory.textures,
  }));
  const rB = await sampleRender(page);
  console.log("travel steady-state:", JSON.stringify({ A: snapA, B: snapB }));
  check("③ travelTo 往返回城垣", snapB.sceneId === "stormveil", `sceneId=${snapB.sceneId}`);
  check("③ 往返两轮 mesh 数稳定", snapA.meshes === snapB.meshes, `${snapA.meshes} → ${snapB.meshes}`);
  check("③ 往返两轮 geometry 计数稳定（±2）", Math.abs(snapB.geometries - snapA.geometries) <= 2, `${snapA.geometries} → ${snapB.geometries}`);
  check("③ 往返两轮 texture 计数稳定（±2）", Math.abs(snapB.textures - snapA.textures) <= 2, `${snapA.textures} → ${snapB.textures}`);
  check("③ 往返两轮场景本体件数一致（±2）", Math.abs(rB.sceneRenderables - rA.sceneRenderables) <= 2, `${rA.sceneRenderables} → ${rB.sceneRenderables}`);
  const pl1 = await countLights(page);
  check("③ 往返后场景 PointLight 仍 ≤5", pl1 <= 5, `PointLight=${pl1}`);

  // ---------------- ⑥ E4/E5 节点位 720p 截图（肉眼复查；放预算/往返后避免扰动采样） ----------------
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  // yaw：0=+Z（北） π/2=+X（东） π=−Z（南） −π/2=−X（西）；跟背相机在玩家身后 5.6m/仰 0.36rad
  const shots = [
    { name: "01-e4-dark-corridor", x: 40.8, z: -1.2, yaw: 1.25 },                 // 暗廊：随残柱厅东移 24m
    { name: "02-gate-rose-beasts", x: 30.1, z: 0, yaw: Math.PI / 2, pitch: 0.3 }, // 玛尔基特东门
    { name: "03-nave-east", x: 59.1, z: -4.6, yaw: 1.42 },                        // 中厅
    { name: "04-nave-side", x: 61.5, z: 12.5, yaw: -0.35, pitch: 0.18 },          // 南侧北望
    { name: "05-apse-altar", x: 76.9, z: 8.6, yaw: 2.21, pitch: 0.14 },           // 后殿
    { name: "06-altar-close", x: 82.5, z: 3.4, yaw: 2.14, pitch: 0.2 },           // 祭坛近景
    { name: "07-arena-look-west", x: 75.1, z: 5.7, yaw: -1.75 },                  // 回望门洞
  ];
  const shotPaths = [];
  for (const s of shots) {
    await page.evaluate(p => {
      const g = window.__game;
      g.player.lockOn = false;
      g.fog.solid = false;                    // 雾门单向墙会让钳制把玩家拽回 x≤-5.4：截图机位直进需先放行
      g.player.pos.set(p.x, 0, p.z);
      g.player.yaw = p.yaw;
      g.camYaw = p.yaw + Math.PI;
      if (p.pitch !== undefined) g.camPitch = p.pitch;
      g.camPrevPos.copy(g.player.pos);
      g.prevPx = p.x;
    }, s);
    await page.waitForTimeout(750);
    const path = `${SHOT_DIR}/${s.name}.png`;
    await page.screenshot({ path });
    shotPaths.push(path);
  }
  console.log("screenshots:", shotPaths.join("\n  "));

  // ---------------- ④ 构建耗时（setupScene 直测，3 次取最小；放最后避免影响前序采样） ----------------
  const buildMs = await page.evaluate(() => {
    const g = window.__game;
    const ts = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      g.setupScene();
      ts.push(performance.now() - t0);
    }
    return Math.min(...ts);
  });
  check("④ 场景构建 <300ms（setupScene 含篝火/雾门重建）", buildMs < 300, `${buildMs.toFixed(1)}ms`);

  await page.waitForTimeout(600);
  check("⑤ 无页面错误/console.error", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | ") || "clean");

  await browser.close();
  console.log(failures === 0 ? "\nALL PROBES PASSED" : `\n${failures} PROBE(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
