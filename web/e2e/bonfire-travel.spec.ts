/** Boss 死亡后的篝火重生，以及菜单传送。
 *  回归：击杀只点亮高墙、不改 lastBonfire，R 会把人送回旧篝火；
 *  城垣永远点不着；未点燃的篝火拒绝打开菜单，传送进去就出不来。 */
import { expect, test, type Page } from "@playwright/test";

async function waitForGame(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const g = (window as unknown as { __game?: { renderer?: unknown } }).__game;
    return !!g?.renderer;
  }, undefined, { timeout: 30_000 });
}

test("击杀刷新本场景篝火，传送落在已点燃的重生点", async ({ page }) => {
  await page.goto("/?fresh=1");
  await waitForGame(page);

  const report = await page.evaluate(async () => {
    const g = (window as unknown as { __game: Record<string, any> }).__game;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const menu = () => (g.menuItems as { label: string; off?: boolean }[]).map((it) => ({
      label: it.label, off: !!it.off,
    }));
    const standAtBonfire = () => {
      g.player.pos.set(g.bonfire.pos.x, 0, g.bonfire.pos.z + 0.4);
      g.prevPx = g.player.pos.x;
    };

    g.onBossDeath();
    standAtBonfire();
    const killedGundyr = {
      flow: g.flow as string,
      fogSolid: g.fog.solid as boolean,
      last: g.progress.lastBonfire as string,
      prompt: g.prompt() as string | null,
    };
    g.interact();
    const gundyrMenu = { open: g.menuOpen as boolean, items: menu() };
    g.closeMenu();

    // 捷径在 Boss 房内。死亡后应能坐回篝火，而不是被胜利流程吞掉。
    const elev = (g.shortcuts as { def: { pos: { x: number; z: number }; dest: { x: number; z: number } }; isOpen: boolean }[])[0];
    g.player.pos.set(elev.def.pos.x, 0, elev.def.pos.z);
    g.prevPx = elev.def.pos.x;
    g.interact();
    await sleep(700);
    const rode = {
      open: elev.isOpen,
      x: g.player.pos.x as number,
      z: g.player.pos.z as number,
      destX: elev.def.dest.x,
      destZ: elev.def.dest.z,
    };

    g.restart();
    await sleep(700);
    const afterGundyrRest = { scene: g.sceneId as string, last: g.progress.lastBonfire as string };

    g.travelTo("highwall");
    await sleep(700);
    standAtBonfire();
    const highwallArrive = {
      last: g.progress.lastBonfire as string,
      lit: [...g.progress.litBonfires] as string[],
      prompt: g.prompt() as string | null,
    };
    g.interact();
    const highwallMenu = { open: g.menuOpen as boolean, items: menu() };
    g.closeMenu();

    g.onBossDeath();
    const killedVordt = {
      last: g.progress.lastBonfire as string,
      lit: [...g.progress.litBonfires] as string[],
      unlocked: [...g.progress.unlockedScenes] as string[],
    };
    g.restart();
    await sleep(700);
    const afterVordtRest = {
      scene: g.sceneId as string,
      boss: g.bossId as string,
      x: g.player.pos.x as number,
      spawnX: g.anchors.spawn.x as number,
    };

    g.travelTo("stormveil");
    await sleep(700);
    standAtBonfire();
    const stormArrive = {
      last: g.progress.lastBonfire as string,
      lit: [...g.progress.litBonfires] as string[],
      prompt: g.prompt() as string | null,
    };
    g.interact();
    const stormMenu = { open: g.menuOpen as boolean, items: menu() };
    g.closeMenu();

    // 玛尔基特死后刷新，下一场是葛瑞克。教堂电梯在残柱厅，不能被加大的圆提前封门。
    g.onBossDeath();
    g.restart();
    await sleep(700);
    g.travelTo("stormveil");
    await sleep(700);
    g.enemies.clear();
    const church = (g.shortcuts as { def: { id: string; pos: { x: number; z: number } } }[])
      .find((s) => s.def.id === "stormveil:e4-e1");
    g.player.pos.set(church!.def.pos.x, 0, church!.def.pos.z);
    g.prevPx = church!.def.pos.x;
    g.bossSeal = null;
    g.bossSealArmed = true;
    await sleep(400);
    const churchPad = {
      boss: g.bossId as string,
      sealed: g.bossSeal != null,
      x: g.player.pos.x as number,
    };

    return {
      killedGundyr, gundyrMenu, rode, afterGundyrRest,
      highwallArrive, highwallMenu, killedVordt, afterVordtRest,
      stormArrive, stormMenu, churchPad,
    };
  });

  expect(report.killedGundyr.fogSolid).toBe(false);
  expect(report.killedGundyr.prompt).toBe("E 篝火（休息 · 传送）");
  expect(report.gundyrMenu.open).toBe(true);
  expect(report.gundyrMenu.items.find((it) => it.label.startsWith("传送 · 洛斯里克"))?.off).toBe(false);

  expect(report.rode.open).toBe(true);
  expect(Math.hypot(report.rode.x - report.rode.destX, report.rode.z - report.rode.destZ)).toBeLessThan(1.5);

  expect(report.afterGundyrRest).toEqual({ scene: "cemetery", last: "cemetery" });

  expect(report.highwallArrive.last).toBe("cemetery");
  expect(report.highwallArrive.lit).not.toContain("highwall");
  expect(report.highwallArrive.prompt).toBe("E 篝火（传送）");
  expect(report.highwallMenu.open).toBe(true);
  expect(report.highwallMenu.items.find((it) => it.label === "休息")?.off).toBe(true);
  expect(report.highwallMenu.items.find((it) => it.label.startsWith("传送 · 灰烬"))?.off).toBe(false);

  expect(report.killedVordt.last).toBe("highwall");
  expect(report.killedVordt.lit).toEqual(expect.arrayContaining(["highwall", "stormveil"]));
  expect(report.killedVordt.unlocked).toContain("stormveil");
  expect(report.afterVordtRest.scene).toBe("highwall");
  expect(report.afterVordtRest.boss).toBe("vordt");
  expect(Math.abs(report.afterVordtRest.x - report.afterVordtRest.spawnX)).toBeLessThan(2);

  expect(report.stormArrive.last).toBe("stormveil");
  expect(report.stormArrive.lit).toContain("stormveil");
  expect(report.stormArrive.prompt).toBe("E 篝火（休息 · 传送）");
  expect(report.stormMenu.open).toBe(true);
  expect(report.stormMenu.items.find((it) => it.label === "休息")?.off).toBe(false);

  expect(report.churchPad.boss).toBe("godrick");
  expect(report.churchPad.sealed).toBe(false);
  expect(report.churchPad.x).toBeGreaterThan(36);
});

test("旧档击败玻尔多后补点燃高墙和城垣", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("inferno.progress.v1", JSON.stringify({
      defeated: ["gundyr", "vordt"],
      unlockedScenes: ["cemetery", "highwall"],
      litBonfires: ["cemetery"],
      lastBonfire: "cemetery",
      souls: 0,
      attempts: {},
      bloodstain: null,
      stats: { deaths: 0, soulRegains: 0, parries: 0, ripostes: 0 },
    }));
  });
  await page.goto("/");
  await waitForGame(page);
  const saved = await page.evaluate(() => {
    const p = (window as unknown as { __game: { progress: { litBonfires: string[]; unlockedScenes: string[]; lastBonfire: string } } }).__game.progress;
    return { lit: [...p.litBonfires], unlocked: [...p.unlockedScenes], last: p.lastBonfire };
  });
  expect(saved.lit).toEqual(expect.arrayContaining(["cemetery", "highwall", "stormveil"]));
  expect(saved.unlocked).toContain("stormveil");
  expect(saved.last).toBe("cemetery");
});
