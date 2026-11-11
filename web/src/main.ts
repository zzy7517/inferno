import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Game } from "./game";
import { AU } from "./audio";

async function boot(): Promise<void> {
  const [gltf, frames] = await Promise.all([
    new GLTFLoader().loadAsync("assets/character.glb"),
    fetch("assets/character_frames.json").then(r => r.json()),
  ]);
  AU.init();
  new Game(gltf, frames.clips as Record<string, Record<string, unknown>>).start();
}

boot().catch(err => {
  document.body.insertAdjacentHTML("beforeend", `<pre style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);color:#9b3b32">${String(err)}</pre>`);
});
