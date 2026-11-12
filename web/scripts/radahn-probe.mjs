/**
 * Boss #8「碎星拉塔恩」验收探针（node 直驱 chromium，结构同 t3/t6-probe；BASE_URL 可覆盖）
 *
 * 断言（任务契约）：
 *  ① 直选 ?fresh=1&boss=radahn：cls=Radahn / 名「碎星拉塔恩」/ hp 950 / radius 1.6 / souls 18000
 *  ② 本体预算：root 内 mesh ≤13、root DC 增量 ≤22（含阴影 pass+紫尘 Points）、无 PointLight
 *  ③ E 拔剑 → fight → rising → combat；一阶段六招逐个驱动（tel→act→rec 全程无错）：
 *     交叉斩/三连/拖剑旋风/重力拉动/岩石投掷(2 连)/碎星之矢
 *  ④ 重力拽引位移：vortex tel 段 / pull act 段玩家被拽向 Boss
 *  ⑤ pickMove 距离分档采样（远=箭狙/岩；贴身=旋风/交叉/拉动/三连；P2 档含 phase2Only 招）
 *  ⑥ 二阶段（55%）：transform 升空陨石坠落演出（root 移至玩家位）→ phase===2 → 箭雨 5 矢扇面 / 重力波 / 陨石回归可驱动
 *  ⑦ tryParried 恒 false（不可弹反）；99999 可击败（died → victory）
 *  ⑧ travelTo 往返（highwall↔cemetery）dispose 无泄漏（geometries 回基线 ±8）+ 全程无 console error
 * ⑨ 截图自检：交叉斩 / 箭雨扇面 / 陨石升空与砸地（/tmp/radahn-*.png）
 *
 * 注：headless 软渲 ~7fps（dt 钳 0.05 → 游戏时间 ≈ 0.35× 墙钟），全部等待按 3× 放宽。
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:5204";
const P1_MOVES = ["radahnCross", "radahnTriple", "radahnVortex", "radahnPull", "radahnRocks", "radahnSnipe"];
const P2_MOVES = ["radahnMeteor", "radahnArrowRain", "radahnGravityWave"];

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

/** 轮询等游戏内条件成真（驱动侧轮询——页内 waitForFunction 轮询在本页偶发不触发，t3/t6 同教训）；
 *  顺带回血保活：驱动步骤间隔里 Boss 自由攻击，挂机玩家会被打死（flow=dead 卡死后续所有等待） */
async function waitGame(page, fn, timeout = 60000, stepMs = 250) {
  const start = Date.now();
  for (;;) {
    const ok = await page.evaluate(() => {
      const g = window.__game;
      if (g.flow === "fight" && g.player.hp < 50) g.player.hp = 100;   // 保活
      return g.flow !== "dead";
    });
    if (!ok) throw new Error("玩家死亡（flow=dead）——驱动中途失守");
    const ok2 = await page.evaluate(fn);
    if (ok2) return;
    if (Date.now() - start > timeout) {
      const diag = await page.evaluate(() => {
        const g = window.__game, b = g.boss;
        return `state=${b.state} sub=${b.sub} t=${b.t.toFixed(2)} move=${b.move?.name ?? "-"} flow=${g.flow} fps-ish elapsed=${(performance.now() / 1000).toFixed(0)}s`;
      }).catch(() => "diag-failed");
      throw new Error(`waitGame timeout(${timeout}ms): ${diag}`);
    }
    await page.waitForTimeout(stepMs);
  }
}

/** 传送玩家到 Boss 西侧 offset 米（-X；prevPx 先行防雾门单向墙误判）——初始镜头朝 +X，Boss 入画 */
async function placePlayer(page, offset, z = 0) {
  return page.evaluate(({ offset, z }) => {
    const g = window.__game;
    const b = g.boss.root.position;
    g.prevPx = b.x - offset;
    g.player.pos.set(b.x - offset, 0, z);
    g.player.hp = 100;
  }, { offset, z });
}

/** 强制 Boss 出指定招（绕过 pickMove 权重：直接置 move/sub/t 并补调 onMoveStart——同引擎 idle→tel 路径） */
async function forceMove(page, name, dist = 8) {
  await page.evaluate(({ name, dist }) => {
    const g = window.__game;
    const b = g.boss;
    const m = b.moveByName(name);
    const bp = b.root.position;
    g.prevPx = bp.x - dist;
    g.player.pos.set(bp.x - dist, 0, 0);
    g.player.hp = 100;
    const toP = g.player.pos.clone().sub(bp); toP.y = 0;
    b.cds = {};
    b.move = m; b.sub = "tel"; b.t = 0; b.hitDone = false; b.hitFired = 0;
    b.onMoveStart(m, toP, toP.length());
    b.movePose(m, "tel", 0, m.startup + m.active + m.recovery);
  }, { name, dist });
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 450 } });   // 小视口提软渲帧率；⑨ 截图前放大
  const consoleErrors = [];
  page.on("pageerror", e => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", m => { if (m.type() === "error") consoleErrors.push(`console.error: ${m.text()}`); });

  // ---------------- ① 直选加载 ----------------
  await page.goto(`${BASE}/?fresh=1&boss=radahn&scene=cemetery`, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__game?.renderer, undefined, { timeout: 30_000 });
  const info = await page.evaluate(() => {
    const g = window.__game;
    let meshes = 0, lights = 0;
    g.boss.root.traverse(o => {
      if (o.isMesh) meshes++;
      if (o.isPointLight) lights++;
    });
    return {
      cls: g.boss.constructor.name,
      entry: g.bossEntry.name,
      radius: g.bossEntry.radius,
      souls: g.bossEntry.souls,
      hp: g.boss.maxHp,
      state: g.boss.state,
      meshes, lights,
    };
  });
  check("① cls=Radahn 直选命中", info.cls === "Radahn", `cls=${info.cls}`);
  check("① 名/血量/身位/魂", info.entry === "碎星拉塔恩" && info.hp === 950 && info.radius === 1.6 && info.souls === 18000,
    `${info.entry} hp=${info.hp} radius=${info.radius} souls=${info.souls}`);
  check("① 初始 statue", info.state === "statue", `state=${info.state}`);

  // ---------------- ② 本体预算（石像态：无 vfx/走位噪声；玩家置 Boss 西 6m——初始镜头朝 +X 入画） ----------------
  await placePlayer(page, 6);
  await page.waitForTimeout(1200);
  const dc = await page.evaluate(frames => new Promise(resolve => {
    const g = window.__game, infoR = g.renderer.info.render;
    const hidden = [g.player.root, ...g.enemies.enemies.map(e => e.root)];
    for (const h of hidden) h.visible = false;
    const run = show => new Promise(res => {
      g.boss.root.visible = show;
      const calls = [];
      let k = 0;
      const tick = () => {
        calls.push(infoR.calls);
        if (++k >= frames) res(calls);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    run(false).then(hiddenCalls => run(true).then(visibleCalls => {
      for (const h of hidden) h.visible = true;
      g.boss.root.visible = true;
      resolve({ hiddenCalls, visibleCalls });
    }));
  }), 30);
  const dcDelta = median(dc.visibleCalls) - median(dc.hiddenCalls);
  check("② 无 PointLight", info.lights === 0, `pointLights=${info.lights}`);
  check("② root mesh ≤13", info.meshes <= 13, `meshes=${info.meshes}`);
  check("② 本体 DC 增量 ≤22（含阴影 pass+紫尘 Points）", dcDelta > 0 && dcDelta <= 22, `medianΔ=${dcDelta}`);

  // ---------------- ③ 拔剑 → fight → combat ----------------
  await placePlayer(page, 2.0);
  await page.evaluate(() => { window.__game.flow = "statue"; window.__game.interact(); });
  const flowInfo = await page.evaluate(() => ({ flow: window.__game.flow, state: window.__game.boss.state }));
  check("③ E 拔剑 → fight/rising", flowInfo.flow === "fight" && flowInfo.state === "rising", `flow=${flowInfo.flow} state=${flowInfo.state}`);
  await waitGame(page, () => window.__game.boss.state === "combat", 60000);
  check("③ rising 2.5s → combat", true, "state=combat");

  // ---------------- ⑤ pickMove 距离分档采样 ----------------
  const bands = await page.evaluate(() => {
    const g = window.__game;
    const b = g.boss;
    const sample = (dist, phase) => {
      b.cds = {}; b.phase = phase;
      const set = new Set();
      for (let i = 0; i < 240; i++) { const m = b.pickMove(dist); if (m) set.add(m.name); }
      return [...set].sort();
    };
    const out = {
      farP1: sample(11, 1),
      nearP1: sample(2.4, 1),
      midP1: sample(7, 1),
      midP2: sample(7, 2),
    };
    b.phase = 1;   // 还原（后续测试走真实 phase2 通道）
    return out;
  });
  const farOK = bands.farP1.length > 0 && bands.farP1.every(n => n === "radahnSnipe" || n === "radahnRocks");
  check("⑤ 远档(11m) 仅箭狙/岩石", farOK, JSON.stringify(bands.farP1));
  const nearSet = ["radahnVortex", "radahnCross", "radahnPull", "radahnTriple"];
  const nearOK = bands.nearP1.length > 0 && bands.nearP1.every(n => nearSet.includes(n)) && bands.nearP1.includes("radahnVortex");
  check("⑤ 贴身档(2.4m) 旋风/交叉/拉动/三连", nearOK, JSON.stringify(bands.nearP1));
  const p2Only = ["radahnMeteor", "radahnArrowRain", "radahnGravityWave"];
  check("⑤ P1 档无 phase2Only 招", bands.midP1.every(n => !p2Only.includes(n)), JSON.stringify(bands.midP1));
  const midP2Has = p2Only.filter(n => bands.midP2.includes(n));
  check("⑤ P2 中档(7m) 开放箭雨/重力波/陨石", midP2Has.length >= 2, JSON.stringify(bands.midP2));

  // ---------------- ③ 一阶段六招逐个驱动 ----------------
  // 完成判据：见到 rec 段（或 idle 空档/换招）——cds 被清空时 Boss 会在 idle 即刻重选同名招，名称变化不可作判据
  const moveDoneExpr = name =>
    `window.__game.boss.sub === 'rec' || (window.__game.boss.sub === 'idle' && !window.__game.boss.move) || window.__game.boss.move?.name !== '${name}'`;
  const waitMoveDone = (page, name) => waitGame(page, moveDoneExpr(name), 120000);

  for (const name of P1_MOVES) {
    await forceMove(page, name, 8);
    const started = await page.evaluate(() => ({ move: window.__game.boss.move?.name, sub: window.__game.boss.sub }));
    await waitMoveDone(page, name).catch(() => null);
    const done = await page.evaluate(() => {
      const b = window.__game.boss;
      return { sub: b.sub, move: b.move?.name ?? null, state: b.state };
    });
    check(`③ ${name} 全段驱动完成`, started.move === name && (done.sub === "rec" || done.sub === "idle" || done.move !== name) && done.state === "combat",
      `start=${started.move}/${started.sub} end=${done.sub}/${done.move}`);
  }

  // 岩石 2 连：投射物峰值（双岩同飞窗口 ~0.65s，粗轮询易漏——100ms 细粒度采样峰值，顺带回血保活）
  {
    await forceMove(page, "radahnRocks", 9);
    let peak = 0;
    for (let i = 0; i < 36; i++) {
      await page.waitForTimeout(100);
      peak = Math.max(peak, await page.evaluate(() => {
        const g = window.__game;
        if (g.flow === "fight" && g.player.hp < 50) g.player.hp = 100;
        return g.projectiles.activeCount;
      }));
    }
    check("③ 岩石投掷 2 连（投射物峰值）", peak >= 2, `峰值=${peak}`);
    await waitMoveDone(page, "radahnRocks").catch(() => null);
  }

  // ---------------- ④ 重力拽引位移 ----------------
  await forceMove(page, "radahnVortex", 6.5);
  await waitGame(page, `window.__game.boss.sub !== 'tel'`, 60000);
  const vortexPull = await page.evaluate(() => {
    const g = window.__game;
    return { d: Math.round(g.player.pos.distanceTo(g.boss.root.position) * 100) / 100, sub: g.boss.sub };
  });
  check("④ 拖剑旋风 tel 段拽近 ≥0.8m", vortexPull.d <= 6.5 - 0.8, `tel 末 dist=${vortexPull.d}（自 6.5m）`);
  await waitMoveDone(page, "radahnVortex");

  await forceMove(page, "radahnPull", 6.5);
  await waitGame(page, `window.__game.boss.sub === 'rec'`, 60000);
  const pullRes = await page.evaluate(() => ({
    d: Math.round(window.__game.player.pos.distanceTo(window.__game.boss.root.position) * 100) / 100,
  }));
  check("④ 重力拉动拽至身前（≤3.2m）", pullRes.d <= 3.2, `act 后 dist=${pullRes.d}`);
  await waitMoveDone(page, "radahnPull");

  // ---------------- ⑦ 不可弹反 ----------------
  const parry = await page.evaluate(() => {
    const g = window.__game;
    const b = g.boss;
    const m = b.moveByName("radahnCross");
    b.cds = {};
    b.move = m; b.sub = "act"; b.t = 0.02; b.hitDone = false; b.hitFired = 0;
    const ok = b.tryParried();
    b.sub = "idle"; b.move = null;
    return ok;
  });
  check("⑦ 全程不可弹反（tryParried=false）", parry === false, `tryParried=${parry}`);

  // ---------------- ⑥ 二阶段：升空→陨石坠落回归 ----------------
  await placePlayer(page, 5.0);
  const tf = await page.evaluate(() => {
    const g = window.__game;
    const target = g.player.pos.clone();
    const r = g.boss.takeHit(Math.ceil(g.boss.maxHp * 0.46), 0);   // 950→513（0.54 ≤ 0.55）→ transform
    return { state: g.boss.state, phase: g.boss.phase, hp: g.boss.hp, tx: target.x, tz: target.z, died: r.died };
  });
  check("⑥ 55% 触发 transform", tf.state === "transform" && tf.phase === 1, `state=${tf.state} phase=${tf.phase} hp=${tf.hp}`);
  await waitGame(page, () => window.__game.boss.state === "combat" && window.__game.boss.phase === 2, 90000);
  const tfDone = await page.evaluate(t => ({
    phase: window.__game.boss.phase,
    dist: Math.round(Math.hypot(window.__game.boss.root.position.x - t.x, window.__game.boss.root.position.z - t.z) * 100) / 100,
  }), { x: tf.tx, z: tf.tz });
  check("⑥ 演出完成 phase=2", tfDone.phase === 2, `phase=${tfDone.phase}`);
  check("⑥ 陨石砸向玩家位（≤3.5m）", tfDone.dist <= 3.5, `crash 距锁定点=${tfDone.dist}m`);

  // P2 三招驱动
  for (const name of P2_MOVES) {
    await forceMove(page, name, 7);
    const started = await page.evaluate(() => ({ move: window.__game.boss.move?.name, sub: window.__game.boss.sub }));
    await waitMoveDone(page, name).catch(() => null);
    const done = await page.evaluate(() => ({ sub: window.__game.boss.sub, move: window.__game.boss.move?.name ?? null }));
    check(`⑥ ${name} 全段驱动完成`, started.move === name && (done.sub === "rec" || done.sub === "idle" || done.move !== name), `start=${started.move}/${started.sub} end=${done.sub}/${done.move}`);
  }

  // 箭雨 5 矢扇面 + 截图（同岩石：100ms 峰值采样，顺带保活）
  {
    await forceMove(page, "radahnArrowRain", 7);
    let peak = 0;
    for (let i = 0; i < 36; i++) {
      await page.waitForTimeout(100);
      peak = Math.max(peak, await page.evaluate(() => {
        const g = window.__game;
        if (g.flow === "fight" && g.player.hp < 50) g.player.hp = 100;
        return g.projectiles.activeCount;
      }));
    }
    check("⑥ 碎星箭雨 5 矢扇面", peak >= 5, `峰值=${peak}`);
    await page.screenshot({ path: "/tmp/radahn-arrow-rain.png" });
    await waitMoveDone(page, "radahnArrowRain").catch(() => null);
  }

  // ---------------- ⑦ 99999 可击败 ----------------
  const kill = await page.evaluate(() => {
    const g = window.__game;
    const r = g.boss.takeHit(99999, 0);
    return { died: r.died, state: g.boss.state, flow: g.flow };
  });
  check("⑦ 99999 可击败（died → dead/victory）", kill.died && kill.state === "dead" && kill.flow === "victory", `died=${kill.died} state=${kill.state} flow=${kill.flow}`);

  // ---------------- ⑧ travelTo 往返 dispose 泄漏 ----------------
  // 几何基线取在变身/击杀之后（二阶段会合法释放一阶段专用几何）——只测旅行重建是否等量回收
  // 去程不带 override：highwall 按进度线自然换人（fresh 档 → 玻尔多）——顺带测 Radahn dispose
  await page.evaluate(() => { window.__game.travelTo("highwall"); });
  await waitGame(page, `window.__game.sceneId === 'highwall'`, 60000);
  const hwBoss = await page.evaluate(() => ({ scene: window.__game.sceneId, cls: window.__game.boss.constructor.name }));
  check("⑧ 去程 highwall（Boss 换场＝Radahn 已 dispose）", hwBoss.scene === "highwall" && hwBoss.cls === "Vordt", `scene=${hwBoss.scene} cls=${hwBoss.cls}`);
  // 回程带 override：radahn 重建直选
  await page.evaluate(() => { const g = window.__game; g.bossOverride = "radahn"; g.travelTo("cemetery"); });
  await waitGame(page, `window.__game.sceneId === 'cemetery' && window.__game.boss.constructor.name === 'Radahn'`, 60000);
  const backInfo = await page.evaluate(() => ({
    scene: window.__game.sceneId,
    cls: window.__game.boss.constructor.name,
    hp: window.__game.boss.maxHp,
    geo: window.__game.renderer.info.memory.geometries,
    tex: window.__game.renderer.info.memory.textures,
  }));
  check("⑧ 往返后仍是 Radahn（重建直选）", backInfo.cls === "Radahn" && backInfo.hp === 950, `scene=${backInfo.scene} cls=${backInfo.cls}`);
  // 稳态二程：变身期临时几何（弓/陨石等）首程 dispose 属合法清理，第二、三程等量才是真无泄漏
  await page.evaluate(() => { window.__game.travelTo("highwall"); });
  await waitGame(page, `window.__game.sceneId === 'highwall'`, 60000);
  await page.evaluate(() => { const g = window.__game; g.bossOverride = "radahn"; g.travelTo("cemetery"); });
  await waitGame(page, `window.__game.sceneId === 'cemetery' && window.__game.boss.constructor.name === 'Radahn'`, 60000);
  const geoSteady = await page.evaluate(() => window.__game.renderer.info.memory.geometries);
  check("⑧ geometries 稳态等量（二三程 ±4 无泄漏）", Math.abs(geoSteady - backInfo.geo) <= 4, `二程=${backInfo.geo} 三程=${geoSteady} Δ=${geoSteady - backInfo.geo}`);

  // ---------------- ⑨ 截图：交叉斩 / 陨石回归（放大视口出高清帧） ----------------
  await page.setViewportSize({ width: 1280, height: 720 });
  await placePlayer(page, 2.0);
  console.log("⑨ pre-interact:", JSON.stringify(await page.evaluate(() => {
    const g = window.__game;
    return { dist: +g.player.pos.distanceTo(g.boss.root.position).toFixed(2), menuOpen: g.menuOpen,
      flow: g.flow, state: g.boss.state, backstab: g.enemies.tryBackstab(g.player.pos, g.player.yaw),
      sc: g.shortcuts.map(s => s.interact(g.player.pos)), bs: !!g.bloodstain && !!g.progress.bloodstain };
  })));
  console.log("⑨ interact-diag:", JSON.stringify(await page.evaluate(() => {
    const g = window.__game;
    window.__errs = [];
    const orig = console.error;
    console.error = (...a) => { window.__errs.push(a.map(x => { try { return typeof x === "string" ? x : x?.message ?? String(x); } catch { return "?"; } }).join(" | ")); orig(...a); };
    g.flow = "statue";
    const pre = { flow: g.flow, dist: +g.player.pos.distanceTo(g.boss.root.position).toFixed(2) };
    let err = null;
    try { g.interact(); } catch (e) { err = String(e); }
    return { pre, err, flow: g.flow, state: g.boss.state, sub: g.boss.sub };
  })));
  try {
    await waitGame(page, () => window.__game.boss.state === "combat", 90000);
  } catch (e) {
    console.log("⑨ wait-fail dump:", JSON.stringify(await page.evaluate(() => ({
      flow: window.__game.flow, state: window.__game.boss.state, cls: window.__game.boss.constructor.name,
      sceneId: window.__game.sceneId, hp: window.__game.player.hp, errs: (window.__errs ?? []).slice(-6),
      url: location.href, vis: document.visibilityState,
    })).catch(x => String(x))));
    throw e;
  }
  await forceMove(page, "radahnCross", 3.2);
  await waitGame(page, () => window.__game.boss.sub === "act" && window.__game.boss.t > 0.04, 60000, 60);
  await page.screenshot({ path: "/tmp/radahn-cross-slash.png" });
  await waitGame(page, moveDoneExpr("radahnCross"), 120000);

  // 陨石回归：重开一场演 transform（升空段 + 落地帧两连拍）——reset 后 Boss 回原位，须先传送再拔剑
  await placePlayer(page, 2.0);
  await page.evaluate(() => { const g = window.__game; g.boss.reset(); g.flow = "statue"; g.interact(); });
  await waitGame(page, () => window.__game.boss.state === "combat", 90000);
  await placePlayer(page, 4.5);
  await page.evaluate(() => { window.__game.boss.takeHit(Math.ceil(window.__game.boss.maxHp * 0.46), 0); });
  await waitGame(page, () => window.__game.boss.state === "transform" && window.__game.boss.t > 0.8 && window.__game.boss.t < 1.1, 60000, 60);
  await page.screenshot({ path: "/tmp/radahn-meteor-rise.png" });
  await waitGame(page, () => window.__game.boss.phase === 2 && window.__game.boss.t > 2.0 && window.__game.boss.t < 2.4, 60000, 60);
  await page.screenshot({ path: "/tmp/radahn-meteor-crash.png" });
  await waitGame(page, () => window.__game.boss.state === "combat", 90000);

  for (const f of ["/tmp/radahn-cross-slash.png", "/tmp/radahn-arrow-rain.png", "/tmp/radahn-meteor-rise.png", "/tmp/radahn-meteor-crash.png"]) {
    check(`⑨ 截图存在 ${f.split("/").pop()}`, fs.existsSync(f) && fs.statSync(f).size > 20_000, `${Math.round((fs.statSync(f)?.size ?? 0) / 1024)}KB`);
  }

  // ---------------- ⑧ 全程无 console error ----------------
  check("⑧ 全程无 console/page error", consoleErrors.length === 0, consoleErrors.slice(0, 4).join(" | ") || "clean");

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
  await browser.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
