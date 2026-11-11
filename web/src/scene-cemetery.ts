/** 灰烬墓地场景（m4-T3 扩建：DS3 尺度 80m 级长卷）：冷灰石 + 余烬火光 + 荒芜
 * 与 scene-highwall 同构：{ anchors, update, dispose }——game.ts 场景注册表按此消费
 * 美术方向（对标 DS3 灰烬墓地 → 法兰要塞深处）：
 *   冷灰蓝石色系为底、火光橙为唯一强调色（C 区加一支法兰冷蓝）；全 roughness≥0.8 哑光
 *   层次：灰霭天穹 + 朦胧冷月 → 雾上浮的墓园围墙/破塔/圣殿残迹/枯树剪影 →
 *         墓园径长廊（袋形墓苑 ×2）→ 古达雾门双火盆 → d24 残柱竞技场 →
 *         门 B 黑拱 → 法兰哨路（下沉暗廊·蓝灯笼）→ d24 监视者王座厅 + 缓落飘灰
 * 分区（SceneAnchors v2，西→东；docs/design/m4-level-flow.md §3.1）：
 *   A1 出生台地(-142..-130) → A2 墓园径三段+袋形墓苑×2 → A3 古达房 d24(c=-1.5)
 *   → 门 B(9.6) → C1 法兰哨路 36m → C2 监视者房 d24(c=57)
 *   直跑 spawn→雾门 130.5m ≈ 21s @6.2m/s（教学区 20-30s 预算内）
 * 预算：静态几何按顶点色 mergeGeometries 合批（6 空间分块），场景本体 ~16 draw call；
 *   火光 PointLight ×3（雾门火盆 ×2 + A1 烛龛），C 区灯笼/烛台/门 B 幽光全 emissive 呼吸
 * 跟随：天穹/冷月/流云随玩家 x 平移（无限远背景，far=120 内恒可见）；
 *   阴影定向灯 38×28m 窗口按 2m 网格吸附跟随（2048² 拉全图会痘影，见 m4 §4.2）
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { COLORS } from "./config";
import type { SceneAnchors, SceneZone } from "./scene-highwall";

/** 派生色板：冷灰蓝石阶 + 灰烬暖灰（ADR-0006 纪律）；强调色仅 ember 系（火盆火焰/炭芯）；
 *  C 区「深处」用更沉的 crypt 阶 + 法兰冷蓝（低饱和，压在冷灰族内不破纪律） */
const PAL = {
  stone: COLORS.stone, stoneMid: 0x34383f, stoneDark: COLORS.stoneDark, stoneDeep: 0x232529,
  mortar: 0x191b20, steel: 0x363b42, ash: 0x14110d,
  pathA: COLORS.groundPath, pathB: 0x2c2825, pathC: 0x31302c,
  crypt: 0x2b2f38, cryptMid: 0x232732, cryptDark: 0x1c1f27, cryptDeep: 0x14161c,
  cryptPath: 0x24272d, cryptPathB: 0x20232a, bone: 0x4a4436,
  bannerBlue: 0x2a3550, bannerBlueB: 0x1c2437,
  skyTop: 0x07090f, skyHorizon: 0x1a202b, skyUnder: 0x0b0d12,
};
/** 远景剪影：略深于地平线，衬出"雾上浮坟"的层次（全部 fog:false 手绘色） */
const FAR = { wall: 0x161b26, tower: 0x121722, chapel: 0x151a24, teeth: 0x10141d, tree: 0x0d1015, crypt: 0x0f1219 };
const CLOUD = { min: -30, max: 44, fade: 10 };

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

/** 运行时 Canvas 径向柔光贴图（月光晕 / 流云 / 飘灰共用，非外部资源） */
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

  // ---------------- 分区布局（m4 §3.1；corridor 半宽 2.75=净宽 5.5m，Boss 房 d24） ----------------
  // 带↔盘衔接口径：切换线处「带口截面 ⊆ 盘可走半径(r-0.9)」，主路径零跳变；
  // 袋形墓苑 r7.5 在 cx±6.0 切换（hypot(6,2.75)=6.6=r-0.9），竞技场东/西鼻 = c∓(r-0.9)。
  // C1.minX = 门B-0.4：未解锁推回值(上一区 maxX-0.4) 恰落在本带 minX 上，墙稳定在 A 东界-0.4。
  const GATE_X = -10, A3C = -1.5, A3R = 12, DOOR_B = A3C + (A3R - 0.9);   // 门 B = 9.6（A 区东界）
  const C2C = 57, C2R = 12, C2_W = C2C - (C2R - 0.9);                     // C2 西鼻 = 45.9
  const HALF = 2.75, WALL_Z = 3.25;                                       // 钳制半宽 / 墙心 z
  const zones: SceneZone[] = [
    { id: "cemetery:A", kind: "corridor", minX: -142, maxX: -101, half: HALF },                                  // A1 台地 + A2 西径
    { id: "cemetery:A", kind: "arena", minX: -101, maxX: -89, center: new THREE.Vector3(-95, 0, 0), r: 7.5 },    // 袋形墓苑 I
    { id: "cemetery:A", kind: "corridor", minX: -89, maxX: -51, half: HALF },                                    // A2 中径
    { id: "cemetery:A", kind: "arena", minX: -51, maxX: -39, center: new THREE.Vector3(-45, 0, 0), r: 7.5 },     // 袋形墓苑 II
    { id: "cemetery:A", kind: "corridor", minX: -39, maxX: GATE_X, half: HALF },                                 // A2 东径 → 雾门
    { id: "cemetery:A", kind: "arena", minX: GATE_X, maxX: DOOR_B, center: new THREE.Vector3(A3C, 0, 0), r: A3R },// A3 古达房 d24
    { id: "cemetery:C", kind: "corridor", minX: DOOR_B - 0.4, maxX: C2_W, half: HALF },                          // C1 法兰哨路 36.3m
    { id: "cemetery:C", kind: "arena", minX: C2_W, maxX: C2C + C2R, center: new THREE.Vector3(C2C, 0, 0), r: C2R }, // C2 监视者房 d24
  ];
  const anchors: SceneAnchors = {
    spawn: new THREE.Vector3(-140.5, 0, 1.4),            // A1 台地西端（来路悬崖封死）
    bonfire: new THREE.Vector3(-140.5, 0, 0),
    fogGate: new THREE.Vector3(GATE_X, 0, 0),            // legacy 雾门 = A 区古达（Boss 生成由主线程按进度推导）
    bossArena: new THREE.Vector3(A3C, 0, 0),
    arenaRadius: A3R,
    corridorMinX: -141.7,
    zones,
  };

  // 天空与雾（dispose 时还原）
  const prevBg = scene.background;
  const prevFog = scene.fog;
  scene.background = new THREE.Color(COLORS.bg);
  scene.fog = new THREE.FogExp2(COLORS.fog, 0.042);

  const mats: THREE.Material[] = [];
  const track = <T extends THREE.Material>(m: T): T => { mats.push(m); return m; };

  // ---------------- 灯光：冷月光主灯（带阴影，跟随玩家 38×28m 窗口）+ 半天环境光 ----------------
  const moonLight = new THREE.DirectionalLight(COLORS.moon, 2.2);
  moonLight.position.set(19, 6, -7);                     // 与冷月视觉方位一致（+X 低空 -Z，长影）
  moonLight.castShadow = true;
  moonLight.shadow.mapSize.set(2048, 2048);
  Object.assign(moonLight.shadow.camera, { left: -19, right: 19, top: 16, bottom: -12, near: 2, far: 75 });
  moonLight.shadow.camera.updateProjectionMatrix();
  moonLight.shadow.bias = -0.0002;
  moonLight.shadow.normalBias = 0.03;
  const moonTarget = new THREE.Object3D();
  moonTarget.position.set(-140, 0, 0);                   // 初始对准出生地（首帧前不瞎）
  root.add(moonTarget);
  moonLight.target = moonTarget;
  root.add(moonLight);
  root.add(new THREE.HemisphereLight(0x2c3548, 0x141210, 0.68));

  // ---------------- 天穹随行组：大球内壁渐变 + 朦胧冷月 + 流云（无限远背景，跟玩家 x） ----------------
  const skyGroup = new THREE.Group();
  skyGroup.position.set(-140.5, 0, 0);
  root.add(skyGroup);
  {
    const geo = new THREE.SphereGeometry(105, 32, 20);
    const pos = geo.attributes.position;
    const colArr = new Float32Array(pos.count * 3);
    const top = new THREE.Color(PAL.skyTop), hor = new THREE.Color(PAL.skyHorizon), un = new THREE.Color(PAL.skyUnder);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const ny = pos.getY(i) / 105;
      if (ny >= 0) c.copy(hor).lerp(top, Math.pow(Math.min(1, ny / 0.85), 0.65));
      else c.copy(hor).lerp(un, Math.min(1, -ny * 3.2));
      colArr[i * 3] = c.r; colArr[i * 3 + 1] = c.g; colArr[i * 3 + 2] = c.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colArr, 3));
    const sky = new THREE.Mesh(geo, track(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })));
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    skyGroup.add(sky);
  }
  // 朦胧冷月：灰霭后的暗盘 + 单层柔光晕（+X 低空偏北，废墟线上升起的残月）
  {
    const mg = new THREE.Group();
    mg.position.set(36, 8.5, -24);
    mg.lookAt(0, 3, 0);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(3.2, 40), track(new THREE.MeshBasicMaterial({ color: 0xdde6f2, transparent: true, opacity: 0.9, fog: false })));
    disc.renderOrder = -8;
    mg.add(disc);
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(14, 14), track(new THREE.MeshBasicMaterial({ map: softDiscTexture(), color: 0x8fa2c4, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })));
    halo.renderOrder = -7;
    mg.add(halo);
    skyGroup.add(mg);
  }
  // 夜霭流云 ×1：缓移过月（wrap 循环 + 边缘渐隐；随行组内局部坐标漂移）
  let cloud: CloudRef;
  {
    const mat = track(new THREE.MeshBasicMaterial({ map: softDiscTexture(), color: 0x6f7b8d, transparent: true, opacity: 0, depthWrite: false, fog: false }));
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(34, 8), mat);
    mesh.position.set(8, 16, -26);
    mesh.lookAt(0, 3, 0);
    mesh.renderOrder = -6;
    skyGroup.add(mesh);
    cloud = { mesh, mat, sp: 0.55, o: 0.1 };
  }

  // ---------------- 远景剪影（fog:false 手绘色，衬在地平线微光前）：围墙弧段/破塔/圣殿残迹/枯树 ----------------
  const farGeoms: THREE.BufferGeometry[] = [];
  /** 墓园围墙弧段：圆心偏到走廊南北两侧（r < 偏距 → 永不横穿可走带），高度参差 */
  const wallArc = (cx: number, cz: number, r: number): void => {
    farGeoms.push(cylG(r, r, rr(2.4, 5.5), 48, cx, rr(1.0, 2.4), cz, FAR.wall, { open: true, t0: rnd() * Math.PI * 2, tl: rr(0.9, 2.2), jitter: 0.06 }));
  };
  wallArc(-118, -16, rr(9, 13)); wallArc(-122, 15, rr(10, 14));
  wallArc(-76, -17, rr(11, 15)); wallArc(-70, 16, rr(9, 13));
  wallArc(-24, -16, rr(10, 14)); wallArc(-30, 15, rr(11, 15));
  wallArc(-1.5, -19, rr(13, 17)); wallArc(4, 18, rr(12, 16));
  wallArc(57, -18, rr(12, 16)); wallArc(62, 17, rr(13, 17));
  const tower = (x: number, z: number, w: number, h: number): void => {
    farGeoms.push(boxG(w, h, w, x, h / 2 - 0.3, z, FAR.tower, { ry: rr(-0.1, 0.1), jitter: 0.07 }));
    for (let i = 0; i < 4; i++) if (rnd() < 0.7)         // 断口残垛
      farGeoms.push(boxG(w * 0.22, rr(0.6, 1.4), w * 0.22, x + rr(-w * 0.32, w * 0.32), h - 0.3 + rr(0.2, 0.6), z + rr(-w * 0.32, w * 0.32), FAR.teeth, { ry: rnd() * 3 }));
  };
  tower(-134, 14, 3.4, 12);
  tower(-70, -15, 3.0, 9.5);
  tower(-24, 15, 2.6, 7);
  tower(16, -15, 3.2, 11);                               // A3 背景破塔（门 B 拱外北侧）
  tower(44, 16, 2.8, 8.5);
  tower(78, -9, 3.4, 13);                                // C2 尽头王座塔影
  for (const s of [-1, 1]) farGeoms.push(boxG(1.3, 7.5, 1.3, 18.5, 3.45, s * 5.2, FAR.chapel, { jitter: 0.06 }));  // 圣殿残柱（A3 东沿）
  farGeoms.push(boxG(9.5, 1.1, 1.5, 18.9, 7.6, 0, FAR.chapel, { rz: 0.06, jitter: 0.06 }));                       // 断拱梁
  farGeoms.push(boxG(1.0, 1.0, 1.2, 18.7, 8.6, -1.2, FAR.teeth));                                                  // 梁上残块
  farGeoms.push(boxG(2.6, 6.5, 0.9, 74, 3.0, -5.4, FAR.crypt, { ry: 0.2 }));                                       // 监视者王座剪影 ×2
  farGeoms.push(boxG(2.2, 5.2, 0.9, 74.6, 2.4, 5.0, FAR.crypt, { ry: -0.15 }));
  const deadTree = (x: number, z: number, s: number, lean: number): void => {    // 枯树剪影（围墙之内，最近一层）
    farGeoms.push(cylG(0.05 * s, 0.17 * s, 2.5 * s, 7, x, 1.25 * s, z, FAR.tree, { rz: lean, jitter: 0.15 }));
    for (let b = 0; b < 5; b++) {
      const ba = b * 1.35 + rnd() * 0.5;
      farGeoms.push(cylG(0.012 * s, 0.05 * s, 1.15 * s, 5, x + Math.cos(ba) * 0.4 * s, (1.2 + b * 0.28) * s + 0.3 * s, z + Math.sin(ba) * 0.4 * s, FAR.tree, { ry: -ba, rz: 0.85 + rnd() * 0.5, jitter: 0.2 }));
    }
  };
  deadTree(-125, -12, 1.25, 0.1);
  deadTree(-108, 11, 1.0, -0.14);
  deadTree(-80, -13, 0.85, 0.12);
  deadTree(-58, 12, 1.1, -0.1);
  deadTree(-30, -14, 0.9, 0.13);
  deadTree(5, 13, 1.2, -0.12);
  deadTree(36, -12, 1.0, 0.1);
  deadTree(66, 13, 1.15, -0.13);
  root.add(batch(farGeoms, track(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: false })), "none"));

  // ---------------- 主石构 + 地面：按空间分 5 块合批（frustum 剔剪），共享 1 个顶点色材质 ----------------
  const stoneMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true, side: THREE.DoubleSide }));
  const structW: THREE.BufferGeometry[] = [];   // 西段：A1 台地 + A2 西径 + 墓苑 I + A2 中径
  const structE: THREE.BufferGeometry[] = [];   // 东段：墓苑 II + A2 东径 + 雾门 + A3 古达房 + 门 B
  const structC: THREE.BufferGeometry[] = [];   // C 区：法兰哨路 + 监视者厅
  const floorW: THREE.BufferGeometry[] = [];
  const floorE: THREE.BufferGeometry[] = [];

  // —— 火光件（先声明供各区使用）：余烬炭芯批 / 法兰冷蓝批 / 火盆 / 壁烛 ——
  const flameMat0 = track(new THREE.MeshBasicMaterial({ color: 0xffa14e, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
  const coalGeoms: THREE.BufferGeometry[] = [];         // 余烬炭芯（emissive 呼吸，A 区火盆/烛芯）
  const blueGeoms: THREE.BufferGeometry[] = [];         // 法兰冷蓝光芯（C 区灯笼/烛台/门 B 幽光，emissive 呼吸代灯）
  const flames: FlameRef[] = [];
  const glowLights: { light: THREE.PointLight; ph: number }[] = [];   // 无火苗件的小光源（A1 烛龛），仅光强呼吸
  /** 立式火盆：石座/杆/缸入静态批，炭芯/火苗/点光单独建以便动效（PointLight ×2，雾门两侧） */
  const brazier = (dst: THREE.BufferGeometry[], x: number, z: number, ph: number): void => {
    dst.push(boxG(0.5, 0.14, 0.5, x, 0.07, z, PAL.stoneDeep, { ry: rnd() * 3, jitter: 0.1 }));
    dst.push(cylG(0.13, 0.2, 0.95, 8, x, 0.48, z, PAL.stoneMid, { jitter: 0.08 }));
    dst.push(cylG(0.32, 0.18, 0.26, 9, x, 1.06, z, PAL.stoneDark, { jitter: 0.06 }));
    coalGeoms.push(dodG(0.15, x, 1.2, z, 0x000000));
    const mesh = new THREE.Mesh(coneG(0.16, 0.5, 7, x, 1.48, z, 0xffffff), track(flameMat0.clone()));
    mesh.renderOrder = 6;
    root.add(mesh);
    const light = new THREE.PointLight(COLORS.ember, 5.5, 9, 2);
    light.position.set(x, 1.62, z);
    root.add(light);
    flames.push({ mesh, mat: mesh.material as THREE.MeshBasicMaterial, light, ph });
  };
  /** 壁龛烛台：石龛入静态批，炭芯亮块入余烬批，点光呼吸（无火苗 mesh，0 额外 DC） */
  const candleNook = (dst: THREE.BufferGeometry[], x: number, y: number, z: number, ry: number): void => {
    dst.push(boxG(0.34, 0.42, 0.16, x, y - 0.21, z, PAL.stoneDeep, { ry, jitter: 0.1 }));
    dst.push(boxG(0.42, 0.08, 0.22, x, y, z, PAL.stoneMid, { ry }));
    coalGeoms.push(dodG(0.07, x, y + 0.08, z, 0x000000));
  };

  // —— 墓碑（三型，随机倾歪高低；沿用原版造型语言） ——
  const grave = (dst: THREE.BufferGeometry[], x: number, z: number): void => {
    const ry = rnd() * Math.PI * 2;
    const lean = { rx: rr(-0.1, 0.1), rz: rr(-0.12, 0.12) };
    dst.push(boxG(0.56, 0.12, 0.42, x, 0.05, z, PAL.stoneDeep, { ry, jitter: 0.1 }));
    const kind = rnd();
    if (kind < 0.45) {                                   // 石板碑（半数带顶帽）
      const h = rr(0.55, 1.0);
      dst.push(boxG(rr(0.4, 0.55), h, 0.15, x, 0.1 + h / 2, z, pick([PAL.stoneMid, PAL.stoneDark, PAL.stone]), { ry, ...lean, jitter: 0.12 }));
      if (rnd() < 0.5) dst.push(boxG(0.5, 0.1, 0.2, x, 0.13 + h, z, PAL.stoneMid, { ry, ...lean }));
    } else if (kind < 0.75) {                            // 十字碑
      const h = rr(0.6, 0.95);
      dst.push(boxG(0.13, h, 0.13, x, 0.1 + h / 2, z, pick([PAL.stoneMid, PAL.stoneDark]), { ry, ...lean, jitter: 0.12 }));
      dst.push(boxG(0.46, 0.11, 0.12, x, 0.1 + h * 0.72, z, PAL.stoneMid, { ry, ...lean }));
    } else {                                             // 斜插剑碑（无碑之剑）
      const tilt = rr(0.18, 0.42) * (rnd() < 0.5 ? -1 : 1);
      dst.push(boxG(0.055, 0.72, 0.02, x, 0.32, z, PAL.steel, { ry, rz: tilt, jitter: 0.06 }));
      dst.push(boxG(0.24, 0.045, 0.05, x, 0.6, z, PAL.steel, { ry, rz: tilt }));
    }
  };
  // —— 碎石散布 ——
  const rubble = (dst: THREE.BufferGeometry[], x: number, z: number, r: number, n: number): void => {
    for (let i = 0; i < n; i++) {
      const s = rr(0.06, 0.18);
      dst.push(dodG(s, x + rr(-r, r), s * rr(0.4, 0.7), z + rr(-r, r), pick([PAL.stoneDark, PAL.stoneMid, PAL.stoneDeep]), { rx: rnd() * 3, ry: rnd() * 3, rz: rnd() * 3 }));
    }
  };
  // —— 墓园径墙体：分段墙身 + 压顶 + 外侧扶壁（高程参差做节奏，缺口处墓碑溢出） ——
  const wallRun = (dst: THREE.BufferGeometry[], x0: number, x1: number, h0 = 2.4, h1 = 3.0): void => {
    for (const s of [-1, 1]) {
      let x = x0;
      while (x < x1 - 0.01) {
        const seg = Math.min(rr(3.6, 5.4), x1 - x);
        const h = rr(h0, h1);
        const gap = rnd() < 0.14;                        // 残缺口：墙体塌陷，墓碑从墙外探进来
        if (!gap) {
          dst.push(boxG(seg - 0.08, h, 0.5, x + seg / 2, h / 2, s * WALL_Z, PAL.stoneDark, { jitter: 0.1 }));
          dst.push(boxG(seg, 0.18, 0.72, x + seg / 2, h + 0.09, s * WALL_Z, PAL.stoneMid));
          if (rnd() < 0.35) dst.push(boxG(seg * rr(0.2, 0.4), rr(0.3, 0.7), 0.4, x + seg * rr(0.2, 0.8), h + 0.4, s * (WALL_Z + 0.1), PAL.stoneMid, { ry: rnd() * 0.4, jitter: 0.12 })); // 塌落墙冠
        } else {
          rubble(dst, x + seg / 2, s * (WALL_Z - 0.4), 0.7, 4);
          grave(dst, x + seg * rr(0.25, 0.75), s * (WALL_Z - 0.85));
        }
        x += seg;
      }
      for (let bx = x0 + 1.3; bx < x1; bx += rr(2.4, 3.2))   // 外侧扶壁
        dst.push(boxG(0.55, rr(2.2, 3.0), 0.9, bx, 1.1, s * (WALL_Z + 0.55), PAL.stoneDeep, { jitter: 0.08 }));
    }
  };
  // —— 袋形墓苑：环形残墙（避开东西两口）+ 院内容物 ——
  const pocketWall = (dst: THREE.BufferGeometry[], cx: number, tone = PAL.stoneDark): void => {
    for (let i = 0; i < 14; i++) {
      const a = Math.PI + (Math.PI * 2 * i) / 14;        // 从 -X 口起顺时针
      const mouth = Math.abs(Math.cos(a % (Math.PI * 2))) > 0.907;  // 东西两轴 ±25° 让口
      if (mouth || rnd() < 0.12) continue;               // 让口 + 随机残缺
      const r = rr(7.0, 7.9);
      dst.push(boxG(3.3, rr(1.8, 3.2), 0.5, cx + Math.cos(a) * r, rr(0.9, 1.6), Math.sin(a) * r, tone, { ry: -a + Math.PI / 2, jitter: 0.1 }));
    }
  };

  // —— A1 出生台地（-142..-130）：来路悬崖封死 + 破拱门出口 + 篝火空场 ——
  {
    const W = structW;
    for (let i = 0; i < 3; i++)                          // 西缘崖壁（高差封路；ry=0 窄厚板，东缘角点 ≤-148.2——跟背相机口袋最深 -147.4，留 ≥0.7m 不黑帧）
      W.push(boxG(rr(2.6, 3.4), rr(5.5, 9), rr(5, 9), -150.2 - i * 1.8, rr(2.2, 4.4), rr(-3.5, 3.5), PAL.stoneDeep, { rz: rr(-0.04, 0.04), jitter: 0.1 }));
    W.push(dodG(1.4, -147.6, 0.7, 2.8, PAL.stoneDeep, { ry: 0.7 }));   // 崖脚巨石
    W.push(dodG(1.0, -147.2, 0.5, -2.4, PAL.stoneDeep, { ry: 1.9 }));
    for (const s of [-1, 1]) {                           // 台地南北缘石（低矮，围出安全区轮廓）
      let x = -141.4;
      while (x < -130.2) {
        const seg = rr(1.6, 3.0);
        W.push(boxG(seg, rr(0.5, 0.9), rr(0.5, 0.8), x + seg / 2, 0.25, s * rr(3.6, 4.0), PAL.stoneMid, { ry: rr(-0.1, 0.1), jitter: 0.12 }));
        x += seg + rr(0.2, 0.9);
      }
    }
    for (const s of [-1, 1]) {                           // 破拱门（A1→A2 唯一出口）
      W.push(boxG(1.0, 3.6, 1.0, -130.1, 1.8, s * 3.0, PAL.stoneMid, { jitter: 0.1 }));
      W.push(boxG(0.8, 0.6, 0.8, -130.1, 3.8, s * 1.9, PAL.stone));
    }
    W.push(boxG(1.3, 0.55, 4.6, -130.1, 3.95, 0, PAL.stoneMid, { rz: 0.03, jitter: 0.08 }));       // 拱梁
    W.push(boxG(0.7, 0.5, 0.7, -130.0, 4.4, -0.9, PAL.stone, { ry: 0.5, rz: 0.2 }));               // 梁上残块
    candleNook(W, -130.62, 1.7, 2.28, Math.PI / 2);      // 拱门双壁烛龛（余烬微光引路向东）
    candleNook(W, -130.62, 1.7, -2.28, Math.PI / 2);
    {
      const light = new THREE.PointLight(COLORS.ember, 4.5, 8, 2);   // A1 烛光（场景第 3 盏 ≤5 预算）
      light.position.set(-130.4, 2.1, 0);
      root.add(light);
      glowLights.push({ light, ph: 1.1 });
    }
    grave(W, -138.4, -2.6); grave(W, -136.2, 2.7); grave(W, -133.4, -2.9);                          // 台地散碑
    W.push(cylG(0.04, 0.06, 1.5, 6, -133.9, 0.75, 3.4, 0x2c2620, { rz: 0.12 }));                    // 拴魂小杆
    rubble(W, -137.5, 1.8, 0.5, 5);
  }

  // —— A2 墓园径：西径(-130..-101) / 中径(-89..-51) / 东径(-39..雾门) ——
  wallRun(structW, -130, -101);
  wallRun(structW, -89, -51);
  wallRun(structE, -39, GATE_X - 1.2);
  for (let i = 0; i < 6; i++) grave(structW, rr(-129, -103), (rnd() < 0.5 ? -1 : 1) * rr(4.2, 6.5));   // 西径墙外墓群
  for (let i = 0; i < 7; i++) grave(structW, rr(-88, -52), (rnd() < 0.5 ? -1 : 1) * rr(4.2, 6.8));     // 中径墙外墓群
  for (let i = 0; i < 7; i++) grave(structE, rr(-38, -12), (rnd() < 0.5 ? -1 : 1) * rr(4.2, 6.8));     // 东径墙外墓群（Boss 前，更密）
  for (const [rx, rz] of [[-118, 1.9], [-112, -1.7], [-64, 1.6], [-58, -1.8], [-34, 1.7], [-16, -1.6]] as const) {
    rubble(rx < -39 ? structW : structE, rx, rz, 0.5, 4);                                              // 路缘碎石
  }
  // 侧墓龛（中径北壁，死路分支的魂点示意）：壁龛 + 骨堆 + 烛芯
  {
    const nx = -66;
    structW.push(boxG(2.6, 2.8, 0.4, nx, 1.4, -3.28, PAL.stoneDeep, { jitter: 0.1 }));   // 龛背（墙外侧掏洞感）
    structW.push(boxG(0.5, 2.6, 1.4, nx - 1.5, 1.3, -2.7, PAL.stoneMid, { jitter: 0.1 }));
    structW.push(boxG(0.5, 2.6, 1.4, nx + 1.5, 1.3, -2.7, PAL.stoneMid, { jitter: 0.1 }));
    structW.push(boxG(3.2, 0.4, 1.5, nx, 2.85, -2.7, PAL.stoneMid));
    for (let i = 0; i < 4; i++) structW.push(boxG(0.07, rr(0.25, 0.4), 0.07, nx + rr(-0.8, 0.8), 0.14, -2.9 + rr(-0.4, 0.4), PAL.bone, { rz: rnd() * 3, ry: rnd() * 3 }));  // 散骨
    candleNook(structW, nx, 0.5, -2.95, 0);              // 龛内烛芯（余烬微光标记魂点）
  }

  // —— 袋形墓苑 I（c=-95，破礼拜堂院）+ 袋形墓苑 II（c=-45，沉坑墓苑） ——
  pocketWall(structW, -95);
  {
    const cx = -95;
    structW.push(boxG(0.9, 3.4, 0.6, cx + 2.4, 1.7, -4.2, PAL.stoneDark, { ry: 0.4, jitter: 0.1 }));     // 礼拜堂残墙 L1
    structW.push(boxG(0.6, 2.6, 2.8, cx + 2.0, 1.3, -2.9, PAL.stoneDark, { ry: 0.4, jitter: 0.1 }));    // L2
    structW.push(boxG(1.7, 0.9, 0.8, cx - 1.8, 0.45, 2.6, PAL.stoneMid, { ry: -0.2 }));                // 断祭台
    structW.push(boxG(0.14, 1.1, 0.14, cx - 1.8, 1.35, 2.6, PAL.steel, { rz: 0.16 }));                 // 台上断十字
    structW.push(boxG(0.5, 0.11, 0.14, cx - 1.8, 1.62, 2.6, PAL.steel, { rz: 0.16 }));
    grave(structW, cx - 3.4, -1.4); grave(structW, cx + 0.6, -3.6); grave(structW, cx - 0.8, 4.4); grave(structW, cx + 3.6, 3.2); grave(structW, cx - 4.6, 2.9);
    structW.push(cylG(0.04, 0.13, 2.1, 6, cx + 4.4, 1.05, -4.6, 0x2c2620, { rz: -0.14, jitter: 0.15 })); // 院内枯树干
    rubble(structW, cx + 1.2, 0.8, 0.55, 5);
  }
  pocketWall(structW, -45);
  {
    const cx = -45;
    for (let i = 0; i < 10; i++) {                       // 沉坑缘石环（比地面低半层的坟苑口）
      const a = (i / 10) * Math.PI * 2;
      if (Math.abs(Math.cos(a)) > 0.9) continue;
      structW.push(boxG(1.4, rr(0.3, 0.55), 0.55, cx + Math.cos(a) * rr(4.6, 5.6), 0.16, Math.sin(a) * rr(4.6, 5.6), PAL.stoneDeep, { ry: -a, jitter: 0.12 }));
    }
    for (let i = 0; i < 5; i++)                          // 中央骸骨冢：乱骨 + 断剑堆
      structW.push(boxG(rr(0.5, 1.1), rr(0.18, 0.4), rr(0.3, 0.6), cx + rr(-0.9, 0.9), 0.12 + i * 0.09, rr(-0.9, 0.9), PAL.bone, { ry: rnd() * 3, rz: rr(-0.2, 0.2), jitter: 0.15 }));
    structW.push(boxG(0.055, 1.0, 0.02, cx - 0.4, 0.5, 0.3, PAL.steel, { rz: 0.5 }));
    structW.push(boxG(0.055, 0.9, 0.02, cx + 0.5, 0.42, -0.4, PAL.steel, { ry: 1.2, rz: -0.42 }));
    grave(structW, cx - 3.0, -3.2); grave(structW, cx + 3.4, -2.6); grave(structW, cx - 3.6, 3.4); grave(structW, cx + 2.8, 4.2); grave(structW, cx + 0.4, -4.8); grave(structW, cx - 0.6, 4.9);
    rubble(structW, cx + 1.8, -1.6, 0.5, 6);
  }

  // —— 雾门收头：门墩 + 收口墙 + 双火盆（沿用原版火盆造型） ——
  {
    const E = structE;
    for (const s of [-1, 1]) {                           // 门墩 + 收口墙（雾门 plane 3.6m 宽，门内收到 ±1.8）
      E.push(boxG(0.85, 3.4, 0.85, GATE_X - 0.05, 1.7, s * 2.3, PAL.stoneMid, { jitter: 0.1 }));
      E.push(boxG(1.05, 0.24, 1.05, GATE_X - 0.05, 3.5, s * 2.3, PAL.stone));
      E.push(boxG(0.6, 2.6, 0.5, GATE_X, 1.3, s * 2.28, PAL.stoneDark, { jitter: 0.08 }));   // 收口垛（fog plane 侧缘）
    }
    E.push(boxG(0.9, 0.5, 5.4, GATE_X - 0.05, 2.7, 0, PAL.stoneMid, { rz: 0.02, jitter: 0.08 }));  // 门楣过梁
    brazier(E, GATE_X - 1.05, 3.05, 0);
    brazier(E, GATE_X - 1.05, -3.05, 2.4);
  }

  // —— A3 古达 Boss 房（d24，c=-1.5）：残柱环 + 外圈墓群（敞场废墟，沿用原版竞技场语言） ——
  {
    const E = structE, cx = A3C;
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * Math.PI * 2 + 0.28;
      if (Math.abs(Math.cos(a)) > 0.86) continue;        // 让开东西两口（雾门/门 B）
      const x = cx + Math.cos(a) * 11.5, z = Math.sin(a) * 11.5;
      const h = 1.5 + ((i * 7919) % 100) / 100 * 2.0;
      E.push(boxG(0.85, 0.26, 0.85, x, 0.13, z, PAL.stoneMid, { jitter: 0.08 }));
      E.push(cylG(0.3, 0.35, h, 9, x, 0.26 + h / 2, z, PAL.stone, { jitter: 0.1 }));
      E.push(boxG(0.56, 0.34, 0.56, x, 0.36 + h, z, PAL.stoneMid, { ry: rnd() * 3, rz: rr(-0.08, 0.08), jitter: 0.1 }));
    }
    for (let i = 0; i < 16; i++) {                       // 外环墓群（墙界之外）
      const a = (i / 16) * Math.PI * 2 + 0.22;
      if (Math.abs(Math.cos(a)) > 0.82) continue;
      grave(E, cx + Math.cos(a) * rr(13.5, 16.5), Math.sin(a) * rr(13.5, 16.5));
    }
    rubble(E, cx + 3.5, -4.8, 0.7, 7); rubble(E, cx - 4.6, 5.2, 0.6, 6); rubble(E, cx + 6.8, 2.2, 0.6, 5);
    // 门 B（A 区东界 → C 区）：黑拱 + 幽蓝门槛光（进出无碰撞，深处由主线程 zoneUnlocks 把关）
    E.push(boxG(1.0, 3.8, 1.0, DOOR_B + 0.15, 1.9, 1.98, PAL.cryptMid, { jitter: 0.08 }));
    E.push(boxG(1.0, 3.8, 1.0, DOOR_B + 0.15, 1.9, -1.98, PAL.cryptMid, { jitter: 0.08 }));
    E.push(boxG(1.2, 0.6, 4.6, DOOR_B + 0.15, 3.9, 0, PAL.cryptMid, { jitter: 0.08 }));
    E.push(boxG(0.5, 3.4, 3.6, DOOR_B + 0.55, 1.7, 0, PAL.cryptDeep));                   // 拱内黑洞
    blueGeoms.push(boxG(0.14, 2.9, 3.1, DOOR_B + 0.9, 1.45, 0, 0x000000));              // 门槛幽光（蓝批）
  }

  // —— C1 法兰哨路（9.6..45.9，36m 下沉暗廊）：高墙 + 箭缝 + 蓝灯笼龛 + 军旗 + 骨堆 ——
  {
    const C = structC;
    for (const s of [-1, 1]) {
      let x = DOOR_B + 0.4;
      while (x < C2_W - 0.4) {
        const seg = Math.min(rr(3.8, 5.6), C2_W - 0.4 - x);
        const h = rr(4.0, 4.8);
        C.push(boxG(seg - 0.08, h, 0.6, x + seg / 2, h / 2, s * WALL_Z, PAL.cryptDark, { jitter: 0.09 }));
        C.push(boxG(seg, 0.22, 0.85, x + seg / 2, h + 0.11, s * WALL_Z, PAL.cryptMid));
        x += seg;
      }
      for (let bx = DOOR_B + 1.6; bx < C2_W - 0.6; bx += rr(2.8, 3.6)) {   // 扶壁（更深更重）
        C.push(boxG(0.7, rr(3.6, 4.4), 1.1, bx, 1.7, s * (WALL_Z + 0.6), PAL.cryptDeep, { jitter: 0.08 }));
        C.push(boxG(0.16, 0.8, 0.14, bx, 3.1, s * 2.94, PAL.cryptDeep));   // 箭缝（暗龛）
        blueGeoms.push(boxG(0.05, 0.62, 0.1, bx, 3.1, s * 2.88, 0x000000)); // 缝内幽蓝（蓝批）
      }
    }
    const lantern = (x: number, s: number): void => {    // 壁挂蓝灯笼：龛 + 吊杆 + 光芯（蓝批）
      C.push(boxG(0.9, 1.3, 0.35, x, 2.9, s * 3.0, PAL.cryptMid, { jitter: 0.08 }));
      C.push(cylG(0.03, 0.03, 0.5, 5, x, 2.35, s * 2.86, PAL.bone));
      C.push(boxG(0.34, 0.44, 0.2, x, 2.05, s * 2.82, PAL.cryptDeep));
      blueGeoms.push(boxG(0.2, 0.3, 0.12, x, 2.05, s * 2.78, 0x000000));
    };
    lantern(15, 1); lantern(23, -1); lantern(31, 1); lantern(39, -1);
    const banner = (x: number, s: number): void => {     // 法兰残旗：杆 + 横杆 + 破旗面（静置）
      C.push(cylG(0.045, 0.06, 4.6, 7, x, 2.3, s * 3.1, 0x2c2620, { rz: rr(-0.05, 0.05), jitter: 0.1 }));
      C.push(cylG(0.03, 0.03, 1.1, 5, x, 4.2, s * 2.6, 0x2c2620, { rx: Math.PI / 2, ry: s * 0.4 }));
      C.push(boxG(0.04, rr(0.9, 1.3), 0.75, x + rr(-0.1, 0.1), 3.55, s * 2.45, s > 0 ? PAL.bannerBlue : PAL.bannerBlueB, { ry: rr(-0.2, 0.2), rz: rr(-0.08, 0.08), jitter: 0.12 }));
    };
    banner(19, 1); banner(35, -1);
    const bones = (x: number, s: number): void => {      // 廊内骨堆（监视者的旧部）
      for (let i = 0; i < 5; i++)
        C.push(boxG(rr(0.06, 0.16), rr(0.06, 0.13), rr(0.06, 0.14), x + rr(-0.7, 0.7), 0.08, s * rr(2.0, 2.8), PAL.bone, { ry: rnd() * 3, rz: rnd() * 3, jitter: 0.15 }));
      C.push(dodG(rr(0.16, 0.24), x, 0.16, s * 2.35, PAL.bone, { ry: rnd() * 3 }));
    };
    bones(12.5, -1); bones(27, 1); bones(33.5, -1); bones(43, 1);
    rubble(C, 21, -1.8, 0.55, 5); rubble(C, 41.5, 1.9, 0.5, 4);
  }

  // —— C2 监视者 Boss 房（d24，c=57）：尖碑环 + 东沿断王座 + 蓝烛台 ——
  {
    const C = structC, cx = C2C;
    for (let i = 0; i < 10; i++) {                       // 尖碑环（让开西口）
      const a = (i / 10) * Math.PI * 2 + 0.31;
      if (Math.cos(a) > 0.86) continue;
      const x = cx + Math.cos(a) * 11.5, z = Math.sin(a) * 11.5;
      const h = 2.2 + ((i * 7919) % 100) / 100 * 1.3;
      C.push(boxG(rr(0.5, 0.7), 0.3, rr(0.5, 0.7), x, 0.15, z, PAL.cryptMid, { ry: rnd() * 3, jitter: 0.1 }));
      C.push(boxG(rr(0.4, 0.55), h, rr(0.35, 0.5), x, 0.3 + h / 2, z, pick([PAL.crypt, PAL.cryptMid, PAL.cryptDark]), { ry: rnd() * 3, rz: rr(-0.06, 0.06), jitter: 0.12 }));
      if (rnd() < 0.5) C.push(coneG(0.22, rr(0.3, 0.6), 4, x, 0.3 + h + 0.2, z, PAL.cryptDark, { ry: rnd() * 3 }));  // 尖顶残段
    }
    for (let i = 0; i < 3; i++) {                        // 东沿断王座 ×3（Boss 背景地标，避开战斗半径）
      const z = -3.6 + i * 3.6;
      C.push(boxG(1.5, 0.5, 1.3, cx + 10.2, 0.25, z, PAL.cryptMid, { jitter: 0.1 }));
      C.push(boxG(1.4, rr(2.2, 3.2), 0.5, cx + 10.7, 1.4, z, PAL.cryptDark, { rz: rr(-0.08, 0.08), jitter: 0.1 }));
      C.push(boxG(0.5, rr(0.8, 1.4), 0.4, cx + 10.6, rr(1.2, 2.2), z + rr(-0.5, 0.5), PAL.cryptMid, { ry: rnd() * 3 }));
    }
    const candelabra = (a: number): void => {            // 蓝烛台（三脚 + 光芯）
      const x = cx + Math.cos(a) * 10.4, z = Math.sin(a) * 10.4;
      for (let i = 0; i < 3; i++) {
        const la = (i / 3) * Math.PI * 2 + 0.5;
        C.push(cylG(0.03, 0.04, 1.2, 5, x + Math.cos(la) * 0.2, 0.58, z + Math.sin(la) * 0.2, PAL.bone, { ry: -la, rz: 0.22 }));
      }
      C.push(cylG(0.3, 0.16, 0.22, 8, x, 1.24, z, PAL.cryptDeep));
      blueGeoms.push(dodG(0.15, x, 1.38, z, 0x000000));
    };
    candelabra(2.2); candelabra(3.6); candelabra(4.9);
    C.push(boxG(2.0, 2.4, 0.6, cx + 2.2, 1.2, -13.2, PAL.cryptMid, { ry: 0.3, jitter: 0.1 }));   // 南缘封死侧门（监视者胜后的 C2→A2 捷径位，T6 开）
    C.push(boxG(1.4, 1.8, 0.4, cx + 2.0, 0.9, -13.5, PAL.cryptDeep, { ry: 0.3 }));
    rubble(C, cx - 4.5, -6.2, 0.6, 6); rubble(C, cx + 5.5, 6.5, 0.6, 6); rubble(C, cx - 7.5, 3.5, 0.5, 5);
  }

  // —— 地面：台地/石板长卷/墓苑/竞技场环纹/暗廊/王座厅 + 大地（receive 批，西/东两分块） ——
  {
    const W = floorW, E = floorE;
    W.push(boxG(110, 0.12, 74, -91, -0.07, 0, 0x14161b, { jitter: 0.05 }));              // 大地·西半（远景基面）
    E.push(boxG(112, 0.12, 74, 20, -0.07, 0, 0x14161b, { jitter: 0.05 }));               // 大地·东半
    W.push(boxG(12.6, 0.16, 7.2, -136, -0.02, 0, PAL.mortar, { jitter: 0.08 }));         // A1 台地基座
    const slabRun = (dst: THREE.BufferGeometry[], x0: number, x1: number, tones: number[]): void => {
      let i = 0;
      for (let x = x0; x < x1; x += 1.15) {
        dst.push(boxG(1.06, 0.07, 5.9, x + 0.53, 0.004 + (i % 2) * 0.004, rr(-0.02, 0.02), tones[i % tones.length], { jitter: 0.07 }));
        i++;
      }
    };
    slabRun(W, -130, -101.2, [PAL.pathA, PAL.pathB, PAL.pathC, PAL.pathB]);
    slabRun(W, -88.8, -51.2, [PAL.pathB, PAL.pathC, PAL.pathA, PAL.pathB]);
    slabRun(E, -38.8, GATE_X - 0.4, [PAL.pathC, PAL.pathA, PAL.pathB, PAL.pathB]);
    W.push(paint(new THREE.CircleGeometry(7.0, 40).rotateX(-Math.PI / 2).translate(-95, 0.001, 0), COLORS.ground, 0.05));   // 墓苑 I 场地
    W.push(paint(new THREE.CircleGeometry(7.0, 40).rotateX(-Math.PI / 2).translate(-45, 0.001, 0), COLORS.ground, 0.05));   // 墓苑 II 场地
    E.push(paint(new THREE.CircleGeometry(12.2, 48).rotateX(-Math.PI / 2).translate(A3C, 0.001, 0), COLORS.ground, 0.05));  // A3 场地
    E.push(paint(new THREE.RingGeometry(2.6, 3.0, 44).rotateX(-Math.PI / 2).translate(A3C, 0.012, 0), 0x1c2026, 0.06));     // A3 环纹 ×2
    E.push(paint(new THREE.RingGeometry(8.4, 8.9, 44).rotateX(-Math.PI / 2).translate(A3C, 0.014, 0), 0x1b1f24, 0.06));
    W.push(paint(new THREE.CircleGeometry(1.0, 20).rotateX(-Math.PI / 2).translate(-140.5, 0.015, 0), PAL.ash, 0.12));      // 篝火灰圈
    slabRun(E, DOOR_B + 0.3, C2_W - 0.2, [PAL.cryptPath, PAL.cryptPathB, PAL.cryptPath, PAL.cryptPathB]);                    // C1 暗廊石板
    E.push(paint(new THREE.CircleGeometry(12.2, 48).rotateX(-Math.PI / 2).translate(C2C, 0.001, 0), 0x191c22, 0.05));       // C2 场地
    E.push(paint(new THREE.RingGeometry(3.1, 3.55, 44).rotateX(-Math.PI / 2).translate(C2C, 0.012, 0), 0x232a38, 0.07));    // C2 深蓝徽环（法兰纹）
    E.push(paint(new THREE.RingGeometry(9.0, 9.4, 44).rotateX(-Math.PI / 2).translate(C2C, 0.014, 0), 0x1d2129, 0.06));
  }

  root.add(batch(structW, stoneMat, "both"));
  root.add(batch(structE, stoneMat, "both"));
  root.add(batch(structC, stoneMat, "both"));
  root.add(batch(floorW, stoneMat, "receive"));
  root.add(batch(floorE, stoneMat, "receive"));
  const coalMat = track(new THREE.MeshStandardMaterial({ color: 0x2a1207, emissive: COLORS.ember, emissiveIntensity: 1.4, roughness: 1, flatShading: true }));
  root.add(batch(coalGeoms, coalMat, "none"));
  const blueMat = track(new THREE.MeshStandardMaterial({ color: 0x0d1420, emissive: 0x4a6f94, emissiveIntensity: 1.5, roughness: 1, flatShading: true }));
  root.add(batch(blueGeoms, blueMat, "none"));

  // ---------------- 灰烬斑：走廊/墓苑/竞技场的半透明暗斑（单 Mesh 单材质） ----------------
  {
    const patchGeoms: THREE.BufferGeometry[] = [];
    for (const px of [-124, -110, -84, -70, -56, -34, -22]) {
      patchGeoms.push(new THREE.CircleGeometry(rr(0.8, 1.5), 16).rotateX(-Math.PI / 2).translate(px + rr(-1, 1), 0.02, rr(-1.6, 1.6)));
      patchGeoms.push(new THREE.CircleGeometry(rr(0.6, 1.2), 16).rotateX(-Math.PI / 2).translate(px + rr(-2, 2), 0.02, rr(-1.6, 1.6)));
    }
    for (const [px, pz, pr] of [[-95, 2.5, 1.8], [-45, -2.0, 1.6], [A3C + 2, -3, 2.0], [C2C - 1, 2, 2.2]] as const)
      patchGeoms.push(new THREE.CircleGeometry(pr, 18).rotateX(-Math.PI / 2).translate(px, 0.02, pz));
    for (const px of [16, 28, 40]) patchGeoms.push(new THREE.CircleGeometry(rr(0.7, 1.3), 16).rotateX(-Math.PI / 2).translate(px, 0.02, rr(-1.4, 1.4)));
    const patches = new THREE.Mesh(mergeGeometries(patchGeoms, false)!, track(new THREE.MeshBasicMaterial({ color: 0x0a0b0e, transparent: true, opacity: 0.4, depthWrite: false })));
    for (const g of patchGeoms) g.dispose();
    root.add(patches);
  }

  // ---------------- 飘灰：110 粒缓落灰烬（全图分布，Points + 位置数组直写，区域内循环） ----------------
  const ASH_N = 110;
  const ASH_X0 = -146, ASH_X1 = 72;
  const ashPos = new Float32Array(ASH_N * 3);
  const ashVy = new Float32Array(ASH_N);
  const ashPh = new Float32Array(ASH_N);
  for (let i = 0; i < ASH_N; i++) {
    ashPos[i * 3] = rr(ASH_X0, ASH_X1); ashPos[i * 3 + 1] = rr(0.2, 5.5); ashPos[i * 3 + 2] = rr(-7, 7);
    ashVy[i] = rr(0.15, 0.42); ashPh[i] = rnd() * Math.PI * 2;
  }
  const ashGeo = new THREE.BufferGeometry();
  ashGeo.setAttribute("position", new THREE.BufferAttribute(ashPos, 3));
  const ash = new THREE.Points(ashGeo, track(new THREE.PointsMaterial({ size: 0.09, map: softDiscTexture(), color: 0x9aa2ac, transparent: true, opacity: 0.6, depthWrite: false, sizeAttenuation: true })));
  ash.frustumCulled = false;
  root.add(ash);

  // ---------------- update：飘灰 / 火焰闪烁 / 炭芯呼吸 / 流云漂移 / 天穹+阴影随玩家 ----------------
  let animT = 0;
  let playerRef: THREE.Object3D | null = null;           // 玩家 GLB 根节点名 "Undead"（player.root 为无名 Group，包它一层）
  const scratch = new THREE.Vector3();
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
          ashPos[j] = rr(ASH_X0, ASH_X1); ashPos[j + 1] = rr(4.5, 6.5); ashPos[j + 2] = rr(-7, 7);
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
    coalMat.emissiveIntensity = 1.3 + Math.sin(animT * 7.3) * 0.3;          // 炭芯呼吸（A 区余烬）
    blueMat.emissiveIntensity = 1.35 + Math.sin(animT * 4.1 + 1.7) * 0.35;  // 幽蓝呼吸（C 区冷灯，异相位）
    for (const gl of glowLights)                                            // 壁烛点光：光强呼吸（无火苗件）
      gl.light.intensity = 4.1 + Math.sin(animT * 8.3 + gl.ph) * 0.8 + Math.sin(animT * 21 + gl.ph * 2) * 0.4;
    {                                                    // 流云：wrap 循环漂移 + 边缘渐隐（随行组局部坐标）
      const span = CLOUD.max - CLOUD.min;
      const x = CLOUD.min + (((animT * cloud.sp) % span) + span) % span;
      const k = Math.min(1, Math.max(0, Math.min((x - CLOUD.min) / CLOUD.fade, (CLOUD.max - x) / CLOUD.fade)));
      cloud.mesh.position.x = x;
      cloud.mat.opacity = cloud.o * k * k;
    }
    // 天穹/冷月随玩家 x（无限远背景恒在 far=120 内）；阴影窗 2m 网格吸附（防像素质心抖动）
    if (!playerRef || playerRef.parent === null) playerRef = scene.getObjectByName("Undead") ?? null;
    if (playerRef) {
      playerRef.getWorldPosition(scratch);
      skyGroup.position.x = scratch.x;
      const sx = Math.round(scratch.x / 2) * 2;
      moonLight.position.set(sx + 19, 6, -7);
      moonTarget.position.set(sx - 2, 0, 0);
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
