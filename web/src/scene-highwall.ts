/** 场景二「洛斯里克的高墙」——纯程序化环境（ADR-0006：冷灰蓝基调 + 火光唯一强调色）
 *
 * 空间语法沿用灰烬墓地 demo，供 game.ts 复用玩家流程：
 *   出生/篝火(x≈-12.4) → 走廊(净宽 3.5m，雾门 x=-5) → 圆形 Boss 竞技场(r=6.6，中心 x=0.6)
 * 视觉对标 DS3 高墙：夜空穹顶渐变 + 冷月与光晕 + 两层远山/城堡剪影(窗火闪烁) +
 *   主城墙/雉堞/双塔/破拱门 + 残旗(顶点摆动) + 石板路/断柱/枯树/瓦砾 + 脚下深渊与雾海中的下层城区。
 * 预算：纯几何 + 顶点色（paint 统一上色），静态几何按材质 mergeGeometries 合并，
 *   整机 ~45 draw call；火光 PointLight ≤3；不加载任何外部资源（光晕/雾片贴图为运行时 Canvas 生成）。
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { COLORS } from "./config";

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
  pathA: COLORS.groundPath, pathB: 0x2c2825, pathC: 0x31302c,
  abyss: 0x101218, roofA: 0x1a1d24, roofB: 0x15171d,
  skyTop: 0x07090f, skyHorizon: 0x1a2130, skyUnder: 0x0c0e13,
  ridgeFar: 0x151b27, ridgeNear: 0x0f141d,
  flagBlue: 0x3a4257, flagBlueB: 0x232a3c, flagChar: 0x2b2f38, flagCharB: 0x1b1e25,
  flagGold: 0x635438, flagGoldB: 0x453a28,
  wood: 0x2c2620, metal: 0x4e535b, bone: 0x4a4436, ash: 0x17140f, goldDim: 0x6b5c3f,
};

// ---------------- 确定性随机（场景每次构建一致） ----------------
let seed = 20260317;
const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
const rr = (a: number, b: number): number => a + rnd() * (b - a);
const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length) % arr.length];
const fract = (v: number): number => v - Math.floor(v);
/** 位置哈希：重合顶点得到同一扰动，避免拼接缝开裂 */
const hashXZ = (x: number, z: number, ch: number): number =>
  fract(Math.sin(x * 127.1 + z * 311.7 + ch * 74.7) * 43758.5453);

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
interface FlameRef { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; light: THREE.PointLight; ph: number }
interface MistRef { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; bx: number; bz: number; dx: number; dz: number; ph: number; spx: number; spz: number; o: number }
interface CloudRef { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; x0: number; sp: number; o: number }

// ================================================================
export function buildHighWall(scene: THREE.Scene): {
  anchors: SceneAnchors;
  update: (t: number, dt: number) => void;
  dispose: () => void;
} {
  const root = new THREE.Group();
  root.name = "highwall";
  scene.add(root);

  /** 锚点：与灰烬墓地 demo 同构（X 为前进轴），game.ts 接入时流程逻辑可复用 */
  const anchors: SceneAnchors = {
    spawn: new THREE.Vector3(-12.4, 0, 1.3),
    bonfire: new THREE.Vector3(-12.4, 0, 0),
    fogGate: new THREE.Vector3(-5.0, 0, 0),
    bossArena: new THREE.Vector3(0.6, 0, 0),
    arenaRadius: 6.6,
    corridorMinX: -13.6,
  };

  // 天空与雾（dispose 时还原）
  const prevBg = scene.background;
  const prevFog = scene.fog;
  scene.background = new THREE.Color(COLORS.bg);
  scene.fog = new THREE.FogExp2(COLORS.fog, 0.036);

  const mats: THREE.Material[] = [];
  const track = <T extends THREE.Material>(m: T): T => { mats.push(m); return m; };

  // ---------------- 灯光：冷月光主灯（带阴影）+ 半天环境光 ----------------
  const moonLight = new THREE.DirectionalLight(COLORS.moon, 1.7);
  moonLight.position.set(21.7, 15.5, -24.3);            // 与月亮视觉方位一致（+X 高空 -Z）
  moonLight.castShadow = true;
  moonLight.shadow.mapSize.set(2048, 2048);
  Object.assign(moonLight.shadow.camera, { left: -17, right: 17, top: 14, bottom: -12, near: 2, far: 75 });
  moonLight.shadow.camera.updateProjectionMatrix();
  moonLight.shadow.bias = -0.0002;
  moonLight.shadow.normalBias = 0.03;
  const moonTarget = new THREE.Object3D();
  moonTarget.position.set(-2, 0, 0);
  root.add(moonTarget);
  moonLight.target = moonTarget;
  root.add(moonLight);
  root.add(new THREE.HemisphereLight(0x2a3242, 0x141110, 0.55));

  // ---------------- 天幕：大球内壁竖向渐变（下暗上更暗、地平线微亮） ----------------
  {
    const geo = new THREE.SphereGeometry(96, 32, 20);
    const pos = geo.attributes.position;
    const colArr = new Float32Array(pos.count * 3);
    const top = new THREE.Color(PAL.skyTop), hor = new THREE.Color(PAL.skyHorizon), un = new THREE.Color(PAL.skyUnder);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const ny = pos.getY(i) / 96;
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
    root.add(stars);
  }

  // ---------------- 冷月：亮盘 + 环形山暗斑 + 双层柔光晕（正对玩家区） ----------------
  {
    const mg = new THREE.Group();
    mg.position.set(46, 33, -47);
    mg.lookAt(0, 3, 0);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(3.1, 48), track(new THREE.MeshBasicMaterial({ color: 0xe3eaf6, fog: false })));
    disc.renderOrder = -8;
    mg.add(disc);
    const craters: THREE.BufferGeometry[] = [
      new THREE.CircleGeometry(0.55, 20).translate(0.7, 0.8, 0.03),
      new THREE.CircleGeometry(0.4, 18).translate(-0.9, 0.2, 0.03),
      new THREE.CircleGeometry(0.3, 16).translate(0.2, -1.1, 0.03),
    ];
    const craterMesh = new THREE.Mesh(mergeGeometries(craters.map(g => paint(g, 0xc6d0e0)), false)!, track(new THREE.MeshBasicMaterial({ vertexColors: true, fog: false })));
    craterMesh.renderOrder = -7;
    mg.add(craterMesh);
    const tex = softDiscTexture();
    const halo1 = new THREE.Mesh(new THREE.PlaneGeometry(11, 11), track(new THREE.MeshBasicMaterial({ map: tex, color: 0x93a8c8, transparent: true, opacity: 0.34, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })));
    const halo2 = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 5.2), track(new THREE.MeshBasicMaterial({ map: tex, color: 0xd8e4f4, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })));
    halo1.renderOrder = 2;
    halo2.renderOrder = 2;
    mg.add(halo1, halo2);
    root.add(mg);
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
      root.add(mesh);
      clouds.push({ mesh, mat, x0: d.x, sp: d.sp, o: d.o });
    }
  }

  // ---------------- 远景：两层远山 + 两座城堡剪影（fog:false 手绘雾色，窗火另建点云） ----------------
  const farGeoms: THREE.BufferGeometry[] = [];
  const winFarPts: number[] = [];                       // x,y,z, r,g,b 逐点
  const addWinFar = (x: number, y: number, z: number, dim = 1): void => {
    const c = new THREE.Color(rnd() < 0.3 ? COLORS.gold : COLORS.ember).multiplyScalar(0.55 + rnd() * 0.45 * dim);
    winFarPts.push(x, y, z, c.r, c.g, c.b);
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
  // 城堡 A：月下主城（正好衬在月亮下方——竞技场远端的视觉锚）
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
  // 城堡 B：出生点身后的残破小城（回头看的构图收尾）
  {
    const cx = -40, cy = -4, cz = -44;
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
  const farMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true, fog: false }));
  root.add(batch(farGeoms, farMat, "none"));

  // 城堡窗火点云（additive、穿雾、整体闪烁）
  const winFarMat = track(new THREE.PointsMaterial({ size: 0.5, vertexColors: true, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(winFarPts.filter((_, i) => i % 6 < 3)), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(winFarPts.filter((_, i) => i % 6 >= 3)), 3));
    root.add(new THREE.Points(g, winFarMat));
  }

  // ---------------- 主石构（全部并入一个顶点色 Mesh：墙/雉堞/塔/拱门/断柱/枯树/瓦砾/火盆座） ----------------
  const stoneMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true, side: THREE.DoubleSide }));
  const structGeoms: THREE.BufferGeometry[] = [];
  const floorGeoms: THREE.BufferGeometry[] = [];
  const massGeoms: THREE.BufferGeometry[] = [];

  // —— 走廊墙体（x -15.0 → -5.4，在竞技场环墙开口处收头）——
  const wallLen = 9.6, wallCx = -10.2;
  for (const s of [-1, 1]) {
    structGeoms.push(boxG(wallLen, 3.4, 0.6, wallCx, 1.7, s * 2.05, PAL.stoneDark, { jitter: 0.1 }));   // 墙身
    structGeoms.push(boxG(wallLen, 0.24, 1.05, wallCx, 3.52, s * 2.05, PAL.stoneMid));                  // 压顶/墙顶步道
    structGeoms.push(boxG(wallLen, 0.12, 0.1, wallCx, 2.62, s * 1.79, PAL.stoneMid));                   // 内壁腰线
  }
  for (let x = -14.6; x <= -5.8; x += 0.78) for (const s of [-1, 1]) {                                  // 双缘雉堞（随机残缺）
    if (rnd() < 0.22) continue;
    if (s === 1 && Math.abs(x + 6.6) < 0.7) continue;                                                   // 破拱门上方让位
    structGeoms.push(boxG(0.52, 0.6 + rnd() * 0.25, 0.45, x, 3.95, s * 2.22, PAL.stone, { jitter: 0.12 }));
  }
  for (let x = -14; x <= -6; x += 2.6) for (const s of [-1, 1]) structGeoms.push(boxG(0.14, 0.6, 0.1, x, 2.05, s * 1.79, PAL.mortar)); // 箭缝
  for (let x = -14.1; x <= -5.9; x += 2.75) for (const s of [-1, 1]) structGeoms.push(boxG(0.6, 4.3, 0.95, x, 1.55, s * 2.5, PAL.stoneDeep, { jitter: 0.08 })); // 外侧扶壁

  // —— 破拱门（x=-6.6，跨走廊，缺三块拱石 + 落石）——
  for (const s of [-1, 1]) structGeoms.push(boxG(1.1, 2.3, 1.0, -6.6, 4.45, s * 2.05, PAL.stoneMid, { jitter: 0.1 }));
  {
    const R = 2.55, yc = 4.4;
    for (let k = 0; k <= 12; k++) {
      const a = 0.12 + (Math.PI - 0.24) * (k / 12);
      if (a > 0.5 && a < 0.95) continue;                                                                // 塌缺口
      const keystone = Math.abs(a - Math.PI / 2) < 0.1;
      structGeoms.push(boxG(0.55, keystone ? 0.75 : 0.62, 0.6, -6.6, yc + Math.sin(a) * R, Math.cos(a) * R, keystone ? PAL.stoneHi : PAL.stone, { rx: Math.PI / 2 - a, jitter: 0.08 }));
    }
  }
  structGeoms.push(boxG(0.6, 0.55, 0.55, -7.4, 0.28, 1.35, PAL.stone, { rx: 0.4, ry: 0.7, jitter: 0.1 }));    // 落石
  structGeoms.push(boxG(0.55, 0.5, 0.5, -7.1, 0.25, -1.2, PAL.stoneMid, { rz: 0.5, ry: 0.3 }));
  structGeoms.push(cylG(0.045, 0.06, 1.7, 8, -6.6, 6.1, 0, PAL.wood, { rz: 0.1 }));                           // 拱顶旗杆

  // —— 雾门收头门墩（x=-5.4，走廊墙尽端两侧）——
  for (const s of [-1, 1]) {
    structGeoms.push(boxG(0.9, 4.6, 1.15, -5.4, 2.3, s * 2.2, PAL.stoneMid, { jitter: 0.1 }));
    structGeoms.push(boxG(0.7, 0.5, 0.85, -5.4, 4.85, s * 2.2, PAL.stone));
  }

  // —— 出生端：门楼塔（封住来路）——
  structGeoms.push(cylG(2.35, 2.5, 8.5, 18, -17.6, 4.25, 0, PAL.stoneDark, { jitter: 0.06 }));
  structGeoms.push(cylG(2.62, 2.62, 0.5, 18, -17.6, 8.7, 0, PAL.stoneMid));
  structGeoms.push(coneG(2.9, 2.7, 12, -17.6, 10.3, 0, PAL.stoneDeep));
  structGeoms.push(boxG(0.5, 2.5, 1.8, -15.5, 1.25, 0, PAL.dark));                                           // 门洞暗龛
  for (const s of [-1, 1]) structGeoms.push(boxG(0.5, 2.9, 0.35, -15.45, 1.45, s * 1.02, PAL.stoneMid));     // 破门框
  structGeoms.push(boxG(0.55, 0.5, 2.45, -15.45, 2.78, 0, PAL.stoneMid));
  for (const wy of [5, 6.5]) for (const s of [-1, 1]) structGeoms.push(boxG(0.2, 0.7, 0.14, -15.32, wy, s * 0.7, PAL.dark)); // 塔身窗缝
  structGeoms.push(boxG(0.5, 3.4, 5.0, -15.05, 1.7, 0, PAL.stoneDark, { jitter: 0.1 }));                     // 塔与走廊的接墙

  // —— 竞技场：环形雉堞墙 + 步道 + 扶壁（-X 侧开口接走廊）——
  const doorA = -Math.PI / 2;                                            // CylinderGeometry θ：-X 方向为 -π/2
  structGeoms.push(cylG(6.4, 6.85, 2.1, 40, 0.6, 1.05, 0, PAL.stoneDark, { open: true, t0: doorA + 0.5, tl: Math.PI * 2 - 1.0, jitter: 0.09 }));
  for (let i = 0; i < 30; i++) {
    const a = Math.PI + 0.55 + ((Math.PI * 2 - 1.1) * i) / 29;           // XZ 平面角（π 为 -X 门口）
    const ca = Math.cos(a), sa = Math.sin(a);
    structGeoms.push(boxG(0.55, 0.1, 0.5, 0.6 + ca * 6.62, 2.14, sa * 6.62, PAL.stoneMid, { ry: a + Math.PI / 2 }));            // 墙顶步道板
    if (rnd() < 0.2) continue;                                                                                                  // 残缺雉堞
    structGeoms.push(boxG(0.5, 0.55 + rnd() * 0.2, 0.42, 0.6 + ca * 6.78, 2.48, sa * 6.78, PAL.stone, { ry: a + Math.PI / 2, jitter: 0.12 }));
  }
  for (let i = 0; i < 7; i++) {
    const a = Math.PI + 0.9 + ((Math.PI * 2 - 1.8) * i) / 6;
    structGeoms.push(boxG(0.55, 3.2, 1.0, 0.6 + Math.cos(a) * 7.1, 0.5, Math.sin(a) * 7.1, PAL.stoneDeep, { ry: a + Math.PI / 2, jitter: 0.08 })); // 环墙扶壁
  }

  // —— 双塔（+X 端夹住竞技场远口）：完好锥顶塔 + 断顶塔 ——
  {
    const u: [number, number] = [0.812, -0.584];                         // 竞技场中心 → 塔 B 方向单位向量
    const tx = 0.6 + u[0] * 8.6, tz = u[1] * 8.6;
    structGeoms.push(cylG(1.85, 2.05, 8, 14, tx, 4, tz, PAL.stoneDark, { jitter: 0.07 }));
    structGeoms.push(cylG(2.05, 2.05, 0.4, 14, tx, 8.2, tz, PAL.stoneMid));
    structGeoms.push(coneG(2.35, 2.9, 10, tx, 9.85, tz, PAL.stoneDeep));
    for (const wy of [3, 5.5, 7]) structGeoms.push(boxG(0.16, 0.7, 0.16, tx - u[0] * 1.95, wy, tz - u[1] * 1.95, PAL.dark));     // 朝场窗缝
    structGeoms.push(boxG(1.1, 1.2, 0.9, 0.6 + u[0] * 7.0, 1.5, u[1] * 7.0, PAL.stoneMid, { ry: Math.atan2(-u[1], u[0]) }));     // 拱肩墩
    structGeoms.push(cylG(0.04, 0.055, 1.8, 6, 6.2, 9.3, -5.6, PAL.wood));                                                       // 塔顶旗杆
  }
  {
    const u: [number, number] = [0.812, 0.584];
    const tx = 0.6 + u[0] * 8.6, tz = u[1] * 8.6;
    structGeoms.push(cylG(1.7, 1.9, 6.2, 14, tx, 3.1, tz, PAL.stoneDark, { jitter: 0.07 }));
    for (let i = 0; i < 5; i++) {                                                                                                                          // 断口残垛
      const a = (i / 5) * Math.PI * 2 + 0.4;
      structGeoms.push(boxG(0.55, 0.5 + rnd() * 0.5, 0.5, tx + Math.cos(a) * 1.5, 6.35, tz + Math.sin(a) * 1.5, PAL.stone, { ry: a, jitter: 0.15 }));
    }
    structGeoms.push(boxG(1.6, 0.35, 1.6, tx, 6.7, tz, PAL.stoneMid, { rz: 0.25, ry: 0.6 }));                                                              // 塌倾盖板
    structGeoms.push(boxG(1.1, 1.2, 0.9, 0.6 + u[0] * 7.0, 1.5, u[1] * 7.0, PAL.stoneMid, { ry: Math.atan2(-u[1], u[0]) }));
  }

  // —— 竞技场远端残像（断剑雕像，Boss 背景地标，避开战斗半径）——
  structGeoms.push(boxG(1.5, 0.5, 1.5, 6.35, 0.25, 0, PAL.stoneDark, { jitter: 0.1 }));
  structGeoms.push(boxG(1.1, 0.4, 1.1, 6.35, 0.7, 0, PAL.stoneMid));
  for (const s of [-1, 1]) structGeoms.push(boxG(0.34, 1.5, 0.42, 6.35 + s * 0.28, 1.65, 0, PAL.stone, { jitter: 0.08 }));      // 残腿
  structGeoms.push(boxG(0.5, 0.6, 0.2, 6.6, 1.55, 0.32, COLORS.steel, { ry: 0.5 }));                                           // 垂盾
  structGeoms.push(boxG(0.1, 0.9, 0.16, 6.15, 1.95, 0.1, PAL.goldDim, { rz: 0.5 }));                                           // 断剑残柄（暗金）

  // —— 断柱 / 枯树 / 瓦砾 / 篝火灰堆 ——
  const column = (x: number, z: number, h: number): void => {
    structGeoms.push(cylG(0.3, 0.34, h, 10, x, h / 2, z, PAL.stone, { jitter: 0.1 }));
    structGeoms.push(boxG(0.72, 0.18, 0.72, x, h + 0.09, z, PAL.stoneMid));
  };
  column(-13.5, -2.3, 1.4);
  column(-14.1, -2.62, 0.8);
  column(4.4, 4.75, 1.1);
  column(-5.05, -2.35, 1.6);
  structGeoms.push(cylG(0.3, 0.3, 1.4, 9, -8.5 + 0.7, 0.3, -1.55, PAL.stoneMid, { rz: Math.PI / 2, ry: 0.5, jitter: 0.12 }));   // 倒地柱身
  structGeoms.push(cylG(0.32, 0.32, 0.4, 9, -8.5, 0.32, -1.55, PAL.stoneMid, { rx: Math.PI / 2 }));

  const deadTree = (x: number, z: number, s: number, lean: number): void => {
    structGeoms.push(cylG(0.05 * s, 0.16 * s, 2.3 * s, 7, x, 1.15 * s, z, PAL.wood, { rz: lean, jitter: 0.15 }));
    for (let b = 0; b < 4; b++) {
      const ba = b * 1.9 + rnd() * 0.6;
      structGeoms.push(cylG(0.015 * s, 0.05 * s, 1.05 * s, 5, x + Math.cos(ba) * 0.42 * s, (1.1 + b * 0.32) * s + 0.28 * s, z + Math.sin(ba) * 0.42 * s, PAL.wood, { ry: -ba, rz: 0.9 + rnd() * 0.4, jitter: 0.2 }));
    }
  };
  deadTree(-13.9, 2.55, 1.15, 0.08);
  deadTree(-14.5, -2.6, 0.8, -0.12);
  deadTree(-3.7, 4.2, 1.0, 0.15);

  const rubble = (x: number, z: number, r: number, n: number): void => {
    for (let i = 0; i < n; i++) {
      const s = rr(0.07, 0.2);
      structGeoms.push(dodG(s, x + rr(-r, r), s * rr(0.4, 0.8), z + rr(-r, r), pick([PAL.stoneDark, PAL.stoneMid, PAL.stoneDeep]), { rx: rnd() * 3, ry: rnd() * 3, rz: rnd() * 3 }));
    }
  };
  rubble(-13.2, 2.6, 0.55, 9);
  rubble(-7.5, 1.6, 0.4, 6);
  rubble(3.2, -5.5, 0.5, 8);
  rubble(-4.5, 4.9, 0.45, 7);
  rubble(-15.3, 1.9, 0.5, 8);
  rubble(5.9, 1.9, 0.35, 5);
  floorGeoms.push(paint(new THREE.CircleGeometry(0.85, 20).rotateX(-Math.PI / 2).translate(-12.4, 0.02, 0), PAL.ash));          // 篝火灰圈（vfx 篝火落位处）
  for (const [bx, bz, ba] of [[-12.0, 0.35, 0.6], [-12.75, -0.3, -0.9], [-12.3, -0.55, 2.2]] as const)
    structGeoms.push(boxG(0.07, 0.5, 0.07, bx, 0.08, bz, PAL.bone, { rz: ba, ry: rnd() * 3 }));                                  // 散落残骨

  // —— 火盆座（金属件；火焰/炭芯单独建以便动效）——
  const flameMat0 = track(new THREE.MeshBasicMaterial({ color: 0xffa14e, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false })); // 火焰材质模板（clone 出独立闪烁相位）
  const coalGeoms: THREE.BufferGeometry[] = [];
  const flames: FlameRef[] = [];
  /** 挂墙火盆：拱门柱内侧 ×2 */
  const sconce = (z: number): void => {
    structGeoms.push(boxG(0.09, 0.6, 0.09, -6.6, 3.0, z * 1.58, PAL.metal));
    structGeoms.push(cylG(0.26, 0.14, 0.2, 8, -6.6, 3.3, z * 1.45, PAL.metal));
    coalGeoms.push(dodG(0.15, -6.6, 3.38, z * 1.45, 0x000000));
    const mesh = new THREE.Mesh(coneG(0.17, 0.55, 7, -6.6, 3.62, z * 1.45, 0xffffff), track(flameMat0.clone()));
    mesh.renderOrder = 6;
    root.add(mesh);
    const light = new THREE.PointLight(COLORS.ember, 7, 9, 2);
    light.position.set(-6.6, 3.75, z * 1.45);
    root.add(light);
    flames.push({ mesh, mat: mesh.material as THREE.MeshBasicMaterial, light, ph: z });
  };
  sconce(1);
  sconce(-1);
  /** 立式火盆：竞技场西南步道 ×1（三脚+炭钵） */
  {
    const x = -1.82, z = -6.05;
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.5;
      structGeoms.push(cylG(0.035, 0.045, 1.15, 6, x + Math.cos(a) * 0.24, 0.55, z + Math.sin(a) * 0.24, PAL.metal, { ry: -a, rz: 0.24 }));
    }
    structGeoms.push(cylG(0.34, 0.18, 0.26, 9, x, 1.18, z, PAL.metal));
    coalGeoms.push(dodG(0.18, x, 1.28, z, 0x000000));
    const mesh = new THREE.Mesh(coneG(0.2, 0.6, 7, x, 1.55, z, 0xffffff), track(flameMat0.clone()));
    mesh.renderOrder = 6;
    root.add(mesh);
    const light = new THREE.PointLight(COLORS.ember, 8, 11, 2);
    light.position.set(x, 1.7, z);
    root.add(light);
    flames.push({ mesh, mat: mesh.material as THREE.MeshBasicMaterial, light, ph: 3.3 });
  }
  const coalMat = track(new THREE.MeshStandardMaterial({ color: 0x2a1207, emissive: COLORS.ember, emissiveIntensity: 1.4, roughness: 1, flatShading: true }));
  {
    const m = batch(coalGeoms, coalMat, "none");
    m.matrixAutoUpdate = true;                           // batch 默认冻结矩阵，动态件还原
    root.add(m);
  }

  // —— 地面：走廊石板 / 出生平台 / 竞技场环纹铺装 ——
  floorGeoms.push(boxG(9.9, 0.2, 3.9, -10.0, -0.12, 0, PAL.mortar));                       // 石板垫床
  {
    let i = 0;
    for (let x = -14.7; x < -5.2; x += 1.19) {
      floorGeoms.push(boxG(1.12, 0.09, 3.5, x + 0.56, 0.005 + (i % 2) * 0.004, rnd() * 0.05, [PAL.pathA, PAL.pathB, PAL.pathC, PAL.pathB][i % 4], { jitter: 0.07 }));
      i++;
    }
  }
  for (const s of [-1, 1]) floorGeoms.push(boxG(2.6, 0.2, 1.5, -13.75, -0.09, s * 2.7, PAL.stoneDeep, { jitter: 0.1 }));      // 出生侧龛地台
  floorGeoms.push(boxG(2.5, 0.2, 5.4, -16.0, -0.09, 0, PAL.pathB, { jitter: 0.08 }));                                         // 门楼前地坪
  floorGeoms.push(boxG(0.5, 0.12, 2.2, -15.3, 0.06, 0, PAL.stoneMid));
  floorGeoms.push(boxG(0.5, 0.24, 2.0, -15.7, 0.12, 0, PAL.stoneMid));
  floorGeoms.push(paint(new THREE.CircleGeometry(6.75, 48).rotateX(-Math.PI / 2).translate(0.6, 0.012, 0), COLORS.ground, 0.06));
  {
    const ringTones = [0x262a30, 0x1b1e23, 0x262a30, 0x1b1e23];
    const rings: [number, number][] = [[1.45, 1.75], [2.95, 3.25], [4.45, 4.75], [5.95, 6.3]];
    rings.forEach(([r0, r1], i) =>
      floorGeoms.push(paint(new THREE.RingGeometry(r0, r1, 48).rotateX(-Math.PI / 2).translate(0.6, 0.02 + i * 0.002, 0), ringTones[i], 0.06)));
    floorGeoms.push(paint(new THREE.RingGeometry(1.05, 1.2, 40).rotateX(-Math.PI / 2).translate(0.6, 0.026, 0), PAL.goldDim, 0.1)); // 场心暗金徽环
  }

  // —— 墙体之下的悬崖体量（吃雾形成"高墙"落差，不参与阴影）——
  massGeoms.push(boxG(10.6, 14, 4.9, -9.85, -7, 0, PAL.cliff, { jitter: 0.12 }));
  massGeoms.push(boxG(3.0, 14, 6.2, -16.1, -7, 0, PAL.cliff, { jitter: 0.12 }));
  massGeoms.push(cylG(7.0, 8.6, 14, 24, 0.6, -7, 0, PAL.cliff, { jitter: 0.12 }));

  root.add(batch(structGeoms, stoneMat, "both"));
  root.add(batch(floorGeoms, stoneMat, "receive"));
  root.add(batch(massGeoms, stoneMat, "none"));

  // ---------------- 脚下深渊 + 雾海中的下层城区（falloff 靠 FogExp2 吃掉远端） ----------------
  {
    const abyss = new THREE.Mesh(
      new THREE.CircleGeometry(110, 40).rotateX(-Math.PI / 2).translate(-4, -14, -6),
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
  };
  {
    const roofGeoms: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 38; i++) {
      const a = rnd() * Math.PI * 2;
      const rad = rr(11, 38);
      const x = -4 + Math.cos(a) * rad;
      const z = -6 + Math.sin(a) * rad;
      if ((x > -15.5 && x < -4 && Math.abs(z) < 3.4) || Math.hypot(x - 0.6, z) < 8.0) continue;    // 避开正下方墙体内量
      const w = rr(1.6, 4.6), h = rr(1.4, 4.2), d = rr(1.6, 4.6);
      roofGeoms.push(boxG(w, h, d, x, -14 + h / 2 - 0.2, z, pick([PAL.roofA, PAL.roofB, PAL.stoneDeep]), { ry: rnd() * Math.PI, jitter: 0.12 }));
      if (rnd() < 0.55) addWinTown(x + rr(-w * 0.3, w * 0.3), -14 + h * 0.72, z + d * 0.52);
    }
    for (let i = 0; i < 3; i++) {                                                                   // 教堂尖顶剪影
      const a = rnd() * Math.PI * 2, rad = rr(16, 30);
      roofGeoms.push(coneG(rr(0.9, 1.4), rr(2.5, 4), 5, -4 + Math.cos(a) * rad, -11.5, -6 + Math.sin(a) * rad, PAL.roofB));
    }
    root.add(batch(roofGeoms, stoneMat, "none"));
  }
  const winTownMat = track(new THREE.PointsMaterial({ size: 0.3, vertexColors: true, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false }));
  {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(winTownPts.filter((_, i) => i % 6 < 3)), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(winTownPts.filter((_, i) => i % 6 >= 3)), 3));
    root.add(new THREE.Points(g, winTownMat));
  }

  // ---------------- 残旗 ×4（顶点摆动；见 flagGeo：撕裂 + 渐变） ----------------
  const flags: FlagRef[] = [];
  const flagDefs = [
    { w: 1.15, h: 1.8, x: -6.72, y: 6.72, z: 0, a: PAL.flagBlue, b: PAL.flagBlueB, ph: 1.2, sp: 2.1 },   // 破拱门顶
    { w: 1.0, h: 1.55, x: -9.2, y: 3.62, z: 2.8, a: PAL.flagChar, b: PAL.flagCharB, ph: 2.6, sp: 2.5 },  // 走廊墙外挑杆
    { w: 0.85, h: 1.4, x: 6.2, y: 10.0, z: -5.6, a: PAL.flagGold, b: PAL.flagGoldB, ph: 4.0, sp: 2.9 },  // 守望塔顶（暗金）
    { w: 1.45, h: 2.2, x: 6.79, y: 4.42, z: 2.26, a: PAL.flagBlue, b: PAL.flagBlueB, ph: 0.4, sp: 1.8 }, // 竞技场环墙大旗
  ];
  for (const d of flagDefs) {
    const { geo, orig } = flagGeo(d.w, d.h, d.a, d.b);
    const mesh = new THREE.Mesh(geo, track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true, side: THREE.DoubleSide })));
    mesh.position.set(d.x, d.y, d.z);
    mesh.rotation.y = Math.PI / 2;                        // 旗面横跨走廊（法线沿 X，顺风摆动）
    mesh.castShadow = true;
    root.add(mesh);
    flags.push({ mesh, orig, h: d.h, ph: d.ph, sp: d.sp });
  }
  // 旗杆（走廊墙外挑杆 + 环墙大旗杆）——静态小批
  root.add(batch([
    cylG(0.035, 0.05, 1.2, 6, -9.2, 3.75, 2.35, PAL.wood, { rx: Math.PI / 2 }),
    cylG(0.04, 0.055, 2.4, 6, 6.79, 3.3, 2.26, PAL.wood),
  ], stoneMat, "cast"));

  // ---------------- 地面雾片（Canvas 柔光贴图，漂移 + 呼吸） ----------------
  const mists: MistRef[] = [];
  {
    const tex = softDiscTexture();
    const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const defs = [
      { x: -13.0, y: 0.28, z: 0.4, s: 5.0, o: 0.06 },
      { x: -8.2, y: 0.22, z: -0.7, s: 4.0, o: 0.05 },
      { x: -5.9, y: 0.3, z: 0.6, s: 3.6, o: 0.055 },
      { x: -0.5, y: 0.24, z: 1.5, s: 4.5, o: 0.05 },
      { x: 2.2, y: 0.2, z: -2.2, s: 5.5, o: 0.045 },
      { x: 0.6, y: 0.35, z: 4.2, s: 4.0, o: 0.05 },
    ];
    for (const d of defs) {
      const mat = track(new THREE.MeshBasicMaterial({ map: tex, color: 0x232b3a, transparent: true, opacity: d.o, depthWrite: false }));
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
      fl.mesh.scale.set(1 + (s - 1) * 0.4, s, 1 + (s - 1) * 0.4);
      fl.mesh.rotation.z = Math.sin(animT * 2.1 + fl.ph) * 0.09;        // 火苗侧摆
      fl.mesh.rotation.x = Math.cos(animT * 1.7 + fl.ph * 0.8) * 0.07;  // 火苗前后俯仰
      fl.mat.opacity = 0.7 + 0.2 * Math.sin(animT * 13 + i * 1.7);
      fl.light.intensity = 6.2 + Math.sin(animT * 9.5 + i * 2.4) * 1.4 + Math.sin(animT * 23 + i) * 0.7;
    }
    coalMat.emissiveIntensity = 1.35 + Math.sin(animT * 7.3) * 0.3;
    {                                                                   // 流云：wrap 循环漂移 + 边缘渐隐（进出不跳变）
      const span = CLOUD_SPAN.max - CLOUD_SPAN.min;
      for (const c of clouds) {
        const x = c.x0 + (((animT * c.sp) % span) + span) % span + CLOUD_SPAN.min;
        const k = Math.min(1, Math.max(0, Math.min((x - CLOUD_SPAN.min) / CLOUD_SPAN.fade, (CLOUD_SPAN.max - x) / CLOUD_SPAN.fade)));
        c.mesh.position.x = x;
        c.mat.opacity = c.o * k * k;
      }
    }
    winFarMat.opacity = 0.72 + Math.sin(animT * 0.8) * 0.14 + Math.sin(animT * 2.3) * 0.08;
    winTownMat.opacity = 0.66 + Math.sin(animT * 1.1 + 2) * 0.15 + Math.sin(animT * 3.1) * 0.07;
    starMat.opacity = 0.72 + Math.sin(animT * 0.5) * 0.12 + Math.sin(animT * 1.3) * 0.06;
    for (const m of mists) {
      m.mesh.position.x = m.bx + Math.sin(animT * m.spx + m.ph) * m.dx;
      m.mesh.position.z = m.bz + Math.cos(animT * m.spz + m.ph * 1.7) * m.dz;
      m.mesh.rotation.z += 0.0004;
      m.mat.opacity = m.o + Math.sin(animT * 0.21 + m.ph) * 0.028;
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
