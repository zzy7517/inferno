/**
 * 高墙 B/D 走廊美术深加工验收探针（node 脚本直驱 chromium，结构同 t3-probe.mjs）
 *
 * 断言（任务契约）：
 *  ① anchors legacy 六字段 + zones 数组与 m4 扩建布局逐值不变（clampWorld/落位/步程依赖）
 *  ② 预算：场景本体 DC ≤45 / 三角形 ≤15 万 / PointLight ≤5（隐藏角色/小怪/Boss 口径）
 *  ③ travelTo 往返（高墙→墓地→高墙 ×2）calls 与 geometry 计数稳定（dispose 无泄漏）
 *  ④ B 走廊直跑 spawn→雾门 ∈[40,60]s（§1.3 大区口径，60Hz 固定步长 @6.2m/s）
 *  ⑤ 构建耗时 <300ms（setupScene 直测，3 次取最小）
 *  ⑥ 无页面错误/console.error + 走廊节点位 720p 截图（人工肉眼复查）
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:5208";
const SHOT_DIR = process.env.SHOT_DIR ?? "/tmp/highwall-art-shots";
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

/** 隐藏角色/小怪/Boss 后采样 renderer.info（场景本体口径；DC 恒定，12 帧中位数足够） */
const sampleRender = page => page.evaluate(frames => new Promise(resolve => {
  const g = window.__game, info = g.renderer.info;
  const calls = [], tris = [];
  const hidden = [g.player.root, g.boss.root, ...g.enemies.enemies.map(e => e.root)];
  for (const h of hidden) h.visible = false;
  const tick = () => {
    calls.push(info.render.calls);
    tris.push(info.render.triangles);
    if (calls.length >= frames) { for (const h of hidden) h.visible = true; resolve({ calls, tris, mem: { ...info.memory } }); }
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}), 12);

/** 场景本体 PointLight 计数（"highwall" 根组内；game.ts 篝火/Boss 灯不属场景本体） */
const countLights = page => page.evaluate(() => {
  let n = 0;
  window.__game.scene.getObjectByName("highwall")?.traverse(o => { if (o.isPointLight) n++; });
  return n;
});

async function main() {
  // 本机 headless chromium 会把 rAF 节流到 ~2fps：关后台节流 + 采样帧数收敛，保证探针时长可控
  const browser = await chromium.launch({
    args: ["--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleErrors = [];
  page.on("pageerror", e => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", m => { if (m.type() === "error") consoleErrors.push(`console.error: ${m.text()}`); });

  await page.goto(`${BASE}/?fresh=1&scene=highwall`, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__game?.renderer, undefined, { timeout: 30_000 });
  console.log("game booted (scene=highwall).");

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
  check("① legacy 锚点六字段不变",
    eq(anchors.spawn, [-276, 0, 1.3]) && eq(anchors.bonfire, [-276, 0, 0]) && eq(anchors.fogGate, [-4, 0, 0]) &&
    eq(anchors.bossArena, [16.1, 0, 0]) && anchors.arenaRadius === 21 && anchors.corridorMinX === -282,
    `spawn=${anchors.spawn} fogGate=${anchors.fogGate} boss=${anchors.bossArena} r=${anchors.arenaRadius} minX=${anchors.corridorMinX}`);
  const zonesExp = [
    { id: "highwall:B", kind: "corridor", minX: -282, maxX: -4, half: 2.4, cx: null, cz: null, r: null },
    { id: "highwall:B", kind: "arena", minX: 16.1 - 21 + 0.9, maxX: 36, half: null, cx: 16.1, cz: 0, r: 21 },
    { id: "highwall:D", kind: "corridor", minX: 36, maxX: 81, half: 2.4, cx: null, cz: null, r: null },
    { id: "highwall:D", kind: "arena", minX: 99.1 - 19 + 0.9, maxX: 99.1 + 19 + 0.4, half: null, cx: 99.1, cz: 0, r: 19 },
  ];
  check("① zones 数组逐值不变（B 走廊/B 房/D 走廊/D 房）", eq(anchors.zones, zonesExp), `${anchors.zones.length} zones（期望 ${zonesExp.length}）`);

  // ---------------- ② 预算：DC / 三角 / PointLight ----------------
  const r0 = await sampleRender(page);
  const dc0 = Math.round(median(r0.calls)), tri0 = Math.round(median(r0.tris));
  console.log(`render(场景本体): dc median=${dc0} max=${Math.max(...r0.calls)} | tri median=${tri0} max=${Math.max(...r0.tris)} | mem=${JSON.stringify(r0.mem)}`);
  check("② 场景本体 DC ≤45（隐藏角色/小怪/Boss 口径）", dc0 <= 45, `DC=${dc0}`);
  check("② 三角形 ≤15 万", tri0 <= 150000, `tri=${tri0}`);
  const pl0 = await countLights(page);
  check("② PointLight ≤5", pl0 <= 5, `PointLight=${pl0}（含 game.ts 篝火）`);

  // ---------------- ④ B 走廊直跑 spawn→雾门 ----------------
  const walk = await page.evaluate(({ speed, hz }) => {
    const g = window.__game, a = g.anchors;
    const step = speed / hz, tx = a.fogGate.x - 0.45;
    let x = a.spawn.x, z = a.spawn.z, ticks = 0;
    while (ticks < hz * 600) {
      const dx = tx - x, dz = -z, d = Math.hypot(dx, dz);
      if (d <= step) break;
      x += (dx / d) * step; z += (dz / d) * step;
      ticks++;
    }
    return { seconds: (ticks + 1) / hz, meters: Math.hypot(a.spawn.x - tx, a.spawn.z) };
  }, { speed: WALK_SPEED, hz: SIM_HZ });
  check("④ B 走廊步程 spawn→雾门 ∈[40,60]s", walk.seconds >= 40 && walk.seconds <= 60,
    `${walk.seconds.toFixed(2)}s（${walk.meters.toFixed(1)}m @${WALK_SPEED}m/s）`);

  // ---------------- ③ travelTo 往返：稳态对比（泄漏表现为逐轮增长，非首建差异） ----------------
  // 先跑一轮让一次性池分配（vfx/敌兵首建）进入稳态，再对相邻两轮的计数做差
  const settle = await page.evaluate(() => new Promise(res => {
    const g = window.__game;
    g.travelTo("cemetery");
    setTimeout(() => { g.travelTo("highwall"); setTimeout(res, 900); }, 900);
  }));
  void settle;
  const snapA = await page.evaluate(() => ({
    sceneId: window.__game.sceneId,
    meshes: (() => { let n = 0; window.__game.scene.traverse(o => { if (o.isMesh) n++; }); return n; })(),
    geometries: window.__game.renderer.info.memory.geometries,
    textures: window.__game.renderer.info.memory.textures,
  }));
  const rA = await sampleRender(page);
  const hop = await page.evaluate(() => new Promise(res => {
    const g = window.__game;
    g.travelTo("cemetery");
    setTimeout(() => { g.travelTo("highwall"); setTimeout(res, 900); }, 900);
  }));
  void hop;
  const snapB = await page.evaluate(() => ({
    sceneId: window.__game.sceneId,
    meshes: (() => { let n = 0; window.__game.scene.traverse(o => { if (o.isMesh) n++; }); return n; })(),
    geometries: window.__game.renderer.info.memory.geometries,
    textures: window.__game.renderer.info.memory.textures,
  }));
  const rB = await sampleRender(page);
  console.log("travel steady-state:", JSON.stringify({ A: snapA, B: snapB }));
  check("③ travelTo 往返回高墙", snapB.sceneId === "highwall", `sceneId=${snapB.sceneId}`);
  check("③ 往返两轮 mesh 数稳定", snapA.meshes === snapB.meshes, `${snapA.meshes} → ${snapB.meshes}`);
  check("③ 往返两轮 geometry 计数稳定（±2）", Math.abs(snapB.geometries - snapA.geometries) <= 2, `${snapA.geometries} → ${snapB.geometries}`);
  check("③ 往返两轮 texture 计数稳定（±2）", Math.abs(snapB.textures - snapA.textures) <= 2, `${snapA.textures} → ${snapB.textures}`);
  const dcA = Math.round(median(rA.calls)), dcB = Math.round(median(rB.calls));
  check("③ 往返两轮场景本体 DC 一致（±2）", Math.abs(dcB - dcA) <= 2, `${dcA} → ${dcB}`);
  const pl1 = await countLights(page);
  check("③ 往返后场景 PointLight 仍 ≤5", pl1 <= 5, `PointLight=${pl1}`);

  // ---------------- ⑥ 走廊节点位截图（720p，肉眼复查用；放在预算/往返之后避免扰动采样） ----------------
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  // yaw：0=+Z（南） π/2=+X（东） π=−Z（北） −π/2=−X（西）。侧向地标用斜向取景（跟背相机在
  // 玩家身后 5.6m/仰 0.36rad ≈ y3.4：正南/正北取景会把相机埋进侧墙，故斜瞄让机位留在走廊内）
  const shots = [
    { name: "01-spawn-plaza", x: -274, z: 1.2, yaw: Math.PI / 2 },   // 篝火广场，向东望长廊纵深
    { name: "02-niche-node", x: -240.5, z: 0.6, yaw: Math.PI / 2 },  // 节点：壁龛/箭缝段
    { name: "03-broken-bridge", x: -160, z: 1.4, yaw: -2.38, pitch: 0.15 }, // 远望断桥高拱落中框
    { name: "04-gallows-birds", x: -113, z: 1.4, yaw: -1.18, pitch: 0.5 },  // 西南望绞刑架+鸟群（略抬）
    { name: "05-gatehouse", x: -68, z: 0, yaw: Math.PI / 2 },        // 东望城门楼过洞
    { name: "06-dragon-bones", x: -16.5, z: 1.2, yaw: -2.23 },       // 西北望龙骨翼残像（雾门前）
    { name: "07-d-moon-altar", x: 44, z: 0, yaw: Math.PI / 2 },      // D 月坛廊道冷蓝+月尘
    { name: "08-d-seal-door", x: 24, z: 0, yaw: -Math.PI / 2 },      // 西望封印门符文环
  ];
  const shotPaths = [];
  for (const s of shots) {
    await page.evaluate(p => {
      const g = window.__game;
      g.player.lockOn = false;
      g.player.pos.set(p.x, 0, p.z);
      g.player.yaw = p.yaw;
      g.camYaw = p.yaw + Math.PI;
      if (p.pitch !== undefined) g.camPitch = p.pitch;   // 高处地标需抬头（静止时不回正）
      g.camPrevPos.copy(g.player.pos);
    }, s);
    await page.waitForTimeout(750);
    const path = `${SHOT_DIR}/${s.name}.png`;
    await page.screenshot({ path });
    shotPaths.push(path);
  }
  console.log("screenshots:", shotPaths.join("\n  "));

  // ---------------- ⑤ 构建耗时（setupScene 直测，3 次取最小；放最后避免影响前序采样） ----------------
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
  check("⑤ 场景构建 <300ms（setupScene 含篝火/雾门重建）", buildMs < 300, `${buildMs.toFixed(1)}ms`);

  await page.waitForTimeout(600);
  check("⑥ 无页面错误/console.error", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | ") || "clean");

  await browser.close();
  console.log(failures === 0 ? "\nALL PROBES PASSED" : `\n${failures} PROBE(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
