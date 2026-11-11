/**
 * Inferno M0 管线验证播放器
 * 验收目标（ROADMAP M0）：
 *   1. clip 切换无跳变（crossfade）
 *   2. 帧数据 JSON 与动画时序对齐（阶段标签随动作实时变化）
 *   3. mixer.timeScale 慢动作生效
 *   4. 取消窗口：攻击后摇 55% 后可用翻滚取消（ADR-0004 预输入缓冲）
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// ---------- 帧数据（与 Blender 生成脚本同源） ----------
interface ClipDef {
  loop?: boolean;
  duration?: number;
  startup?: number;
  active?: number;
  recovery?: number;
  cancelFrom?: number; // 后摇进度 fraction，超过后可取消
  total?: number;
  iframes?: [number, number];
}
interface FrameData { fps: number; clips: Record<string, ClipDef> }

const MODEL_URL = "assets/character.glb";
const FRAMES_URL = "assets/character_frames.json";
const MODEL_YAW = Math.PI; // 角色朝向修正（Blender +Y 前端 → three 场景），可调
const BUFFER_WINDOW = 0.25; // 预输入缓冲（秒）

// ---------- 场景 ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1016);
scene.fog = new THREE.FogExp2(0x0d1016, 0.055);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100);
camera.position.set(2.8, 2.0, 3.4);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.0, 0);
controls.enableDamping = true;
controls.minDistance = 1.5;
controls.maxDistance = 10;

// 冷月光（主光，投影）+ 环境冷灰 —— ADR-0006：冷灰基调
const moon = new THREE.DirectionalLight(0x9db4d8, 2.4);
moon.position.set(4, 7, 3);
moon.castShadow = true;
moon.shadow.mapSize.set(2048, 2048);
moon.shadow.camera.left = -6; moon.shadow.camera.right = 6;
moon.shadow.camera.top = 6; moon.shadow.camera.bottom = -6;
scene.add(moon);
scene.add(new THREE.HemisphereLight(0x2c3548, 0x141210, 0.7));

// 火光（唯一强调色，闪烁）—— ADR-0006：火光唯一强调色
const ember = new THREE.PointLight(0xff8c3a, 14, 9, 2);
ember.position.set(1.4, 0.9, 1.2);
scene.add(ember);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(9, 48),
  new THREE.MeshStandardMaterial({ color: 0x1e2126, roughness: 0.95 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ---------- 载入 ----------
let frames: FrameData = { fps: 30, clips: {} }; // boot 时填充

async function loadAll(): Promise<{ model: THREE.Group; frames: FrameData }> {
  const [{ GLTFLoader }, frames] = await Promise.all([
    import("three/addons/loaders/GLTFLoader.js"),
    fetch(FRAMES_URL).then(r => r.json()) as Promise<FrameData>,
  ]);
  const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
  gltf.scene.traverse(o => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return { model: gltf.scene, frames };
}

// ---------- 动画状态机 ----------
type StateName = "idle" | "attack" | "roll";

const actions: Record<string, THREE.AnimationAction> = {};
let mixer: THREE.AnimationMixer;
let current: StateName = "idle";
let buffered: { name: StateName; at: number } | null = null;
let slowmo = false;
let elapsed = 0;

function enter(next: StateName, fade = 0.12): void {
  if (next === current && next === "idle") return;
  const from = actions[current];
  const to = actions[next];
  to.reset();
  to.setLoop(next === "idle" ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
  to.clampWhenFinished = true;
  to.enabled = true;
  to.fadeIn(fade).play();
  if (from && from !== to) from.fadeOut(fade);
  current = next;
}

function buffer(name: StateName): void {
  buffered = { name, at: elapsed };
}

function cancelAllowed(): boolean {
  const fd = frames.clips.attack;
  const t = actions.attack.time;
  const threshold = (fd.startup ?? 0) + (fd.active ?? 0) + (fd.recovery ?? 0) * (fd.cancelFrom ?? 1);
  return t >= threshold;
}

function updateState(): void {
  // 预输入缓冲过期
  if (buffered && elapsed - buffered.at > BUFFER_WINDOW) buffered = null;

  const t = actions[current].time;
  if (current === "attack") {
    const fd = frames.clips.attack;
    if (buffered?.name === "roll" && cancelAllowed()) { buffered = null; enter("roll"); return; }
    if (t >= (fd.total ?? Infinity)) { enter("idle"); return; }
  } else if (current === "roll") {
    const fd = frames.clips.roll;
    if (t >= (fd.total ?? Infinity)) { enter("idle"); return; }
  } else { // idle
    if (buffered) { const n = buffered.name; buffered = null; enter(n); return; }
  }
}

// ---------- 阶段标签（验收点 2：时序对齐的可视化证据） ----------
const phaseEl = document.getElementById("phase")!;
const debugEl = document.getElementById("debug")!;

function phaseOf(): { label: string; cls: string } {
  const t = actions[current].time;
  if (current === "attack") {
    const fd = frames.clips.attack;
    const su = fd.startup ?? 0, ac = fd.active ?? 0, re = fd.recovery ?? 0;
    if (t < su) return { label: "前 摇", cls: "" };
    if (t < su + ac) return { label: "判 定 帧", cls: "active" };
    const cancel = t >= su + ac + re * (fd.cancelFrom ?? 1);
    return { label: cancel ? "后摇 · 可取消" : "后 摇", cls: "" };
  }
  if (current === "roll") {
    const fd = frames.clips.roll;
    const [a, b] = fd.iframes ?? [0, 0];
    if (t >= a && t <= b) return { label: "无 敌 帧", cls: "iframe" };
    return { label: "翻 滚", cls: "" };
  }
  return { label: "待 机", cls: "" };
}

function updateHUD(): void {
  const p = phaseOf();
  phaseEl.textContent = p.label;
  phaseEl.className = p.cls;
  const fd = frames.clips[current];
  const t = actions[current].time;
  debugEl.innerHTML =
    `状态   <b>${current}</b>  t=${t.toFixed(2)}s / ${(fd.total ?? fd.duration ?? 0).toFixed(2)}s\n` +
    `慢动作 <b>${slowmo ? "0.25×" : "1×"}</b>   预输入 <b>${buffered?.name ?? "—"}</b>\n` +
    `帧数据 attack: 前摇${frames.clips.attack.startup} 判定${frames.clips.attack.active} 后摇${frames.clips.attack.recovery}\n` +
    `       roll: 无敌帧[${frames.clips.roll.iframes?.join(", ")}]`;
}

// ---------- 输入 ----------
addEventListener("pointerdown", e => { if (e.button === 0 && e.target === renderer.domElement) buffer("attack"); });
addEventListener("keydown", e => {
  if (e.repeat) return;
  if (e.code === "Space") { e.preventDefault(); buffer("roll"); }
  else if (e.code === "KeyT") { slowmo = !slowmo; if (mixer) mixer.timeScale = slowmo ? 0.25 : 1; }
  else if (e.code === "KeyR") { if (mixer) { enter("idle", 0.2); buffered = null; } }
});

// ---------- 主循环 ----------
const clock = new THREE.Clock();
async function boot(): Promise<void> {
  const { model, frames: fd } = await loadAll();
  frames = fd;
  model.rotation.y = MODEL_YAW;
  scene.add(model);

  mixer = new THREE.AnimationMixer(model);
  for (const clip of (Object.keys(fd.clips) as StateName[])) {
    const action = mixer.clipAction(THREE.AnimationClip.findByName(model.animations, clip) ?? clip);
    actions[clip] = action;
  }
  enter("idle", 0);

  renderer.setAnimationLoop(() => {
    const dt = clock.getDelta();
    elapsed += dt;
    mixer.update(dt);
    updateState();
    ember.intensity = 12 + Math.sin(elapsed * 13) * 2 + Math.sin(elapsed * 31) * 1.2;
    controls.update();
    updateHUD();
    renderer.render(scene, camera);
  });
}

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

boot().catch(err => {
  const el = document.getElementById("debug")!;
  el.textContent = `载入失败：${err}\n（请先在仓库根目录运行 blender -b -P tools/blender/build_character.py）`;
});
