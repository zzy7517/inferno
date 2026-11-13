import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Game } from "./game";
import { AU } from "./audio";
import { setBossGltf } from "./boss-gltf";

async function boot(): Promise<void> {
  const load = (url: string) => new GLTFLoader().loadAsync(url);
  const [gltf, frames, gundyr, vordt, watchers, sulyvahn, margit, godrick, morgott, radahn] = await Promise.all([
    load("assets/character.glb"),
    fetch("assets/character_frames.json").then(r => r.json()),
    load("assets/bosses/gundyr.glb"),
    load("assets/bosses/vordt.glb"),
    load("assets/bosses/watchers.glb"),
    load("assets/bosses/sulyvahn.glb"),
    load("assets/bosses/margit.glb"),
    load("assets/bosses/godrick.glb"),
    load("assets/bosses/morgott.glb"),
    load("assets/bosses/radahn.glb"),
  ]);
  setBossGltf({ gundyr, vordt, watchers, sulyvahn, margit, godrick, morgott, radahn });
  AU.init();
  const game = new Game(gltf, frames.clips as Record<string, Record<string, unknown>>);
  game.start();
  // 自动化测试/调试钩子（调校台的程序化入口）
  (window as unknown as Record<string, unknown>).__game = game;
}

boot().catch(err => {
  document.body.insertAdjacentHTML("beforeend", `<pre style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);color:#9b3b32">${String(err)}</pre>`);
});
