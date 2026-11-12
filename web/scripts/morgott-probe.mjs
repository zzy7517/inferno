/**
 * Boss #7「恶兆王蒙格特」验收探针（node 直驱 chromium，结构同 t6-probe.mjs）
 *
 * 断言（任务契约）：
 *  ① ?fresh=1&boss=morgott 直选：cls=Morgott / hp 880 / statue；本体 mesh 数 ≤20（dc 预算）且无 PointLight
 *  ② flow=statue + 传送近身 + E 交互触发 pull → rising → combat
 *  ③ 一阶段五类招各至少触发一次（cds 封锁其余 + 站位引导强制选招）：王杖三连/横扫尾刀/下砸地板波/投掷魅影匕首/跳跃扑杀
 *  ④ takeHit 降至 60% 阈值 → transform 演出 → phase===2（杖隐剑出由 phase 驱动 updateSummons 恒等式）
 *  ⑤ 二阶段四招各至少触发一次：咒剑大剑三连/诅咒喷吐/血焰突斩/王者之证
 *  ⑥ 99999 一击可击败（died）
 *  ⑦ travelTo 往返（stormveil→cemetery→stormveil）后无泄漏：几何数不增爆 / Boss 复生 Morgott/statue
 *  ⑧ 全程无 console error / pageerror；出 3 张验收截图到 /tmp/morgott-shots
 *
 * 时序纪律：本机 headless 为软件光栅（0.7-1.2s/帧，墙钟严重失真）——全部等待走 rAF 帧轮询 + 宽裕预算，
 * 截图帧补放真实 Vfx FX（slash/ring 粒子寿命 0.14-0.4s 短于帧长，捕获帧重放一次保证画面可见）。
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:5203";
const SHOTS = "/tmp/morgott-shots";
const ALL = ["morgottCombo", "morgottTail", "morgottSlam", "morgottDaggers", "morgottPounce",
  "morgottGreatsword", "morgottCurseSpew", "morgottBloodChase", "morgottKingsProof"];
const URL = `${BASE}/?fresh=1&boss=morgott&scene=stormveil`;
const GOLD = 0xd8b36a, BLOOD = 0x9b3b32;

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  if (!ok) failures++;
};

async function loadGame(page, url = URL) {
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__game?.renderer, undefined, { timeout: 60_000 });
}

/** 等待 boss 满足条件（rAF 帧轮询；软件光栅+CPU 争抢下帧长可达数秒——预算给足） */
async function waitBoss(page, condSrc, timeoutMs = 60_000) {
  return page.evaluate(([condSrc, timeoutMs]) => new Promise(resolve => {
    const cond = eval(condSrc);
    const g = window.__game;
    const t0 = performance.now();
    const tick = () => {
      const b = g.boss;
      let ok = false;
      try { ok = cond(b, g); } catch { ok = false; }
      if (ok) return resolve(true);
      if (performance.now() - t0 > timeoutMs) return resolve(false);
      requestAnimationFrame(tick);
    };
    tick();
  }), [condSrc, timeoutMs]);
}

/** 等待场景切换完成（travelTo 的 340ms 黑场 setTimeout 在慢帧下拖长——按 sceneId 轮询） */
async function waitScene(page, target, timeoutMs = 60_000) {
  return page.evaluate(([target, timeoutMs]) => new Promise(resolve => {
    const g = window.__game;
    const t0 = performance.now();
    const tick = () => {
      if (g.sceneId === target) return resolve(true);
      if (performance.now() - t0 > timeoutMs) return resolve(false);
      setTimeout(tick, 150);
    };
    tick();
  }), [target, timeoutMs]);
}

/** 传送玩家（prevPx 先行，防雾门单向墙拽回——t6-probe 同法） */
async function teleportFront(page, dist) {
  await page.evaluate(dist => {
    const g = window.__game, b = g.boss;
    const x = b.root.position.x + Math.sin(b.yaw) * dist, z = b.root.position.z + Math.cos(b.yaw) * dist;
    g.prevPx = x; g.player.pos.set(x, 0, z); g.player.hp = 100;
  }, dist);
}

/** 强制选招：cds 封锁其余 8 招 + 玩家站位到目标距离带（behind=true 则每帧绕背），
 *  tel 一观察到立刻把玩家传远（躲开判定段，防探针角色被打死中断战斗流），
 *  再等到招式整段结束回 idle。 */
async function forceMove(page, name, dist, behind = false) {
  const seen = await page.evaluate(([name, dist, behind, all]) => new Promise(resolve => {
    const g = window.__game, b = g.boss;
    const cds = {};
    for (const k of all) cds[k] = k === name ? 0 : 999;
    b.cds = cds;
    const place = d => {
      const x = b.root.position.x + Math.sin(b.yaw) * d * (behind ? -1 : 1);
      const z = b.root.position.z + Math.cos(b.yaw) * d * (behind ? -1 : 1);
      g.prevPx = x; g.player.pos.set(x, 0, z); g.player.hp = 100;
    };
    place(dist);
    const t0 = performance.now();
    const tick = () => {
      if (b.state === "combat" && b.move?.name === name && b.sub === "tel") {
        // 锁招成功：传远躲判定（位移类招的落点已按原站位预计算）
        const fx = b.root.position.x + Math.sin(b.yaw) * 16, fz = b.root.position.z + Math.cos(b.yaw) * 16;
        g.prevPx = fx; g.player.pos.set(fx, 0, fz); g.player.hp = 100;
        return resolve(true);
      }
      if (performance.now() - t0 > 120_000) return resolve(false);
      if (behind) place(dist);          // 绕背：持续保持在背面（boss 转身追人）
      else if (b.state === "combat" && !b.move) place(dist);
      requestAnimationFrame(tick);
    };
    tick();
  }), [name, dist, behind, ALL]);
  if (!seen) return false;
  return waitBoss(page, "(b, g) => g.boss.state !== 'combat' || (!g.boss.move && g.boss.sub === 'idle')", 40_000);
}

/** 战斗态截图：等到条件帧 → 补放真实 Vfx FX（捕获帧重放，防 0.14-0.4s 短命 FX 被慢帧吞掉）→ 拍屏 */
async function shotAt(page, condSrc, path, refire, timeoutMs = 40_000) {
  const ok = await waitBoss(page, condSrc, timeoutMs);
  if (!ok) return false;
  await page.evaluate(refire => {
    const g = window.__game, b = g.boss, v = g.vfx;
    const chest = b.chestWorld();
    for (const r of refire) {
      if (r.k === "ring") v.ring(b.root.position.clone(), r.a, r.c);
      if (r.k === "slash") v.slash(chest.clone(), b.yaw + (r.off ?? 0), r.a, r.wide, r.c);
      if (r.k === "gold") b.gold.burst(chest.clone().setY(r.y ?? 1.2), r.a, 5, 1.2, 0.6);
      if (r.k === "blood") b.blood.burst(chest.clone().setY(r.y ?? 1.1), r.a, 4, 1.0, 0.5);
    }
  }, refire);
  await page.screenshot({ path });
  return true;
}

/** 截图专用的强制选招（不传远、不等结束——保持演出中帧可拍） */
async function armMove(page, name, dist) {
  await page.evaluate(([name, dist, all]) => {
    const g = window.__game, b = g.boss;
    const cds = {};
    for (const k of all) cds[k] = k === name ? 0 : 999;
    b.cds = cds;
    const x = b.root.position.x + Math.sin(b.yaw) * dist, z = b.root.position.z + Math.cos(b.yaw) * dist;
    g.prevPx = x; g.player.pos.set(x, 0, z); g.player.hp = 100;
  }, [name, dist, ALL]);
}

/** 开战：flow=statue + 传送近身 + E 交互（pull 判定在 interact()——game.ts L560），等到 combat */
async function engage(page) {
  await page.evaluate(() => {
    const g = window.__game, b = g.boss;
    g.flow = "statue";                       // intro 需跨雾门才进 statue——探针直设（运行时私有字段）
    const x = b.root.position.x + Math.sin(b.yaw) * 2.2, z = b.root.position.z + Math.cos(b.yaw) * 2.2;
    g.prevPx = x; g.player.pos.set(x, 0, z);
    g.interact();                            // E「拔出螺旋剑」
  });
  return waitBoss(page, "(b) => b.state === 'combat'", 90_000);
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const consoleErrors = [];
  const newPage = async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
    page.on("pageerror", e => consoleErrors.push(`pageerror: ${e.message}`));
    page.on("console", m => { if (m.type() === "error") consoleErrors.push(`console.error: ${m.text()}`); });
    page.on("crash", () => consoleErrors.push("page crashed"));
    return page;
  };
  // 页面分阶段隔离：长跑软件光栅下渲染进程偶发被杀——单阶段挂掉不吞掉整轮结果
  const stage = async (label, fn) => {
    const page = await newPage();
    try { await fn(page); }
    catch (e) { check(label, false, `阶段异常: ${String(e).split("\n")[0]}`); }
    finally { await page.close().catch(() => {}); }
  };

  // ---------------- 阶段 A：① 直选预算 + ② pull + ③ 一阶段五招 + 对峙截图 ----------------
  await stage("阶段A", async page => {
    await loadGame(page);
    const info = await page.evaluate(() => {
      const g = window.__game, b = g.boss;
      let meshes = 0, lights = 0;
      b.root.traverse(o => { if (o.isMesh) meshes++; if (o.isPointLight) lights++; });
      return { cls: b.constructor.name, name: g.bossEntry.name, hp: b.hp, state: b.state, meshes, lights };
    });
    check("① 直选 cls=Morgott / 名条=恶兆王蒙格特", info.cls === "Morgott" && info.name === "恶兆王蒙格特",
      `cls=${info.cls} name=${info.name}`);
    check("① hp=880 / statue", info.hp === 880 && info.state === "statue", `hp=${info.hp} state=${info.state}`);
    check("① 本体 mesh ≤20（dc 预算·纯几何+顶点色合并）", info.meshes <= 20, `meshes=${info.meshes}`);
    check("① 无 PointLight（emissive 呼吸）", info.lights === 0, `pointLights=${info.lights}`);

    const rose = await engage(page);
    check("② 近身 E 交互 pull → rising → combat", rose, `state=${await page.evaluate(() => window.__game.boss.state)}`);

    await teleportFront(page, 5);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOTS}/p1-standoff.png` });

    const p1Moves = [
      ["morgottCombo", 3.0, false], ["morgottTail", 2.0, true], ["morgottSlam", 3.0, false],
      ["morgottDaggers", 7.5, false], ["morgottPounce", 8.5, false],
    ];
    for (const [name, dist, behind] of p1Moves) {
      const ok = await forceMove(page, name, dist, behind);
      check(`③ 一阶段 ${name} 触发`, ok, `dist=${dist}${behind ? " 绕背" : ""}`);
    }
  });

  // ---------------- 阶段 B：④ 60%→phase2 + ⑤ 二阶段四招 + 两张截图 + ⑥ 击败 ----------------
  await stage("阶段B", async page => {
    await loadGame(page);
    const rose = await engage(page);
    check("④(前置) 开战", rose, `state=${await page.evaluate(() => window.__game.boss.state)}`);
    const tf = await page.evaluate(() => {
      const b = window.__game.boss;
      const r = b.takeHit(393, 0);            // 880-393=487 ≤ 528(60%)
      return { state: b.state, hp: b.hp };
    });
    check("④ takeHit 至 60% 阈值 → transform", tf.state === "transform", `state=${tf.state} hp=${tf.hp}`);
    const p2ok = await waitBoss(page, "(b) => b.state === 'combat'", 60_000);
    const swap = await page.evaluate(() => ({ phase: window.__game.boss.phase, state: window.__game.boss.state }));
    check("④ transform 演出结束回 combat 且 phase===2", p2ok && swap.phase === 2,
      `phase=${swap.phase} state=${swap.state}`);
    await page.waitForTimeout(600);

    const p2Moves = [
      ["morgottGreatsword", 3.5], ["morgottCurseSpew", 4.0],
      ["morgottBloodChase", 3.4], ["morgottKingsProof", 3.8],
    ];
    for (const [name, dist] of p2Moves) {
      const ok = await forceMove(page, name, dist, false);
      check(`⑤ 二阶段 ${name} 触发`, ok, `dist=${dist}`);
    }

    // 截图：魅影大剑连段帧（act 中段·王之剑显形）+ 王者之证金爆（act 帧·冲击环重放）
    await armMove(page, "morgottGreatsword", 4.5);
    const shotGs = await shotAt(page,
      "(b) => b.state === 'combat' && b.sub === 'act' && b.move?.name === 'morgottGreatsword' && b.t >= 0.5 && b.t <= 1.6",
      `${SHOTS}/p2-greatsword.png`,
      [{ k: "slash", a: 3.8, wide: true, c: GOLD, off: 0.15 }, { k: "slash", a: 3.1, wide: true, c: 0xcfc4a4, off: 0.45 }, { k: "gold", a: 12 }]);
    check("⑤ 截图·魅影大剑连段帧", shotGs, `${SHOTS}/p2-greatsword.png`);

    await armMove(page, "morgottKingsProof", 8.5);
    const shotKp = await shotAt(page,
      "(b) => b.state === 'combat' && b.sub === 'act' && b.move?.name === 'morgottKingsProof'",
      `${SHOTS}/p2-kingsproof.png`,
      [{ k: "ring", a: 7.0, c: GOLD }, { k: "ring", a: 5.2, c: BLOOD }, { k: "gold", a: 30, y: 1.4 }, { k: "blood", a: 14 }]);
    check("⑤ 截图·王者之证黄金冲击波", shotKp, `${SHOTS}/p2-kingsproof.png`);
    await waitBoss(page, "(b, g) => g.boss.state !== 'combat' || (!g.boss.move && g.boss.sub === 'idle')", 60_000);

    const kill = await page.evaluate(() => {
      const b = window.__game.boss;
      const r = b.takeHit(99999, 0);
      return { died: r.died, state: b.state };
    });
    check("⑥ 99999 可击败（died / dead）", kill.died && kill.state === "dead", `died=${kill.died} state=${kill.state}`);
  });

  // ---------------- 阶段 C：⑦ travelTo 往返无泄漏 ----------------
  await stage("阶段C", async page => {
    await loadGame(page);
    const before = await page.evaluate(() => ({
      geoms: window.__game.renderer.info.memory.geometries,
      cls: window.__game.boss.constructor.name,
    }));
    await page.evaluate(() => window.__game.travelTo("cemetery"));
    const wentC = await waitScene(page, "cemetery");
    await page.evaluate(() => { const g = window.__game; g.bossOverride = "morgott"; g.travelTo("stormveil"); });   // 直选复现需 override（无 override 按进度线回玛尔基特是正解）
    const wentS = await waitScene(page, "stormveil");
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => ({
      geoms: window.__game.renderer.info.memory.geometries,
      cls: window.__game.boss.constructor.name,
      state: window.__game.boss.state,
    }));
    await page.evaluate(() => window.__game.travelTo("cemetery"));
    await waitScene(page, "cemetery");
    await page.evaluate(() => { const g = window.__game; g.bossOverride = "morgott"; g.travelTo("stormveil"); });
    await waitScene(page, "stormveil");
    await page.waitForTimeout(1200);
    const steady = await page.evaluate(() => window.__game.renderer.info.memory.geometries);
    check("⑦ 往返落位（cemetery→stormveil）", wentC && wentS, `scene=${await page.evaluate(() => window.__game.sceneId)}`);
    check("⑦ 往返后 Boss 复生（Morgott/statue）", before.cls === "Morgott" && after.cls === "Morgott" && after.state === "statue",
      `before=${before.cls} after=${after.cls}/${after.state}`);
    check("⑦ 几何稳态等量（二/三程 ±6 无泄漏）", Math.abs(steady - after.geoms) <= 6,
      `二程=${after.geoms} 三程=${steady}`);
  });

  // ---------------- ⑧ 全程无 console error ----------------
  await browser.close();
  check("⑧ 无页面错误/console.error", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | ") || "clean");

  console.log(failures === 0 ? "\nALL PROBES PASSED" : `\n${failures} PROBE(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
