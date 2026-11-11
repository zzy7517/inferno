/**
 * T6 捷径系统验收探针（node 脚本直驱 chromium，非 playwright test；结构同 t3-probe.mjs）
 *
 * 断言（任务契约）：
 *  ① 新档三场景捷径均 locked；靠近 #prompt 显示「捷径尚未开启」；E 交互给出提示且不落位
 *  ② 注入 defeated=["gundyr"] 旧档（无 shortcuts 字段）→ migrate 补开 cemetery:a3-a1；
 *     墓地电梯 open；E 乘坐后 player 落在 A1 篝火 ±3m（1s 后仍稳定——雾门单向墙 prevPx 回归）
 *  ③ 监视者胜（注入进度）→ highwall:d-b 开；乘坐落位 B 走廊东端 (-6,0)
 *  ④ 玛尔基特胜（注入进度）→ stormveil:e4-e1 开；乘坐落位 E1 篝火 (-36.6,0) ±3m
 *  ⑤ travelTo 往返后捷径状态保持（progress 持久化到 localStorage）
 *  ⑥ 捷径乘坐无 console error / pageerror；场景本体 DC ≤45+3（t3 口径：隐藏角色/小怪）
 */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:5199";

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

/** 注入旧档并进指定场景（?scene= 调试参数优先于解锁表；不带 fresh 免清档）。
 *  先 goto 一次落到同源页面再写 localStorage（about:blank 上访问 localStorage 会被拒），重载后生效 */
async function loadWithProgress(page, progress, scene) {
  const url = `${BASE}/?scene=${scene}`;
  await page.goto(url, { waitUntil: "load" });
  await page.evaluate(p => {
    localStorage.setItem("inferno.progress.v1", JSON.stringify(p));
  }, progress);
  await page.goto(url, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__game?.renderer, undefined, { timeout: 30_000 });
}

/** 传送玩家到捷径旁（prevPx 先行，防雾门单向墙误判——t3-probe 同法） */
async function standNearShortcut(page, offset = 1.0) {
  return page.evaluate(off => {
    const g = window.__game;
    const s = g.shortcuts[0];
    g.prevPx = s.def.pos.x;
    g.player.pos.set(s.def.pos.x + off, 0, s.def.pos.z);
    return { id: s.def.id, open: s.isOpen, pos: [s.def.pos.x, s.def.pos.z], dest: [s.def.dest.x, s.def.dest.z] };
  }, offset);
}

/** E 乘坐并等黑场落位（340ms 渐隐 + 余量），再等 1s 验位置稳定 */
async function ride(page) {
  return page.evaluate(() => new Promise(resolve => {
    const g = window.__game;
    g.interact();
    setTimeout(() => {
      const landed = { x: g.player.pos.x, z: g.player.pos.z };
      setTimeout(() => resolve({ landed, stable: { x: g.player.pos.x, z: g.player.pos.z } }), 1000);
    }, 700);
  }));
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleErrors = [];
  page.on("pageerror", e => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("console", m => { if (m.type() === "error") consoleErrors.push(`console.error: ${m.text()}`); });

  // ---------------- ① 新档三场景 locked ----------------
  // 高墙 D / 城垣 E4 区与对应捷径同 Boss 解锁——实战里「能站到电梯旁时必然已开门」，
  // locked 态可达性靠注入 zoneUnlocks 模拟（不击败 Boss，shortcuts 保持空）
  for (const scene of ["cemetery", "highwall", "stormveil"]) {
    const extraZones = scene === "highwall" ? ["highwall:D"] : scene === "stormveil" ? ["stormveil:E4"] : [];
    await loadWithProgress(page, { defeated: [], zoneUnlocks: ["cemetery:A", "highwall:B", ...extraZones] }, scene);
    const info = await standNearShortcut(page);
    // 采样 prompt（直接 rAF 轮询 DOM——updateHud 每帧刷新；waitForFunction 的 raf 轮询在此页面偶发不触发）
    const promptText = await page.evaluate(() => new Promise(res => {
      let n = 0;
      const tick = () => {
        const t = document.getElementById("prompt").textContent;
        if (t || ++n > 240) res(t);
        else requestAnimationFrame(tick);
      };
      tick();
    }));
    const msg = await page.evaluate(() => {
      const g = window.__game;
      const before = { x: g.player.pos.x, z: g.player.pos.z };
      g.interact();
      return { text: document.getElementById("msg").textContent, after: { x: g.player.pos.x, z: g.player.pos.z }, before };
    });
    const ids = { cemetery: "cemetery:a3-a1", highwall: "highwall:d-b", stormveil: "stormveil:e4-e1" };
    const stayed = Math.hypot(msg.after.x - msg.before.x, msg.after.z - msg.before.z) < 0.01;
    check(`① ${scene} 新档捷径 locked`, info.id === ids[scene] && info.open === false,
      `id=${info.id} open=${info.open}`);
    check(`① ${scene} 靠近提示「捷径尚未开启」`, (promptText ?? "").includes("尚未开启"), `prompt="${promptText}"`);
    check(`① ${scene} E 交互提示且不落位`, (msg.text ?? "").includes("尚未开启") && stayed, `msg="${msg.text}" 原地=${stayed}`);
  }

  // 场景本体 DC（墓地 intro、locked 锁链可见=最重状态；t3 口径）
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
  const dc = median(render.calls);
  check("⑥ 场景本体 DC ≤48（45+捷径 3）", dc <= 48, `median=${dc} max=${Math.max(...render.calls)}`);

  // ---------------- ② 古达旧档迁移 + 墓地乘坐 ----------------
  await loadWithProgress(page, { defeated: ["gundyr"] }, "cemetery");
  const migrated = await page.evaluate(() => ({
    shortcuts: window.__game.progress.shortcuts,
    zoneUnlocks: window.__game.progress.zoneUnlocks,
  }));
  check("② 旧档(defeated=gundyr,无 shortcuts 字段) migrate 补开", migrated.shortcuts.includes("cemetery:a3-a1"),
    `shortcuts=${JSON.stringify(migrated.shortcuts)}`);
  const gundyrSc = await standNearShortcut(page);
  check("② 墓地电梯实例 open", gundyrSc.open === true, `id=${gundyrSc.id} open=${gundyrSc.open}`);
  const ride1 = await ride(page);
  const distA1 = Math.hypot(ride1.landed.x - (-140.5), ride1.landed.z - 0);
  const stableDrift = Math.hypot(ride1.stable.x - ride1.landed.x, ride1.stable.z - ride1.landed.z);
  check("② E 乘坐落在 A1 篝火 ±3m", distA1 <= 3, `落位=(${ride1.landed.x.toFixed(2)},${ride1.landed.z.toFixed(2)}) 距篝火=${distA1.toFixed(2)}m`);
  check("② 落位 1s 后仍稳定（雾门 prevPx 单向墙回归）", stableDrift < 0.05 && ride1.stable.x < -100,
    `drift=${stableDrift.toFixed(3)}m x=${ride1.stable.x.toFixed(2)}`);

  // ---------------- ⑤ travelTo 往返状态保持（progress 持久化） ----------------
  const persist = await page.evaluate(() => new Promise(resolve => {
    const g = window.__game;
    g.travelTo("highwall");
    setTimeout(() => {
      const mid = { sceneId: g.sceneId, id: g.shortcuts[0]?.def.id, open: g.shortcuts[0]?.isOpen };
      g.travelTo("cemetery");
      setTimeout(() => {
        // 存档落盘：旅行本身不写档（沿既有语义：仅存档事件触发 saveState），这里显式落盘后再读
        g.saveState();
        resolve({
          mid,
          back: { sceneId: g.sceneId, id: g.shortcuts[0]?.def.id, open: g.shortcuts[0]?.isOpen },
          saved: JSON.parse(localStorage.getItem("inferno.progress.v1")).shortcuts,
        });
      }, 1200);
    }, 1200);
  }));
  check("⑤ 往返高墙后回墓地，捷径仍 open（实例态）", persist.back.sceneId === "cemetery" && persist.back.open === true,
    `back=${JSON.stringify(persist.back)}`);
  check("⑤ saveState 后 localStorage.shortcuts 落盘", (persist.saved ?? []).includes("cemetery:a3-a1"), `saved=${JSON.stringify(persist.saved)}`);
  // 冷重载：从原始旧档再次 migrate → 捷径补开且实例开门（持久化闭环）
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => !!window.__game?.renderer, undefined, { timeout: 30_000 });
  const cold = await page.evaluate(() => ({
    sc: window.__game.progress.shortcuts,
    open: window.__game.shortcuts[0]?.isOpen,
  }));
  check("⑤ 冷重载 migrate 再次补开 + 实例 open", cold.sc.includes("cemetery:a3-a1") && cold.open === true,
    `progress.shortcuts=${JSON.stringify(cold.sc)} open=${cold.open}`);

  // ---------------- ③ 监视者胜 → highwall:d-b ----------------
  await loadWithProgress(page, { defeated: ["gundyr", "vordt", "margit", "godrick", "watchers"] }, "highwall");
  const hw = await page.evaluate(() => ({
    shortcuts: window.__game.progress.shortcuts,
    zones: window.__game.progress.zoneUnlocks,
  }));
  check("③ 监视者胜 → shortcuts 含 highwall:d-b", hw.shortcuts.includes("highwall:d-b"), `shortcuts=${JSON.stringify(hw.shortcuts)}`);
  check("③ 监视者胜 → D 区解锁（电梯可达性前提）", hw.zones.includes("highwall:D"), `zones 含 highwall:D=${hw.zones.includes("highwall:D")}`);
  const hwSc = await standNearShortcut(page);
  check("③ 高墙月坛电梯实例 open", hwSc.id === "highwall:d-b" && hwSc.open === true, `id=${hwSc.id} open=${hwSc.open}`);
  const ride2 = await ride(page);
  const atB = ride2.landed.x >= -9 && ride2.landed.x <= -3 && Math.abs(ride2.landed.z) <= 2.4;
  const stable2 = Math.hypot(ride2.stable.x - ride2.landed.x, ride2.stable.z - ride2.landed.z);
  check("③ E 乘坐落位 B 走廊东端 (-6,0)±3", atB, `落位=(${ride2.landed.x.toFixed(2)},${ride2.landed.z.toFixed(2)})`);
  check("③ 落位稳定（雾门西侧不被拽回）", stable2 < 0.05, `drift=${stable2.toFixed(3)}m`);

  // ---------------- ④ 玛尔基特胜 → stormveil:e4-e1 ----------------
  await loadWithProgress(page, { defeated: ["gundyr", "vordt", "margit"] }, "stormveil");
  const sv = await page.evaluate(() => ({
    shortcuts: window.__game.progress.shortcuts,
    zones: window.__game.progress.zoneUnlocks,
  }));
  check("④ 玛尔基特胜 → shortcuts 含 stormveil:e4-e1", sv.shortcuts.includes("stormveil:e4-e1"), `shortcuts=${JSON.stringify(sv.shortcuts)}`);
  check("④ 玛尔基特胜 → E4 区解锁", sv.zones.includes("stormveil:E4"), `zones 含 stormveil:E4=${sv.zones.includes("stormveil:E4")}`);
  const svSc = await standNearShortcut(page);
  check("④ 城垣教堂电梯实例 open", svSc.id === "stormveil:e4-e1" && svSc.open === true, `id=${svSc.id} open=${svSc.open}`);
  const ride3 = await ride(page);
  const distE1 = Math.hypot(ride3.landed.x - (-36.6), ride3.landed.z - 0);
  check("④ E 乘坐落在 E1 篝火 ±3m", distE1 <= 3, `落位=(${ride3.landed.x.toFixed(2)},${ride3.landed.z.toFixed(2)}) 距篝火=${distE1.toFixed(2)}m`);

  // ---------------- ⑥ 全程无 console error ----------------
  await page.waitForTimeout(600);
  check("⑥ 无页面错误/console.error", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | ") || "clean");

  await browser.close();
  console.log(failures === 0 ? "\nALL PROBES PASSED" : `\n${failures} PROBE(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
