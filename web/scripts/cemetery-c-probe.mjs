/**
 * 墓地 C 区法兰要塞艺术化验收探针（node 脚本直驱 chromium，结构同 highwall-art-probe.mjs）
 *
 * 断言（任务契约）：
 *  ① anchors legacy 六字段 + zones 数组与扩建布局逐值不变（clampWorld/落位/步程依赖）
 *  ② 预算：场景本体 DC ≤45 / 三角形 ≤15 万 / PointLight ≤5（隐藏角色/小怪/Boss 口径；C1 中段取景）
 *  ③ travelTo 往返（墓地→高墙→墓地 ×2）mesh/geometry/texture/DC 稳态（dispose 无泄漏）
 *  ④ C 区可走域抽查：解锁后 C1 走廊 z 钳制 ±2.75 / C2 圆心站立 / 未解锁推回 A 东界-0.4
 *  ⑤ 构建耗时 <300ms（setupScene 直测，3 次取最小）
 *  ⑥ 无页面错误/console.error + C 区节点位 720p 截图 ×8（门B/C1 中段/蓝灯笼龛/残旗骨堆/
 *     尖碑环/断王座/崩塌豁口冷月，人工肉眼复查）
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:5206";
const SHOT_DIR = process.env.SHOT_DIR ?? "/tmp/cemetery-c-shots";

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

/** 传送取景（轨道相机：yaw 0=+Z π/2=+X；snapCamera 把注视点贴到新位置） */
const teleport = (page, p) => page.evaluate(pp => {
  const g = window.__game;
  g.player.lockOn = false;
  g.player.pos.set(pp.x, 0, pp.z);
  g.player.yaw = pp.yaw;
  g.camYaw = pp.yaw + Math.PI;
  if (pp.pitch !== undefined) g.camPitch = pp.pitch;
  g.snapCamera();
}, p);

/** 隐藏角色/小怪/Boss 后采样 renderer.info（场景本体口径；12 帧中位数） */
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

/** 场景本体 PointLight 计数（"cemetery" 根组内；game.ts 篝火/雾门不属场景本体） */
const countLights = page => page.evaluate(() => {
  let n = 0;
  window.__game.scene.getObjectByName("cemetery")?.traverse(o => { if (o.isPointLight) n++; });
  return n;
});

async function main() {
  // 本机 headless chromium 会把 rAF 节流：关后台节流，保证探针时长可控
  const browser = await chromium.launch({
    args: ["--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleErrors = [];
  page.on("pageerror", e => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", m => { if (m.type() === "error") consoleErrors.push(`console.error: ${m.text()}`); });

  await page.goto(`${BASE}/?fresh=1&scene=cemetery`, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__game?.renderer, undefined, { timeout: 30_000 });
  console.log("game booted (scene=cemetery).");

  // 解锁 C 区 + 跨雾门标记（截图/采样都要深入 C 区；不改可走域，仅放开进度闸门）
  await page.evaluate(() => {
    const g = window.__game;
    if (!g.progress.zoneUnlocks.includes("cemetery:C")) g.progress.zoneUnlocks.push("cemetery:C");
    g.fog.solid = false;
  });

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
    eq(anchors.spawn, [-140.5, 0, 1.4]) && eq(anchors.bonfire, [-140.5, 0, 0]) && eq(anchors.fogGate, [-10, 0, 0]) &&
    eq(anchors.bossArena, [3.5, 0, 0]) && anchors.arenaRadius === 17 && anchors.corridorMinX === -141.7,
    `spawn=${anchors.spawn} fogGate=${anchors.fogGate} boss=${anchors.bossArena} r=${anchors.arenaRadius} minX=${anchors.corridorMinX}`);
  const zonesExp = [
    { id: "cemetery:A", kind: "corridor", minX: -142, maxX: -101, half: 2.75, cx: null, cz: null, r: null },
    { id: "cemetery:A", kind: "arena", minX: -101, maxX: -89, half: null, cx: -95, cz: 0, r: 7.5 },
    { id: "cemetery:A", kind: "corridor", minX: -89, maxX: -51, half: 2.75, cx: null, cz: null, r: null },
    { id: "cemetery:A", kind: "arena", minX: -51, maxX: -39, half: null, cx: -45, cz: 0, r: 7.5 },
    { id: "cemetery:A", kind: "corridor", minX: -39, maxX: -10, half: 2.75, cx: null, cz: null, r: null },
    { id: "cemetery:A", kind: "arena", minX: -10, maxX: 19.6, half: null, cx: 3.5, cz: 0, r: 17 },
    { id: "cemetery:C", kind: "corridor", minX: 19.2, maxX: 55.9, half: 2.75, cx: null, cz: null, r: null },
    { id: "cemetery:C", kind: "arena", minX: 55.9, maxX: 92.1, half: null, cx: 74, cz: 0, r: 19 },
    { id: "cemetery:D", kind: "corridor", minX: 91.7, maxX: 104.9, half: 2.75, cx: null, cz: null, r: null },
    { id: "cemetery:D", kind: "arena", minX: 104.9, maxX: 286, half: null, cx: 195, cz: 0, r: 91 },
  ];
  check("① zones 数组逐值不变（A 六分区 + C 哨路/监视者房 + D 碎星径/战场）", eq(anchors.zones, zonesExp), `${anchors.zones.length} zones（期望 ${zonesExp.length}）`);

  // ---------------- ④ C 区可走域抽查（clampWorld 不因美术改动漂移） ----------------
  const clampProbe = await page.evaluate(() => {
    const g = window.__game;
    const out = {};
    g.prevPx = 26; g.player.pos.set(26, 0, 9); g.clampWorld(); out.corridorZ = g.player.pos.z;      // C1 z 钳制
    g.prevPx = 74; g.player.pos.set(74, 0, 0.5); g.clampWorld(); out.arenaCenterX = g.player.pos.x; // C2 圆心站立
    g.prevPx = 80; g.player.pos.set(80, 0, 20); g.clampWorld(); out.arenaEdgeR = Math.hypot(g.player.pos.x - 74, g.player.pos.z);
    const i = g.progress.zoneUnlocks.indexOf("cemetery:C");
    if (i >= 0) g.progress.zoneUnlocks.splice(i, 1);                                                  // 临时锁回 C：推回口径
    g.prevPx = 30; g.player.pos.set(30, 0, 0); g.clampWorld(); out.lockedX = g.player.pos.x;
    g.progress.zoneUnlocks.push("cemetery:C");
    return out;
  });
  console.log("clamp:", JSON.stringify(clampProbe));
  check("④ C1 走廊 z 钳制 ±2.75", Math.abs(clampProbe.corridorZ - 2.75) < 0.01, `z=${clampProbe.corridorZ}`);
  check("④ C2 圆心可站立", Math.abs(clampProbe.arenaCenterX - 74) < 0.05, `x=${clampProbe.arenaCenterX}`);
  check("④ C2 竞技场径向钳制 r-0.9", Math.abs(clampProbe.arenaEdgeR - (19 - 0.9)) < 0.05, `r=${clampProbe.arenaEdgeR.toFixed(3)} 期望=${(19 - 0.9).toFixed(3)}`);
  check("④ C 未解锁推回 A 东界-0.4", Math.abs(clampProbe.lockedX - (19.6 - 0.4)) < 0.05, `lockedX=${clampProbe.lockedX.toFixed(3)} 期望=19.2`);

  // ---------------- ② 预算：DC / 三角 / PointLight（C1 中段取景——C 区几何在场） ----------------
  await teleport(page, { x: 26, z: 0.4, yaw: Math.PI / 2 });
  await page.waitForTimeout(600);
  const r0 = await sampleRender(page);
  const dc0 = Math.round(median(r0.calls)), tri0 = Math.round(median(r0.tris));
  console.log(`render(场景本体@C1中段): dc median=${dc0} max=${Math.max(...r0.calls)} | tri median=${tri0} max=${Math.max(...r0.tris)} | mem=${JSON.stringify(r0.mem)}`);
  check("② 场景本体 DC ≤45（隐藏角色/小怪/Boss 口径）", dc0 <= 45, `DC=${dc0}`);
  check("② 三角形 ≤15 万", tri0 <= 150000, `tri=${tri0}`);
  const pl0 = await countLights(page);
  check("② PointLight ≤5（cemetery 组内）", pl0 <= 5, `PointLight=${pl0}`);

  // ---------------- ③ travelTo 往返：稳态对比（泄漏表现为逐轮增长，非首建差异） ----------------
  const hop = () => page.evaluate(() => new Promise(res => {
    const g = window.__game;
    g.travelTo("highwall");
    setTimeout(() => { g.travelTo("cemetery"); setTimeout(res, 900); }, 900);
  }));
  await hop();                                            // 先跑一轮进稳态（一次性池分配）
  const snapAndRender = async () => {
    const snap = await page.evaluate(() => ({
      sceneId: window.__game.sceneId,
      meshes: (() => { let n = 0; window.__game.scene.traverse(o => { if (o.isMesh) n++; }); return n; })(),
      geometries: window.__game.renderer.info.memory.geometries,
      textures: window.__game.renderer.info.memory.textures,
    }));
    await page.evaluate(() => {                          // travelTo 把玩家重置回出生点：再取 C1 中段口径
      const g = window.__game;
      if (!g.progress.zoneUnlocks.includes("cemetery:C")) g.progress.zoneUnlocks.push("cemetery:C");
      g.fog.solid = false;
    });
    await teleport(page, { x: 26, z: 0.4, yaw: Math.PI / 2 });
    await page.waitForTimeout(600);
    return { snap, render: await sampleRender(page) };
  };
  const A = await snapAndRender();
  await hop();
  const B = await snapAndRender();
  console.log("travel steady-state:", JSON.stringify({ A: A.snap, B: B.snap }));
  check("③ travelTo 往返回墓地", B.snap.sceneId === "cemetery", `sceneId=${B.snap.sceneId}`);
  check("③ 往返两轮 mesh 数稳定", A.snap.meshes === B.snap.meshes, `${A.snap.meshes} → ${B.snap.meshes}`);
  check("③ 往返两轮 geometry 计数稳定（±2）", Math.abs(B.snap.geometries - A.snap.geometries) <= 2, `${A.snap.geometries} → ${B.snap.geometries}`);
  check("③ 往返两轮 texture 计数稳定（±2）", Math.abs(B.snap.textures - A.snap.textures) <= 2, `${A.snap.textures} → ${B.snap.textures}`);
  const dcA = Math.round(median(A.render.calls)), dcB = Math.round(median(B.render.calls));
  check("③ 往返两轮场景本体 DC 一致（±2）", Math.abs(dcB - dcA) <= 2, `${dcA} → ${dcB}`);
  const pl1 = await countLights(page);
  check("③ 往返后场景 PointLight 仍 ≤5", pl1 <= 5, `PointLight=${pl1}`);

  // ---------------- ⑥ C 区节点位截图（720p，肉眼复查用；放在预算/往返之后避免扰动采样） ----------------
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  // yaw：0=+Z（南） π/2=+X（东）。跟背相机在玩家身后 5.6m——C1 净宽仅 5.5m，
  // 纯南北向取景会把相机埋进侧墙（黑帧），侧墙题材一律斜瞄且限制 yaw 贴近东西轴。
  const shots = [
    { name: "01-doorB-approach", x: 4.2, z: 0.4, yaw: Math.PI / 2 },          // 东望沉重黑拱+幽蓝门槛（跨古达房）
    { name: "02-doorB-under", x: 11.6, z: 0.2, yaw: -Math.PI / 2 },           // 门洞下回望：门槛光带+光晕
    { name: "03-c1-descent", x: 26, z: 0.4, yaw: Math.PI / 2 },               // C1 中段：压顶横梁+高墙+暗地面+薄雾
    { name: "04-lantern-niche", x: 21.9, z: -2.0, yaw: 1.9, pitch: 0.1 },     // 北壁蓝灯笼龛（悬灯+链+光晕，斜瞄）
    { name: "05-banner-bones", x: 34.6, z: -1.5, yaw: 1.8, pitch: 0.08 },     // 残旗+骨堆+盔甲残骸（东北斜瞄）
    { name: "06-obelisk-ring", x: 49.5, z: 2.6, yaw: 1.9, pitch: 0.06 },      // 尖碑环+符文刻痕（西口内望）
    { name: "07-broken-throne", x: 52.5, z: 2.2, yaw: 1.6, pitch: 0.14 },     // 断王座仪式：台阶+王冠+剑冢
    { name: "08-breach-moon", x: 57.5, z: 5.5, yaw: 2.25, pitch: 0.1 },       // 崩塌豁口：冷月+监视者立影
  ];
  const shotPaths = [];
  for (const s of shots) {
    await teleport(page, s);
    await page.waitForTimeout(750);
    const path = `${SHOT_DIR}/${s.name}.png`;
    await page.screenshot({ path });
    shotPaths.push(path);
  }
  console.log("screenshots:\n  " + shotPaths.join("\n  "));

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
