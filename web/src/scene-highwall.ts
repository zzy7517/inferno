/** 场景二「洛斯里克的高墙」——纯程序化环境（ADR-0006：冷灰蓝基调 + 火光唯一强调色）
 *
 * m4 T4 扩建（docs/design/m4-level-flow.md §3.2）：80×60m 级 DS3 尺度，B/D 两区西→东一线铺开：
 *   B 区（id "highwall:B"，progress.ZONE_OF.vordt）
 *     B1 城下街区（x -282 → -170：北侧城郭楼影 + 长墙雉堞）
 *     B2 城墙步道（x -170 → -4：双缘雉堞 + 破拱门 + 深渊缺口，玻尔多雾门在 x=-4）
 *     B3 玻尔多房（圆心 16.1 r21，可走直径 40.2；西门=雾门 x=-4，东门接月坛，双塔夹峙）
 *   D 区（id "highwall:D"，progress.ZONE_OF.sulyvahn，监视者胜后解锁）
 *     D1 教宗月坛（x 36 → 81：下沉廊道 + 月纹阶 + 封印门在廊西口；随玻尔多东扩整段东移）
 *     D2 沙力万房（圆心 99.1 r19，可走直径 36.2，西开门接月坛阶，苍白月石环墙）
 * 步程对标：spawn(-276)→雾门(-4) 直跑 272m @6.2m/s ≈ 43.9s（§1.3 大区 40–60s）。
 * 主线走廊 x 单调（clampWorld v2 逐区钳制口径），80×60 以上的路程靠廊道长度达成。
 *
 * 视觉对标 DS3 高墙：夜空穹顶渐变 + 冷月与光晕 + 两层远山/城堡剪影(窗火闪烁) +
 *   主城墙/雉堞/双塔/破拱门 + 残旗(顶点摆动) + 石板路/断柱/枯树/瓦砾 + 脚下深渊与雾海中的下层城区。
 * 走廊美术深加工（B/D 长廊视觉密度）：~34m 节奏节点（壁龛烛龛/坍塌断梁/悬挑哨位/箭缝月光轮换）+
 *   纵向双层墙（粗石基座+檐线+上段城齿剪影）+ 四处地标认路锚（-200 断桥拱影 / -120 绞刑架鸟群 /
 *   -60 城门楼过洞 / -21 龙骨翼残像）+ D 月坛前导（幽蓝箭缝/月尘缓升/封印符文环）+
 *   氛围（远雷双闪、雾色沿 x 暖→冷渐变）；新增 emissive 一批 + 月尘一档 dc。
 * 预算：纯几何 + 顶点色（paint 统一上色），静态几何按 5 个空间分块 merge 合批（frustum 剔剪），
 *   场景本体 ≤45 draw call；火光 PointLight ≤5（挂火×2 + 火盆×1 + 月坛烛台×2）；
 *   不加载任何外部资源（光晕/雾片贴图为运行时 Canvas 生成）。
 * 大场景适配（不改 game.ts）：天球/星月/流云编入 celestial 组，经 sky.onBeforeRender 逐帧
 *   对齐相机（否则约 400m 跨度会穿出 r96 天球）；月光主灯同步跟随——
 *   阴影相机 ±17m 窗口随玩家平移，全程阴影覆盖不打折扣。
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { COLORS } from "./config";
import { createSceneGeom } from "./scene-geom";

export interface SceneAnchors {
  spawn: THREE.Vector3;
  bonfire: THREE.Vector3;
  fogGate: THREE.Vector3;
  bossArena: THREE.Vector3;
  arenaRadius: number;
  corridorMinX: number;
  /** v2（m4 T2）：分区布局。缺省时按 legacy 单走廊+单竞技场钳制（上方六字段）。
   *  zones 西→东有序；zone.id 与 progress.ZONE_OF 对齐（"cemetery:A" 等），
   *  未解锁区域在衔接 x 处形成单向墙（clampWorld），T6 捷径/门可视化在此基础上扩展。 */
  zones?: SceneZone[];
}

export interface SceneZone {
  id: string;                       // "cemetery:A" / "stormveil:E4" …（progress.zoneUnlocks 键）
  kind: "corridor" | "arena";
  minX: number;                     // x 区间（西界）
  maxX: number;                     // x 区间（东界=与下一区衔接门）
  half?: number;                    // corridor：z 半宽（默认 1.45）
  center?: THREE.Vector3;           // arena：圆心（y=0）
  r?: number;                       // arena：半径（钳制用 r-0.9）
}

/** 派生色板：石色系中间阶（ADR-0006 纪律）+ 夜空冷灰蓝（压低饱和度）；强调色仅 ember/gold 系 */
const PAL = {
  stoneHi: 0x474c54, stone: COLORS.stone, stoneMid: 0x34383f, stoneDark: COLORS.stoneDark,
  stoneDeep: 0x232529, mortar: 0x191b20, dark: 0x0a0b0e, cliff: 0x1e2127,
  pathA: COLORS.groundPath, pathB: 0x33302c, pathC: 0x383733,
  abyss: 0x101218, roofA: 0x1a1d24, roofB: 0x15171d,
  skyTop: 0x07090f, skyHorizon: 0x1a2130, skyUnder: 0x0c0e13,
  ridgeFar: 0x151b27, ridgeNear: 0x0f141d,
  flagBlue: 0x3a4257, flagBlueB: 0x232a3c, flagChar: 0x2b2f38, flagCharB: 0x1b1e25,
  flagGold: 0x635438, flagGoldB: 0x453a28,
  wood: 0x2c2620, metal: 0x4e535b, bone: 0x4a4436, ash: 0x17140f, goldDim: 0x6b5c3f,
  moonPale: 0x39404e, moonDeep: 0x1a2030, sealIndigo: 0x2b3350,
  moonGlow: 0x8fa6c8, sealBlue: 0x5a7fb4, rune: 0x9db9e8, bird: 0x0b0d11,
};

// ---------------- 布局常数（m4 §3.2；与 zones/锚点同源） ----------------
/** B 区走廊（B1 城下街区 + B2 城墙步道）：278m 长廊，净宽 4.8m */
const B_CORR = { minX: -282, maxX: -4, half: 2.4 };
/** B3 玻尔多房：r=21（可走直径 40.2）。西可走边钉在雾门 x=-4，圆心因此东移到 16.1。 */
const ARENA_B = { cx: -4 + (21 - 0.9), r: 21 };
/** 玻尔多东可走边 18.2→36.2 的外推量。月坛与沙力万整段东移，东门才不会被圆吞掉。 */
const B_EAST_DX = 18;
/** D1 教宗月坛（下沉月纹廊）。宽度不变，西口随东移落在玻尔多东可走边内侧 0.2m。 */
const D_CORR = { minX: 18 + B_EAST_DX, maxX: 63 + B_EAST_DX, half: 2.4 };
/** D2 沙力万房：r=19（可走直径 36.2）。西可走边钉在月坛东口，圆心再因此东移。 */
const ARENA_D = { cx: 63 + B_EAST_DX + (19 - 0.9), r: 19 };
/** B 走廊空间分块（合批边界=frustum 剔剪边界） */
const B_CHUNKS: [number, number][] = [[-282, -226.4], [-226.4, -170.8], [-170.8, -115.2], [-115.2, -59.6], [-59.6, -4]];
/** 环墙开门半角：墙根净宽保持约 6.4m（旧 2×12.3×sin0.26），盖过走廊 4.8m，不随半径撑开。 */
const doorPhi = (r: number): number => Math.asin(3.2 / (r + 0.3));

// ---------------- 确定性随机（场景每次构建一致） ----------------
let seed = 20260317;
const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
const rr = (a: number, b: number): number => a + rnd() * (b - a);
const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length) % arr.length];
const fract = (v: number): number => v - Math.floor(v);
/** 位置哈希：重合顶点得到同一扰动，避免拼接缝开裂 */
const hashXZ = (x: number, z: number, ch: number): number =>
  fract(Math.sin(x * 127.1 + z * 311.7 + ch * 74.7) * 43758.5453);

/** 与另外两个场景同一份实现；jitter 仍消耗本文件的 rnd。 */
const { paint, boxG, cylG, coneG, dodG, batch } = createSceneGeom(rnd);

/** 运行时 Canvas 径向柔光贴图（月亮光晕 / 地面雾片共用，非外部资源） */
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

// ---------------- 残旗：撕裂旗面 + 竖向风化渐变顶点色 ----------------
function flagGeo(w: number, h: number, colA: number, colB: number): { geo: THREE.BufferGeometry; orig: Float32Array } {
  const g = new THREE.PlaneGeometry(w, h, 7, 10);
  const p = g.attributes.position as THREE.BufferAttribute;
  const cols = 7, rows = 10;
  for (let iy = 0; iy <= rows; iy++) {
    for (let ix = 0; ix <= cols; ix++) {
      const i = iy * (cols + 1) + ix;
      if (iy === rows && ix % 2 === 1) p.setY(i, p.getY(i) + h * (0.1 + ((ix * 37) % 11) / 60)); // 底边撕裂缺口
      if (iy === rows || ix === 0 || ix === cols) p.setX(i, p.getX(i) + (((ix * 53 + iy * 29) % 13) - 6) / 200); // 侧缘毛边
    }
  }
  g.translate(0, -h / 2, 0); // 顶边为挂点 y=0，向下垂
  const ng = g.toNonIndexed();
  g.dispose();
  const pos = ng.attributes.position;
  const arr = new Float32Array(pos.count * 3);
  const a = new THREE.Color(colA), b = new THREE.Color(colB), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const k = Math.min(1, Math.max(0, -pos.getY(i) / h)); // 0=挂点 1=垂底
    c.copy(a).lerp(b, k);
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  ng.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  const orig = new Float32Array((ng.attributes.position as THREE.BufferAttribute).array as Float32Array);
  return { geo: ng, orig };
}

interface FlagRef { mesh: THREE.Mesh; orig: Float32Array; h: number; ph: number; sp: number }
/** 火焰组：成对火盆合并为单 mesh（顶点级闪烁——绕各自火位缩放/摆动，不整mesh变换）；每组可挂多盏灯 */
interface FlameRef {
  mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; lights: THREE.PointLight[];
  base: number; ph: number; orig: Float32Array; centers: [number, number, number][]; vpc: number;
}
interface MistRef { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; bx: number; bz: number; dx: number; dz: number; ph: number; spx: number; spz: number; o: number }
interface CloudRef { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; x0: number; sp: number; o: number; base: THREE.Color }

// ================================================================
export function buildHighWall(scene: THREE.Scene): {
  anchors: SceneAnchors;
  update: (t: number, dt: number) => void;
  dispose: () => void;
} {
  // 旅行/重进会重建场景：重置种子保证每次构建逐顶点一致
  seed = 20260317;

  const root = new THREE.Group();
  root.name = "highwall";
  scene.add(root);

  /** 锚点（legacy 六字段语义不变，坐标随 m4 扩建西移/扩建）+ zones v2 分区表 */
  const anchors: SceneAnchors = {
    spawn: new THREE.Vector3(-276, 0, 1.3),
    bonfire: new THREE.Vector3(-276, 0, 0),
    fogGate: new THREE.Vector3(B_CORR.maxX, 0, 0),          // 玻尔多雾门（B 走廊东口）
    bossArena: new THREE.Vector3(ARENA_B.cx, 0, 0),
    arenaRadius: ARENA_B.r,
    corridorMinX: B_CORR.minX,
    zones: [
      { id: "highwall:B", kind: "corridor", minX: B_CORR.minX, maxX: B_CORR.maxX, half: B_CORR.half },
      { id: "highwall:B", kind: "arena", minX: ARENA_B.cx - ARENA_B.r + 0.9, maxX: D_CORR.minX, center: new THREE.Vector3(ARENA_B.cx, 0, 0), r: ARENA_B.r },
      { id: "highwall:D", kind: "corridor", minX: D_CORR.minX, maxX: D_CORR.maxX, half: D_CORR.half },
      { id: "highwall:D", kind: "arena", minX: ARENA_D.cx - ARENA_D.r + 0.9, maxX: ARENA_D.cx + ARENA_D.r + 0.4, center: new THREE.Vector3(ARENA_D.cx, 0, 0), r: ARENA_D.r },
    ],
  };

  // 天空与雾（dispose 时还原）；雾色/密度沿 x 渐变（篝火暖 → 远处冷蓝，update 驱动）
  const prevBg = scene.background;
  const prevFog = scene.fog;
  scene.background = new THREE.Color(COLORS.bg);
  scene.fog = new THREE.FogExp2(COLORS.fog, 0.022);
  const fogWarm = new THREE.Color(COLORS.fog).lerp(new THREE.Color(0x302820), 0.5);
  const fogCold = new THREE.Color(COLORS.fog).lerp(new THREE.Color(0x1a263e), 0.6);

  const mats: THREE.Material[] = [];
  const track = <T extends THREE.Material>(m: T): T => { mats.push(m); return m; };

  // ---------------- 灯光：冷月光主灯（带阴影，窗口随相机）+ 半天环境光 ----------------
  const MOON_OFF = new THREE.Vector3(23.7, 15.5, -24.3);    // 原 (21.7,15.5,-24.3)−target(-2,0,0)：方向保持
  const moonLight = new THREE.DirectionalLight(COLORS.moon, 1.85);
  moonLight.position.copy(MOON_OFF);
  moonLight.castShadow = true;
  moonLight.shadow.mapSize.set(2048, 2048);
  Object.assign(moonLight.shadow.camera, { left: -17, right: 17, top: 14, bottom: -12, near: 2, far: 75 });
  moonLight.shadow.camera.updateProjectionMatrix();
  moonLight.shadow.bias = -0.0002;
  moonLight.shadow.normalBias = 0.03;
  const moonTarget = new THREE.Object3D();
  root.add(moonTarget);
  moonLight.target = moonTarget;
  root.add(moonLight);
  const HEMI_BASE = 0.72;                                 // 与墓地 0.68/城垣 0.85 同族的夜天光（走廊可读性）
  const hemiLight = new THREE.HemisphereLight(0x2a3242, 0x141110, HEMI_BASE);
  root.add(hemiLight);                                     // 远雷闪时整组瞬提（update）

  // ---------------- 天穹组（celestial）：随相机平移的"无限远"背景 ----------------
  // 约 400m 跨度下静态 r96 天球会穿出远平面：把夜穹/星野/冷月/流云编组，
  // 在 sky.onBeforeRender（每帧最先绘制）里对齐相机，同时平移月光灯保阴影窗口全程覆盖。
  const celestial = new THREE.Group();
  celestial.name = "celestial";
  root.add(celestial);
  let camX = B_CORR.minX;                                  // 相机 x（天穹随行回调记录；雾色沿 x 渐变用）
  let skyMat!: THREE.MeshBasicMaterial;                    // 天幕材质（远雷闪时整体提亮）

  // ---------------- 天幕：大球内壁竖向渐变（下暗上更暗、地平线微亮） ----------------
  {
    const R = 96;
    const geo = new THREE.SphereGeometry(R, 32, 20);
    const pos = geo.attributes.position;
    const colArr = new Float32Array(pos.count * 3);
    const top = new THREE.Color(PAL.skyTop), hor = new THREE.Color(PAL.skyHorizon), un = new THREE.Color(PAL.skyUnder);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const ny = pos.getY(i) / R;
      if (ny >= 0) c.copy(hor).lerp(top, Math.pow(Math.min(1, ny / 0.85), 0.65));
      else c.copy(hor).lerp(un, Math.min(1, -ny * 3.2));
      colArr[i * 3] = c.r; colArr[i * 3 + 1] = c.g; colArr[i * 3 + 2] = c.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colArr, 3));
    skyMat = track(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    const sky = new THREE.Mesh(geo, skyMat);
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    sky.onBeforeRender = (_r, _s, cam) => {
      camX = cam.position.x;
      celestial.position.set(cam.position.x, 0, cam.position.z);
      celestial.updateMatrixWorld(true);
      moonLight.position.set(cam.position.x + MOON_OFF.x, MOON_OFF.y, cam.position.z + MOON_OFF.z);
      moonTarget.position.set(cam.position.x, 0, cam.position.z);
      moonTarget.updateMatrixWorld();
    };
    celestial.add(sky);
  }

  // ---------------- 星野（微闪烁） ----------------
  const starMat = track(new THREE.PointsMaterial({ size: 0.62, vertexColors: true, transparent: true, opacity: 0.85, fog: false, depthWrite: false }));
  {
    const N = 240;
    const p = new Float32Array(N * 3);
    const c = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const u = rnd() * Math.PI * 2;
      const v = Math.acos(rr(0.18, 0.98));             // 只取上半球
      p[i * 3] = Math.sin(v) * Math.cos(u) * 90;
      p[i * 3 + 1] = Math.cos(v) * 90;
      p[i * 3 + 2] = Math.sin(v) * Math.sin(u) * 90;
      const b = 0.35 + rnd() * 0.65;                   // 偏冷白
      c[i * 3] = b * 0.82; c[i * 3 + 1] = b * 0.87; c[i * 3 + 2] = b;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    g.setAttribute("color", new THREE.BufferAttribute(c, 3));
    const stars = new THREE.Points(g, starMat);
    stars.renderOrder = -9;
    stars.frustumCulled = false;
    celestial.add(stars);
  }

  // ---------------- 冷月：亮盘+环形山暗斑+双层柔光晕（盘/斑合批省 1 dc） ----------------
  {
    const mg = new THREE.Group();
    mg.position.set(46, 33, -47);
    mg.lookAt(0, 3, 0);
    const discGeos = [
      new THREE.CircleGeometry(3.1, 48),
      new THREE.CircleGeometry(0.55, 20).translate(0.7, 0.8, 0.03),
      new THREE.CircleGeometry(0.4, 18).translate(-0.9, 0.2, 0.03),
      new THREE.CircleGeometry(0.3, 16).translate(0.2, -1.1, 0.03),
    ];
    const cols = [0xe3eaf6, 0xc6d0e0, 0xc6d0e0, 0xc6d0e0];
    const parts = discGeos.map((g, i) => paint(g, cols[i]));
    const moon = new THREE.Mesh(mergeGeometries(parts, false)!, track(new THREE.MeshBasicMaterial({ vertexColors: true, fog: false })));
    moon.renderOrder = -8;
    mg.add(moon);
    const tex = softDiscTexture();
    const halo1 = new THREE.Mesh(new THREE.PlaneGeometry(11, 11), track(new THREE.MeshBasicMaterial({ map: tex, color: 0x93a8c8, transparent: true, opacity: 0.34, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })));
    const halo2 = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 5.2), track(new THREE.MeshBasicMaterial({ map: tex, color: 0xd8e4f4, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })));
    halo1.renderOrder = 2;
    halo2.renderOrder = 2;
    mg.add(halo1, halo2);
    celestial.add(mg);
  }

  // ---------------- 夜空流云：冷灰蓝雾云带（穿月、边缘渐隐、wrap 循环漂移） ----------------
  const CLOUD_SPAN = { min: -82, max: 82, fade: 26 };
  const clouds: CloudRef[] = [];
  {
    const tex = softDiscTexture();
    const cloudPlane = new THREE.PlaneGeometry(1, 1);
    const defs = [
      { x: -30, y: 27.5, z: -41.5, w: 30, h: 11, o: 0.115, c: 0x7e8aa0, sp: 0.5 },
      { x: 6,   y: 30.0, z: -44.0, w: 42, h: 13, o: 0.09,  c: 0x9aa8bc, sp: 0.38 },
      { x: 44,  y: 24.5, z: -39.0, w: 24, h: 8,  o: 0.13,  c: 0x6b7789, sp: 0.62 },
    ];
    for (const d of defs) {
      const mat = track(new THREE.MeshBasicMaterial({ map: tex, color: d.c, transparent: true, opacity: 0, depthWrite: false, fog: false }));
      const mesh = new THREE.Mesh(cloudPlane, mat);
      mesh.scale.set(d.w, d.h, 1);
      mesh.position.set(d.x, d.y, d.z);
      mesh.lookAt(0, 3, 0);                                   // 正对玩家区，横亘天穹
      mesh.renderOrder = -6;                                  // 月亮盘(-8)之后、实体(0)之前画：云遮月
      celestial.add(mesh);
      clouds.push({ mesh, mat, x0: d.x, sp: d.sp, o: d.o, base: new THREE.Color(d.c) });
    }
  }

  // ---------------- 远景：两层远山 + 两座城堡剪影（fog:false 手绘雾色，窗火另建点云） ----------------
  const farGeoms: THREE.BufferGeometry[] = [];
  const winPts: number[] = [];                           // x,y,z, r,g,b 逐点（远堡窗火+下层城区窗火合用一个点云）
  const addWinFar = (x: number, y: number, z: number, dim = 1): void => {
    const c = new THREE.Color(rnd() < 0.3 ? COLORS.gold : COLORS.ember).multiplyScalar(0.55 + rnd() * 0.45 * dim);
    winPts.push(x, y, z, c.r, c.g, c.b);
  };
  /** 远山：六棱锥 + 位置哈希扰动（重合顶点同步，不开裂），山顶不受扰动保尖 */
  const peak = (r: number, h: number, x: number, y: number, z: number, color: number, jag = 0.4): void => {
    const g = new THREE.ConeGeometry(r, h, 6, 3);
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const ox = p.getX(i), oy = p.getY(i), oz = p.getZ(i);
      const k = (oy + h / 2) / h;                       // 0=山脚 1=峰顶
      p.setX(i, ox * (1 + (hashXZ(ox, oz, 1) - 0.5) * jag * (1.2 - k)));
      p.setZ(i, oz * (1 + (hashXZ(ox, oz, 2) - 0.5) * jag * (1.2 - k)));
    }
    g.translate(x, y + h / 2, z);
    farGeoms.push(paint(g, color, 0.1));
  };
  peak(46, 30, -28, -13, -66, PAL.ridgeFar);
  peak(55, 36, 30, -15, -70, PAL.ridgeFar);
  peak(30, 17, 72, -10, -60, PAL.ridgeFar);
  peak(38, 20, -62, -11, -58, PAL.ridgeFar);
  peak(30, 16, -12, -9, -52, PAL.ridgeNear);
  peak(36, 21, 38, -10, -54, PAL.ridgeNear);
  peak(22, 12, -45, -8, -46, PAL.ridgeNear);
  // 长廊中段的两座近山剪影（城下街区北望的 vista 时刻）
  peak(26, 15, -215, -9, -50, PAL.ridgeNear);
  peak(30, 17, -95, -10, -56, PAL.ridgeNear);
  // 城堡 A：月下主城（衬在竞技场远端——Boss 房的视觉锚）
  {
    const cx = 38, cy = -2, cz = -46;
    farGeoms.push(boxG(26, 3, 9, cx, cy - 1.5, cz, PAL.cliff, { jitter: 0.1 }));
    farGeoms.push(boxG(24, 6, 3, cx, cy + 3, cz, 0x10131b));
    for (let i = -2; i <= 2; i++) farGeoms.push(boxG(1.1, 1, 3.2, cx + i * 2.75, cy + 6.5, cz, 0x10131b));
    farGeoms.push(boxG(6.5, 16, 6.5, cx - 2, cy + 8, cz - 1, 0x0f121a));                    // 主堡
    farGeoms.push(coneG(4.4, 5.5, 4, cx - 2, cy + 18.7, cz - 1, 0x0d1018, { ry: Math.PI / 4 })); // 主堡尖顶
    farGeoms.push(boxG(3, 12, 3, cx - 11.5, cy + 6, cz + 0.5, 0x0f121a));                   // 左塔
    farGeoms.push(coneG(2.4, 4, 6, cx - 11.5, cy + 14, cz + 0.5, 0x0d1018));
    farGeoms.push(boxG(2.7, 10, 2.7, cx + 10.8, cy + 5, cz + 0.5, 0x0f121a));               // 右塔
    farGeoms.push(coneG(2.1, 3.4, 6, cx + 10.8, cy + 11.7, cz + 0.5, 0x0d1018));
    farGeoms.push(boxG(2.4, 8, 2.4, cx + 4.5, cy + 4, cz + 0.8, 0x0f121a));                // 中塔
    farGeoms.push(coneG(1.9, 3, 6, cx + 4.5, cy + 9.5, cz + 0.8, 0x0d1018));
    farGeoms.push(boxG(8, 0.7, 1.4, cx + 3.5, cy + 9, cz + 0.5, 0x0f121a));                // 跨塔石桥
    for (const wy of [7, 10, 13]) for (const wx of [-1.6, 0, 1.6]) addWinFar(cx - 2 + wx, cy + wy, cz + 2.35);
    addWinFar(cx - 11.5, cy + 8, cz + 2.05);
    addWinFar(cx - 11.5, cy + 10, cz + 2.05);
    addWinFar(cx + 10.8, cy + 8.5, cz + 1.9);
    addWinFar(cx + 4.5, cy + 6, cz + 2.05);
    for (let wx = -8; wx <= 8; wx += 4) addWinFar(cx + wx, cy + 2.5, cz + 1.6, 0.6);       // 城墙暗窗
  }
  // 城堡 B：出生点身后的残破小城（回头看的构图收尾；随出生点西移至长廊尽头外）
  {
    const cx = -296, cy = -4, cz = -44;
    farGeoms.push(boxG(12, 4.5, 2.5, cx, cy + 2.25, cz, 0x0f1210));
    for (let i = -1; i <= 2; i++) farGeoms.push(boxG(1, 0.9, 2.7, cx + i * 2.6, cy + 4.9, cz, 0x0f1210));
    farGeoms.push(boxG(3.2, 7, 3.2, cx - 4.5, cy + 3.5, cz, 0x0f121a));                    // 断塔（无顶）
    farGeoms.push(boxG(1.1, 0.8, 1.1, cx - 4.5, cy + 7.4, cz, 0x0f121a));
    farGeoms.push(boxG(4, 6.5, 4, cx + 3, cy + 3.25, cz - 0.5, 0x0f121a));
    farGeoms.push(boxG(2.2, 4, 0.5, cx + 3.5, cy + 4, cz + 1.6, 0x0f121a, { rz: 0.35 }));  // 倾塌楼板
    addWinFar(cx - 4.5, cy + 5.5, cz + 1.7, 0.7);
    addWinFar(cx + 3, cy + 4, cz + 1.55, 0.7);
    addWinFar(cx + 5.2, cy + 3.2, cz + 1.55, 0.6);
  }
  // 巨型断桥拱影（~x=-200 北望地标）：残断引桥跨雾海——长廊中段的远景认路锚（DS3 高墙跨桥意象）
  {
    const bz = -40, tone = 0x141a24, deck = 0x171e29;
    for (const px of [-236, -166]) {                     // 两座桥墩扎进雾海
      farGeoms.push(boxG(3.4, 16, 3.0, px, -8, bz, tone, { jitter: 0.08 }));
      farGeoms.push(boxG(4.6, 1.2, 4.2, px, -1.4, bz, tone, { jitter: 0.08 }));
    }
    const R = 34, yc = 7.5;                              // 主拱（中段塌缺）
    for (let k = 0; k <= 20; k++) {
      const a = 0.24 + (Math.PI - 0.48) * (k / 20);
      if (a > 1.15 && a < 1.95) continue;                // 塌缺口
      farGeoms.push(boxG(2.2, 1.5, 2.4, -201 + Math.cos(a) * R, yc + Math.sin(a) * R * 0.62, bz, tone,
        { rz: Math.atan2(0.62 * Math.cos(a), -Math.sin(a)), jitter: 0.1 }));
    }
    farGeoms.push(boxG(20, 1.1, 2.6, -222, 15.2, bz, deck, { ry: 0.03, jitter: 0.06 }));        // 西段残桥面
    farGeoms.push(boxG(14, 1.1, 2.6, -172, 14.6, bz, deck, { ry: -0.05, rz: 0.04, jitter: 0.06 })); // 东段桥面（坠斜）
    for (const wx of [-228, -216, -208, -180, -174]) farGeoms.push(boxG(1.2, 1.5, 1.4, wx, 16.2, bz, tone)); // 桥栏残垛
    farGeoms.push(boxG(2.0, 3.2, 2.0, -186, 16.5, bz, tone, { rz: 0.5 }));                     // 塌口垂石
  }
  const farMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true, fog: false }));
  root.add(batch(farGeoms, farMat, "none"));

  // ---------------- 主石构共用材质 + 火盆件 ----------------
  const stoneMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true, side: THREE.DoubleSide }));
  const flameMat0 = track(new THREE.MeshBasicMaterial({ color: 0xffc56a, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })); // 火焰材质模板（clone 出独立闪烁相位）
  const coalGeoms: THREE.BufferGeometry[] = [];
  const glowGeoms: THREE.BufferGeometry[] = [];          // 静态自发光批：箭缝月光/塔窗烛光/哨位火光/D 幽蓝/封印符文
  const flames: FlameRef[] = [];

  /** 火焰组 + 炭芯 + 火光：同组火位并入单 mesh（顶点级闪烁），每位挂一盏灯 */
  const addFlames = (fires: [number, number, number][], scale: number, intensity: number, dist: number, ph: number, throughFog = false): void => {
    const cones: THREE.BufferGeometry[] = [];
    const lights: THREE.PointLight[] = [];
    for (const [x, y, z] of fires) {
      coalGeoms.push(dodG(0.16 * scale, x, y - 0.18 * scale, z, 0x000000));
      cones.push(coneG(0.18 * scale, 0.58 * scale, 7, x, y, z, 0xffffff));
      const light = new THREE.PointLight(COLORS.ember, intensity, dist, 2);
      light.position.set(x, y + 0.15, z);
      root.add(light);
      lights.push(light);
    }
    const merged = mergeGeometries(cones, false)!;
    const mat = track(flameMat0.clone());
    if (throughFog) mat.fog = false;                       // 雾门前拱火穿雾，长廊东向信标
    const mesh = new THREE.Mesh(merged, mat);
    mesh.renderOrder = 6;
    const vpc = cones[0].attributes.position.count;       // 各锥顶点数一致（同参数生成）
    for (const c of cones) c.dispose();
    root.add(mesh);
    flames.push({
      mesh, mat: mesh.material as THREE.MeshBasicMaterial, lights, base: intensity, ph,
      orig: new Float32Array((merged.attributes.position as THREE.BufferAttribute).array as Float32Array),
      centers: fires, vpc,
    });
  };

  // ================================================================
  // B 区走廊（B1 城下街区 → B2 城墙步道）：5 个空间分块，各一块合批
  // ================================================================
  const flags: FlagRef[] = [];
  /** 挂一面残旗（mesh 独立建以便顶点摆动；旗杆并入所在分块合批） */
  const addFlag = (w: number, h: number, x: number, y: number, z: number, a: number, b: number, ph: number, sp: number): void => {
    const { geo, orig } = flagGeo(w, h, a, b);
    const mesh = new THREE.Mesh(geo, track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true, side: THREE.DoubleSide })));
    mesh.position.set(x, y, z);
    mesh.rotation.y = Math.PI / 2;                        // 旗面横跨走廊（法线沿 X，顺风摆动）
    mesh.castShadow = true;
    root.add(mesh);
    flags.push({ mesh, orig, h, ph, sp });
  };

  /** 破拱门：双柱 + 缺石拱券 + 落石（跨走廊，piers 贴墙基避开 z±2.4 可走带） */
  const arch = (G: THREE.BufferGeometry[], x: number): void => {
    for (const s of [-1, 1]) G.push(boxG(1.1, 2.5, 1.05, x, 4.55, s * 2.9, PAL.stoneMid, { jitter: 0.1 }));
    const R = 2.7, yc = 4.5;
    for (let k = 0; k <= 12; k++) {
      const a = 0.12 + (Math.PI - 0.24) * (k / 12);
      if (a > 0.5 && a < 0.95) continue;                                                                // 塌缺口
      const keystone = Math.abs(a - Math.PI / 2) < 0.1;
      G.push(boxG(0.55, keystone ? 0.75 : 0.62, 0.6, x, yc + Math.sin(a) * R, Math.cos(a) * R, keystone ? PAL.stoneHi : PAL.stone, { rx: Math.PI / 2 - a, jitter: 0.08 }));
    }
    G.push(boxG(0.6, 0.55, 0.55, x - 0.8, 0.28, 1.45, PAL.stone, { rx: 0.4, ry: 0.7, jitter: 0.1 }));   // 落石
    G.push(boxG(0.55, 0.5, 0.5, x - 0.5, 0.25, -1.3, PAL.stoneMid, { rz: 0.5, ry: 0.3 }));
    G.push(cylG(0.045, 0.06, 1.7, 8, x, 6.15, 0, PAL.wood, { rz: 0.1 }));                               // 拱顶旗杆
  };

  /** 断柱 / 枯树 / 瓦砾（走廊沿途点缀；大件落在 z±2.55 墙基外，避让可走带） */
  const column = (G: THREE.BufferGeometry[], x: number, z: number, h: number): void => {
    G.push(cylG(0.3, 0.34, h, 10, x, h / 2, z, PAL.stone, { jitter: 0.1 }));
    G.push(boxG(0.72, 0.18, 0.72, x, h + 0.09, z, PAL.stoneMid));
  };
  const deadTree = (G: THREE.BufferGeometry[], x: number, z: number, s: number, lean: number): void => {
    G.push(cylG(0.05 * s, 0.16 * s, 2.3 * s, 7, x, 1.15 * s, z, PAL.wood, { rz: lean, jitter: 0.15 }));
    for (let b = 0; b < 4; b++) {
      const ba = b * 1.9 + rnd() * 0.6;
      G.push(cylG(0.015 * s, 0.05 * s, 1.05 * s, 5, x + Math.cos(ba) * 0.42 * s, (1.1 + b * 0.32) * s + 0.28 * s, z + Math.sin(ba) * 0.42 * s, PAL.wood, { ry: -ba, rz: 0.9 + rnd() * 0.4, jitter: 0.2 }));
    }
  };
  const rubble = (G: THREE.BufferGeometry[], x: number, z: number, r: number, n: number): void => {
    for (let i = 0; i < n; i++) {
      const s = rr(0.07, 0.2);
      G.push(dodG(s, x + rr(-r, r), s * rr(0.4, 0.8), z + rr(-r, r), pick([PAL.stoneDark, PAL.stoneMid, PAL.stoneDeep]), { rx: rnd() * 3, ry: rnd() * 3, rz: rnd() * 3 }));
    }
  };

  // —— 走廊节奏节点（30-40m 一个，四型轮换）：壁龛烛龛 / 坍塌段 / 悬挑哨位 / 箭缝开窗 ——
  // 壁龛：实体墙上做「影盒」——暗背板贴墙 + 凸出龛柱/龛楣围出凹感 + 烛芯（入余烬批呼吸，0 额外灯）
  const nodeNiche = (G: THREE.BufferGeometry[], x: number, side: number): void => {
    G.push(boxG(1.24, 1.9, 0.08, x, 1.45, side * 2.41, PAL.dark, { jitter: 0.06 }));     // 龛底暗背板
    G.push(boxG(0.2, 1.8, 0.3, x - 0.78, 1.5, side * 2.45, PAL.stoneMid, { jitter: 0.1 }));   // 龛柱 ×2
    G.push(boxG(0.2, 1.8, 0.3, x + 0.78, 1.5, side * 2.45, PAL.stoneMid, { jitter: 0.1 }));
    G.push(boxG(1.82, 0.22, 0.3, x, 2.48, side * 2.46, PAL.stoneMid));                 // 龛楣
    G.push(boxG(1.9, 0.5, 0.24, x, 0.5, side * 2.44, PAL.stoneDeep, { jitter: 0.12 })); // 龛下哑座
    G.push(boxG(0.09, 0.3, 0.09, x - 0.3, 0.88, side * 2.46, PAL.bone, { rz: 0.08 })); // 烛台杆
    G.push(cylG(0.09, 0.11, 0.07, 8, x - 0.3, 1.06, side * 2.46, PAL.bone));           // 烛座
    coalGeoms.push(dodG(0.075, x - 0.3, 1.16, side * 2.46, 0x000000));                 // 烛芯（余烬呼吸）
    if (rnd() < 0.6) G.push(boxG(0.16, 0.12, 0.12, x + 0.34, 0.82, side * 2.44, PAL.bone, { ry: rnd() * 3 })); // 龛内骷髅
    rubble(G, x + rr(-1.2, 1.2), side * 1.95, 0.4, 4);
  };
  // 坍塌段：碎石堆 + 坠地断梁 + 墙头悬垂塌石 + 越过头顶的斜穿断梁
  const nodeCollapse = (G: THREE.BufferGeometry[], x: number, side: number): void => {
    rubble(G, x, side * 2.0, 0.85, 9);
    G.push(dodG(0.48, x + 0.3, 0.32, side * 2.05, PAL.stoneMid, { rx: rnd() * 3, ry: rnd() * 3 }));
    G.push(boxG(5.2, 0.26, 0.24, x - 0.2, 0.4, side * 1.95, PAL.wood, { ry: 0.42, rz: 0.05, jitter: 0.12 }));     // 坠地断梁
    G.push(boxG(5.6, 0.22, 0.22, x + 0.4, 2.95, 0, PAL.wood, { rx: side * 0.12, ry: rr(-0.15, 0.15), jitter: 0.1 })); // 斜穿走廊的断梁（越过头顶）
    G.push(boxG(1.9, 0.22, 0.2, x + side * 0.8, side === 1 ? 2.9 : 3.3, side * 2.72, PAL.wood, { rz: side * 0.55, ry: 0.3 })); // 墙头残段
    G.push(boxG(0.75, 0.65, 0.5, x - 1.6, side === 1 ? 2.75 : 3.85, side * 2.62, PAL.stoneDeep, { rz: 0.35, jitter: 0.15 })); // 悬垂塌石
  };
  // 悬挑哨位：北墙外凸平台（牛腿支撑）+ 火盆（纯 emissive，不占 PointLight）+ 器械剪影
  const nodeSentry = (G: THREE.BufferGeometry[], x: number): void => {
    G.push(boxG(2.4, 0.2, 1.5, x, 3.66, -3.85, PAL.stoneMid, { jitter: 0.09 }));        // 悬挑平台板
    G.push(boxG(0.22, 0.95, 0.22, x - 0.9, 3.22, -4.35, PAL.stoneDeep, { rx: 0.7 }));  // 牛腿斜撑 ×2
    G.push(boxG(0.22, 0.95, 0.22, x + 0.9, 3.22, -4.35, PAL.stoneDeep, { rx: 0.7 }));
    G.push(boxG(2.4, 0.44, 0.16, x, 4.0, -4.55, PAL.stone, { jitter: 0.1 }));          // 外缘矮墙
    for (let i = -1; i <= 1; i++) G.push(boxG(0.42, 0.42, 0.18, x + i * 0.85, 4.42, -4.55, PAL.stone, { jitter: 0.12 }));
    const fx = x + 0.5, fz = -3.7;                                                      // 火盆
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.5;
      G.push(cylG(0.028, 0.038, 0.8, 5, fx + Math.cos(a) * 0.16, 4.16, fz + Math.sin(a) * 0.16, PAL.metal, { ry: -a, rz: 0.2 }));
    }
    G.push(cylG(0.24, 0.13, 0.18, 8, fx, 4.54, fz, PAL.metal));
    coalGeoms.push(dodG(0.12, fx, 4.64, fz, 0x000000));
    glowGeoms.push(boxG(0.34, 0.36, 0.34, fx, 4.74, fz, 0xffc56a));                     // 火光晕（沿路暖橙，比冷月缝更亮）
    G.push(cylG(0.024, 0.032, 2.0, 5, x - 0.75, 4.76, -4.1, PAL.wood, { rz: 0.24 }));  // 靠墙长矛
    G.push(boxG(0.06, 0.38, 0.06, x - 0.52, 5.7, -3.9, COLORS.steel, { rz: 0.24 }));
    G.push(cylG(0.27, 0.27, 0.05, 10, x + 1.0, 3.98, -4.2, PAL.flagChar, { rx: Math.PI / 2, ry: 0.4 })); // 倚墙圆盾
  };
  // 箭缝开窗：磨光石框夹窄缝，冷月光从缝里透出（月侧=北）+ 直/横棂石
  const nodeSlit = (G: THREE.BufferGeometry[], x: number): void => {
    G.push(boxG(0.34, 1.7, 0.18, x - 0.3, 2.3, -2.36, PAL.stoneMid, { jitter: 0.09 })); // 缝框 ×2
    G.push(boxG(0.34, 1.7, 0.18, x + 0.3, 2.3, -2.36, PAL.stoneMid, { jitter: 0.09 }));
    G.push(boxG(1.0, 0.3, 0.18, x, 3.16, -2.36, PAL.stoneMid));                        // 顶楣
    G.push(boxG(1.0, 0.3, 0.18, x, 1.44, -2.36, PAL.stoneMid));                        // 底台
    glowGeoms.push(boxG(0.17, 1.0, 0.05, x, 2.3, -2.43, PAL.moonGlow));               // 缝内天光（冷月）
    G.push(boxG(0.1, 0.5, 0.1, x, 2.3, -2.41, PAL.stoneDeep));                         // 直棂
    G.push(boxG(0.42, 0.09, 0.09, x, 2.3, -2.41, PAL.stoneDeep));                      // 横棂
  };
  let nodeSeq = 0;                                        // 节点序号（类型/朝向轮换；布局确定性）

  B_CHUNKS.forEach(([x0, x1], ci) => {
    const G: THREE.BufferGeometry[] = [];
    const L = x1 - x0, cx = (x0 + x1) / 2;
    const urban = ci <= 1;                                // B1 城下街区（西两块）：北墙高耸 + 楼影
    // —— 两侧墙体（北高南低：南望深渊雾海）——
    G.push(boxG(L, 3.6, 0.55, cx, 1.8, -2.7, PAL.stoneDark, { jitter: 0.1 }));
    G.push(boxG(L, 0.24, 1.0, cx, 3.66, -2.7, PAL.stoneMid));
    G.push(boxG(L, 0.12, 0.1, cx, 2.75, -2.44, PAL.stoneMid));
    G.push(boxG(L, urban ? 2.7 : 2.4, 0.55, cx, (urban ? 2.7 : 2.4) / 2, 2.7, PAL.stoneDark, { jitter: 0.1 }));
    G.push(boxG(L, 0.22, 0.9, cx, urban ? 2.76 : 2.46, 2.7, PAL.stoneMid));
    // —— 雉堞（随机残缺；北墙顶/南墙顶各一排）——
    for (let x = x0 + 0.5; x <= x1 - 0.5; x += 1.56) {
      if (rnd() < 0.24) continue;
      G.push(boxG(0.52, 0.55 + rnd() * 0.25, 0.45, x, 4.02, -2.92, PAL.stone, { jitter: 0.12 }));
      if (rnd() < 0.3) continue;
      G.push(boxG(0.52, 0.5 + rnd() * 0.22, 0.45, x, urban ? 3.05 : 2.75, 2.92, PAL.stone, { jitter: 0.12 }));
    }
    // —— 北墙箭缝 + 外侧扶壁（每三条之一透月光：墙体作为夜城垛读得出来）——
    for (let x = x0 + 1.2, sk = 0; x <= x1 - 1; x += 3.1, sk++) {
      G.push(boxG(0.14, 0.6, 0.1, x, 2.15, -2.44, PAL.mortar));
      if (sk % 3 === 1) glowGeoms.push(boxG(0.13, 0.52, 0.06, x, 2.15, -2.41, PAL.moonGlow));
    }
    for (let x = x0 + 1.5; x <= x1 - 1.2; x += 6.4) G.push(boxG(0.6, 4.4, 0.95, x, 1.6, -3.22, PAL.stoneDeep, { jitter: 0.08 }));
    for (let x = x0 + 3.1; x <= x1 - 2.5; x += 9.7) G.push(boxG(0.6, 3.4, 0.95, x, 1.3, 3.22, PAL.stoneDeep, { jitter: 0.08 }));
    // —— 纵向层次：下段粗石基座 + 檐线分界 + 北墙后上段城齿剪影（雉堞缺口处露夜空）——
    G.push(boxG(L, 0.85, 0.72, cx, 0.42, -2.78, PAL.stoneDeep, { jitter: 0.14 }));       // 北墙粗石基座
    G.push(boxG(L, 0.16, 0.62, cx, 2.2, -2.7, PAL.stoneMid));                            // 檐线（上下段分界）
    G.push(boxG(L, 0.6, 0.68, cx, 0.3, 2.76, PAL.stoneDeep, { jitter: 0.14 }));          // 南侧矮基座（不挡深渊景）
    for (let i = 0; i < 2; i++) {
      const bw = rr(5, 11), bh = rr(2.2, 4.6), bx = rr(x0 + 4 + bw / 2, x1 - 4 - bw / 2);
      G.push(boxG(bw, bh, 0.5, bx, 3.6 + bh / 2, -3.3, pick([PAL.stoneDeep, 0x1c2027]), { jitter: 0.1 }));  // 后排上层墙影
      for (let tx = bx - bw / 2 + 0.55; tx <= bx + bw / 2 - 0.4; tx += 1.1)
        if (rnd() < 0.7) G.push(boxG(0.55, 0.5 + rnd() * 0.4, 0.42, tx, 3.6 + bh + 0.3, -3.3, PAL.stoneDark, { jitter: 0.14 })); // 上段城齿
    }
    for (let i = 0; i < 3; i++) {                                                        // 北墙顶局部抬升（天际线参差）
      const bw = rr(3, 7), bh = rr(0.5, 1.5);
      G.push(boxG(bw, bh, 0.55, rr(x0 + 3 + bw / 2, x1 - 3 - bw / 2), 3.6 + bh / 2, -2.7, PAL.stoneDark, { jitter: 0.1 }));
    }
    // —— B1 城下街区：北墙外的城郭楼影（下探至崖体扎根深渊）——
    if (urban) {
      for (let i = 0; i < 4; i++) {
        const bx = rr(x0 + 3, x1 - 3), bz = -rr(6.2, 9.6);
        const h = rr(4, 8.5), w = rr(2.6, 5.2), d = rr(2.6, 4.6);
        G.push(boxG(w, h + 7, d, bx, (h - 7) / 2, bz, pick([PAL.stoneDeep, 0x1c2027, PAL.roofA]), { jitter: 0.12 }));
        if (rnd() < 0.6) G.push(coneG(w * 0.62, rr(1.6, 2.6), 4, bx, h + 1, bz, PAL.roofB));
      }
    }
    // —— 地面：垫床 + 石板（2.4m 板缝节奏）——
    G.push(boxG(L, 0.2, 5.1, cx, -0.12, 0, PAL.mortar));
    let i = 0;
    for (let x = x0 + 0.25; x < x1 - 0.2; x += 2.4) {
      G.push(boxG(2.3, 0.09, 4.66, x + 1.2, 0.005 + (i % 2) * 0.004, rnd() * 0.05, [PAL.pathA, PAL.pathB, PAL.pathC, PAL.pathB][i % 4], { jitter: 0.07 }));
      i++;
    }
    // —— 墙体之下的悬崖体量（吃雾形成"高墙"落差；随分块一并剔剪）——
    G.push(boxG(L + 0.7, 14, 8.2, cx, -7, 0, PAL.cliff, { jitter: 0.12 }));
    // —— 途经破拱门（每分块一座，节奏 ~56m）——
    const ax = cx + rr(-6, 6);
    arch(G, ax);
    // —— 点缀：断柱 / 枯树 / 瓦砾（墙基带）——
    column(G, rr(x0 + 2, x1 - 2), pick([-2.6, 2.6]), rr(0.8, 1.5));
    deadTree(G, rr(x0 + 2, x1 - 2), pick([-2.75, 2.75]), rr(0.8, 1.2), rr(-0.15, 0.15));
    rubble(G, rr(x0 + 2, x1 - 2), rr(-1.2, 1.2), 0.5, 7);
    // —— 节奏节点：~34m 一个（壁龛/坍塌/悬挑哨位/箭缝轮换；让位破拱与城门楼）——
    for (let nx = x0 + 16; nx <= x1 - 12; nx += 34) {
      if (Math.abs(nx - ax) < 8 || Math.abs(nx + 60) < 10) continue;
      const kind = nodeSeq % 4, side = nodeSeq % 2 === 0 ? -1 : 1;
      nodeSeq++;
      if (kind === 0) nodeNiche(G, nx, side);
      else if (kind === 1) nodeCollapse(G, nx, side);
      else if (kind === 2) nodeSentry(G, nx);
      else nodeSlit(G, nx);
    }
    // —— 地标 ②：绞刑架 + 鸟群剪影（~x=-120，南侧崖畔；静态）——
    if (ci === 2) {
      const gx = -120;
      for (const s of [-1, 1]) G.push(boxG(0.24, 3.6, 0.24, gx + s * 1.5, 1.8, 4.3, PAL.wood, { rz: s * 0.03, jitter: 0.12 }));
      G.push(boxG(4.0, 0.22, 0.22, gx, 3.66, 4.3, PAL.wood, { rz: 0.02 }));
      G.push(boxG(0.16, 1.6, 0.16, gx - 1.1, 2.95, 4.3, PAL.wood, { rz: -0.75 }));      // 斜撑
      G.push(boxG(1.0, 0.3, 0.7, gx - 1.5, 0.15, 4.3, PAL.stoneDeep, { jitter: 0.12 })); // 架基 ×2
      G.push(boxG(1.0, 0.3, 0.7, gx + 1.5, 0.15, 4.3, PAL.stoneDeep, { jitter: 0.12 }));
      const cage = (cx2: number, cy2: number, cz2: number): void => {                    // 铁链绞笼
        G.push(cylG(0.015, 0.015, 0.7, 4, cx2, cy2 + 0.55, cz2, PAL.metal));
        for (const s2 of [-1, 1]) {
          G.push(boxG(0.02, 0.75, 0.02, cx2 + s2 * 0.22, cy2, cz2 + 0.22, PAL.metal));
          G.push(boxG(0.02, 0.75, 0.02, cx2 + s2 * 0.22, cy2, cz2 - 0.22, PAL.metal));
        }
        G.push(boxG(0.5, 0.03, 0.5, cx2, cy2 + 0.4, cz2, PAL.metal));
        G.push(boxG(0.5, 0.03, 0.5, cx2, cy2 - 0.4, cz2, PAL.metal));
        G.push(boxG(0.3, 0.5, 0.24, cx2, cy2 - 0.08, cz2, PAL.flagCharB, { rx: 0.2 }));  // 笼中蜷尸
      };
      cage(gx - 0.9, 2.75, 4.3);
      cage(gx + 0.6, 2.9, 4.15);
      G.push(boxG(0.16, 0.16, 1.6, gx - 0.1, 3.62, 3.6, PAL.wood));                      // 探出矮墙的悬臂
      G.push(cylG(0.015, 0.015, 0.6, 4, gx - 0.1, 3.3, 3.15, PAL.metal));               // 吊链
      G.push(boxG(0.3, 0.8, 0.28, gx - 0.1, 2.7, 3.15, PAL.flagCharB, { rx: 0.14, rz: -0.05, jitter: 0.1 })); // 蜷缩尸囊
      G.push(boxG(0.09, 0.42, 0.09, gx - 0.12, 2.1, 3.12, PAL.bone, { rx: 0.25 }));     // 垂腿骨
      const crow = (bx2: number, bz2: number, a2: number): void => {                     // 栖梁乌鸦剪影 ×4
        G.push(boxG(0.22, 0.12, 0.1, bx2, 3.86, bz2, PAL.bird, { ry: a2 }));
        G.push(boxG(0.09, 0.08, 0.08, bx2 + Math.sin(a2) * 0.13, 3.94, bz2 + Math.cos(a2) * 0.13, PAL.bird, { ry: a2 }));
        G.push(boxG(0.3, 0.03, 0.16, bx2, 3.9, bz2, PAL.bird, { ry: a2 + 0.3 }));
      };
      crow(gx - 1.2, 4.3, 0.4); crow(gx - 0.3, 4.42, 2.6); crow(gx + 0.7, 4.25, 3.8); crow(gx + 1.35, 4.38, 1.2);
      const gull = (bx2: number, by2: number, bz2: number, a2: number): void => {        // 盘旋群鸟剪影（V 字双翅）
        G.push(boxG(0.16, 0.035, 0.05, bx2, by2, bz2, PAL.bird, { ry: a2 }));
        G.push(boxG(0.6, 0.03, 0.12, bx2, by2 + 0.03, bz2, PAL.bird, { ry: a2, rz: 0.4 }));
        G.push(boxG(0.6, 0.03, 0.12, bx2, by2 + 0.03, bz2, PAL.bird, { ry: a2 + Math.PI / 2, rz: 0.4 }));
      };
      gull(gx - 6.5, 6.2, 2.5, 0.7); gull(gx - 3.0, 7.4, 4.8, 2.1); gull(gx + 1.8, 6.8, 1.2, 4.0); gull(gx + 5.2, 8.1, 6.0, 1.4);
    }
    // —— 地标 ③：城门楼过洞（~x=-60）：双塔夹峙 + 过洞拱 + 门楼体量（长廊的视觉压缩点）——
    if (ci === 3) {
      const gx = -60;
      for (const s of [-1, 1]) {
        G.push(cylG(1.75, 1.95, 8.5, 14, gx, 4.25, s * 4.75, PAL.stoneDark, { jitter: 0.07 }));
        G.push(cylG(1.98, 1.98, 0.45, 14, gx, 8.7, s * 4.75, PAL.stoneMid));
        if (s < 0) {                                                                     // 北塔完好锥顶 + 塔窗残烛
          G.push(coneG(2.3, 2.8, 12, gx, 10.3, s * 4.75, PAL.stoneDeep));
          glowGeoms.push(boxG(0.18, 0.6, 0.12, gx - 1.85, 6.0, s * 4.75, 0xffb060));   // 塔窗残烛：主路上的火色地标
          glowGeoms.push(boxG(0.14, 0.45, 0.12, gx - 1.8, 7.2, s * 4.4, 0xe09048));
        } else {                                                                         // 南塔断顶残垛
          for (let i = 0; i < 5; i++) {
            const a = (i / 5) * Math.PI * 2 + 0.4;
            G.push(boxG(0.55, 0.5 + rnd() * 0.5, 0.5, gx + Math.cos(a) * 1.5, 8.95, s * 4.75 + Math.sin(a) * 1.5, PAL.stone, { ry: a, jitter: 0.15 }));
          }
          G.push(boxG(1.5, 0.3, 1.5, gx, 9.2, s * 4.75, PAL.stoneMid, { rz: 0.2, ry: 0.5 }));
        }
        G.push(boxG(0.9, 6.5, 2.6, gx, 3.25, s * 3.55, PAL.stoneDeep, { jitter: 0.09 })); // 塔-走廊接墙
      }
      const R = 2.9, yc = 4.1;                                                           // 过洞拱券（跨走廊）
      for (let k = 0; k <= 14; k++) {
        const a = 0.1 + (Math.PI - 0.2) * (k / 14);
        G.push(boxG(0.8, 0.6, 0.58, gx, yc + Math.sin(a) * R, Math.cos(a) * R, PAL.stone, { rx: Math.PI / 2 - a, jitter: 0.08 }));
      }
      G.push(boxG(1.5, 2.4, 6.6, gx, 6.4, 0, PAL.stoneDark, { jitter: 0.08 }));          // 拱上墙体
      G.push(boxG(1.7, 0.5, 7.0, gx, 7.8, 0, PAL.stoneMid));                             // 门楼压顶
      for (let x = gx - 3; x <= gx + 3; x += 1.2) if (rnd() < 0.8)                        // 门楼城齿
        G.push(boxG(0.6, 0.55 + rnd() * 0.3, 0.45, x, 8.3, rnd() < 0.5 ? -3.3 : 3.3, PAL.stone, { jitter: 0.12 }));
      G.push(boxG(0.9, 0.24, 0.14, gx, 5.2, -3.28, PAL.goldDim));                         // 拱心石徽记（暗金残纹）
      G.push(boxG(0.5, 0.16, 0.1, gx, 5.0, -3.26, PAL.goldDim, { ry: 0.3 }));
      rubble(G, gx + 2.2, 1.85, 0.5, 5); rubble(G, gx - 2.4, -1.9, 0.5, 5);
    }
    // —— 地标 ④：龙骨翼残像（~x=-21，玻尔多房前致敬）：贴北墙的骨翼扇骨 + 蜷卧头骨 ——
    if (ci === 4) {
      const dx = -21, sparX = dx - 2.6, sparY = 2.6;
      G.push(cylG(0.1, 0.16, 6.4, 7, sparX, sparY, -2.28, PAL.bone, { rz: 0.62, jitter: 0.12 })); // 主翼骨（斜上）
      for (let i = 0; i < 6; i++) {
        const t = i / 5;
        const bx = sparX + Math.sin(0.62) * 6.4 * (0.18 + t * 0.62);
        const by = sparY + Math.cos(0.62) * 6.4 * (0.18 + t * 0.62) * 0.9;
        const ribL = 2.6 - t * 1.4, ribA = 1.35 - t * 0.85;
        G.push(cylG(0.03, 0.06, ribL, 5, bx, by, -2.3, PAL.bone, { rz: ribA, ry: rr(-0.15, 0.15), jitter: 0.15 }));
        G.push(dodG(0.07, bx + Math.cos(ribA) * ribL * 0.5, by + Math.sin(ribA) * ribL * 0.5, -2.3, PAL.bone, { ry: rnd() * 3 })); // 指节骨
      }
      G.push(boxG(0.04, 2.2, 0.6, dx + 1.2, 3.3, -2.3, 0x2a2620, { rz: 1.1 }));          // 翼膜残影（暗革色薄板）
      G.push(boxG(0.04, 1.7, 0.5, dx + 0.2, 2.7, -2.28, 0x2a2620, { rz: 1.3 }));
      G.push(boxG(1.15, 0.62, 0.7, dx - 1.7, 0.5, -2.5, PAL.bone, { ry: 0.5, jitter: 0.1 })); // 头骨
      G.push(boxG(0.6, 0.4, 0.44, dx - 1.1, 0.45, -2.28, PAL.bone, { ry: 0.5 }));        // 吻部
      G.push(boxG(0.18, 0.2, 0.2, dx - 1.35, 0.62, -2.2, PAL.dark, { ry: 0.5 }));        // 眼窝暗洞
      G.push(coneG(0.09, 0.5, 5, dx - 2.2, 0.95, -2.62, PAL.bone, { rz: 0.8, ry: 0.5 })); // 断角
      rubble(G, dx - 1.0, -1.9, 0.6, 6);
    }
    // —— B2 末段（第 5 块）：挂墙火盆拱门 + 雾门收头门墩 + 门楼残垛 ——
    if (ci === 4) {
      for (const s of [-1, 1]) {
        G.push(boxG(0.09, 0.6, 0.09, ax, 3.0, s * 1.62, PAL.metal));        // 拱门火盆支架（贴拱柱内侧）
        G.push(cylG(0.26, 0.14, 0.2, 8, ax, 3.3, s * 1.5, PAL.metal));
      }
      addFlames([[ax, 3.62, 1.5], [ax, 3.62, -1.5]], 1, 7, 9, 1, true); // 拱门火盆一对（穿雾，共享闪烁）
      for (const s of [-1, 1]) {                                            // 雾门门墩（x=-4 走廊东口）
        G.push(boxG(0.95, 4.8, 1.3, B_CORR.maxX, 2.4, s * 2.5, PAL.stoneMid, { jitter: 0.1 }));
        G.push(boxG(0.72, 0.5, 1.0, B_CORR.maxX, 5.0, s * 2.5, PAL.stone));
        G.push(boxG(0.5, 3.6, 0.7, B_CORR.maxX - 0.5, 1.8, s * 1.75, PAL.stoneDeep, { jitter: 0.1 }));  // 门侧短墙
      }
      G.push(boxG(0.5, 0.6, 6.2, B_CORR.maxX, 5.1, 0, PAL.stoneMid));       // 门楣
    }
    // —— B1 首块（第 1 块）：出生端门楼塔（封住来路）+ 篝火小广场 ——
    if (ci === 0) {
      const tx = -284.8;
      G.push(cylG(2.35, 2.5, 8.5, 18, tx, 4.25, 0, PAL.stoneDark, { jitter: 0.06 }));
      G.push(cylG(2.62, 2.62, 0.5, 18, tx, 8.7, 0, PAL.stoneMid));
      G.push(coneG(2.9, 2.7, 12, tx, 10.3, 0, PAL.stoneDeep));
      G.push(boxG(0.5, 2.5, 1.8, tx + 2.1, 1.25, 0, PAL.dark));                                  // 门洞暗龛
      for (const s of [-1, 1]) G.push(boxG(0.5, 2.9, 0.35, tx + 2.15, 1.45, s * 1.02, PAL.stoneMid));
      G.push(boxG(0.55, 0.5, 2.45, tx + 2.15, 2.78, 0, PAL.stoneMid));
      for (const wy of [5, 6.5]) for (const s of [-1, 1]) G.push(boxG(0.2, 0.7, 0.14, tx + 2.32, wy, s * 0.7, PAL.dark));
      G.push(boxG(0.6, 3.6, 5.2, tx + 2.55, 1.8, 0, PAL.stoneDark, { jitter: 0.1 }));             // 塔与走廊的接墙
      G.push(cylG(0.04, 0.055, 2.1, 6, tx, 9.9, 0, PAL.wood));                                   // 塔顶旗杆
      // 篝火小广场：地坪 + 灰圈 + 残骨
      G.push(boxG(7.5, 0.2, 6.4, -278.5, -0.09, 0, PAL.pathB, { jitter: 0.08 }));
      G.push(paint(new THREE.CircleGeometry(0.85, 20).rotateX(-Math.PI / 2).translate(anchors.bonfire.x, 0.02, 0), PAL.ash));
      for (const [bx, bz, ba] of [[-275.6, 0.35, 0.6], [-276.35, -0.3, -0.9], [-275.9, -0.55, 2.2]] as const)
        G.push(boxG(0.07, 0.5, 0.07, bx, 0.08, bz, PAL.bone, { rz: ba, ry: rnd() * 3 }));
      addFlag(1.0, 1.55, tx, 8.6, 0, PAL.flagBlue, PAL.flagBlueB, 1.2, 2.1);                     // 塔顶残旗
    }
    if (ci === 2) addFlag(1.15, 1.8, ax, 6.6, 0, PAL.flagChar, PAL.flagCharB, 2.6, 2.5);          // 中段拱顶残旗
    root.add(batch(G, stoneMat, "both"));
  });

  // ================================================================
  // B3 玻尔多房（圆心随 r 东移，西可走边仍是雾门）：环墙双门 + 双塔 + 断剑雕像
  // ================================================================
  {
    const G: THREE.BufferGeometry[] = [];
    const cx = ARENA_B.cx;
    const r = ARENA_B.r;
    const phi = doorPhi(r);
    const wallIn = r + 0.3, wallOut = r + 0.75, lip = r + 0.5, cren = r + 0.68;
    const butt = r + 1.25, orbit = r + 1.9, pierR = r + 0.1;
    const brim = r - 0.4;                               // 旧 11.6：可走圆（r−0.9）之外、环墙之内
    const k = r / 12;                                   // 环纹按旧 r=12 的比例铺到新圆
    // 环墙两弧（西/东各开门）：XZ 角 φ——0=+X 东门、π=−X 西门
    const arcLen = Math.PI - 2 * phi;
    G.push(cylG(wallIn, wallOut, 2.7, 44, cx, 1.35, 0, PAL.stoneDark, { open: true, t0: -Math.PI / 2 + phi, tl: arcLen, jitter: 0.09 }));
    G.push(cylG(wallIn, wallOut, 2.7, 44, cx, 1.35, 0, PAL.stoneDark, { open: true, t0: Math.PI / 2 + phi, tl: arcLen, jitter: 0.09 }));
    // 墙顶步道 + 雉堞 + 扶壁（沿两弧；门口留空）
    const N = 46;
    for (let i = 0; i <= N; i++) {
      const φ = phi + 0.1 + ((Math.PI - 2 * (phi + 0.1)) * i) / N;
      for (const s of [1, -1]) {
        const a = s * φ;                                  // 南北两半弧（±phi 为东/西门口）
        const ca = Math.cos(a), sa = Math.sin(a);
        G.push(boxG(0.55, 0.1, 0.5, cx + ca * lip, 2.78, sa * lip, PAL.stoneMid, { ry: a + Math.PI / 2 }));
        if (rnd() < 0.22) continue;                                                                                              // 残缺雉堞
        G.push(boxG(0.5, 0.5 + rnd() * 0.22, 0.42, cx + ca * cren, 3.06, sa * cren, PAL.stone, { ry: a + Math.PI / 2, jitter: 0.12 }));
      }
    }
    for (let i = 0; i < 7; i++) {
      const a = phi + 0.62 + ((Math.PI - 2 * (phi + 0.62)) * i) / 6;
      for (const s of [1, -1]) {
        G.push(boxG(0.55, 3.3, 1.0, cx + Math.cos(a) * butt, 0.55, s * Math.sin(a) * butt, PAL.stoneDeep, { ry: a + Math.PI / 2, jitter: 0.08 }));
      }
    }
    // —— 双塔（东门外侧夹峙 D 门，轨道在环墙外，不侵入可走圆）——
    const tower = (tz: number, broken: boolean): void => {
      const tx = cx + orbit * Math.cos(0.44), z = tz * orbit * Math.sin(0.44);
      G.push(cylG(1.85, 2.05, broken ? 6.2 : 8, 14, tx, broken ? 3.1 : 4, z, PAL.stoneDark, { jitter: 0.07 }));
      G.push(cylG(2.05, 2.05, 0.4, 14, tx, broken ? 6.4 : 8.2, z, PAL.stoneMid));
      if (broken) {
        for (let i = 0; i < 5; i++) {                                                                                       // 断口残垛
          const a = (i / 5) * Math.PI * 2 + 0.4;
          G.push(boxG(0.55, 0.5 + rnd() * 0.5, 0.5, tx + Math.cos(a) * 1.5, 6.55, z + Math.sin(a) * 1.5, PAL.stone, { ry: a, jitter: 0.15 }));
        }
        G.push(boxG(1.6, 0.35, 1.6, tx, 6.9, z, PAL.stoneMid, { rz: 0.25, ry: 0.6 }));
      } else {
        G.push(coneG(2.35, 2.9, 10, tx, 9.85, z, PAL.stoneDeep));
        for (const wy of [3, 5.5, 7]) G.push(boxG(0.16, 0.7, 0.16, tx - 1.95, wy, z, PAL.dark));  // 朝场窗缝
        G.push(cylG(0.04, 0.055, 1.8, 6, tx, 9.3, z - 1.2, PAL.wood));                             // 塔顶旗杆
      }
      const u = 1 / orbit;                                                                                                    // 拱肩墩（朝场一侧）
      G.push(boxG(1.1, 1.2, 0.9, cx + (tx - cx) * (pierR * u), 1.5, z * (pierR * u), PAL.stoneMid, { ry: Math.atan2(-z, tx - cx) }));
    };
    tower(-1, false);                                     // 北塔：完好锥顶（旗）
    tower(1, true);                                       // 南塔：断顶
    // —— 断剑雕像（南缘墙龛；贴在可走圆外，不挡战斗）——
    G.push(boxG(1.7, 0.5, 1.1, cx, 0.25, -brim, PAL.stoneDark, { jitter: 0.1 }));
    G.push(boxG(1.3, 0.4, 0.9, cx, 0.7, -brim, PAL.stoneMid));
    for (const s of [-1, 1]) G.push(boxG(0.34, 1.5, 0.42, cx + s * 0.28, 1.65, -(brim + 0.05), PAL.stone, { jitter: 0.08 }));
    G.push(boxG(0.5, 0.6, 0.2, cx + 0.3, 1.55, -(brim - 0.3), COLORS.steel, { ry: 0.5 }));
    G.push(boxG(0.1, 0.9, 0.16, cx - 0.25, 1.95, -(brim - 0.05), PAL.goldDim, { rz: 0.5 }));
    // —— 立式火盆（西南墙根：三脚+炭钵；沿用原灯，不新加 PointLight）——
    {
      const x = cx - brim / Math.SQRT2, z = -brim / Math.SQRT2;
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.5;
        G.push(cylG(0.035, 0.045, 1.15, 6, x + Math.cos(a) * 0.24, 0.55, z + Math.sin(a) * 0.24, PAL.metal, { ry: -a, rz: 0.24 }));
      }
      G.push(cylG(0.34, 0.18, 0.26, 9, x, 1.18, z, PAL.metal));
      addFlames([[x, 1.55, z]], 1, 8, 11, 3.3);
    }
    // —— 地面：铺装圆 + 环纹 + 场心暗金徽环 ——
    G.push(paint(new THREE.CircleGeometry(wallIn, 56).rotateX(-Math.PI / 2).translate(cx, 0.012, 0), COLORS.ground, 0.06));
    {
      const ringTones = [0x262a30, 0x1b1e23, 0x262a30, 0x1b1e23, 0x262a30, 0x1b1e23, 0x262a30];
      const rings: [number, number][] = [[1.45, 1.75], [2.95, 3.25], [4.45, 4.75], [5.95, 6.3], [7.45, 7.8], [8.95, 9.3], [10.45, 10.8]];
      rings.forEach(([r0, r1], i) =>
        G.push(paint(new THREE.RingGeometry(r0 * k, r1 * k, 56).rotateX(-Math.PI / 2).translate(cx, 0.02 + i * 0.002, 0), ringTones[i], 0.06)));
      G.push(paint(new THREE.RingGeometry(1.05 * k, 1.2 * k, 40).rotateX(-Math.PI / 2).translate(cx, 0.026, 0), PAL.goldDim, 0.1));
    }
    // —— 悬崖体量（顶缘盖过地面圆，玩家停在墙内）
    G.push(cylG(r + 1.4, r + 4.2, 14, 28, cx, -7, 0, PAL.cliff, { jitter: 0.12 }));
    root.add(batch(G, stoneMat, "both"));
    // 守望塔顶残旗（暗金）
    addFlag(0.85, 1.4, cx + orbit * Math.cos(0.44), 10.0, -orbit * Math.sin(0.44), PAL.flagGold, PAL.flagGoldB, 4.0, 2.9);
  }

  // ================================================================
  // D1 教宗月坛（随玻尔多东扩整段东移）：下沉月纹廊 + 封印门（监视者胜后开）
  // ================================================================
  // 月尘（D 区专属）：悬浮冷蓝微粒，逆重力缓升——月坛前导的仪式空气感
  const DUST_N = 64;
  const dustPos = new Float32Array(DUST_N * 3);
  const dustVy = new Float32Array(DUST_N);
  const dustPh = new Float32Array(DUST_N);
  for (let i = 0; i < DUST_N; i++) {
    dustPos[i * 3] = rr(D_CORR.minX + 0.5, D_CORR.maxX + 0.5);
    dustPos[i * 3 + 1] = rr(0.15, 4.8);
    dustPos[i * 3 + 2] = rr(-2.1, 2.1);
    dustVy[i] = rr(0.06, 0.2);
    dustPh[i] = rnd() * Math.PI * 2;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  {
    const G: THREE.BufferGeometry[] = [];
    const x0 = D_CORR.minX, x1 = D_CORR.maxX, L = x1 - x0, cx = (x0 + x1) / 2;
    // —— 高墙夹峙的下沉廊道（无雉堞：整石墙体 + 壁柱 + 拱肋）——
    for (const s of [-1, 1]) {
      G.push(boxG(L, 4.6, 0.6, cx, 2.3, s * 2.72, PAL.stoneDeep, { jitter: 0.1 }));
      G.push(boxG(L, 0.26, 0.9, cx, 4.66, s * 2.72, PAL.stoneMid));
      G.push(boxG(L, 0.12, 0.1, cx, 3.5, s * 2.44, PAL.moonPale));
    }
    for (let x = x0 + 2; x <= x1 - 2; x += 6) {
      for (const s of [-1, 1]) G.push(boxG(0.55, 3.9, 0.4, x, 1.95, s * 2.56, PAL.stoneMid, { jitter: 0.08 }));  // 壁柱
      G.push(boxG(0.42, 0.36, 5.9, x, 4.32, 0, PAL.stoneMid, { jitter: 0.06 }));                                 // 横拱肋
    }
    // —— 冷蓝化：壁柱间幽蓝箭缝（月色经文感；纯 emissive 不占灯）——
    for (let x = x0 + 5; x <= x1 - 4; x += 8) {
      for (const s of [-1, 1]) {
        G.push(boxG(0.34, 1.7, 0.18, x, 2.55, s * 2.34, PAL.stoneMid, { jitter: 0.08 }));   // 缝框 ×2 + 楣/台
        G.push(boxG(1.0, 0.3, 0.18, x, 3.46, s * 2.34, PAL.stoneMid));
        G.push(boxG(1.0, 0.3, 0.18, x, 1.64, s * 2.34, PAL.stoneMid));
        glowGeoms.push(boxG(0.16, 1.0, 0.05, x, 2.55, s * 2.4, PAL.sealBlue));              // 缝内幽蓝月光
        G.push(boxG(0.09, 0.48, 0.09, x, 2.55, s * 2.38, PAL.stoneDeep));                   // 直棂
      }
    }
    // —— 地面：暗色板 + 月纹中线 + 双月徽 ——
    G.push(boxG(L, 0.2, 5.2, cx, -0.12, 0, PAL.mortar));
    let i = 0;
    for (let x = x0 + 0.25; x < x1 - 0.2; x += 2.4) {
      G.push(boxG(2.3, 0.09, 4.7, x + 1.2, 0.005 + (i % 2) * 0.004, rnd() * 0.04, [0x23262c, 0x1f2228, 0x26292f, 0x1f2228][i % 4], { jitter: 0.07 }));
      i++;
    }
    G.push(boxG(L - 1, 0.02, 0.42, cx, 0.03, 0, PAL.moonPale));
    for (const sx of [x0 + 12, x0 + 32]) {
      G.push(paint(new THREE.RingGeometry(0.9, 1.15, 32).rotateX(-Math.PI / 2).translate(sx, 0.035, 0), 0x465062, 0.1));
      G.push(paint(new THREE.RingGeometry(0.3, 0.42, 24).rotateX(-Math.PI / 2).translate(sx, 0.037, 0), PAL.goldDim, 0.12));
    }
    // —— D 门封印（廊西口，监视者胜后可越）：暗月门框 + 靛蓝封印幔（幔另建半透明面片）——
    for (const s of [-1, 1]) G.push(boxG(0.9, 4.6, 1.2, x0, 2.3, s * 2.45, PAL.stoneMid, { jitter: 0.1 }));
    G.push(boxG(0.8, 0.55, 5.6, x0, 4.75, 0, PAL.stone));
    for (const s of [-1, 1]) G.push(boxG(0.22, 3.8, 0.3, x0 + 0.15, 1.9, s * 2.1, PAL.goldDim));
    G.push(boxG(0.22, 0.3, 4.3, x0 + 0.15, 3.95, 0, PAL.goldDim));
    // —— 封印仪式强化：符文光环（emissive 环 + 八枚符刻）+ 门侧幽蓝烛芯 + 门槛月石 ——
    glowGeoms.push(paint(new THREE.RingGeometry(2.45, 2.62, 44).rotateY(Math.PI / 2).translate(x0 + 0.55, 2.3, 0), PAL.rune));
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      glowGeoms.push(boxG(0.1, 0.34, 0.1, x0 + 0.5, 2.3 + Math.sin(a) * 2.53, Math.cos(a) * 2.53, i % 2 ? PAL.rune : 0xbdd3f0));
    }
    glowGeoms.push(boxG(0.06, 0.5, 0.06, x0 + 0.55, 1.05, 2.02, PAL.sealBlue));           // 门侧烛芯 ×2
    glowGeoms.push(boxG(0.06, 0.5, 0.06, x0 + 0.55, 1.05, -2.02, PAL.sealBlue));
    G.push(boxG(1.4, 0.03, 4.2, x0 + 0.7, 0.045, 0, PAL.moonPale));                       // 门槛月石带
    // —— 月坛烛台 ×2（火光强调色，PointLight 预算内新增 2 盏；火焰共享一个合批 mesh）——
    for (const [tx, tz] of [[x0 + 12, -1.98], [x0 + 32, 1.98]] as const) {
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2 + 0.5;
        G.push(cylG(0.035, 0.05, 1.25, 6, tx + Math.cos(a) * 0.22, 0.6, tz + Math.sin(a) * 0.22, PAL.metal, { ry: -a, rz: 0.22 }));
      }
      G.push(cylG(0.3, 0.16, 0.24, 9, tx, 1.28, tz, PAL.metal));
    }
    addFlames([[x0 + 12, 1.66, -1.98], [x0 + 32, 1.66, 1.98]], 0.95, 6, 9, 1.3);
    // —— 廊道残旗（暗金，月坛方向）——
    const flagX = x0 + 26;
    G.push(cylG(0.04, 0.055, 2.3, 6, flagX, 3.4, 2.85, PAL.wood));
    addFlag(1.3, 2.0, flagX, 4.5, 2.85, PAL.flagGoldB, PAL.flagCharB, 0.4, 1.8);
    // —— 悬崖体量
    G.push(boxG(L + 0.8, 14, 8.6, cx, -7, 0, PAL.cliff, { jitter: 0.12 }));
    root.add(batch(G, stoneMat, "both"));
    // 封印幔（半透明暗月色，越门如穿纱——T6 换真门交互）
    const veil = new THREE.Mesh(
      new THREE.PlaneGeometry(4.4, 3.9).rotateY(Math.PI / 2).translate(x0, 1.95, 0),
      track(new THREE.MeshBasicMaterial({ color: PAL.sealIndigo, transparent: true, opacity: 0.34, side: THREE.DoubleSide, depthWrite: false })),
    );
    veil.renderOrder = 4;
    root.add(veil);
    // 月尘微粒（D 区）：Points + 位置数组直写，缓升循环（update 驱动）
    const dust = new THREE.Points(dustGeo, track(new THREE.PointsMaterial({
      size: 0.075, map: softDiscTexture(), color: 0xaebfe0, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })));
    dust.frustumCulled = false;
    root.add(dust);
  }

  // ================================================================
  // D2 沙力万房（西可走边钉在月坛东口）：苍白月石环墙 + 断柱（全通终点）
  // ================================================================
  {
    const G: THREE.BufferGeometry[] = [];
    const cx = ARENA_D.cx;
    const r = ARENA_D.r;
    const phi = doorPhi(r);
    const wallIn = r + 0.3, wallOut = r + 0.75, lip = r + 0.5, cren = r + 0.68;
    const butt = r + 1.2;
    const k = r / 12;
    // 环墙单开门（西，XZ 角 π）：整圈减去 π±phi
    G.push(cylG(wallIn, wallOut, 2.9, 52, cx, 1.45, 0, 0x3a3f47, { open: true, t0: -Math.PI / 2 + phi, tl: Math.PI * 2 - 2 * phi, jitter: 0.09 }));
    const N = 44;
    for (let i = 0; i <= N; i++) {
      const a = (Math.PI * 2 * i) / N;
      const dWest = Math.abs(Math.atan2(Math.sin(a - Math.PI), Math.cos(a - Math.PI)));   // 距西门角
      if (dWest < phi + 0.12) continue;
      const ca = Math.cos(a), sa = Math.sin(a);
      G.push(boxG(0.55, 0.1, 0.5, cx + ca * lip, 3.0, sa * lip, PAL.stoneMid, { ry: a + Math.PI / 2 }));
      if (rnd() < 0.2) continue;
      G.push(boxG(0.5, 0.55 + rnd() * 0.2, 0.42, cx + ca * cren, 3.3, sa * cren, PAL.stoneHi, { ry: a + Math.PI / 2, jitter: 0.12 }));
    }
    for (let i = 0; i < 8; i++) {
      const a = phi + 0.7 + ((Math.PI * 2 - 2 * (phi + 0.7)) * i) / 7;
      const dWest = Math.abs(Math.atan2(Math.sin(a - Math.PI), Math.cos(a - Math.PI)));
      if (dWest < phi + 0.75) continue;                                          // 让开西门
      G.push(boxG(0.55, 3.5, 1.0, cx + Math.cos(a) * butt, 0.6, Math.sin(a) * butt, PAL.stoneDeep, { ry: a + Math.PI / 2, jitter: 0.08 }));
    }
    // 断柱 ×2（贴可走圆外缘，柱身不伸进可走半径）
    {
      const colR = r - 0.475;
      const colL = Math.hypot(7.5, 8.75);
      const ux = 7.5 / colL, uz = 8.75 / colL;
      for (const [px, pz] of [[cx - ux * colR, -uz * colR], [cx + ux * colR, uz * colR]] as const) {
        G.push(boxG(0.9, 0.4, 0.9, px, 0.2, pz, PAL.stoneMid));
        G.push(cylG(0.3, 0.36, rr(2.2, 3.2), 10, px, 1.6, pz, 0x3f444d, { rz: rr(-0.1, 0.1), jitter: 0.1 }));
      }
    }
    // 地面：月纹环 + 暗金弦月徽（铺到新圆边）
    G.push(paint(new THREE.CircleGeometry(wallIn, 56).rotateX(-Math.PI / 2).translate(cx, 0.012, 0), 0x20242b, 0.06));
    {
      const tones = [0x2e3440, 0x252a33, 0x2e3440, 0x252a33, 0x2e3440, 0x252a33];
      const rings: [number, number][] = [[1.45, 1.75], [2.95, 3.25], [4.45, 4.75], [5.95, 6.3], [7.45, 7.8], [8.95, 9.3]];
      rings.forEach(([r0, r1], i) =>
        G.push(paint(new THREE.RingGeometry(r0 * k, r1 * k, 56).rotateX(-Math.PI / 2).translate(cx, 0.02 + i * 0.002, 0), tones[i], 0.06)));
      G.push(paint(new THREE.RingGeometry(0.7 * k, 1.25 * k, 40, 1, 0.6, 2.0).rotateX(-Math.PI / 2).translate(cx, 0.028, 0), PAL.goldDim, 0.12)); // 弦月徽
      G.push(paint(new THREE.RingGeometry(10.4 * k, 10.7 * k, 56).rotateX(-Math.PI / 2).translate(cx, 0.032, 0), 0x465062, 0.08));
    }
    G.push(cylG(r + 1.4, r + 4.2, 14, 28, cx, -7, 0, PAL.cliff, { jitter: 0.12 }));
    root.add(batch(G, stoneMat, "both"));
  }

  // 静态自发光批（箭缝月光/塔窗烛光/哨位火光/D 幽蓝/封印符文；fog 衰减 + 整批呼吸）
  const glowMat = track(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.92 }));
  root.add(batch(glowGeoms, glowMat, "none"));

  // 步道中线余烬短杠（炭芯批，0 新灯）：东雾变浓时仍能顺着火色走到 x=-4 雾门。
  for (let i = 0; i < 19; i++) {
    coalGeoms.push(boxG(0.78, 0.08, 0.16, -260 + i * 14, 0.1, 0, 0x000000));
  }
  // 炭芯合批（emissive 呼吸）
  const coalMat = track(new THREE.MeshStandardMaterial({ color: 0x2a1207, emissive: COLORS.ember, emissiveIntensity: 1.9, roughness: 1, flatShading: true }));
  {
    const m = batch(coalGeoms, coalMat, "none");
    m.matrixAutoUpdate = true;                           // batch 默认冻结矩阵，动态件还原
    root.add(m);
  }

  // ---------------- 脚下深渊 + 雾海中的下层城区（falloff 靠 FogExp2 吃掉远端） ----------------
  {
    const abyss = new THREE.Mesh(
      new THREE.CircleGeometry(340, 48).rotateX(-Math.PI / 2).translate(-100, -14.3, 0),
      track(new THREE.MeshStandardMaterial({ color: PAL.abyss, roughness: 1 })),
    );
    abyss.receiveShadow = false;
    abyss.updateMatrix();
    abyss.matrixAutoUpdate = false;
    root.add(abyss);
  }
  const winTownPts: number[] = [];
  const addWinTown = (x: number, y: number, z: number): void => {
    const c = new THREE.Color(COLORS.ember).multiplyScalar(0.35 + rnd() * 0.5);
    winTownPts.push(x, y, z, c.r, c.g, c.b);
  };  {
    // 下层城区沿整段高墙铺开；按西/中/东三块合批（frustum 剔剪 + 远端雾吃）
    const bands: [number, number][] = [[-284, -150], [-150, 10], [10, ARENA_D.cx + ARENA_D.r + 24]];
    for (const [bx0, bx1] of bands) {
      const G: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 26; i++) {
        const x = rr(bx0, bx1);
        const z = (rnd() < 0.5 ? -1 : 1) * rr(5.4, 30);
        if (x > B_CORR.minX - 2 && x < D_CORR.maxX + 2 && Math.abs(z) < 4.6) continue;                 // 让开墙基正下方
        if (Math.hypot(x - ARENA_B.cx, z) < ARENA_B.r + 7 || Math.hypot(x - ARENA_D.cx, z) < ARENA_D.r + 7) continue; // 让开竞技场崖体
        const w = rr(1.6, 4.6), h = rr(1.4, 4.2), d = rr(1.6, 4.6);
        G.push(boxG(w, h, d, x, -14 + h / 2 - 0.2, z, pick([PAL.roofA, PAL.roofB, PAL.stoneDeep]), { ry: rnd() * Math.PI, jitter: 0.12 }));
        if (rnd() < 0.55) addWinTown(x + rr(-w * 0.3, w * 0.3), -14 + h * 0.72, z + d * 0.52);
      }
      const a = rnd() * Math.PI * 2, rad = rr(8, 20);                                                  // 教堂尖顶剪影
      const sx = (bx0 + bx1) / 2 + Math.cos(a) * rad, sz = Math.sin(a) * rad;
      if (Math.abs(sz) > 5 && Math.hypot(sx - ARENA_B.cx, sz) > ARENA_B.r + 7 && Math.hypot(sx - ARENA_D.cx, sz) > ARENA_D.r + 7) G.push(coneG(rr(0.9, 1.4), rr(2.5, 4), 5, sx, -11.5, sz, PAL.roofB));
      root.add(batch(G, stoneMat, "none"));
    }
  }
  // 窗火点云（additive、穿雾、整体闪烁；远堡与下层城区合用一个点云——省一档 dc）
  const winMat = track(new THREE.PointsMaterial({ size: 0.4, vertexColors: true, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  {
    const all = [...winPts, ...winTownPts];
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(all.filter((_, i) => i % 6 < 3)), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(all.filter((_, i) => i % 6 >= 3)), 3));
    root.add(new THREE.Points(g, winMat));
  }

  // ---------------- 地面雾片（Canvas 柔光贴图，漂移 + 呼吸；沿长廊布 6 片，暖→冷渐变） ----------------
  const mists: MistRef[] = [];
  {
    const tex = softDiscTexture();
    const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const defs = [
      { x: -276, y: 0.28, z: 0.4, s: 5.0, o: 0.06, c: 0x2a241c },   // 篝火暖雾
      { x: -250, y: 0.22, z: -0.6, s: 4.0, o: 0.05, c: 0x28241e },
      { x: -198, y: 0.22, z: -0.7, s: 4.2, o: 0.05, c: 0x232b3a },
      { x: -88, y: 0.24, z: 0.6, s: 4.5, o: 0.05, c: 0x212a3b },
      { x: -20, y: 0.3, z: 0.6, s: 3.8, o: 0.055, c: 0x1f2839 },
      { x: (D_CORR.minX + D_CORR.maxX) / 2, y: 0.26, z: 0, s: 4.6, o: 0.05, c: 0x1d2a44 }, // D 月坛冷雾
    ];
    for (const d of defs) {
      const mat = track(new THREE.MeshBasicMaterial({ map: tex, color: d.c, transparent: true, opacity: d.o, depthWrite: false }));
      const mesh = new THREE.Mesh(plane, mat);
      mesh.position.set(d.x, d.y, d.z);
      mesh.scale.setScalar(d.s);
      mesh.renderOrder = 5;
      root.add(mesh);
      mists.push({ mesh, mat, bx: d.x, bz: d.z, dx: rr(1.2, 2.6), dz: rr(1.2, 2.6), ph: rnd() * 6.28, spx: rr(0.04, 0.09), spz: rr(0.03, 0.08), o: d.o });
    }
  }

  // ---------------- update：旗面摆动 / 火光闪烁 / 窗火 / 星光 / 雾片漂移 ----------------
  let animT = 0;
  const update = (t: number, dt: number): void => {
    animT += dt;                                          // 用累加时间：顿帧/暂停(dt=0)时环境随之冻结
    void t;
    for (const f of flags) {
      const attr = f.mesh.geometry.attributes.position as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      const gust = 1 + 0.4 * Math.sin(animT * 0.33 + f.ph);          // 阵风包络
      for (let i = 0; i < attr.count; i++) {
        const ox = f.orig[i * 3], oy = f.orig[i * 3 + 1];
        const k = Math.min(1, Math.max(0, -oy / f.h));               // 挂点固定 → 垂底摆幅最大
        arr[i * 3 + 2] = (Math.sin(animT * f.sp + f.ph + ox * 1.9 + oy * 2.3) * 0.12
          + Math.sin(animT * f.sp * 0.62 + ox * 3.4 + 1.3) * 0.05) * k * gust * f.h * 0.5;
      }
      attr.needsUpdate = true;
    }
    for (let i = 0; i < flames.length; i++) {
      const fl = flames[i];
      const s = 1 + Math.sin(animT * 11 + i * 2.1) * 0.18 + Math.sin(animT * 27 + i) * 0.08;
      const sway = Math.sin(animT * 2.1 + fl.ph) * 0.1;               // 火苗侧摆（随高度）
      const pit = Math.cos(animT * 1.7 + fl.ph * 0.8) * 0.08;         // 火苗前后俯仰
      const attr = fl.mesh.geometry.attributes.position as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      for (let v = 0; v < attr.count; v++) {
        const ci = Math.min(fl.centers.length - 1, Math.floor(v / fl.vpc));
        const cx = fl.centers[ci][0], cy = fl.centers[ci][1], cz = fl.centers[ci][2];
        const ox = fl.orig[v * 3] - cx, oy = fl.orig[v * 3 + 1] - cy, oz = fl.orig[v * 3 + 2] - cz;
        arr[v * 3] = cx + ox * s + sway * oy * 1.2;
        arr[v * 3 + 1] = cy + oy * s;
        arr[v * 3 + 2] = cz + oz * s + pit * oy * 1.2;
      }
      attr.needsUpdate = true;
      fl.mat.opacity = 0.9 + 0.08 * Math.sin(animT * 13 + i * 1.7);
      const li = fl.base - 0.8 + Math.sin(animT * 9.5 + i * 2.4) * 1.4 + Math.sin(animT * 23 + i) * 0.7;
      for (const l of fl.lights) l.intensity = li;
    }
    coalMat.emissiveIntensity = 1.9 + Math.sin(animT * 7.3) * 0.35;
    {                                                                   // 流云：wrap 循环漂移 + 边缘渐隐（进出不跳变）
      const span = CLOUD_SPAN.max - CLOUD_SPAN.min;
      for (const c of clouds) {
        const x = c.x0 + (((animT * c.sp) % span) + span) % span + CLOUD_SPAN.min;
        const k = Math.min(1, Math.max(0, Math.min((x - CLOUD_SPAN.min) / CLOUD_SPAN.fade, (CLOUD_SPAN.max - x) / CLOUD_SPAN.fade)));
        c.mesh.position.x = x;
        c.mat.opacity = c.o * k * k;
      }
    }
    winMat.opacity = 0.74 + Math.sin(animT * 0.9) * 0.12 + Math.sin(animT * 2.4) * 0.07;
    starMat.opacity = 0.72 + Math.sin(animT * 0.5) * 0.12 + Math.sin(animT * 1.3) * 0.06;
    for (const m of mists) {
      m.mesh.position.x = m.bx + Math.sin(animT * m.spx + m.ph) * m.dx;
      m.mesh.position.z = m.bz + Math.cos(animT * m.spz + m.ph * 1.7) * m.dz;
      m.mesh.rotation.z += 0.0004;
      m.mat.opacity = m.o + Math.sin(animT * 0.21 + m.ph) * 0.028;
    }
    // D 月尘：缓升 + 侧摆（触顶回卷到地面；逆重力的仪式感）
    if (dt > 0) {
      for (let i = 0; i < DUST_N; i++) {
        const j = i * 3;
        dustPos[j + 1] += dustVy[i] * dt;
        dustPos[j] += Math.sin(animT * 0.4 + dustPh[i]) * 0.14 * dt;
        dustPos[j + 2] += Math.cos(animT * 0.33 + dustPh[i] * 1.3) * 0.1 * dt;
        if (dustPos[j + 1] > 5) {
          dustPos[j] = rr(D_CORR.minX + 0.5, D_CORR.maxX + 0.5);
          dustPos[j + 1] = 0.15;
          dustPos[j + 2] = rr(-2.1, 2.1);
        }
      }
      (dustGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    }
    // 雾色/密度沿 x 渐变：篝火暖 → 月坛冷（camX 由天穹随行回调逐帧记录）
    {
      const fogSpan = ARENA_D.cx + ARENA_D.r - B_CORR.minX;
      const fk = Math.min(1, Math.max(0, (camX - B_CORR.minX) / fogSpan));
      (scene.fog as THREE.FogExp2).color.copy(fogWarm).lerp(fogCold, fk);
      // 东段密度封顶：约 40m 的房对岸仍可读（旧 0.040 在 40m 处只剩约两成）
      (scene.fog as THREE.FogExp2).density = 0.022 + 0.002 * fk;
    }
    // 自发光批呼吸（箭缝月光/封印符文的月之脉动）
    glowMat.opacity = 0.86 + Math.sin(animT * 2.2) * 0.1;
    // 远雷闪：~11.3s 周期双闪——天穹提亮 + 流云增亮 + 半天光瞬提（远处风暴的静默闪电）
    {
      const strobe = (u: number): number => (u > 0 && u < 0.12 ? 1 - u / 0.12 : 0);
      const lp = animT % 11.3;
      const lf = strobe(lp) + 0.65 * strobe(lp - 0.26);
      skyMat.color.setScalar(1 + 0.55 * lf);
      hemiLight.intensity = HEMI_BASE + 1.6 * lf;
      for (const c of clouds) c.mat.color.copy(c.base).multiplyScalar(1 + 0.7 * lf);
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
