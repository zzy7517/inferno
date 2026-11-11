/** 灰烬墓地场景：DS3 开局氛围——冷灰石 + 余烬火光 + 荒芜
 * 与 scene-highwall 同构：{ anchors, update, dispose }——game.ts 场景注册表按此消费
 * 美术方向（对标 DS3 灰烬墓地）：
 *   冷灰蓝石色系为底、火光橙为唯一强调色；全 roughness≥0.8 哑光，禁高饱和
 *   层次：灰霭天穹 + 朦胧冷月 → 雾上浮的墓园围墙/破塔/圣殿残迹/枯树剪影 →
 *         竞技场残柱 + 墓碑群(石板/十字/斜插剑) + 碎石灰斑 → 雾门双火盆 + 缓落飘灰
 * 预算：静态几何按顶点色 mergeGeometries 合并，场景自身 ~13 draw call；火光 PointLight ×2
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { COLORS } from "./config";
import type { SceneAnchors } from "./scene-highwall";

/** 派生色板：冷灰蓝石阶 + 灰烬暖灰（ADR-0006 纪律）；强调色仅 ember 系（火盆火焰/炭芯） */
const PAL = {
  stone: COLORS.stone, stoneMid: 0x34383f, stoneDark: COLORS.stoneDark, stoneDeep: 0x232529,
  mortar: 0x191b20, steel: 0x363b42, ash: 0x14110d,
  pathA: COLORS.groundPath, pathB: 0x2c2825, pathC: 0x31302c,
  skyTop: 0x07090f, skyHorizon: 0x1a202b, skyUnder: 0x0b0d12,
};
/** 远景剪影：略深于地平线，衬出"雾上浮坟"的层次（全部 fog:false 手绘色） */
const FAR = { wall: 0x161b26, tower: 0x121722, chapel: 0x151a24, teeth: 0x10141d, tree: 0x0d1015 };
const CLOUD = { min: -26, max: 38, fade: 10 };

// ---------------- 确定性随机（每次构建重置，场景可复现） ----------------
let seed = 20260930;
const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
const rr = (a: number, b: number): number => a + rnd() * (b - a);
const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length) % arr.length];

interface GOpt { rx?: number; ry?: number; rz?: number; jitter?: number; open?: boolean; t0?: number; tl?: number }

/** 统一上色：非索引化 + 每面（每 3 顶点）同色微扰，merge 后仍是低开销的顶点色几何 */
function paint(geo: THREE.BufferGeometry, color: number, jitter = 0): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 3) {
    const f = jitter ? 1 + (rnd() - 0.5) * jitter : 1;
    for (let k = 0; k < 3 && i + k < n; k++) {
      const j = (i + k) * 3;
      arr[j] = c.r * f; arr[j + 1] = c.g * f; arr[j + 2] = c.b * f;
    }
  }
  g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return g;
}

function boxG(w: number, h: number, d: number, x: number, y: number, z: number, color: number, opt: GOpt = {}): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (opt.rx) g.rotateX(opt.rx);
  if (opt.ry) g.rotateY(opt.ry);
  if (opt.rz) g.rotateZ(opt.rz);
  g.translate(x, y, z);
  return paint(g, color, opt.jitter ?? 0);
}

function cylG(rt: number, rb: number, h: number, seg: number, x: number, y: number, z: number, color: number, opt: GOpt = {}): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1, opt.open ?? false, opt.t0 ?? 0, opt.tl ?? Math.PI * 2);
  if (opt.rx) g.rotateX(opt.rx);
  if (opt.ry) g.rotateY(opt.ry);
  if (opt.rz) g.rotateZ(opt.rz);
  g.translate(x, y, z);
  return paint(g, color, opt.jitter ?? 0);
}

function coneG(r: number, h: number, seg: number, x: number, y: number, z: number, color: number, opt: GOpt = {}): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(r, h, seg);
  if (opt.rx) g.rotateX(opt.rx);
  if (opt.ry) g.rotateY(opt.ry);
  if (opt.rz) g.rotateZ(opt.rz);
  g.translate(x, y, z);
  return paint(g, color, opt.jitter ?? 0);
}

function dodG(r: number, x: number, y: number, z: number, color: number, opt: GOpt = {}): THREE.BufferGeometry {
  const g = new THREE.DodecahedronGeometry(r, 0);
  if (opt.rx) g.rotateX(opt.rx);
  if (opt.ry) g.rotateY(opt.ry);
  if (opt.rz) g.rotateZ(opt.rz);
  g.translate(x, y, z);
  return paint(g, color, opt.jitter ?? 0.2);
}

/** 合批建 Mesh：merge 后释放源几何；静态物关闭 matrixAutoUpdate */
function batch(geoms: THREE.BufferGeometry[], mat: THREE.Material, shadows: "both" | "cast" | "receive" | "none" = "both"): THREE.Mesh {
  const merged = mergeGeometries(geoms, false)!;
  const m = new THREE.Mesh(merged, mat);
  m.castShadow = shadows === "both" || shadows === "cast";
  m.receiveShadow = shadows === "both" || shadows === "receive";
  m.updateMatrix();
  m.matrixAutoUpdate = false;
  for (const g of geoms) g.dispose();
  return m;
}

/** 运行时 Canvas 径向柔光贴图（月光晕 / 流云共用，非外部资源） */
function softDiscTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 3, 64, 64, 62);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(0.4, "rgba(255,255,255,0.34)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface FlameRef { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; light: THREE.PointLight; ph: number }
interface CloudRef { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; sp: number; o: number }

// ================================================================
export function buildCemetery(scene: THREE.Scene): {
  anchors: SceneAnchors;
  update: (t: number, dt: number) => void;
  dispose: () => void;
} {
  seed = 20260930;                                       // 每次构建重置 → 场景可复现
  const root = new THREE.Group();
  root.name = "cemetery";
  scene.add(root);

  const anchors: SceneAnchors = {
    spawn: new THREE.Vector3(-12.2, 0, 1.4),
    bonfire: new THREE.Vector3(-12.2, 0, 0),
    fogGate: new THREE.Vector3(-5.0, 0, 0),
    bossArena: new THREE.Vector3(0.6, 0, 0),
    arenaRadius: 6.6,
    corridorMinX: -13.4,
  };

  // 天空与雾（dispose 时还原）
  const prevBg = scene.background;
  const prevFog = scene.fog;
  scene.background = new THREE.Color(COLORS.bg);
  scene.fog = new THREE.FogExp2(COLORS.fog, 0.042);

  const mats: THREE.Material[] = [];
  const track = <T extends THREE.Material>(m: T): T => { mats.push(m); return m; };

  // ---------------- 灯光：冷月光主灯（带阴影）+ 半天环境光 ----------------
  const moonLight = new THREE.DirectionalLight(COLORS.moon, 2.0);
  moonLight.position.set(19, 6, -7);                     // 与冷月视觉方位一致（+X 低空 -Z，长影）
  moonLight.castShadow = true;
  moonLight.shadow.mapSize.set(2048, 2048);
  Object.assign(moonLight.shadow.camera, { left: -17, right: 17, top: 14, bottom: -10, near: 2, far: 60 });
  moonLight.shadow.camera.updateProjectionMatrix();
  moonLight.shadow.bias = -0.0002;
  moonLight.shadow.normalBias = 0.03;
  root.add(moonLight);
  root.add(new THREE.HemisphereLight(0x2c3548, 0x141210, 0.62));

  // ---------------- 灰霭天穹：大球内壁竖向渐变（下暗上更暗、地平线微亮） ----------------
  {
    const geo = new THREE.SphereGeometry(92, 32, 20);
    const pos = geo.attributes.position;
    const colArr = new Float32Array(pos.count * 3);
    const top = new THREE.Color(PAL.skyTop), hor = new THREE.Color(PAL.skyHorizon), un = new THREE.Color(PAL.skyUnder);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const ny = pos.getY(i) / 92;
      if (ny >= 0) c.copy(hor).lerp(top, Math.pow(Math.min(1, ny / 0.85), 0.65));
      else c.copy(hor).lerp(un, Math.min(1, -ny * 3.2));
      colArr[i * 3] = c.r; colArr[i * 3 + 1] = c.g; colArr[i * 3 + 2] = c.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colArr, 3));
    const sky = new THREE.Mesh(geo, track(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })));
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    root.add(sky);
  }

  // ---------------- 朦胧冷月：灰霭后的暗盘 + 单层柔光晕（+X 低空偏北，废墟线上升起的残月） ----------------
  {
    const mg = new THREE.Group();
    mg.position.set(44, 7, -16);
    mg.lookAt(0, 3, 0);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(3.2, 40), track(new THREE.MeshBasicMaterial({ color: 0xdde6f2, transparent: true, opacity: 0.9, fog: false })));
    disc.renderOrder = -8;
    mg.add(disc);
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), track(new THREE.MeshBasicMaterial({ map: softDiscTexture(), color: 0x8fa2c4, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })));
    halo.renderOrder = -7;
    mg.add(halo);
    root.add(mg);
  }

  // ---------------- 夜霭流云 ×1：缓移过月（wrap 循环 + 边缘渐隐） ----------------
  let cloud: CloudRef;
  {
    const mat = track(new THREE.MeshBasicMaterial({ map: softDiscTexture(), color: 0x6f7b8d, transparent: true, opacity: 0, depthWrite: false, fog: false }));
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(34, 8), mat);
    mesh.position.set(8, 16, -26);
    mesh.lookAt(0, 3, 0);
    mesh.renderOrder = -6;
    root.add(mesh);
    cloud = { mesh, mat, sp: 0.55, o: 0.1 };
  }

  // ---------------- 远景剪影（fog:false 手绘色，衬在地平线微光前）：围墙弧段/破塔/圣殿残迹/枯树 ----------------
  const farGeoms: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 5; k++) {                          // 墓园围墙：环布弧段，高度参差
    const r = 29 + k * 1.3;
    farGeoms.push(cylG(r, r, rr(2.4, 5.5), 48, 0.6, rr(1.0, 2.4), 0, FAR.wall, { open: true, t0: rnd() * Math.PI * 2, tl: rr(0.9, 2.2), jitter: 0.06 }));
  }
  const tower = (x: number, z: number, w: number, h: number): void => {
    farGeoms.push(boxG(w, h, w, x, h / 2 - 0.3, z, FAR.tower, { ry: rr(-0.1, 0.1), jitter: 0.07 }));
    for (let i = 0; i < 4; i++) if (rnd() < 0.7)         // 断口残垛
      farGeoms.push(boxG(w * 0.22, rr(0.6, 1.4), w * 0.22, x + rr(-w * 0.32, w * 0.32), h - 0.3 + rr(0.2, 0.6), z + rr(-w * 0.32, w * 0.32), FAR.teeth, { ry: rnd() * 3 }));
  };
  tower(31, -13, 3.4, 12);
  tower(-27, 11, 3.0, 9.5);
  tower(-24, -17, 2.6, 7);
  for (const s of [-1, 1]) farGeoms.push(boxG(1.3, 7.5, 1.3, 36, 3.45, s * 3.4, FAR.chapel, { jitter: 0.06 }));   // 圣殿残柱（+X 中轴）
  farGeoms.push(boxG(9.5, 1.1, 1.5, 36.4, 7.6, 0, FAR.chapel, { rz: 0.06, jitter: 0.06 }));                      // 断拱梁
  farGeoms.push(boxG(1.0, 1.0, 1.2, 36.2, 8.6, -1.2, FAR.teeth));                                                // 梁上残块
  const deadTree = (x: number, z: number, s: number, lean: number): void => {    // 枯树剪影（围墙之内，最近一层）
    farGeoms.push(cylG(0.05 * s, 0.17 * s, 2.5 * s, 7, x, 1.25 * s, z, FAR.tree, { rz: lean, jitter: 0.15 }));
    for (let b = 0; b < 5; b++) {
      const ba = b * 1.35 + rnd() * 0.5;
      farGeoms.push(cylG(0.012 * s, 0.05 * s, 1.15 * s, 5, x + Math.cos(ba) * 0.4 * s, (1.2 + b * 0.28) * s + 0.3 * s, z + Math.sin(ba) * 0.4 * s, FAR.tree, { ry: -ba, rz: 0.85 + rnd() * 0.5, jitter: 0.2 }));
    }
  };
  deadTree(16, -10, 1.25, 0.1);
  deadTree(22, 8, 1.0, -0.14);
  deadTree(-18, -8, 0.85, 0.12);
  root.add(batch(farGeoms, track(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: false })), "none"));

  // ---------------- 主石构（一个顶点色 Mesh：走廊/残柱/墓碑/碎石/火盆座）+ 地面（receive 批） ----------------
  const stoneMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true, side: THREE.DoubleSide }));
  const structGeoms: THREE.BufferGeometry[] = [];
  const floorGeoms: THREE.BufferGeometry[] = [];

  // —— 走廊：墙体 + 压顶 + 外侧扶壁 + 雾门门墩 ——
  for (const s of [-1, 1]) {
    structGeoms.push(boxG(9.6, 2.4, 0.5, -9.6, 1.2, s * 2.0, PAL.stoneDark, { jitter: 0.1 }));
    structGeoms.push(boxG(9.7, 0.18, 0.72, -9.6, 2.49, s * 2.0, PAL.stoneMid));
    for (let x = -13.5; x <= -6; x += 2.6) structGeoms.push(boxG(0.55, 2.9, 0.9, x, 1.25, s * 2.5, PAL.stoneDeep, { jitter: 0.08 }));
  }
  for (const s of [-1, 1]) {                             // 雾门收头门墩（火盆之间）
    structGeoms.push(boxG(0.75, 3.1, 0.75, -5.05, 1.55, s * 2.15, PAL.stoneMid, { jitter: 0.1 }));
    structGeoms.push(boxG(0.95, 0.22, 0.95, -5.05, 3.2, s * 2.15, PAL.stone));
  }

  // —— 竞技场残柱：柱身 + 方座 + 断裂柱头（位置沿用原九柱环） ——
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + 0.35;
    if (Math.abs(a - Math.PI) < 0.5) continue;           // 留出门口（-X 朝走廊）
    const x = 0.6 + Math.cos(a) * 6.1, z = Math.sin(a) * 6.1;
    const h = 1.2 + ((i * 7919) % 100) / 100 * 1.8;
    structGeoms.push(boxG(0.75, 0.22, 0.75, x, 0.11, z, PAL.stoneMid, { jitter: 0.08 }));
    structGeoms.push(cylG(0.26, 0.3, h, 9, x, 0.22 + h / 2, z, PAL.stone, { jitter: 0.1 }));
    structGeoms.push(boxG(0.5, 0.3, 0.5, x, 0.32 + h, z, PAL.stoneMid, { ry: rnd() * 3, rz: rr(-0.08, 0.08), jitter: 0.1 }));
  }

  // —— 墓碑群：石板/十字/斜插剑三型，随机倾歪高低 ——
  const grave = (x: number, z: number): void => {
    const ry = rnd() * Math.PI * 2;
    const lean = { rx: rr(-0.1, 0.1), rz: rr(-0.12, 0.12) };
    structGeoms.push(boxG(0.56, 0.12, 0.42, x, 0.05, z, PAL.stoneDeep, { ry, jitter: 0.1 }));
    const kind = rnd();
    if (kind < 0.45) {                                   // 石板碑（半数带顶帽）
      const h = rr(0.55, 1.0);
      structGeoms.push(boxG(rr(0.4, 0.55), h, 0.15, x, 0.1 + h / 2, z, pick([PAL.stoneMid, PAL.stoneDark, PAL.stone]), { ry, ...lean, jitter: 0.12 }));
      if (rnd() < 0.5) structGeoms.push(boxG(0.5, 0.1, 0.2, x, 0.13 + h, z, PAL.stoneMid, { ry, ...lean }));
    } else if (kind < 0.75) {                            // 十字碑
      const h = rr(0.6, 0.95);
      structGeoms.push(boxG(0.13, h, 0.13, x, 0.1 + h / 2, z, pick([PAL.stoneMid, PAL.stoneDark]), { ry, ...lean, jitter: 0.12 }));
      structGeoms.push(boxG(0.46, 0.11, 0.12, x, 0.1 + h * 0.72, z, PAL.stoneMid, { ry, ...lean }));
    } else {                                             // 斜插剑碑（无碑之剑）
      const tilt = rr(0.18, 0.42) * (rnd() < 0.5 ? -1 : 1);
      structGeoms.push(boxG(0.055, 0.72, 0.02, x, 0.32, z, PAL.steel, { ry, rz: tilt, jitter: 0.06 }));
      structGeoms.push(boxG(0.24, 0.045, 0.05, x, 0.6, z, PAL.steel, { ry, rz: tilt }));
    }
  };
  for (let i = 0; i < 13; i++) {                         // 竞技场外环
    const a = (i / 13) * Math.PI * 2 + 0.22;
    if (Math.abs(a - Math.PI) < 0.55) continue;          // 让开 -X 门口
    const rad = rr(7.9, 10.4);
    grave(0.6 + Math.cos(a) * rad, Math.sin(a) * rad);
  }
  for (let i = 0; i < 7; i++) grave(rr(-13.6, -5.6), (rnd() < 0.5 ? -1 : 1) * rr(3.0, 4.8));   // 走廊两侧

  // —— 碎石散布：竞技场环带 + 走廊沿墙 + 墓碑之间 ——
  const rubble = (x: number, z: number, r: number, n: number): void => {
    for (let i = 0; i < n; i++) {
      const s = rr(0.06, 0.18);
      structGeoms.push(dodG(s, x + rr(-r, r), s * rr(0.4, 0.7), z + rr(-r, r), pick([PAL.stoneDark, PAL.stoneMid, PAL.stoneDeep]), { rx: rnd() * 3, ry: rnd() * 3, rz: rnd() * 3 }));
    }
  };
  for (let i = 0; i < 8; i++) { const a = rnd() * Math.PI * 2; rubble(0.6 + Math.cos(a) * 5.4, Math.sin(a) * 5.4, 0.5, 1); }
  rubble(-9.8, 1.55, 0.5, 4);
  rubble(-10.4, -1.5, 0.5, 4);
  rubble(-6.2, 3.6, 0.8, 5);
  rubble(4.5, 6.8, 0.9, 6);

  // —— 火盆 ×2（雾门两侧）：石座/杆/缸并入 struct，炭芯与火焰单独建以便动效 ——
  const flameMat0 = track(new THREE.MeshBasicMaterial({ color: 0xffa14e, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
  const coalGeoms: THREE.BufferGeometry[] = [];
  const flames: FlameRef[] = [];
  const brazier = (x: number, z: number, ph: number): void => {
    structGeoms.push(boxG(0.5, 0.14, 0.5, x, 0.07, z, PAL.stoneDeep, { ry: rnd() * 3, jitter: 0.1 }));
    structGeoms.push(cylG(0.13, 0.2, 0.95, 8, x, 0.48, z, PAL.stoneMid, { jitter: 0.08 }));
    structGeoms.push(cylG(0.32, 0.18, 0.26, 9, x, 1.06, z, PAL.stoneDark, { jitter: 0.06 }));
    coalGeoms.push(dodG(0.15, x, 1.2, z, 0x000000));
    const mesh = new THREE.Mesh(coneG(0.16, 0.5, 7, x, 1.48, z, 0xffffff), track(flameMat0.clone()));
    mesh.renderOrder = 6;
    root.add(mesh);
    const light = new THREE.PointLight(COLORS.ember, 5.5, 9, 2);
    light.position.set(x, 1.62, z);
    root.add(light);
    flames.push({ mesh, mat: mesh.material as THREE.MeshBasicMaterial, light, ph });
  };
  brazier(-5.75, 2.65, 0);
  brazier(-5.75, -2.65, 2.4);
  const coalMat = track(new THREE.MeshStandardMaterial({ color: 0x2a1207, emissive: COLORS.ember, emissiveIntensity: 1.4, roughness: 1, flatShading: true }));
  root.add(batch(coalGeoms, coalMat, "none"));

  // —— 地面：走廊石板 / 竞技场环纹 / 篝火灰圈 / 大地面（一并 receive 批） ——
  floorGeoms.push(boxG(9.6, 0.2, 3.7, -9.6, -0.1, 0, PAL.mortar, { jitter: 0.08 }));
  {
    let i = 0;
    for (let x = -14.3; x < -5.0; x += 1.15) {
      floorGeoms.push(boxG(1.06, 0.07, 3.34, x + 0.53, 0.004 + (i % 2) * 0.004, rr(-0.02, 0.02), pick([PAL.pathA, PAL.pathB, PAL.pathC, PAL.pathB]), { jitter: 0.07 }));
      i++;
    }
  }
  floorGeoms.push(paint(new THREE.CircleGeometry(6.6, 48).rotateX(-Math.PI / 2).translate(0.6, 0.001, 0), COLORS.ground, 0.05));
  floorGeoms.push(paint(new THREE.RingGeometry(1.5, 1.8, 44).rotateX(-Math.PI / 2).translate(0.6, 0.012, 0), 0x1c2026, 0.06));
  floorGeoms.push(paint(new THREE.RingGeometry(4.7, 5.0, 44).rotateX(-Math.PI / 2).translate(0.6, 0.014, 0), 0x1b1f24, 0.06));
  floorGeoms.push(paint(new THREE.CircleGeometry(1.0, 20).rotateX(-Math.PI / 2).translate(-12.2, 0.015, 0), PAL.ash, 0.12));      // 篝火灰圈
  floorGeoms.push(paint(new THREE.CircleGeometry(60, 40).rotateX(-Math.PI / 2).translate(0, -0.05, 0), 0x14161b, 0.05));          // 大地面（远景）
  root.add(batch(structGeoms, stoneMat, "both"));
  root.add(batch(floorGeoms, stoneMat, "receive"));

  // ---------------- 灰烬斑：竞技场与走廊的半透明暗斑（单 Mesh 单材质） ----------------
  {
    const patchGeoms: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 8; i++) {
      const a = rnd() * Math.PI * 2, rad = rr(0.8, 4.9);
      patchGeoms.push(new THREE.CircleGeometry(rr(0.6, 1.7), 18).rotateX(-Math.PI / 2).translate(0.6 + Math.cos(a) * rad, 0.02, Math.sin(a) * rad));
    }
    patchGeoms.push(new THREE.CircleGeometry(1.1, 16).rotateX(-Math.PI / 2).translate(-8.2, 0.02, 0.7));
    patchGeoms.push(new THREE.CircleGeometry(0.9, 16).rotateX(-Math.PI / 2).translate(-11.6, 0.02, -0.6));
    const patches = new THREE.Mesh(mergeGeometries(patchGeoms, false)!, track(new THREE.MeshBasicMaterial({ color: 0x0a0b0e, transparent: true, opacity: 0.4, depthWrite: false })));
    for (const g of patchGeoms) g.dispose();
    root.add(patches);
  }

  // ---------------- 飘灰：64 粒缓落灰烬（Points + 位置数组直写，区域内循环） ----------------
  const ASH_N = 64;
  const ashPos = new Float32Array(ASH_N * 3);
  const ashVy = new Float32Array(ASH_N);
  const ashPh = new Float32Array(ASH_N);
  for (let i = 0; i < ASH_N; i++) {
    ashPos[i * 3] = rr(-14, 7); ashPos[i * 3 + 1] = rr(0.2, 5); ashPos[i * 3 + 2] = rr(-5.5, 5.5);
    ashVy[i] = rr(0.15, 0.42); ashPh[i] = rnd() * Math.PI * 2;
  }
  const ashGeo = new THREE.BufferGeometry();
  ashGeo.setAttribute("position", new THREE.BufferAttribute(ashPos, 3));
  const ash = new THREE.Points(ashGeo, track(new THREE.PointsMaterial({ size: 0.09, map: softDiscTexture(), color: 0x9aa2ac, transparent: true, opacity: 0.6, depthWrite: false, sizeAttenuation: true })));
  ash.frustumCulled = false;
  root.add(ash);

  // ---------------- update：飘灰 / 火焰闪烁 / 炭芯呼吸 / 流云漂移 ----------------
  let animT = 0;
  const update = (t: number, dt: number): void => {
    animT += dt;                                         // 用累加时间：顿帧/暂停(dt=0)时环境随之冻结
    void t;
    if (dt > 0) {                                        // 飘灰：缓落 + 侧摆 + 顺风，触地回卷到高空
      for (let i = 0; i < ASH_N; i++) {
        const j = i * 3;
        ashPos[j + 1] -= ashVy[i] * dt;
        ashPos[j] += (0.12 + Math.sin(animT * 0.6 + ashPh[i]) * 0.3) * dt;
        ashPos[j + 2] += Math.cos(animT * 0.47 + ashPh[i] * 1.3) * 0.22 * dt;
        if (ashPos[j + 1] < 0.06) {
          ashPos[j] = rr(-14, 7); ashPos[j + 1] = rr(4.5, 6); ashPos[j + 2] = rr(-5.5, 5.5);
        }
      }
      (ashGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    }
    for (let i = 0; i < flames.length; i++) {            // 火盆：火苗缩放/侧摆 + 光强闪烁
      const fl = flames[i];
      const s = 1 + Math.sin(animT * 11 + i * 2.1) * 0.18 + Math.sin(animT * 27 + i) * 0.08;
      fl.mesh.scale.set(1 + (s - 1) * 0.4, s, 1 + (s - 1) * 0.4);
      fl.mesh.rotation.z = Math.sin(animT * 2.1 + fl.ph) * 0.09;
      fl.mat.opacity = 0.7 + 0.2 * Math.sin(animT * 13 + i * 1.7);
      fl.light.intensity = 5.2 + Math.sin(animT * 9.5 + i * 2.4) * 1.2 + Math.sin(animT * 23 + i) * 0.6;
    }
    coalMat.emissiveIntensity = 1.3 + Math.sin(animT * 7.3) * 0.3;   // 炭芯呼吸
    {                                                    // 流云：wrap 循环漂移 + 边缘渐隐
      const span = CLOUD.max - CLOUD.min;
      const x = CLOUD.min + (((animT * cloud.sp) % span) + span) % span;
      const k = Math.min(1, Math.max(0, Math.min((x - CLOUD.min) / CLOUD.fade, (CLOUD.max - x) / CLOUD.fade)));
      cloud.mesh.position.x = x;
      cloud.mat.opacity = cloud.o * k * k;
    }
  };

  // ---------------- dispose：摘树、释放几何/材质/贴图，还原天空与雾 ----------------
  const dispose = (): void => {
    scene.background = prevBg;
    scene.fog = prevFog;
    root.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    for (const mt of mats) {
      const withMap = mt as THREE.Material & { map?: THREE.Texture | null };
      if (withMap.map) withMap.map.dispose();
      mt.dispose();
    }
    root.removeFromParent();
  };

  return { anchors, update, dispose };
}
