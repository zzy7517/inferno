// M4 整链路验收 v1.2：新档 → 8 Boss 顺序全通（古达→玻尔多→玛尔基特→葛瑞克→蒙格特→监视者→拉塔恩→沙力万）
import { chromium } from "/data/inferno/web/node_modules/playwright/index.mjs";
const r = []; const ok = (n, c, e = "") => r.push(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  " + e : ""}`);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on("pageerror", e => r.push(`PAGEERROR  ${e.message}`));

const BONFIRE = { cemetery: [-140.0, 0.4], highwall: [-275.5, 0.4], stormveil: [-36.1, 0.4] };
const TO_ID = { "墓地": "cemetery", "高墙": "highwall", "城垣": "stormveil" };
async function travelTo(scene) {
  scene.cur = await p.evaluate(() => window.__game.sceneId);
  if (TO_ID[scene.to] === scene.cur) return scene.cur;
  for (let i = 0; i < 60; i++) { const f = await p.evaluate(() => window.__game.flow); if (f === "intro") break; await p.waitForTimeout(150); }
  await p.waitForTimeout(400);
  await p.evaluate(([x, z]) => { const g = window.__game; g.player.pos.set(x, 0, z); }, BONFIRE[scene.cur]);
  let open = false;
  for (let a = 0; a < 3 && !open; a++) {
    await p.keyboard.press("e");
    for (let i = 0; i < 40 && !open; i++) { open = await p.evaluate(() => window.__game.menuOpen === true); if (!open) await p.waitForTimeout(100); }
    if (!open) await p.waitForTimeout(500);
  }
  if (!open) return `menu-not-open@${scene.cur}`;
  await p.waitForTimeout(200);
  for (let step = 0; step < 10; step++) {
    const sel = await p.evaluate(() => { const g = window.__game; return g.menuItems[g.menuIdx]?.label ?? ""; });
    if (sel.includes(scene.to)) break;
    await p.keyboard.press("ArrowDown");
    await p.waitForTimeout(120);
  }
  const sel = await p.evaluate(() => { const g = window.__game; return g.menuItems[g.menuIdx]?.label ?? ""; });
  if (!sel.includes(scene.to)) return `no-item(${sel})`;
  await p.keyboard.press("e");
  await p.waitForTimeout(2400);
  scene.cur = scene.to;
  return await p.evaluate(() => window.__game.sceneId);
}
async function killBoss(name) {
  const at = await p.evaluate(() => {
    const g = window.__game;
    g.enemies.clear();
    const boss = g.boss.root.position;
    g.player.pos.set(boss.x - 4, 0, boss.z);
    g.boss.pull();
    return { cls: g.boss.constructor.name, bx: +boss.x.toFixed(1) };
  });
  let state = "";
  for (let i = 0; i < 60; i++) { state = await p.evaluate(() => window.__game.boss.state); if (state === "combat") break; await p.waitForTimeout(150); }
  if (state !== "combat") return { err: `not-combat(${state})`, at };
  for (let r2 = 0; r2 < 3; r2++) {
    const died = await p.evaluate(() => window.__game.boss.takeHit(99999, 0).died);
    if (died) break;
    for (let i = 0; i < 80; i++) { state = await p.evaluate(() => window.__game.boss.state); if (state === "combat") break; await p.waitForTimeout(150); }
  }
  let d = 0;
  for (let i = 0; i < 30; i++) { d = await p.evaluate(() => window.__game.progress.defeated.length); if (d > 0) break; await p.waitForTimeout(200); }
  let flow = "";
  for (let a = 0; a < 3; a++) {
    flow = await p.evaluate(() => window.__game.flow);
    if (flow === "intro") break;
    await p.keyboard.press("r");
    await p.waitForTimeout(1200);
  }
  for (let i = 0; i < 60; i++) { flow = await p.evaluate(() => window.__game.flow); if (flow === "intro") break; await p.waitForTimeout(150); }
  return { at, state, flow, defeated: await p.evaluate(() => window.__game.progress.defeated) };
}

// ---------- 开局：墓地古达 ----------
await p.goto("http://localhost:5199/?fresh=1", { waitUntil: "networkidle" });
await p.waitForFunction(() => window.__game && window.__game.boss, null, { timeout: 15000 });
let st = await p.evaluate(() => ({ cls: window.__game.boss.constructor.name, id: window.__game.bossId }));
ok("开局 Boss=古达", st.id === "gundyr", JSON.stringify(st));
let k = await killBoss("gundyr");
ok("古达击败入档", k.defeated?.includes("gundyr"), JSON.stringify({ cls: k.at?.cls, bx: k.at?.bx }));

// ---------- 高墙：玻尔多 ----------
let cur = { cur: "cemetery", to: "高墙" };
let sc = await travelTo(cur);
st = await p.evaluate(() => ({ scene: window.__game.sceneId, id: window.__game.bossId, bx: +window.__game.boss.root.position.x.toFixed(1) }));
ok("旅行高墙+Boss=玻尔多@B房", sc === "highwall" && st.id === "vordt" && Math.abs(st.bx - 17.9) < 0.8, JSON.stringify({ sc, ...st }));
k = await killBoss("vordt");
ok("玻尔多击败(解锁城垣+E区)", k.defeated?.includes("vordt"), JSON.stringify(k.defeated));
st = await p.evaluate(() => ({ scenes: window.__game.progress.unlockedScenes, zones: window.__game.progress.zoneUnlocks }));
ok("城垣场景+E区解锁", st.scenes.includes("stormveil") && st.zones.includes("stormveil:E"), JSON.stringify(st.scenes));

// ---------- 城垣：玛尔基特 → 葛瑞克 → 蒙格特 ----------
cur = { cur: "highwall", to: "城垣" };
sc = await travelTo(cur);
st = await p.evaluate(() => ({ scene: window.__game.sceneId, id: window.__game.bossId, cls: window.__game.boss.constructor.name }));
ok("旅行城垣+Boss=玛尔基特", sc === "stormveil" && st.id === "margit" && st.cls === "Margit", JSON.stringify({ sc, ...st }));
k = await killBoss("margit");
ok("玛尔基特击败(解锁E4)", k.defeated?.includes("margit"), JSON.stringify(k.defeated));
cur = { cur: "stormveil", to: "墓地" };
sc = await travelTo(cur);
cur = { cur: "cemetery", to: "城垣" };
sc = await travelTo(cur);
st = await p.evaluate(() => ({ scene: window.__game.sceneId, id: window.__game.bossId, bx: +window.__game.boss.root.position.x.toFixed(1) }));
ok("再入城垣+Boss=葛瑞克@E5教堂", sc === "stormveil" && st.id === "godrick" && Math.abs(st.bx - 64.3) < 0.8, JSON.stringify({ sc, ...st }));
k = await killBoss("godrick");
ok("葛瑞克击败(解锁城垣F)", k.defeated?.includes("godrick"), JSON.stringify(k.defeated));
st = await p.evaluate(() => window.__game.progress.zoneUnlocks.includes("stormveil:F"));
ok("蒙格特王座厅(F区)解锁", st === true, `F=${st}`);
cur = { cur: "stormveil", to: "墓地" };
sc = await travelTo(cur);
cur = { cur: "cemetery", to: "城垣" };
sc = await travelTo(cur);
st = await p.evaluate(() => ({ scene: window.__game.sceneId, id: window.__game.bossId, cls: window.__game.boss.constructor.name, bx: +window.__game.boss.root.position.x.toFixed(1) }));
ok("再入城垣+Boss=蒙格特@F王座厅", sc === "stormveil" && st.id === "morgott" && st.cls === "Morgott" && Math.abs(st.bx - 132.8) < 0.8, JSON.stringify({ sc, ...st }));
k = await killBoss("morgott");
ok("蒙格特击败(解锁墓地C)", k.defeated?.includes("morgott"), JSON.stringify(k.defeated));

// ---------- 墓地深处：监视者 → 拉塔恩 ----------
cur = { cur: "stormveil", to: "墓地" };
sc = await travelTo(cur);
st = await p.evaluate(() => ({ scene: window.__game.sceneId, id: window.__game.bossId, bx: +window.__game.boss.root.position.x.toFixed(1) }));
ok("再入墓地+Boss=监视者@C房", sc === "cemetery" && st.id === "watchers" && Math.abs(st.bx - 75.8) < 0.8, JSON.stringify({ sc, ...st }));
k = await killBoss("watchers");
ok("监视者击败(解锁墓地D)", k.defeated?.includes("watchers"), JSON.stringify(k.defeated));
st = await p.evaluate(() => window.__game.progress.zoneUnlocks.includes("cemetery:D"));
ok("碎星战场(D区)解锁", st === true, `D=${st}`);
cur = { cur: "cemetery", to: "高墙" };
sc = await travelTo(cur);
cur = { cur: "highwall", to: "墓地" };
sc = await travelTo(cur);
st = await p.evaluate(() => ({ scene: window.__game.sceneId, id: window.__game.bossId, cls: window.__game.boss.constructor.name, bx: +window.__game.boss.root.position.x.toFixed(1) }));
ok("再入墓地+Boss=拉塔恩@D碎星战场", sc === "cemetery" && st.id === "radahn" && st.cls === "Radahn" && Math.abs(st.bx - 196.8) < 0.8, JSON.stringify({ sc, ...st }));
k = await killBoss("radahn");
ok("拉塔恩击败(解锁高墙D)", k.defeated?.includes("radahn"), JSON.stringify(k.defeated));

// ---------- 高墙深处：沙力万 → 全通 ----------
cur = { cur: "cemetery", to: "高墙" };
sc = await travelTo(cur);
st = await p.evaluate(() => ({ scene: window.__game.sceneId, id: window.__game.bossId, bx: +window.__game.boss.root.position.x.toFixed(1) }));
ok("再入高墙+Boss=沙力万@D月坛", sc === "highwall" && st.id === "sulyvahn" && Math.abs(st.bx - 100.9) < 0.8, JSON.stringify({ sc, ...st }));
k = await killBoss("sulyvahn");
ok("沙力万击败=8/8全通", k.defeated?.length === 8, JSON.stringify(k.defeated));
st = await p.evaluate(() => ({
  win: document.getElementById("winSub")?.textContent,
  souls: window.__game.player.souls,
}));
// 再战菜单：R 重生后玩家在篝火旁——开菜单数「再战 ·」项（menuItems 仅开菜单时填充）
await p.keyboard.press("e");
for (let i = 0; i < 40; i++) { if (await p.evaluate(() => window.__game.menuOpen === true)) break; await p.waitForTimeout(100); }
const rematches = await p.evaluate(() => (window.__game.menuItems ?? []).filter(i => (i.label ?? "").startsWith("再战")).length);
await p.keyboard.press("Escape");
await p.waitForTimeout(300);
ok("全通结算文案(8 Boss)", (st.win ?? "").includes("8") || (st.win ?? "").includes("尽"), JSON.stringify(st.win));
ok("魂累计(8 Boss 全额)", st.souls >= 86000, `${st.souls}`);
ok("再战菜单=8 位", rematches === 8, `再战=${rematches}`);
await p.screenshot({ path: "/tmp/m4shots/8-allclear.png" });

await b.close();
console.log(r.join("\n"));
console.log(r.some(x => x.startsWith("FAIL") || x.startsWith("PAGEERROR")) ? "FAILURES" : "ALL PASS");
process.exit(r.some(x => x.startsWith("FAIL") || x.startsWith("PAGEERROR")) ? 1 : 0);
