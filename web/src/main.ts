import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Game } from "./game";
import { AU } from "./audio";
import { setBossAssets } from "./boss-rig";

async function boot(): Promise<void> {
  const load = (url: string) => new GLTFLoader().loadAsync(url);
  const [gltf, frames, gundyr, vordt, watchers, sulyvahn] = await Promise.all([
    load("assets/character.glb"),
    fetch("assets/character_frames.json").then(r => r.json()),
    load("assets/boss-gundyr.glb"),
    load("assets/boss-vordt.glb"),
    load("assets/boss-watchers.glb"),
    load("assets/boss-sulyvahn.glb"),
  ]);
  setBossAssets({ gundyr, vordt, watchers, sulyvahn });
  AU.init();
  const game = new Game(gltf, frames.clips as Record<string, Record<string, unknown>>);
  game.start();
  // 自动化测试/调试钩子（调校台的程序化入口）
  (window as unknown as Record<string, unknown>).__game = game;
}

boot().catch(err => {
  document.body.insertAdjacentHTML("beforeend", `<pre style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);color:#9b3b32">${String(err)}</pre>`);
});
