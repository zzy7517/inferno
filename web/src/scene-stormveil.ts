/** 场景三「史东薇尔城垣」——T7 全量美术场景（design/m4-level-flow.md §3.3 分区表 / §4.1 裁决 / §7 色板定夺）
 *
 * 对标法环史东薇尔外城墙：西侧主门封死来路，四折之字坡沿大城墙盘上（风暴风效），过断翼露台抵
 * 玛尔基特雾门；胜后东拱门通接肢教堂——西段塌顶残柱走道，东端完整圣所即葛瑞克竞技场。
 *
 * 布局（X 西→东为前进轴，Z+ 北侧临渊；全图包围盒 ~80×60 m，可走 ~1500 m²）：
 *   E1 城垣外梯  x∈[-38,-20.5]  四折之字坡（走幅 z±11），南倚大城墙、北临深渊，篝火在坡底主门前
 *   E2 断翼露台  x∈[-20.5,-8]   城墙头台地（z±4.5），断翼残骸+攻城弩残骸，东端收口为玛尔基特雾门
 *   E3 玛尔基特房 d=24 m         圆形雉堞竞技场，中心 (1.5,0,0) 可走 r=11.1，东侧拱门通教堂
 *   E4 残柱厅    x∈[12.4,24]    接肢教堂西段塌顶走道（z±4，塌方碎堆夹峙的残柱通道）
 *   E5 接肢教堂  d=28 m         巨厅 x∈[14,41.5]×z±15.2，可走圆 r=13.1 中心 (26.5,0,0)=葛瑞克竞技场
 *
 * E4/E5 接肢教堂内景深加工（对标法环·接肢教堂「被亵渎的圣所」）：E5 教堂中厅竖向空间用足
 *   （三面墙抬升到 12.4 + 幸存桁架屋盖 x∈[24.5,41.8]——E4 段塌顶露天，「教堂断成两截」天际线）、
 *   尖拱高侧窗冷月透光 / 东端半圆后殿 apse+残破玫瑰窗（金红祭仪焦点）/ 悬肢残躯+锁链+蜡泪祭坛+
 *   接肢失败蜷躯+金血红渍（肢体崇拜叙事）；E4 暗廊残墙+烛台光龛（暖橙）+地面裂缝余烬微光，
 *   与教堂内冷月形成进深对比；氛围=尘埃光柱（additive 单批）+腐金/冷月双色温+雾密度室内外分层。
 *   PointLight 预算已满 5 盏（壁炬×2/火盆×2/圣坛恩泽），新增光效全走 emissive 批。
 *
 * 色板（§7 裁决：风暴青灰）：石色整体带青灰(绿相)、天穹青灰风暴云、无月——以「风暴面纱」双旋带与
 *   远堡暖窗代偿高墙月亮的构图锚；暗金只留给接肢教堂（E4/E5），玛尔基特房仅一枚暗金徽环点题。
 *   与墓地灰金、高墙冷蓝三分立。
 *
 * 预算（§4.2）：静态几何按 5 个空间分块 merge 合批（E1/E2/E3/E4/E5 各一 + 地面/山体/远景分批，
 *   frustum 可剔剪）；场景本体 ≤45 draw call；PointLight≤5（篝火属 game.ts 不计）；0 外部资源，
 *   柔光贴图运行时 Canvas 生成；构建确定性随机（每次进场景布局一致）。
 */
import * as THREE from "three";
import { COLORS } from "./config";
import { createSceneGeom } from "./scene-geom";
import type { SceneAnchors, SceneZone } from "./scene-highwall";

export interface SceneResult {
  anchors: SceneAnchors;
  update?: (t: number, dt: number) => void;
  dispose: () => void;
}

/** 传送锚→玛尔基特雾门的主线步径（之字坡四折+露台绕行，~125 m ≈ 20 s @6.2 m/s；
 *  供探针/CI 引用同一份路径真源；坐标均为 [x,z]） */
export const STORMVEIL_WALK: [number, number][] = [
  [-36.6, 1.2],   // 传送锚/篝火
  [-35.8, 10.2],  // C1 北折
  [-34.6, -10.2], // C1 南下（南折点）
  [-32.2, -8.8],  // 过南缺口入 C2
  [-31.0, 10.2],  // C2 北上
  [-28.2, 8.8],   // 过北缺口入 C3
  [-26.6, -10.2], // C3 南下
  [-23.8, -8.8],  // 过南缺口入 C4
  [-22.6, 8.0],   // C4 北上
  [-20.9, 4.0],   // 坡顶收口
  [-18.2, -3.2],  // E2 露台绕行
  [-14.8, 2.9],
  [-11.4, -2.9],
  [-9.6, 2.6],
  [-8.2, -1.2],   // 雾门收口渐窄
  [-5.0, 0.0],    // 玛尔基特雾门
];

/** 派生色板：风暴青灰（ADR-0006 纪律：石色系中间阶 + 低饱和；强调色仅 ember/gold 系） */
const PAL = {
  stoneHi: 0x4a545c, stone: 0x3f4952, stoneMid: 0x353f47, stoneDark: 0x2a323a,
  stoneDeep: 0x20262d, mortar: 0x161c22, dark: 0x0a0e13, cliff: 0x1d242b,
  pathA: 0x2f3a3c, pathB: 0x2a3236, pathC: 0x333c3d, moss: 0x2c3a33,
  wallHi: 0x46505a, wall: 0x39434d, wallDeep: 0x252d35,
  skyTop: 0x0a0f13, skyHorizon: 0x27333b, skyUnder: 0x141b21,
  ridgeFar: 0x171e26, ridgeNear: 0x121820, castle: 0x0f151c,
  roofA: 0x1a2026, roofB: 0x151a20,
  flagSlate: 0x3d4854, flagSlateB: 0x272f3b, flagChar: 0x2c3138, flagCharB: 0x1c2127,
  flagGold: 0x665637, flagGoldB: 0x453a27,
  wood: 0x2b2620, metal: 0x4c525a, bone: 0x494337, ash: 0x17140f,
  goldDim: 0x6d5e40, amber: 0x8a6a3e, amberHi: 0xb98d52,
  mistColor: 0x2a3641,
  // —— E4 接肢教堂内景派生色（§7「暗金只留给接肢教堂」的深加工：建筑本体冷蓝 / 祭仪元素腐金）——
  paneMoon: 0x7fa6d4, paneMoonB: 0x6e94c6, paneMoonC: 0x8db8e2, paneDim: 0x33486e,
  amberGlow: 0xd89850, amberHiGlow: 0xf2bd6e, spokeGlow: 0xc08a48,           // 玫瑰窗日晖（自发光亮阶——远读的信标）
  rot1: 0x4c5540, rot2: 0x3d4434, flesh: 0x452a22,                    // 接肢肉色（腐绿/暗红低饱和）
  bloodA: 0x351c16, bloodB: 0x42231a, bloodC: 0x4a3020,               // 金血红渍（暗红→带金的三阶）
  wax: 0x9a8258, emberRed: 0x8a3b26, vault: 0x1a1f26,
};

// ---------------- 确定性随机（build 时重置种子：每次构建布局一致） ----------------
let seed = 20261112;
const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
const rr = (a: number, b: number): number => a + rnd() * (b - a);
const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length) % arr.length];

/** 与另外两个场景同一份实现；jitter 仍消耗本文件的 rnd。 */
const { paint, boxG, cylG, coneG, dodG, batch } = createSceneGeom(rnd);

/** 运行时 Canvas 径向柔光贴图（云/雾片/光晕共用，非外部资源） */
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

/** 残旗：撕裂旗面 + 竖向风化渐变顶点色（高墙同款；风暴摆幅在 update 中加大） */
function flagGeo(w: number, h: number, colA: number, colB: number): { geo: THREE.BufferGeometry; orig: Float32Array } {
  const g = new THREE.PlaneGeometry(w, h, 7, 10);
  const p = g.attributes.position as THREE.BufferAttribute;
  const cols = 7, rows = 10;
  for (let iy = 0; iy <= rows; iy++) {
    for (let ix = 0; ix <= cols; ix++) {
      const i = iy * (cols + 1) + ix;
      if (iy === rows && ix % 2 === 1) p.setY(i, p.getY(i) + h * (0.1 + ((ix * 37) % 11) / 60));
      if (iy === rows || ix === 0 || ix === cols) p.setX(i, p.getX(i) + (((ix * 53 + iy * 29) % 13) - 6) / 200);
    }
  }
  g.translate(0, -h / 2, 0);
  const ng = g.toNonIndexed();
  g.dispose();
  const pos = ng.attributes.position;
  const arr = new Float32Array(pos.count * 3);
  const a = new THREE.Color(colA), b = new THREE.Color(colB), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const k = Math.min(1, Math.max(0, -pos.getY(i) / h));
    c.copy(a).lerp(b, k);
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  ng.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  const orig = new Float32Array((ng.attributes.position as THREE.BufferAttribute).array as Float32Array);
  return { geo: ng, orig };
}

interface FlagRef { mesh: THREE.Mesh; orig: Float32Array; h: number; ph: number; sp: number; amp: number }
interface FlameRef { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; light: THREE.PointLight; ph: number }
interface MistRef { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; bx: number; bz: number; dx: number; dz: number; ph: number; spx: number; spz: number; o: number }
interface CloudRef { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; x0: number; sp: number; o: number }
interface SwirlRef { inner: THREE.Mesh; mat: THREE.MeshBasicMaterial; ph: number; spin: number }

// ================================================================
export function buildStormveil(scene: THREE.Scene): SceneResult {
  seed = 20261112;                                   // 确定性：每次构建同一布局
  const root = new THREE.Group();
  root.name = "stormveil";
  scene.add(root);

  /** 锚点：legacy 六字段指向玛尔基特 A 侧（篝火→雾门→Boss 房）；
 *  zones 西→东有序，E 区=E1+E2+E3（id stormveil:E）、E4 区=E4+E5（id stormveil:E4）。 */
  const anchors: SceneAnchors = {
    spawn: new THREE.Vector3(-36.6, 0, 1.2),
    bonfire: new THREE.Vector3(-36.6, 0, 0),
    fogGate: new THREE.Vector3(-5.0, 0, 0),
    bossArena: new THREE.Vector3(1.5, 0, 0),
    arenaRadius: 12,
    corridorMinX: -37.5,
    zones: [
      { id: "stormveil:E", kind: "corridor", minX: -38, maxX: -20.5, half: 11 },            // E1 之字坡
      { id: "stormveil:E", kind: "corridor", minX: -20.5, maxX: -8, half: 4.5 },            // E2 断翼露台
      { id: "stormveil:E", kind: "corridor", minX: -8, maxX: -5, half: 2.2 },               // 雾门收口
      { id: "stormveil:E", kind: "arena", minX: -5, maxX: 13, center: new THREE.Vector3(1.5, 0, 0), r: 12 },     // E3 玛尔基特房
      { id: "stormveil:E4", kind: "corridor", minX: 12.4, maxX: 24, half: 4 },              // E4 残柱厅（拱门+塌方走道）
      { id: "stormveil:E4", kind: "arena", minX: 24, maxX: 42, center: new THREE.Vector3(26.5, 0, 0), r: 14 },   // E5 接肢教堂
      { id: "stormveil:F", kind: "corridor", minX: 39.2, maxX: 52.9, half: 2.6 },           // F1 谒见长廊（圣所东门→王座厅；39.2=E5 可走鼻 39.6-0.4）
      { id: "stormveil:F", kind: "arena", minX: 52.9, maxX: 80, center: new THREE.Vector3(66, 0, 0), r: 14 },     // F2 王座厅（蒙格特）
    ] satisfies SceneZone[],
  };

  // 天空与雾（dispose 时还原）；雾密度/色温随相机 x 室内外分层（update 驱动）
  const prevBg = scene.background;
  const prevFog = scene.fog;
  scene.background = new THREE.Color(PAL.skyUnder);
  scene.fog = new THREE.FogExp2(PAL.skyUnder, 0.026);
  const fogBase = new THREE.Color(PAL.skyUnder);   // 室外：风暴青灰
  const fogIn = new THREE.Color(0x241f18);         // 教堂内：微暖的腐金空气
  let camX = -36.6;                                // 相机 x（天穹 onBeforeRender 逐帧记录）

  const mats: THREE.Material[] = [];
  const track = <T extends THREE.Material>(m: T): T => { mats.push(m); return m; };

  // ---------------- 灯光：风暴天光（青灰主灯带阴影）+ 半天环境光 ----------------
  const stormLight = new THREE.DirectionalLight(0x9fb6bb, 1.45);
  stormLight.position.set(16, 30, -20);              // 东北侧高位（城堡一方来光）
  stormLight.castShadow = true;
  stormLight.shadow.mapSize.set(2048, 2048);
  Object.assign(stormLight.shadow.camera, { left: -30, right: 30, top: 24, bottom: -24, near: 2, far: 85 });
  stormLight.shadow.camera.updateProjectionMatrix();
  stormLight.shadow.bias = -0.0002;
  stormLight.shadow.normalBias = 0.035;
  const lightTarget = new THREE.Object3D();
  lightTarget.position.set(8, 0, 0);                 // 覆盖 E2~E5 主战斗带；E1 外梯吃雾即可
  root.add(lightTarget);
  stormLight.target = lightTarget;
  root.add(stormLight);
  root.add(new THREE.HemisphereLight(0x364650, 0x181c20, 0.85));
  // 教堂内景补光：无投影冷色平行光（同 stormLight 方位、穿墙不投影）——三面高墙的投影扇会把
  // 中厅地板压到近黑；此灯模拟「北面尖拱窗透进的冷月」，救回 Boss 房可读性（非 PointLight，不占预算）
  const naveFill = new THREE.DirectionalLight(0x9db4c6, 0.52);
  naveFill.position.set(37, 30, -20);
  const fillTarget = new THREE.Object3D();
  fillTarget.position.set(29, 0, 0);
  root.add(fillTarget);
  naveFill.target = fillTarget;
  root.add(naveFill);

  // ---------------- 天幕：大球内壁竖向渐变（青灰风暴，地平线微亮） ----------------
  {
    const geo = new THREE.SphereGeometry(70, 32, 20);
    const pos = geo.attributes.position;
    const colArr = new Float32Array(pos.count * 3);
    const top = new THREE.Color(PAL.skyTop), hor = new THREE.Color(PAL.skyHorizon), un = new THREE.Color(PAL.skyUnder);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const ny = pos.getY(i) / 70;
      if (ny >= 0) c.copy(hor).lerp(top, Math.pow(Math.min(1, ny / 0.85), 0.65));
      else c.copy(hor).lerp(un, Math.min(1, -ny * 3.2));
      colArr[i * 3] = c.r; colArr[i * 3 + 1] = c.g; colArr[i * 3 + 2] = c.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colArr, 3));
    const sky = new THREE.Mesh(geo, track(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })));
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    sky.onBeforeRender = (_r, _s, cam) => { camX = cam.position.x; };   // 记录相机 x：室内外雾分层用
    root.add(sky);
  }

  // ---------------- 风暴流云：三层暗云带（快漂、穿天穹、wrap 循环） ----------------
  const CLOUD_SPAN = { min: -84, max: 84, fade: 24 };
  const clouds: CloudRef[] = [];
  {
    const tex = softDiscTexture();
    const cloudPlane = new THREE.PlaneGeometry(1, 1);
    const defs = [
      { x: -34, y: 30.0, z: -40.0, w: 40, h: 13, o: 0.16, c: 0x5c6870, sp: 1.35 },
      { x: 8, y: 33.0, z: -46.0, w: 52, h: 15, o: 0.13, c: 0x6a757c, sp: 1.05 },
      { x: 48, y: 27.5, z: -38.0, w: 34, h: 11, o: 0.17, c: 0x525e66, sp: 1.6 },
    ];
    for (const d of defs) {
      const mat = track(new THREE.MeshBasicMaterial({ map: tex, color: d.c, transparent: true, opacity: 0, depthWrite: false, fog: false }));
      const mesh = new THREE.Mesh(cloudPlane, mat);
      mesh.scale.set(d.w, d.h, 1);
      mesh.position.set(d.x, d.y, d.z);
      mesh.lookAt(0, 4, 0);
      mesh.renderOrder = -6;
      root.add(mesh);
      clouds.push({ mesh, mat, x0: d.x, sp: d.sp, o: d.o });
    }
  }

  // ---------------- 「风暴面纱」：远堡上空双旋带 + 远堡暖晕（史东薇尔的构图锚，代偿月亮） ----------------
  const swirls: SwirlRef[] = [];
  {
    const tex = softDiscTexture();
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(26, 26), track(new THREE.MeshBasicMaterial({ map: tex, color: 0x5a5646, transparent: true, opacity: 0.13, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })));
    halo.position.set(60, 16, -30);
    halo.lookAt(0, 8, 0);
    halo.renderOrder = -5;
    root.add(halo);
    const defs = [
      { x: 60, y: 25, z: -30, ri: 6.0, ro: 11.5, o: 0.12, c: 0x6f7566, spin: 0.5 },
      { x: 67, y: 18, z: -16, ri: 4.4, ro: 8.6, o: 0.1, c: 0x767a68, spin: -0.36 },
    ];
    for (const d of defs) {
      const grp = new THREE.Group();
      grp.position.set(d.x, d.y, d.z);
      grp.lookAt(0, 10, 0);
      const mat = track(new THREE.MeshBasicMaterial({ color: d.c, transparent: true, opacity: d.o, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false, fog: false }));
      const inner = new THREE.Mesh(new THREE.CylinderGeometry(d.ri, d.ro, 1.3, 26, 1, true).rotateX(Math.PI / 2), mat);
      grp.add(inner);
      grp.renderOrder = -4;
      root.add(grp);
      swirls.push({ inner, mat, ph: d.x, spin: d.spin });
    }
  }

  // ---------------- 远景：风暴群山 + 远堡剪影（fog:false 手绘雾色）+ 窗火点云 ----------------
  const farGeoms: THREE.BufferGeometry[] = [];
  const winFarPts: number[] = [];
  const addWinFar = (x: number, y: number, z: number, dim = 1): void => {
    const c = new THREE.Color(rnd() < 0.35 ? COLORS.gold : COLORS.ember).multiplyScalar(0.5 + rnd() * 0.5 * dim);
    winFarPts.push(x, y, z, c.r, c.g, c.b);
  };
  const peak = (r: number, h: number, x: number, y: number, z: number, color: number, jag = 0.4): void => {
    const g = new THREE.ConeGeometry(r, h, 6, 3);
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const ox = p.getX(i), oy = p.getY(i), oz = p.getZ(i);
      const k = (oy + h / 2) / h;
      const j1 = Math.sin(ox * 127.1 + oz * 311.7) * 43758.5453;
      const j2 = Math.sin(ox * 269.5 + oz * 183.3 + 74.7) * 22578.145;
      p.setX(i, ox * (1 + ((j1 - Math.floor(j1)) - 0.5) * jag * (1.2 - k)));
      p.setZ(i, oz * (1 + ((j2 - Math.floor(j2)) - 0.5) * jag * (1.2 - k)));
    }
    g.translate(x, y + h / 2, z);
    farGeoms.push(paint(g, color, 0.1));
  };
  peak(44, 26, -30, -13, -68, PAL.ridgeFar);
  peak(56, 34, 34, -15, -72, PAL.ridgeFar);
  peak(30, 16, 74, -10, -56, PAL.ridgeFar);
  peak(40, 22, -64, -11, -60, PAL.ridgeFar);
  peak(28, 15, -14, -9, -54, PAL.ridgeNear);
  peak(34, 20, 44, -10, -58, PAL.ridgeNear);
  // 远堡（东北：史东薇尔主城，衬在接肢教堂之后——葛瑞克的巢）
  {
    const cx = 62, cy = -3, cz = -34;
    farGeoms.push(boxG(34, 4, 8, cx, cy + 2, cz, PAL.cliff, { jitter: 0.1 }));
    farGeoms.push(boxG(30, 7, 3, cx, cy + 6.5, cz, PAL.castle));
    for (let i = -3; i <= 3; i++) farGeoms.push(boxG(1.2, 1.1, 3.4, cx + i * 3.4, cy + 10.6, cz, PAL.castle));
    farGeoms.push(boxG(7.5, 20, 7.5, cx - 4, cy + 10, cz - 1, PAL.castle));                    // 主堡
    farGeoms.push(coneG(5.2, 6.5, 4, cx - 4, cy + 23.2, cz - 1, 0x0c1117, { ry: Math.PI / 4 }));
    farGeoms.push(boxG(3.4, 15, 3.4, cx - 14.5, cy + 7.5, cz + 0.5, PAL.castle));              // 左塔
    farGeoms.push(coneG(2.8, 4.6, 6, cx - 14.5, cy + 17.3, cz + 0.5, 0x0c1117));
    farGeoms.push(boxG(3.0, 12.5, 3.0, cx + 12.8, cy + 6.2, cz + 0.5, PAL.castle));            // 右塔（断顶）
    for (let i = 0; i < 4; i++) farGeoms.push(boxG(0.6, 0.8 + rnd() * 0.6, 0.6, cx + 12.8 + Math.cos(i * 1.6) * 1.7, cy + 12.9, cz + Math.sin(i * 1.6) * 1.7, PAL.castle, { ry: i }));
    farGeoms.push(boxG(9, 0.8, 1.6, cx + 4, cy + 11.5, cz + 0.5, PAL.castle));                 // 跨塔石桥
    for (const wy of [8, 12, 16]) for (const wx of [-2.2, 0, 2.2]) addWinFar(cx - 4 + wx, cy + wy, cz + 2.9);
    addWinFar(cx - 14.5, cy + 10, cz + 2.2);
    addWinFar(cx - 14.5, cy + 12.5, cz + 2.2);
    addWinFar(cx + 12.8, cy + 9, cz + 2.0);
    for (let wx = -10; wx <= 10; wx += 4) addWinFar(cx + wx, cy + 4.5, cz + 1.7, 0.55);
  }
  const farMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true, fog: false }));
  root.add(batch(farGeoms, farMat, "none"));
  const winFarMat = track(new THREE.PointsMaterial({ size: 0.55, vertexColors: true, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(winFarPts.filter((_, i) => i % 6 < 3)), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(winFarPts.filter((_, i) => i % 6 >= 3)), 3));
    root.add(new THREE.Points(g, winFarMat));
  }

  // ---------------- 空间分块的静态几何收集器（合批 → frustum 剔剪） ----------------
  const stoneMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true, side: THREE.DoubleSide }));
  const sE1: THREE.BufferGeometry[] = [], sE2: THREE.BufferGeometry[] = [], sE3: THREE.BufferGeometry[] = [];
  const sE4: THREE.BufferGeometry[] = [], sE5: THREE.BufferGeometry[] = [];
  const fE1: THREE.BufferGeometry[] = [], fE2: THREE.BufferGeometry[] = [], fE3: THREE.BufferGeometry[] = [];
  const fE45: THREE.BufferGeometry[] = [];
  const massGeoms: THREE.BufferGeometry[] = [];
  const emisGeoms: THREE.BufferGeometry[] = [];     // 暖窗/残烛/玫瑰窗碎片（自发光小批）
  const coldGlowGeoms: THREE.BufferGeometry[] = []; // 冷月窗格/玫瑰窗龛（建筑本体冷蓝，慢呼吸批）
  const shaftsGeoms: THREE.BufferGeometry[] = [];   // 尘埃光柱（additive 半透明，顶亮底暗顶点色）

  /** 顺墙段：两点连线生成旋转墙体 */
  const wallSeg = (arr: THREE.BufferGeometry[], x1: number, z1: number, x2: number, z2: number, h: number, y: number, c: number, th = 0.6): void => {
    const dx = x2 - x1, dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    arr.push(boxG(len + th, h, th, (x1 + x2) / 2, y + h / 2, (z1 + z2) / 2, c, { ry: Math.atan2(-dz, dx), jitter: 0.09 }));
  };
  /** 瓦砾堆 */
  const rubble = (arr: THREE.BufferGeometry[], x: number, z: number, r: number, n: number): void => {
    for (let i = 0; i < n; i++) {
      const s = rr(0.08, 0.24);
      arr.push(dodG(s, x + rr(-r, r), s * rr(0.4, 0.8), z + rr(-r, r), pick([PAL.stoneDark, PAL.stoneMid, PAL.stoneDeep]), { rx: rnd() * 3, ry: rnd() * 3, rz: rnd() * 3 }));
    }
  };
  /** 雉堞：沿 X 向直线墙顶 */
  const crenels = (arr: THREE.BufferGeometry[], x0: number, x1: number, z: number, y: number, c: number, keep = 0.75): void => {
    for (let x = x0; x <= x1; x += 0.85) {
      if (rnd() > keep) continue;
      arr.push(boxG(0.5, 0.55 + rnd() * 0.25, 0.42, x, y, z, c, { jitter: 0.12 }));
    }
  };

  // ================================================= E1 城垣外梯：四折之字坡
  {
    // —— 坡道基底 + 逐道铺石（四条坡道 x 带，之字折返） ——
    massGeoms.push(boxG(17.8, 0.5, 25.2, -29.1, -0.27, 0, PAL.cliff, { jitter: 0.1 }));
    const bands: [number, number][] = [[-37.5, -33.3], [-33.3, -29.1], [-29.1, -24.9], [-24.9, -20.5]];
    for (const [bx0, bx1] of bands) {
      let i = 0;
      for (let z = -11.8; z < 11.8; z += 1.52) {
        if (rnd() < 0.06) { i++; continue; }        // 缺石
        fE1.push(boxG(bx1 - bx0 - 0.14, 0.08, 1.38, (bx0 + bx1) / 2, 0.012 + (i % 2) * 0.004, z + 0.72, pick([PAL.pathA, PAL.pathB, PAL.pathC, PAL.moss]), { jitter: 0.08 }));
        i++;
      }
    }
    // —— 之字隔墙（矮护墙，折点处留缺口：南/北/南交替） ——
    const divs: [number, -1 | 1][] = [[-33.3, -1], [-29.1, 1], [-24.9, -1]];
    for (const [xd, gapSide] of divs) {
      const z0 = gapSide < 0 ? -5.6 : -12.3;
      const z1 = gapSide < 0 ? 12.3 : 5.6;
      sE1.push(boxG(0.78, 1.15, z1 - z0, xd, 0.58, (z0 + z1) / 2, PAL.stoneDark, { jitter: 0.1 }));
      sE1.push(boxG(0.95, 0.14, z1 - z0 + 0.2, xd, 1.2, (z0 + z1) / 2, PAL.stoneMid));
      for (let z = z0 + 0.6; z < z1; z += 1.7) if (rnd() < 0.5) sE1.push(boxG(0.55, 0.4, 0.4, xd, 1.48, z, PAL.stone, { ry: rnd() * 0.4, jitter: 0.12 }));
      rubble(sE1, xd + gapSide * 1.2, gapSide * 9.8, 0.8, 5);   // 折点碎石导流
    }
    // —— 南侧大城墙（倚城攀升：西高东低） ——
    const segs: [number, number, number][] = [[-39, -32.5, 13.5], [-32.5, -26, 11.8], [-26, -19.8, 10.2]];
    for (const [wx0, wx1, wh] of segs) {
      const wm = (wx0 + wx1) / 2;
      sE1.push(boxG(wx1 - wx0, wh, 1.7, wm, wh / 2, -13.5, PAL.wall, { jitter: 0.07 }));
      sE1.push(boxG(wx1 - wx0 + 0.5, 2.6, 2.6, wm, 1.1, -14.2, PAL.wallDeep, { jitter: 0.08 }));   // 贴脚
      sE1.push(boxG(wx1 - wx0, 0.26, 2.0, wm, wh + 0.13, -13.5, PAL.wallHi));                      // 压顶
      crenels(sE1, wx0 + 0.5, wx1 - 0.5, -13.5, wh + 0.62, PAL.wallHi, 0.7);
      for (let x = wx0 + 1.2; x < wx1; x += 2.7) sE1.push(boxG(0.16, 0.9, 0.14, x, wh * 0.62, -12.62, PAL.mortar));  // 箭缝
    }
    // —— 北侧临渊矮堞（风暴直灌面，残缺更甚） ——
    {
      let x = -37.4;
      while (x < -20.9) {
        const len = rr(1.2, 2.6);
        if (rnd() < 0.68) {
          sE1.push(boxG(len, 1.05, 0.6, x + len / 2, 0.52, 12.45, PAL.stoneDark, { jitter: 0.1 }));
          if (rnd() < 0.5) sE1.push(boxG(0.45, 0.5, 0.4, x + len / 2, 1.3, 12.45, PAL.stone, { jitter: 0.12 }));
        }
        x += len + rr(0.3, 1.4);
      }
    }
    // —— 西端主门楼：封死来路（大门紧闭 + 落闸） ——
    sE1.push(boxG(4.6, 16, 14.2, -40.0, 8, -6.4, PAL.wallDeep, { jitter: 0.06 }));
    sE1.push(boxG(5.0, 0.6, 14.8, -40.0, 16.3, -6.4, PAL.wall));
    for (let i = -2; i <= 2; i++) sE1.push(boxG(1.1, 1.0, 1.2, -40.0, 17.1, -6.4 + i * 2.7, PAL.wall, { jitter: 0.1 }));
    sE1.push(boxG(0.7, 4.6, 4.4, -37.6, 2.3, -6.4, PAL.dark));                                     // 门洞暗龛
    for (let i = 0; i < 5; i++) sE1.push(boxG(0.12, 4.0, 0.12, -37.55, 2.0, -8.1 + i * 0.85, PAL.metal));   // 落闸栅
    for (let i = 0; i < 3; i++) sE1.push(boxG(0.1, 0.1, 3.6, -37.5, 0.9 + i * 1.3, -6.4, PAL.metal));
    emisGeoms.push(boxG(0.2, 0.3, 0.2, -37.7, 3.6, -8.6, 0x5a3f22));                               // 未燃火把×2（微光）
    emisGeoms.push(boxG(0.2, 0.3, 0.2, -37.7, 3.6, -4.2, 0x5a3f22));
    sE1.push(boxG(1.0, 5.0, 8.0, -38.6, 2.5, 4.8, PAL.wallDeep, { jitter: 0.08 }));                // 门楼接墙（北段收口）
    sE1.push(boxG(1.0, 3.5, 4.6, -38.6, 1.75, 10.4, PAL.wallDeep, { jitter: 0.08 }));
    sE1.push(boxG(0.55, 0.45, 0.55, -37.9, 4.9, -8.6, PAL.metal));
    sE1.push(boxG(0.55, 0.45, 0.55, -37.9, 4.9, -4.2, PAL.metal));
    // —— 坡底篝火龛（篝火本体由 game.ts 落位） ——
    fE1.push(paint(new THREE.CircleGeometry(0.85, 20).rotateX(-Math.PI / 2).translate(-36.6, 0.02, 0), PAL.ash));
    for (const [bx, bz, ba] of [[-36.0, 0.4, 0.6], [-37.15, -0.35, -0.9], [-36.5, -0.6, 2.2]] as const)
      sE1.push(boxG(0.07, 0.5, 0.07, bx, 0.08, bz, PAL.bone, { rz: ba, ry: rnd() * 3 }));
    rubble(sE1, -35.6, 2.6, 0.5, 6);
    // 北渊断崖体量（雾海吃掉落差）
    massGeoms.push(boxG(19.5, 3.0, 4.5, -29.2, -1.9, 15.2, PAL.cliff, { jitter: 0.12 }));
    massGeoms.push(boxG(19.5, 6.0, 4.0, -29.2, -5.6, 17.6, PAL.cliff, { jitter: 0.12 }));
    massGeoms.push(boxG(19.5, 9.0, 4.0, -29.2, -11.0, 20.2, PAL.cliff, { jitter: 0.12 }));
  }

  // ================================================= E2 断翼露台
  {
    massGeoms.push(boxG(16.2, 0.5, 14.0, -12.7, -0.27, 0, PAL.cliff, { jitter: 0.1 }));
    // 南墙（大城墙延续，矮下去——已在墙头）
    sE2.push(boxG(15.0, 7.6, 1.5, -13.0, 3.8, -7.3, PAL.wall, { jitter: 0.07 }));
    sE2.push(boxG(15.4, 2.2, 2.4, -13.0, 0.9, -8.0, PAL.wallDeep, { jitter: 0.08 }));
    sE2.push(boxG(15.0, 0.24, 1.9, -13.0, 7.72, -7.3, PAL.wallHi));
    crenels(sE2, -20.0, -6.4, -7.3, 8.2, PAL.wallHi, 0.65);
    for (let x = -18.6; x < -6.6; x += 3.0) sE2.push(boxG(0.16, 0.8, 0.14, x, 4.9, -6.42, PAL.mortar));
    // 北堞（临渊）
    {
      let x = -20.0;
      while (x < -5.8) {
        const len = rr(1.4, 3.0);
        if (rnd() < 0.7) sE2.push(boxG(len, 1.05, 0.6, x + len / 2, 0.52, 6.85, PAL.stoneDark, { jitter: 0.1 }));
        x += len + rr(0.4, 1.6);
      }
    }
    // 西收口漏斗（坡顶 z±12 → 露台 z±6.6）
    wallSeg(sE2, -21.4, 12.3, -20.4, 6.4, 2.6, 0, PAL.stoneDark);
    wallSeg(sE2, -21.4, -12.3, -20.4, -6.4, 2.6, 0, PAL.stoneDark);
    // 东收口漏斗（露台 z±4.6 → 雾门 z±2.2）
    wallSeg(sE2, -8.0, 4.6, -5.15, 2.3, 4.6, 0, PAL.stoneMid);
    wallSeg(sE2, -8.0, -4.6, -5.15, -2.3, 4.6, 0, PAL.stoneMid);
    // 玛尔基特雾门门墩（x=-5.15，雾门本体由 game.ts 落位）
    for (const s of [-1, 1]) {
      sE2.push(boxG(1.0, 5.4, 1.3, -5.15, 2.7, s * 2.45, PAL.stoneMid, { jitter: 0.1 }));
      sE2.push(boxG(0.75, 0.55, 1.0, -5.15, 5.65, s * 2.45, PAL.stone));
      sE2.push(boxG(0.9, 0.35, 2.3, -5.15, 5.1, s * 1.6, PAL.stoneHi));
    }
    sE2.push(boxG(1.15, 0.7, 5.6, -5.15, 5.95, 0, PAL.stoneHi, { jitter: 0.08 }));                 // 门楣
    sE2.push(coneG(0.5, 1.0, 4, -5.15, 6.8, 0, PAL.stoneDeep, { ry: Math.PI / 4 }));               // 脊饰
    // 断翼残骸（北侧巨石翼折断坠台——「断翼露台」题眼）
    sE2.push(cylG(0.85, 1.05, 1.3, 10, -9.0, 0.65, 5.3, PAL.stoneMid, { jitter: 0.1 }));           // 折断基座
    sE2.push(boxG(4.6, 0.55, 1.25, -8.6, 2.0, 5.6, PAL.stone, { rx: -1.15, ry: 0.22, jitter: 0.1 }));
    sE2.push(boxG(3.6, 0.45, 1.0, -9.4, 3.3, 5.9, PAL.stoneMid, { rx: -1.35, ry: 0.4, jitter: 0.1 }));
    sE2.push(boxG(2.4, 0.4, 0.85, -10.2, 3.9, 6.4, PAL.stoneDark, { rx: -1.5, ry: 0.6, jitter: 0.12 }));
    sE2.push(boxG(0.9, 1.4, 0.5, -7.6, 1.0, 5.1, PAL.stone, { rz: 0.4, ry: 0.3, jitter: 0.12 }));  // 碎块
    // 攻城弩残骸（架在北堞，遥指城堡——远行的注脚）
    {
      const bx = -13.6, bz = 4.9;
      sE2.push(boxG(1.9, 0.5, 1.0, bx, 0.45, bz, PAL.wood, { ry: 0.6, jitter: 0.1 }));
      sE2.push(cylG(0.09, 0.13, 2.6, 8, bx + Math.cos(0.6) * 0.7, 1.3, bz - Math.sin(0.6) * 0.7, PAL.wood, { rz: 0.9, ry: 0.6 }));
      sE2.push(boxG(1.7, 0.09, 0.09, bx, 1.62, bz, PAL.wood, { ry: 0.6, rz: 0.35 }));
      for (const s of [-1, 1]) sE2.push(cylG(0.55, 0.55, 0.14, 12, bx + s * 0.75 * Math.sin(0.6), 0.55, bz + s * 0.75 * Math.cos(0.6), PAL.wood, { rx: Math.PI / 2, ry: 0.6 }));
    }
    // 枯树/瓦砾/残骨
    {
      const tx = -17.6, tz = -3.4;
      sE2.push(cylG(0.05, 0.15, 2.0, 7, tx, 1.0, tz, PAL.wood, { rz: 0.3, jitter: 0.15 }));
      for (let b = 0; b < 4; b++) {
        const ba = b * 1.9 + rnd() * 0.6;
        sE2.push(cylG(0.014, 0.045, 0.95, 5, tx + Math.cos(ba) * 0.38, 1.7 + b * 0.12, tz + Math.sin(ba) * 0.38, PAL.wood, { ry: -ba, rz: 1.15 + rnd() * 0.4, jitter: 0.2 }));
      }
    }
    rubble(sE2, -12.0, 2.2, 0.5, 7);
    rubble(sE2, -7.2, -3.4, 0.45, 6);
    rubble(sE2, -18.6, 4.4, 0.4, 5);
    // 露台铺石
    {
      let i = 0;
      for (let x = -20.2; x < -5.4; x += 1.22) {
        fE2.push(boxG(1.16, 0.09, 12.9, x + 0.6, 0.008 + (i % 2) * 0.004, 0, pick([PAL.pathA, PAL.pathB, PAL.pathC]), { jitter: 0.07 }));
        i++;
      }
    }
    // 北渊断崖体量延续
    massGeoms.push(boxG(15.6, 3.0, 4.2, -12.8, -1.9, 9.6, PAL.cliff, { jitter: 0.12 }));
    massGeoms.push(boxG(15.6, 7.0, 4.0, -12.8, -6.2, 12.2, PAL.cliff, { jitter: 0.12 }));
  }

  // ================================================= E3 玛尔基特房（d24，可走 r11.1）
  {
    const AC = 1.5, AR = 12;                         // 圆心/半径
    // 环形雉堞墙（两段弧：西门口 θ=-π/2±0.46 / 东拱门 θ=+π/2±0.42）
    const openW = 0.46, openE = 0.42;
    sE3.push(cylG(12.2, 12.6, 3.7, 44, AC, 1.85, 0, PAL.stoneDark, { open: true, t0: -Math.PI / 2 + openW, tl: Math.PI - openW - openE, jitter: 0.09 }));
    sE3.push(cylG(12.2, 12.6, 3.7, 44, AC, 1.85, 0, PAL.stoneDark, { open: true, t0: Math.PI / 2 + openE, tl: Math.PI - openW - openE, jitter: 0.09 }));
    // 墙顶步道环 + 雉堞 + 扶壁
    for (let i = 0; i < 34; i++) {
      const th = -Math.PI / 2 + openW + 0.1 + (Math.PI * 2 - openW - openE - 0.2) * (i / 33);
      const wx = AC + Math.sin(th) * 12.4, wz = Math.cos(th) * 12.4;
      sE3.push(boxG(1.5, 0.14, 1.05, wx, 3.78, wz, PAL.stoneMid, { ry: th, jitter: 0.08 }));
      if (rnd() < 0.72) sE3.push(boxG(0.95, 0.5 + rnd() * 0.25, 0.42, AC + Math.sin(th) * 12.55, 4.1, Math.cos(th) * 12.55, PAL.stone, { ry: th, jitter: 0.12 }));
    }
    for (let i = 0; i < 8; i++) {
      const th = -Math.PI / 2 + 0.9 + (Math.PI * 2 - 1.8) * (i / 7);
      sE3.push(boxG(0.6, 3.4, 1.1, AC + Math.sin(th) * 13.0, 0.5, Math.cos(th) * 13.0, PAL.stoneDeep, { ry: th, jitter: 0.08 }));
    }
    // 外圈残柱（错落，缺顶者多——废墟感）
    const pilTh = [-2.0, -1.55, -0.85, 0.15, 0.75, 2.35];
    for (const th of pilTh) {
      const px = AC + Math.sin(th) * 13.7, pz = Math.cos(th) * 13.7;
      const h = rnd() < 0.4 ? rr(2.2, 3.4) : rr(5.2, 6.8);
      sE3.push(cylG(0.32, 0.38, h, 10, px, h / 2, pz, PAL.stone, { jitter: 0.1 }));
      if (h > 5) sE3.push(boxG(0.8, 0.2, 0.8, px, h + 0.1, pz, PAL.stoneMid));
      else rubble(sE3, px, pz, 0.6, 4);
    }
    // 东拱门：环墙开口→教堂西门（走幅一致 z±4；胜玛尔基特前 clamp 单向墙锁住）
    wallSeg(sE3, 12.8, 5.0, 14.6, 4.5, 4.4, 0, PAL.stoneMid);
    wallSeg(sE3, 12.8, -5.0, 14.6, -4.5, 4.4, 0, PAL.stoneMid);
    for (const s of [-1, 1]) {
      sE4.push(boxG(1.1, 5.6, 1.2, 14.5, 2.8, s * 4.6, PAL.stoneMid, { jitter: 0.1 }));
      sE4.push(boxG(0.85, 0.5, 1.05, 14.5, 5.85, s * 4.6, PAL.stone));
    }
    sE4.push(boxG(1.2, 0.75, 10.4, 14.5, 6.15, 0, PAL.stoneHi, { jitter: 0.08 }));
    sE4.push(coneG(0.45, 0.9, 4, 14.5, 6.95, 0, PAL.stoneDeep, { ry: Math.PI / 4 }));
    // 门内拱顶横梁（低矮压迫感）
    sE4.push(boxG(2.6, 0.5, 9.6, 15.8, 3.5, 0, PAL.stoneDeep, { jitter: 0.09 }));
    sE4.push(boxG(0.35, 0.35, 9.2, 14.6, 2.9, 0, PAL.stoneMid));
    // 场心地面：环纹 + 暗金徽环（恶兆点题）
    fE3.push(paint(new THREE.CircleGeometry(11.9, 52).rotateX(-Math.PI / 2).translate(AC, 0.012, 0), PAL.stoneMid, 0.06));
    {
      const ringTones = [PAL.pathA, PAL.stoneDeep, PAL.pathA, PAL.stoneDeep];
      const rings: [number, number][] = [[2.4, 2.8], [4.9, 5.3], [7.4, 7.8], [9.9, 10.3]];
      rings.forEach(([r0, r1], i) =>
        fE3.push(paint(new THREE.RingGeometry(r0, r1, 52).rotateX(-Math.PI / 2).translate(AC, 0.02 + i * 0.002, 0), ringTones[i], 0.06)));
      fE3.push(paint(new THREE.RingGeometry(4.0, 4.4, 48).rotateX(-Math.PI / 2).translate(AC, 0.026, 0), PAL.goldDim, 0.1));
    }
    // 西门口地面收口 + 东拱门阈石（衔接过道地坪）
    fE3.push(boxG(1.3, 0.1, 10.6, -5.6, 0.03, 0, PAL.pathB, { jitter: 0.08 }));
    fE3.push(boxG(1.8, 0.1, 9.0, 13.0, 0.006, 0, PAL.pathB, { jitter: 0.08 }));
    // 悬崖岩体（竞技场凌空）
    massGeoms.push(cylG(12.4, 16.5, 15, 26, AC, -7.7, 0, PAL.cliff, { jitter: 0.12 }));
    // 环外零星瓦砾
    rubble(sE3, AC - 9.5, 9.6, 0.6, 6);
    rubble(sE3, AC + 10.2, -8.8, 0.6, 6);
  }

  // ================================================= E4 残柱厅（教堂西段塌顶走道）
  {
    // 过道地坪 + 走道铺石（z±4 拱门直通塌方走道）
    fE45.push(boxG(3.2, 0.4, 9.2, 15.0, -0.2, 0, PAL.cliff, { jitter: 0.1 }));
    {
      let i = 0;
      for (let x = 16.6; x < 24.2; x += 1.18) {
        fE45.push(boxG(1.1, 0.09, 8.5, x + 0.58, 0.01 + (i % 2) * 0.004, 0, pick([PAL.pathB, PAL.pathA, PAL.moss]), { jitter: 0.08 }));
        i++;
      }
    }
    // 塌方碎堆（两侧 z±(4.6..14.5)：走幅收束的视觉理由）
    for (const side of [-1, 1]) {
      for (let x = 16.4; x < 24.2; x += rr(1.6, 2.6)) {
        const cx = x + rr(-0.3, 0.3);
        const cz = side * rr(6.2, 12.6);
        const s = rr(0.9, 2.1);
        sE4.push(dodG(s, cx, s * rr(0.3, 0.6), cz, pick([PAL.stoneDark, PAL.stoneDeep, PAL.wallDeep]), { rx: rnd() * 3, ry: rnd() * 3, rz: rnd() * 3 }));
        if (rnd() < 0.5) sE4.push(boxG(rr(1.2, 2.6), rr(0.35, 0.7), rr(0.9, 1.6), cx + rr(-1, 1), rr(0.3, 1.5), cz + rr(-1.4, 1.4), PAL.stoneMid, { rx: rr(-0.5, 0.5), ry: rnd() * 3, rz: rr(-0.4, 0.4), jitter: 0.12 }));
      }
      // 残柱（立在碎堆中：完整者擎着断梁，断者只剩墩）
      for (let k = 0; k < 3; k++) {
        const px = 17.6 + k * 2.9 + rr(-0.3, 0.3);
        const pz = side * rr(5.6, 7.4);
        if (rnd() < 0.45) {
          sE4.push(cylG(0.36, 0.42, 8.6, 10, px, 4.3, pz, PAL.stone, { jitter: 0.09 }));
          sE4.push(boxG(1.0, 0.26, 1.0, px, 8.75, pz, PAL.stoneMid));
          sE4.push(boxG(1.1, 0.42, 0.7, px, 9.3, pz + side * 0.9, PAL.stoneMid, { ry: rnd() * 0.3, jitter: 0.1 }));   // 断梁头
        } else {
          const h = rr(1.4, 3.6);
          sE4.push(cylG(0.38, 0.44, h, 10, px, h / 2, pz, PAL.stone, { jitter: 0.12 }));
          sE4.push(boxG(0.9, 0.22, 0.9, px, h + 0.1, pz, PAL.stoneMid, { ry: rnd() * 0.5 }));
          rubble(sE4, px, pz + side * 1.1, 0.7, 5);
        }
      }
    }
    // 接肢祭余绪：碎堆间的肢体堆（暗红骨色，低饱和）
    for (const [gx, gz] of [[18.2, -6.8], [21.8, 7.0], [23.4, -7.6]] as const) {
      for (let i = 0; i < 6; i++) sE4.push(boxG(rr(0.09, 0.16), rr(0.35, 0.6), rr(0.09, 0.14), gx + rr(-0.7, 0.7), rr(0.1, 0.5), gz + rr(-0.7, 0.7), pick([PAL.bone, 0x4a3a36, PAL.stoneDeep]), { rx: rr(-0.9, 0.9), ry: rnd() * 3, rz: rr(-0.9, 0.9), jitter: 0.15 }));
      sE4.push(dodG(rr(0.3, 0.55), gx, 0.25, gz, PAL.stoneDeep, { ry: rnd() * 3 }));
    }

    // —— 葛瑞克房入口仪式感（x=14.5 拱门）：残破玫瑰窗拱 + 双石兽首 ——
    {
      const gy = 9.15, R = 1.55;
      // 门洞上方的卸力拱券（贴墙面内外两道，残缺；深度 14.0/15.02 避开玫瑰窗件 13.95±）
      for (const fx of [14.0, 15.02]) {
        for (let k = 0; k <= 8; k++) {
          const a = 0.14 + (Math.PI - 0.28) * (k / 8);
          if (fx < 14 && (k === 2 || k === 6)) continue;                            // 西面残缺
          sE4.push(boxG(0.12, 0.5, 0.6, fx, 6.6 + Math.sin(a) * 4.35, Math.cos(a) * 4.35, k % 4 === 0 ? PAL.stoneHi : PAL.stone, { rx: Math.PI / 2 - a, jitter: 0.08 }));
        }
      }
      // 玫瑰窗：暗龛底(13.84) + 冷晕(13.88) + 碎片环/轮辐石/芯格(13.95) 三层浅浮雕
      sE4.push(paint(new THREE.CircleGeometry(R + 0.5, 24).rotateY(-Math.PI / 2).translate(13.84, gy, 0), PAL.stoneDeep, 0.08));
      coldGlowGeoms.push(paint(new THREE.CircleGeometry(R + 0.14, 24).rotateY(-Math.PI / 2).translate(13.88, gy, 0), PAL.paneDim));
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + 0.26;
        if (i % 2 === 1 && rnd() < 0.55) continue;                                  // 碎缺
        sE4.push(boxG(0.34, 0.3, 0.16, 13.95, gy + Math.sin(a) * R, Math.cos(a) * R, PAL.stoneMid, { rx: Math.PI / 2 - a, jitter: 0.1 }));  // 环石
      }
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        if (a > 1.1 && a < 2.1) continue;                                           // 破洞辐条缺失
        const pc = i === 2 ? PAL.amber : pick([PAL.paneMoon, PAL.paneMoonB, PAL.paneMoonC]);
        const pg = boxG(0.3, 0.82, 0.09, 13.95, gy + Math.sin(a) * R * 0.55, Math.cos(a) * R * 0.55, pc, { rx: Math.PI / 2 - a });
        if (i === 2) emisGeoms.push(pg); else coldGlowGeoms.push(pg);               // 一枚残火金瓣，余为冷月
      }
      coldGlowGeoms.push(boxG(0.3, 0.3, 0.1, 13.95, gy, 0, PAL.paneMoonC, { ry: Math.PI / 4 }));   // 芯格
      // 双石兽首（门楣上方两角，俯瞰来者）：吻部前伸 + 眼窝余烬
      const beast = (side: number): void => {
        const bz = side * 5.95, by = 7.0;
        sE4.push(boxG(0.9, 0.5, 0.7, 14.15, by - 0.5, bz, PAL.stoneDeep, { jitter: 0.08 }));      // 兽首座
        sE4.push(boxG(0.4, 0.42, 0.46, 13.9, by, bz, PAL.stoneMid, { ry: -side * 0.15, jitter: 0.08 }));
        sE4.push(boxG(0.36, 0.26, 0.3, 13.5, by - 0.12, bz, PAL.stone, { ry: -side * 0.15 }));  // 吻部
        sE4.push(boxG(0.3, 0.12, 0.46, 13.8, by + 0.24, bz, PAL.stone, { ry: -side * 0.15 }));  // 眉脊
        sE4.push(boxG(0.3, 0.1, 0.3, 13.55, by - 0.32, bz, PAL.stoneMid, { ry: -side * 0.15, rx: 0.18 })); // 下颚
        for (const hs of [-1, 1]) sE4.push(coneG(0.08, 0.32, 5, 13.88, by + 0.42, bz + hs * 0.24, PAL.stoneDeep, { rz: 0.55 * hs }));
        for (const hs of [-1, 1]) emisGeoms.push(boxG(0.1, 0.08, 0.1, 13.76, by + 0.06, bz + hs * 0.15, PAL.amberHiGlow));  // 眼窝余烬
      };
      beast(1);
      beast(-1);
      // 门洞暖光透出（面朝西；E4 内侧为背面剔除，不挡行内视点）：烛廊光从破拱溢出，与冷月玫瑰成双色信标
      coldGlowGeoms.push(paint(new THREE.PlaneGeometry(7.8, 2.4).rotateY(-Math.PI / 2).translate(15.3, 2.2, 0), PAL.amberGlow));
      coldGlowGeoms.push(paint(new THREE.PlaneGeometry(7.8, 3.1).rotateY(-Math.PI / 2).translate(15.3, 4.95, 0), 0x8a6136));
    }

    // —— 暗廊侧界：残墙段（z±4.62，走幅 z±4 外）界定走廊 + 坠落石梁 ——
    for (const side of [-1, 1]) {
      let x = 16.7;
      let k = 0;
      while (x < 23.9) {
        const len = rr(1.5, 3.0);
        const h = rr(1.5, 2.6);
        // 北侧让开火盆（18.7,-4.75）与残柱位；南侧整段
        const blocked = side < 0 && x < 19.7 && x + len > 17.9;
        if (!blocked && (k % 2 === 0 || rnd() < 0.7)) {
          sE4.push(boxG(len, h, 0.5, x + len / 2, h / 2, side * 4.62, PAL.stoneDark, { ry: rr(-0.04, 0.04), jitter: 0.1 }));
          sE4.push(boxG(len + 0.22, 0.18, 0.64, x + len / 2, h, side * 4.62, PAL.stoneMid));
        }
        x += len + rr(0.9, 2.2);
        k++;
      }
    }
    // 坠落石梁（平放贴地/半埋碎堆，避免悬空；平行走廊不侵走幅）
    sE4.push(boxG(4.4, 0.42, 0.55, 17.3, 0.22, 5.15, PAL.stoneMid, { ry: 0.16, rz: 0.03, jitter: 0.1 }));
    sE4.push(boxG(3.8, 0.38, 0.5, 20.3, 0.5, -6.8, PAL.stoneMid, { rx: 0.28, ry: 0.2, jitter: 0.1 }));
    sE4.push(boxG(3.0, 0.36, 0.48, 23.0, 0.9, 6.3, PAL.stone, { ry: 0.3, rz: 0.24, jitter: 0.1 }));

    // —— 烛台光龛：壁龛 ×3（残墙面上）+ 立式烛台 ×2（暖橙呼吸——与教堂内冷月成进深对比）——
    const shrine = (x: number, side: number): void => {
      const sz = side * 4.34;
      sE4.push(boxG(0.56, 0.78, 0.09, x, 2.2, side * 4.42, PAL.dark, { jitter: 0.06 }));          // 龛底暗背板
      sE4.push(boxG(0.62, 0.09, 0.28, x, 1.78, sz, PAL.stoneMid));                               // 龛楣/托板
      for (const cs of [-0.14, 0.12]) {
        sE4.push(cylG(0.035, 0.042, rr(0.18, 0.3), 6, x + cs, 1.9 + 0.09, sz + side * 0.03, PAL.bone));
        emisGeoms.push(boxG(0.055, 0.09, 0.055, x + cs, 2.06, sz + side * 0.03, PAL.amberHi));    // 烛焰
      }
      emisGeoms.push(boxG(0.34, 0.42, 0.08, x, 1.95, side * 4.4, 0x7a5228));                      // 暖晕（呼吸批）
    };
    shrine(18.35, 1);
    shrine(21.6, -1);
    shrine(23.55, 1);
    for (const [sx, sz] of [[19.8, 4.2], [22.7, -4.2]] as const) {                                // 立式烛台（墙前，走幅外）
      sE4.push(cylG(0.04, 0.055, 1.5, 7, sx, 0.75, sz, PAL.metal));
      sE4.push(cylG(0.2, 0.11, 0.09, 8, sx, 1.53, sz, PAL.metal));
      for (let b = 0; b < 3; b++) {
        const ba = b * 2.1 + 0.6;
        sE4.push(cylG(0.03, 0.038, 0.24, 6, sx + Math.cos(ba) * 0.14, 1.68, sz + Math.sin(ba) * 0.14, PAL.bone));
        emisGeoms.push(boxG(0.05, 0.08, 0.05, sx + Math.cos(ba) * 0.14, 1.84, sz + Math.sin(ba) * 0.14, PAL.amberHi));
      }
      emisGeoms.push(boxG(0.38, 0.4, 0.38, sx, 1.78, sz, 0x7a5228));
    }

    // —— 地面裂缝余烬微光（缝两侧暗色崩边 + 缝内 ember 红芯；折线随机游走，确定性。
    //    注意走道铺石顶面 y≈0.055：裂缝件顶面必须抬高到 y≥0.065 否则埋进铺石）——
    const crack = (cx: number, cz: number, dir: number): void => {
      let x = cx, z = cz, a = dir;
      for (let i = 0; i < 5; i++) {
        const l = rr(0.5, 1.0);
        const mx = x + Math.cos(a) * l / 2, mz = z - Math.sin(a) * l / 2;
        for (const s2 of [-1, 1])
          sE4.push(boxG(l + 0.14, 0.05, 0.075, mx + Math.sin(a) * s2 * 0.085, 0.038, mz + Math.cos(a) * s2 * 0.085, PAL.dark, { ry: a, jitter: 0.1 }));
        emisGeoms.push(boxG(l, 0.055, 0.06, mx, 0.04, mz, PAL.emberRed, { ry: a }));
        x += Math.cos(a) * l;
        z -= Math.sin(a) * l;
        a += rr(-0.5, 0.5);
      }
    };
    crack(17.5, 1.9, 0.2);
    crack(20.7, -1.7, -0.45);
    crack(23.0, 1.1, 0.55);
  }

  // ================================================= E5 接肢教堂（巨厅=葛瑞克竞技场，可走圆 r13.1@26.5）
  {
    const HC = 26.5;                                 // 可走圆心（r13.1；视觉墙在 z±15.2 / x 41.5）
    // —— 外壳：三面墙抬升到 12.4（教堂中厅体量）+ 檐口压顶 ——
    sE5.push(boxG(28.6, 12.4, 1.4, 27.7, 6.2, -15.2, PAL.wall, { jitter: 0.06 }));
    sE5.push(boxG(28.6, 12.4, 1.4, 27.7, 6.2, 15.2, PAL.wall, { jitter: 0.06 }));
    // 东墙（F1 谒见长廊门洞 z±2.75 开在下段——「圣所之后即王座厅」）：两侧整幅 + 门楣整幅
    sE5.push(boxG(1.4, 12.4, 10.45, 41.5, 6.2, -10.68, PAL.wall, { jitter: 0.06 }));
    sE5.push(boxG(1.4, 12.4, 10.45, 41.5, 6.2, 10.68, PAL.wall, { jitter: 0.06 }));
    sE5.push(boxG(1.4, 6.2, 5.5, 41.5, 9.3, 0, PAL.wall, { jitter: 0.06 }));
    sE5.push(boxG(1.8, 0.55, 0.75, 41.5, 6.3, 0, PAL.stoneHi));                                  // 门楣梁
    for (const s of [-1, 1]) sE5.push(boxG(1.8, 6.3, 0.62, 41.5, 3.15, s * 3.06, PAL.stoneMid, { jitter: 0.07 }));   // 门侧壁柱
    sE5.push(boxG(0.7, 5.9, 5.4, 41.25, 2.95, 0, PAL.dark, { jitter: 0.05 }));                    // 门洞幽深（半明半暗的过堂）
    sE5.push(boxG(29.2, 2.4, 3.2, 27.7, 1.2, -16.4, PAL.wallDeep, { jitter: 0.08 }));
    sE5.push(boxG(29.2, 2.4, 3.2, 27.7, 1.2, 16.4, PAL.wallDeep, { jitter: 0.08 }));
    sE5.push(boxG(3.2, 2.4, 13.2, 42.8, 1.2, -9.7, PAL.wallDeep, { jitter: 0.08 }));            // 外墙裙分踞门洞两侧（F1 出口）
    sE5.push(boxG(3.2, 2.4, 13.2, 42.8, 1.2, 9.7, PAL.wallDeep, { jitter: 0.08 }));
    for (const zz of [-15.2, 15.2]) sE5.push(boxG(29.3, 0.62, 1.95, 27.7, 12.7, zz, PAL.wallHi));
    sE5.push(boxG(1.95, 0.62, 32.4, 41.5, 12.7, 0, PAL.wallHi));
    // 西墙（拱门开口 z±4.4）：下半分踞开口两侧，上半整幅封墙 + 阶梯山墙升到脊（教堂正立面）
    sE5.push(boxG(1.4, 6.6, 10.7, 14.5, 3.3, -9.85, PAL.wall, { jitter: 0.07 }));
    sE5.push(boxG(1.4, 6.6, 10.7, 14.5, 3.3, 9.85, PAL.wall, { jitter: 0.07 }));
    sE5.push(boxG(1.4, 5.8, 30.4, 14.5, 9.5, 0, PAL.wall, { jitter: 0.07 }));
    sE5.push(boxG(1.7, 0.5, 30.9, 14.5, 12.5, 0, PAL.wallHi));                                 // 檐口压顶
    for (let i = 0; i < 6; i++) sE5.push(boxG(1.5, 0.55, 27.4 - i * 4.6, 14.5, 12.95 + i * 0.52, 0, PAL.wall, { jitter: 0.07 }));  // 阶梯山墙
    // —— 中厅节奏：半嵌壁柱（两长边各 6 + 东墙 2）+ 外扶壁到檐 ——
    for (const side of [-1, 1]) {
      for (let k = 0; k < 6; k++) {
        const px = 18.5 + k * 4.6;
        sE5.push(cylG(0.55, 0.62, 10.4, 12, px, 5.2, side * 14.6, PAL.stoneDark, { jitter: 0.07 }));
        sE5.push(boxG(1.6, 0.4, 1.1, px, 10.6, side * 14.6, PAL.stoneMid));
        sE5.push(boxG(0.22, 2.6, 0.16, px, 8.4, side * 14.48, PAL.dark));               // 柱身暗缝（残龛）
        sE5.push(boxG(0.7, 3.0, 1.4, px, 1.5, side * 15.5, PAL.wallDeep, { jitter: 0.08 }));   // 外扶壁
        sE5.push(boxG(0.9, 0.3, 1.6, px, 12.55, side * 15.5, PAL.stoneMid));           // 扶壁压顶
      }
    }
    for (const pz of [-10, 10]) {
      sE5.push(cylG(0.55, 0.62, 10.4, 12, 40.9, 5.2, pz, PAL.stoneDark, { jitter: 0.07 }));
      sE5.push(boxG(1.1, 0.4, 1.6, 40.9, 10.6, pz, PAL.stoneMid));
    }
    // —— 尖拱高侧窗（冷月透光窗格——建筑本体冷蓝；壁柱跨中 4 樘/侧，两樘「熄窗」残破）——
    {
      const winX = [20.8, 25.4, 30.0, 34.6];
      for (let i = 0; i < winX.length; i++) {
        const wx = winX[i];
        for (const side of [-1, 1]) {
          const lit = !((i === 2 && side > 0) || (i === 0 && side < 0));
          sE5.push(boxG(1.04, 3.3, 0.1, wx, 9.35, side * 14.46, PAL.dark, { jitter: 0.05 }));        // 暗龛
          sE5.push(boxG(0.68, 0.68, 0.1, wx, 11.3, side * 14.46, PAL.dark, { rz: Math.PI / 4 }));    // 尖拱龛顶
          if (lit) {
            const pc = [PAL.paneMoon, PAL.paneMoonB, PAL.paneMoonC][(i + (side > 0 ? 1 : 0)) % 3];
            coldGlowGeoms.push(boxG(0.68, 2.75, 0.07, wx, 9.2, side * 14.4, pc, { jitter: 0.04 })); // 冷月窗格
            coldGlowGeoms.push(boxG(0.44, 0.44, 0.07, wx, 11.16, side * 14.4, pc, { rz: Math.PI / 4 })); // 尖顶格
          }
          sE5.push(boxG(0.08, 2.6, 0.06, wx, 9.2, side * 14.34, PAL.stoneDeep));                     // 直棂
          sE5.push(boxG(0.56, 0.08, 0.06, wx, 10.15, side * 14.34, PAL.stoneDeep));                  // 横棂
          sE5.push(boxG(1.16, 0.18, 0.26, wx, 7.62, side * 14.42, PAL.stoneMid));                    // 窗台
        }
      }
    }
    // —— 尽端圣所门：王座厅入口（原半圆后殿壁改为门洞上暗壁——拱肋与玫瑰窗仍在，其下开门）——
    sE5.push(boxG(0.5, 4.0, 9.4, 40.74, 8.4, 0, PAL.stoneDeep, { jitter: 0.07 }));
    for (const s of [-1, 1]) {
      sE5.push(cylG(0.5, 0.58, 10.2, 12, 40.85, 5.1, s * 4.35, PAL.stoneDark, { jitter: 0.07 }));
      sE5.push(boxG(1.4, 0.38, 1.0, 40.85, 10.4, s * 4.35, PAL.stoneMid));
    }
    {
      const R = 4.3, AY = 5.5;
      for (let k = 0; k <= 10; k++) {
        const a = 0.12 + (Math.PI - 0.24) * (k / 10);
        if (k === 3 || k === 7) continue;                                                             // 残缺
        sE5.push(boxG(0.18, 0.52, 0.34, 40.52, AY + Math.sin(a) * R, Math.cos(a) * R, k % 5 === 0 ? PAL.stoneHi : PAL.stone, { rx: Math.PI / 2 - a, jitter: 0.08 }));
      }
    }
    // 大玫瑰窗（残破：碎片环 + 芯徽——后殿的暖金祭仪焦点，与侧窗冷月成双色温对极；自发光亮阶当信标读）
    for (let i = 0; i < 11; i++) {
      const a = -1.9 + i * 0.475;
      if (a > -0.5 && a < 0.5 && rnd() < 0.6) continue;                               // 破洞
      emisGeoms.push(boxG(0.34, 1.35, 0.12, 40.62, 7.6 + Math.sin(a) * 2.35, Math.cos(a) * 2.35 * 1.35, i % 3 === 0 ? PAL.amberHiGlow : PAL.amberGlow, { rz: a }));
    }
    emisGeoms.push(boxG(0.5, 0.5, 0.14, 40.62, 7.6, 0, PAL.amberHiGlow, { ry: Math.PI / 4 }));
    for (let i = 0; i < 6; i++) {                                                                                    // 日晖辐条（金红）
      const a = -1.2 + i * 0.48;
      const rl = rr(2.6, 4.0);
      emisGeoms.push(boxG(0.1, rl, 0.05, 40.68, 7.6 + Math.sin(a) * rl / 2, Math.cos(a) * rl / 2, PAL.spokeGlow, { rx: Math.PI / 2 - a }));
    }
    // 圣坛（阶台居中可踏过；石案/供品北移 z≈3.0 让开 F1 门道——「穿圣坛而过即谒见厅」）
    sE5.push(boxG(3.2, 0.4, 5.2, 40.1, 0.2, 0, PAL.stoneMid, { jitter: 0.08 }));
    sE5.push(boxG(2.5, 0.4, 4.0, 40.3, 0.6, 0, PAL.stoneMid, { jitter: 0.08 }));
    sE5.push(boxG(1.6, 1.05, 0.8, 40.5, 1.3, 3.0, PAL.stoneHi, { jitter: 0.08 }));
    sE5.push(boxG(0.14, 2.6, 0.05, 40.45, 2.6, 3.45, COLORS.steel, { rz: 0.35 }));
    sE5.push(boxG(0.14, 2.6, 0.05, 40.45, 2.6, 2.55, COLORS.steel, { rz: -0.35 }));
    sE5.push(boxG(0.5, 0.08, 0.1, 40.45, 3.9, 3.0, PAL.goldDim));
    // 断剑供品：斜插阶上的残刃 ×3（「接肢失败者」的献纳；均离门道）
    for (const [sx, sz, sa] of [[39.45, 3.5, 0.5], [39.35, -3.6, -0.42], [40.95, 3.95, 0.28]] as const) {
      sE5.push(boxG(0.09, rr(0.7, 1.15), 0.05, sx, 0.45, sz, COLORS.steel, { rz: sa, ry: rnd() * 3 }));
      sE5.push(boxG(0.2, 0.08, 0.07, sx - Math.sin(sa) * 0.4, 0.72, sz, PAL.goldDim, { rz: sa }));
    }
    // 蜡泪：案沿垂凝 ×7（近火两枚透光入暖批；随案北移）
    for (let i = 0; i < 7; i++) {
      const wx = 40.3 + rr(-0.9, 0.9), wz = 3.0 + rr(-0.4, 0.4), hy = 0.82 + (rnd() < 0.5 ? 0 : 0.45);
      const wl = rr(0.14, 0.4);
      if (i < 2) emisGeoms.push(boxG(0.075, wl * 0.8, 0.075, wx, hy - wl * 0.4, wz, 0x8a6a3e));
      else sE5.push(boxG(0.07, wl, 0.07, wx, hy - wl / 2, wz, PAL.wax, { ry: rnd() * 3, jitter: 0.1 }));
    }
    for (const [cx, cz] of [[39.9, 3.6], [39.9, -3.6], [40.8, 3.2], [40.8, -3.2]] as const)
      emisGeoms.push(cylG(0.05, 0.06, rr(0.3, 0.55), 6, cx, 1.1, cz, PAL.amberHi));
    // 立式三臂烛台 ×2（夹道阶前，r 13.4 外）
    for (const s of [-1, 1]) {
      const sx = 39.6, sz = s * 3.0;
      sE5.push(cylG(0.05, 0.07, 1.7, 8, sx, 0.85, sz, PAL.metal));
      sE5.push(cylG(0.22, 0.12, 0.1, 8, sx, 1.72, sz, PAL.metal));
      for (let b = 0; b < 3; b++) {
        const ba = b * 2.1 + s;
        emisGeoms.push(cylG(0.035, 0.045, 0.3, 6, sx + Math.cos(ba) * 0.16, 1.95, sz + Math.sin(ba) * 0.16, 0xd8a86a));
      }
      emisGeoms.push(boxG(0.42, 0.54, 0.42, sx, 2.12, sz, 0x7a5228));                 // 烛群暖晕
    }
    // 祭坛尸山（南壁下：接肢的「素材」堆）
    {
      const gx = 25.0, gz = 13.9;
      for (let i = 0; i < 9; i++) sE5.push(dodG(rr(0.45, 0.95), gx + rr(-2.2, 2.2), rr(0.3, 1.3), gz + rr(-0.8, 0.8), pick([PAL.stoneDeep, PAL.bone, 0x4a3a36]), { rx: rnd() * 3, ry: rnd() * 3, rz: rnd() * 3 }));
      for (let i = 0; i < 7; i++) sE5.push(boxG(rr(0.1, 0.17), rr(0.4, 0.75), rr(0.1, 0.15), gx + rr(-2.4, 2.4), rr(0.2, 1.6), gz + rr(-1.0, 1.0), pick([PAL.bone, 0x4a3a36]), { rx: rr(-1, 1), ry: rnd() * 3, rz: rr(-1, 1), jitter: 0.15 }));
    }
    // 龙尸（沿北壁蜷卧——葛瑞克的手笔，竞技场的体量锚；轴向取 X 与壁平行，整体留可走圆外）
    {
      const dx = 29.5, dz = -14.15, dy = 0.55;
      sE5.push(cylG(1.0, 1.25, 8.4, 10, dx, dy, dz, 0x262c33, { rz: Math.PI / 2, ry: 0.1, jitter: 0.09 }));           // 躯干（沿壁）
      sE5.push(cylG(0.5, 0.75, 4.2, 8, dx - 5.6, dy + 0.1, dz + 0.15, 0x232830, { rz: Math.PI / 2, ry: 0.5 }));       // 尾（西甩）
      sE5.push(cylG(0.18, 0.32, 3.2, 6, dx - 8.3, dy + 0.08, dz + 0.6, 0x232830, { rz: Math.PI / 2, ry: 0.9 }));
      sE5.push(cylG(0.32, 0.48, 3.0, 8, dx + 5.4, dy + 1.2, dz + 0.35, 0x2a3038, { rz: 1.05, ry: -0.3 }));            // 颈（东昂）
      sE5.push(boxG(1.5, 0.7, 0.9, dx + 7.1, dy + 2.1, dz + 0.75, 0x2a3038, { ry: -0.3, rz: 0.15, jitter: 0.1 }));    // 头颅
      sE5.push(coneG(0.34, 1.3, 6, dx + 8.1, dy + 2.05, dz + 0.95, 0x232830, { ry: -0.3, rz: 1.57 }));                // 吻部
      sE5.push(boxG(2.6, 0.16, 1.1, dx - 0.5, dy + 1.2, dz + 0.45, 0x2d333b, { rx: 0.7, ry: 0.3, jitter: 0.1 }));     // 断翼骨（朝场一侧）
      sE5.push(boxG(2.0, 0.14, 0.9, dx + 2.0, dy + 1.1, dz - 0.4, 0x2d333b, { rx: -0.6, ry: 0.2, jitter: 0.1 }));
      for (let i = 0; i < 4; i++) sE5.push(boxG(0.1, 1.0, 0.5, dx - 1.6 + i * 1.3, dy + 0.85, dz + 1.0, 0x39414b, { rx: 0.35, ry: 0.15 }));  // 肋骨
      // 冷月骨棱反光（朝场侧肋尖/断翼/脊背/颅脊的窄条微光——北壁逆光处让巨躯剪影可读）
      for (let i = 0; i < 4; i++) coldGlowGeoms.push(boxG(0.5, 0.05, 0.1, dx - 1.6 + i * 1.3, dy + 1.38, dz + 1.16, PAL.paneMoonC));
      coldGlowGeoms.push(boxG(0.7, 0.05, 0.12, dx - 1.2, dy + 1.56, dz + 0.78, PAL.paneMoonC, { ry: 0.3 }));
      coldGlowGeoms.push(boxG(0.7, 0.05, 0.12, dx + 0.2, dy + 1.5, dz + 0.72, PAL.paneMoonC, { ry: 0.2 }));
      coldGlowGeoms.push(boxG(0.9, 0.05, 0.14, dx - 2.2, dy + 1.34, dz + 0.05, PAL.paneMoonB));
      coldGlowGeoms.push(boxG(0.9, 0.05, 0.14, dx + 1.4, dy + 1.3, dz - 0.1, PAL.paneMoonB));
      coldGlowGeoms.push(boxG(0.55, 0.06, 0.3, dx + 7.0, dy + 2.5, dz + 0.75, PAL.paneMoonC, { ry: -0.3 }));
    }
    // —— 接肢叙事 ①：墙上悬肢残躯（壁架+锁链+断臂/断腿低模剪影+壁血痕；合批）——
    const hungLimb = (x: number, side: number, leg: boolean): void => {
      const wz = side * 14.26;
      sE5.push(boxG(0.1, 0.12, 0.5, x, 6.25, side * 14.3, PAL.metal));                          // 壁挑臂
      for (let i = 0; i < 3; i++) sE5.push(boxG(0.06, 0.15, 0.05, x + rr(-0.02, 0.02), 6.05 - i * 0.17, wz, PAL.metal));   // 锁链
      const flesh = pick([PAL.rot1, PAL.rot2, PAL.flesh, PAL.bone]);
      const hy = 5.1;
      if (leg) {
        sE5.push(cylG(0.11, 0.13, 0.62, 7, x, hy - 0.28, wz, flesh, { rx: 0.25, jitter: 0.12 }));
        sE5.push(cylG(0.085, 0.1, 0.55, 7, x + rr(-0.06, 0.06), hy - 0.85, wz + side * 0.08, flesh, { rx: 0.5, jitter: 0.12 }));
        sE5.push(boxG(0.12, 0.09, 0.3, x, hy - 1.12, wz + side * 0.16, flesh, { rx: 0.9, jitter: 0.15 }));   // 足
      } else {
        sE5.push(cylG(0.095, 0.115, 0.55, 7, x, hy - 0.25, wz, flesh, { rx: 0.18, jitter: 0.12 }));
        sE5.push(cylG(0.07, 0.088, 0.5, 7, x + rr(-0.08, 0.08), hy - 0.75, wz + side * 0.06, flesh, { rx: 0.55, jitter: 0.12 }));
        sE5.push(dodG(0.09, x + rr(-0.1, 0.1), hy - 1.05, wz + side * 0.12, flesh, { ry: rnd() * 3 }));      // 手
      }
      sE5.push(boxG(0.05, rr(1.2, 2.0), 0.04, x, 3.6, side * 14.44, PAL.bloodA, { jitter: 0.1 }));          // 壁血垂痕
      fE45.push(paint(new THREE.CircleGeometry(rr(0.3, 0.5), 12).rotateX(-Math.PI / 2).translate(x, 0.038, side * 13.9), PAL.bloodA, 0.14));  // 壁下血渍
    };
    const LIMBS: [number, number, boolean][] = [[19.4, -1, true], [21.1, 1, false], [24.3, -1, false], [26.9, 1, true], [29.7, -1, false], [32.5, 1, true], [35.1, -1, false]];
    for (const [lx, lside, lleg] of LIMBS) hungLimb(lx, lside, lleg);
    // 门内「迎宾」悬肢 ×2（西墙内面：一进堂先见祭仪）
    for (const s of [-1, 1]) {
      sE5.push(boxG(0.12, 0.4, 0.5, 15.32, 6.2, s * 6.4, PAL.metal));
      for (let i = 0; i < 3; i++) sE5.push(boxG(0.05, 0.14, 0.06, 15.32, 5.92 - i * 0.17, s * 6.4, PAL.metal));
      sE5.push(cylG(0.09, 0.11, 0.6, 7, 15.32, 5.2, s * 6.4, pick([PAL.rot1, PAL.flesh]), { rx: Math.PI / 2 - 0.25, jitter: 0.12 }));
      sE5.push(dodG(0.08, 15.32, 4.82, s * 6.4, PAL.rot2, { ry: rnd() * 3 }));
    }

    // —— 接肢叙事 ②：「接肢失败」蜷躯 ×4（场缘散落，均在可走圆外）+ 血泊/拖痕 ——
    const failedGraft = (x: number, z: number, ry: number): void => {
      sE5.push(dodG(0.34, x, 0.32, z, pick([PAL.rot1, PAL.flesh]), { rx: rnd() * 3, ry, rz: rnd() * 3 }));                 // 蜷躯
      sE5.push(boxG(0.24, 0.2, 0.2, x + Math.sin(ry) * 0.3, 0.28, z + Math.cos(ry) * 0.3, PAL.rot2, { ry, jitter: 0.12 })); // 头
      sE5.push(boxG(0.42, 0.11, 0.11, x - Math.cos(ry) * 0.3, 0.22, z + Math.sin(ry) * 0.3, PAL.flesh, { ry, rz: 1.1, jitter: 0.12 }));   // 环抱臂
      sE5.push(boxG(0.36, 0.1, 0.1, x - Math.cos(ry) * 0.1, 0.15, z - Math.sin(ry) * 0.26, PAL.rot1, { ry, rz: 1.35, jitter: 0.12 }));    // 蜷腿
      fE45.push(paint(new THREE.CircleGeometry(rr(0.5, 0.8), 14).rotateX(-Math.PI / 2).translate(x, 0.036, z), PAL.bloodA, 0.15));
      fE45.push(boxG(1.3, 0.012, 0.24, x - Math.cos(ry) * 0.9, 0.035, z + Math.sin(ry) * 0.9, PAL.bloodB, { ry, jitter: 0.1 }));  // 拖痕
    };
    failedGraft(16.6, -9.6, 2.2);
    failedGraft(21.5, 12.7, -0.6);
    failedGraft(31.6, -12.6, 0.9);
    failedGraft(35.7, 11.5, 2.8);

    // —— 接肢叙事 ③：金血红渍地面斑（顶点色椭圆斑；由门向坛渐密）+ 中门踩踏血径 ——
    {
      const stains: [number, number, number, number][] = [
        [24.0, 2.2, 0.55, PAL.bloodA], [25.2, -2.6, 0.4, PAL.bloodB], [28.0, 3.4, 0.7, PAL.bloodC],
        [29.5, -3.8, 0.5, PAL.bloodA], [31.5, 1.2, 0.45, PAL.bloodB], [33.0, -1.6, 0.6, PAL.bloodA],
        [26.5, 0, 0.85, PAL.bloodC], [38.0, 1.8, 0.8, PAL.bloodB], [38.3, -2.0, 0.65, PAL.bloodA],
      ];
      for (const [sx, sz, sr, sc] of stains)
        fE45.push(paint(new THREE.CircleGeometry(sr, 14).rotateX(-Math.PI / 2).scale(1, 1, rr(0.7, 1.3)).translate(sx, 0.037 + rnd() * 0.005, sz), sc, 0.18));
    }
    for (let i = 0; i < 15; i++) {
      const px = 16.4 + i * 1.55;
      fE45.push(boxG(1.4, 0.012, rr(0.6, 1.0), px, 0.034 + (i % 3) * 0.001, rr(-0.5, 0.5), pick([0x33231e, 0x3a2822, 0x2e211c]), { ry: rr(-0.2, 0.2), jitter: 0.1 }));
    }

    // —— 屋架：幸存桁架屋盖 x∈[24.5,41.8]（E4 段塌顶露天——「教堂断成两截」的天际线）——
    // 屋盖双坡入 massGeoms（免投影：月光穿顶保 Boss 房可读，檐上剪影照读）
    {
      const EAVE = 12.4, RISE = 3.1, X0 = 24.5, X1 = 41.8, CX = (X0 + X1) / 2, L = X1 - X0;
      const ra = Math.atan2(RISE, 15.6);
      for (const s of [-1, 1]) massGeoms.push(boxG(L, 0.4, Math.hypot(15.6, RISE), CX, EAVE + RISE / 2 + 0.2, s * 7.8, PAL.roofA, { rx: s * ra, jitter: 0.08 }));
      massGeoms.push(boxG(L + 0.4, 0.36, 1.0, CX, EAVE + RISE + 0.2, 0, PAL.roofB));                                  // 脊盖
      for (let i = 0; i < 3; i++) massGeoms.push(boxG(1.4, 0.5, 26 - i * 9, 41.5, 12.9 + i * 0.9, 0, PAL.wall, { jitter: 0.07 }));  // 东端阶梯山墙
      // 桁架 ×5（横梁/拱臂/中柱/上弦）+ 脊檩/檐檩——中厅的木构剪影
      for (const bx of [25.6, 28.8, 32.0, 35.2, 38.4]) {
        sE5.push(boxG(0.34, 0.42, 29.6, bx, 12.0, 0, PAL.wood, { jitter: 0.06 }));
        for (const s of [-1, 1]) sE5.push(boxG(0.26, 0.26, 5.4, bx, 12.75, s * 11.0, PAL.wood, { rx: s * 0.34, jitter: 0.08 }));
        sE5.push(boxG(0.28, 2.5, 0.3, bx, 13.2, 0, PAL.wood));
        sE5.push(boxG(0.3, 0.32, 9.4, bx, 14.4, 0, PAL.wood));
      }
      sE5.push(boxG(L, 0.3, 0.34, CX, EAVE + RISE - 0.15, 0, PAL.wood));                                             // 脊檩
      for (const s of [-1, 1]) sE5.push(boxG(L, 0.26, 0.3, CX, 13.3, s * 8.4, PAL.wood, { rx: s * ra }));            // 檐檩（贴坡）
      // 塌口断桁（x≈24.5：半截断梁垂进室内 + 屋檐垂链）
      sE5.push(boxG(0.32, 0.36, 7.8, 24.9, 10.6, -8.6, PAL.wood, { rx: 0.16, rz: 0.1, jitter: 0.08 }));
      for (let i = 0; i < 3; i++) sE5.push(boxG(0.06, 0.3, 0.06, 24.9, 10.1 - i * 0.34, -5.1, PAL.metal));
      // 梁上吊锁镣铐 ×2（高处悬空，不侵走幅）
      for (const [cx2, cz2] of [[28.8, 2.6], [35.2, -2.8]] as const) {
        for (let i = 0; i < 3; i++) sE5.push(boxG(0.06, 0.22, 0.06, cx2, 11.55 - i * 0.26, cz2, PAL.metal));
        sE5.push(boxG(0.3, 0.1, 0.08, cx2, 10.55, cz2, PAL.metal, { ry: rnd() * 3 }));                                // 镣铐
      }
    }

    // —— 氛围：尘埃光柱（北窗冷月 ×4 + 后殿暖金 + E4 塌口天光 ×2；additive 单批）——
    {
      const v = new THREE.Vector3(0.21, 0.8, -0.53).normalize();   // 光向：东南天顶→西北地面（stormLight 反向）
      const tilt = Math.acos(v.y), yaw = Math.atan2(-v.z, v.x);
      const addShaft = (tx: number, ty: number, tz: number, w: number, h: number, warm: boolean): void => {
        const g = new THREE.PlaneGeometry(w, h, 1, 4);
        const cA = new THREE.Color(warm ? 0xb08d52 : 0x86aede), cB = new THREE.Color(warm ? 0x2e2618 : 0x1c2a3e);
        const p = g.attributes.position as THREE.BufferAttribute;
        const cols = new Float32Array(p.count * 3);
        const cc = new THREE.Color();
        for (let i = 0; i < p.count; i++) {
          const k = Math.min(1, Math.max(0, 0.5 - p.getY(i) / h));  // 0=顶 1=底，底端渐灭
          cc.copy(cA).lerp(cB, k * k);
          cols[i * 3] = cc.r; cols[i * 3 + 1] = cc.g; cols[i * 3 + 2] = cc.b;
        }
        g.rotateZ(-tilt);
        g.rotateY(yaw);
        g.translate(tx - v.x * h / 2, ty - v.y * h / 2, tz - v.z * h / 2);
        g.setAttribute("color", new THREE.BufferAttribute(cols, 3));
        shaftsGeoms.push(g);
      };
      addShaft(20.8, 10.4, -14.0, 1.05, 9.6, false);
      addShaft(25.4, 10.4, -14.0, 0.95, 9.4, false);
      addShaft(30.0, 10.4, -14.0, 1.15, 9.8, false);
      addShaft(34.6, 10.4, -14.0, 0.95, 9.6, false);
      addShaft(40.4, 9.6, 0, 1.6, 8.6, true);                        // 后殿玫瑰暖金
      addShaft(19.2, 6.4, -1.4, 1.4, 5.8, false);                    // E4 塌口天光
      addShaft(22.6, 6.6, 1.2, 1.2, 6.0, false);
    }

    // 圣所地面：整幅石板 + 环纹 + 接肢徽记（暗金）
    fE45.push(boxG(27.2, 0.4, 29.6, 28.2, -0.19, 0, PAL.cliff, { jitter: 0.1 }));
    fE45.push(paint(new THREE.CircleGeometry(13.7, 56).rotateX(-Math.PI / 2).translate(HC, 0.014, 0), PAL.stoneMid, 0.05));
    {
      const ringTones = [PAL.pathB, PAL.stoneDeep, PAL.pathA, PAL.stoneDeep, PAL.pathB];
      const rings: [number, number][] = [[2.6, 3.0], [5.6, 6.0], [8.6, 9.0], [11.6, 12.0], [13.1, 13.5]];
      rings.forEach(([r0, r1], i) =>
        fE45.push(paint(new THREE.RingGeometry(r0, r1, 56).rotateX(-Math.PI / 2).translate(HC, 0.024 + i * 0.002, 0), ringTones[i], 0.06)));
      fE45.push(paint(new THREE.RingGeometry(4.8, 5.3, 56).rotateX(-Math.PI / 2).translate(HC, 0.03, 0), PAL.goldDim, 0.1));
      fE45.push(paint(new THREE.CircleGeometry(1.5, 32).rotateX(-Math.PI / 2).translate(HC, 0.032, 0), PAL.goldDim, 0.12));
      for (let i = 0; i < 8; i++) {                                                                                  // 徽记轮辐
        const a = (i / 8) * Math.PI * 2;
        fE45.push(paint(new THREE.RingGeometry(1.6, 1.85, 4, 1, a - 0.09, 0.18).rotateX(-Math.PI / 2).translate(HC, 0.031, 0), PAL.goldDim, 0.1));
      }
    }
    // 巨厅底盘岩体
    massGeoms.push(boxG(30.0, 15, 33.4, 27.8, -7.7, 0, PAL.cliff, { jitter: 0.12 }));
  }

  // ================================================= F1 谒见长廊（圣所东门→王座厅，x∈[41.5,52.9] z±2.6）
  {
    // 地面 + 石板路
    fE45.push(boxG(13.4, 0.4, 6.6, 47.4, -0.19, 0, PAL.cliff, { jitter: 0.1 }));
    for (let i = 0; i < 10; i++)
      fE45.push(boxG(1.06, 0.1, rr(3.4, 4.6), 42.4 + i * 1.12, 0.02 + (i % 3) * 0.004, rr(-0.2, 0.2), pick([PAL.pathB, PAL.pathA, PAL.stoneDeep]), { ry: rr(-0.06, 0.06), jitter: 0.07 }));
    // 侧墙 + 壁柱节奏 + 压顶（幽暗过堂——王座厅前的收敛段）
    for (const s of [-1, 1]) {
      sE5.push(boxG(12.4, 5.4, 0.8, 47.6, 2.7, s * 2.95, PAL.wall, { jitter: 0.07 }));
      sE5.push(boxG(12.9, 0.45, 1.2, 47.6, 5.5, s * 2.95, PAL.wallDeep));
      for (let k = 0; k < 6; k++) {
        const px = 42.6 + k * 2.0;
        sE5.push(boxG(0.5, 4.6, 0.22, px, 2.3, s * 2.62, PAL.stoneDark, { jitter: 0.08 }));
      }
    }
    // 烛龛 ×2（暖橙龛室——长廊仅有的两点光）
    for (const cx of [45.2, 50.2]) {
      for (const s of [-1, 1]) {
        sE5.push(boxG(0.5, 0.72, 0.12, cx, 2.0, s * 2.83, PAL.stoneDeep));
        emisGeoms.push(boxG(0.3, 0.44, 0.1, cx, 1.98, s * 2.78, 0xd8a86a));
        emisGeoms.push(cylG(0.04, 0.05, 0.26, 6, cx, 2.3, s * 2.78, PAL.amberHi));
      }
    }
    // 塌方收口（x≈48：断柱碎堆——「王座厅也已被攻破过」的伏笔）
    for (let i = 0; i < 6; i++)
      sE5.push(dodG(rr(0.24, 0.5), 47.6 + rr(-1.2, 1.2), rr(0.2, 0.8), rr(-2.1, 2.1), pick([PAL.stoneDark, PAL.stoneDeep, PAL.stoneMid]), { rx: rnd() * 3, ry: rnd() * 3, rz: rnd() * 3 }));
    sE5.push(cylG(0.34, 0.4, 2.6, 8, 48.3, 0.5, -1.6, PAL.stone, { rz: 1.35, ry: 0.4, jitter: 0.12 }));   // 断柱斜倚
    // 顶盖（暗板免投影）
    massGeoms.push(boxG(12.6, 0.5, 6.8, 47.6, 5.85, 0, PAL.roofB, { jitter: 0.1 }));
    // 王座厅门拱（x=53：门垛 + 尖拱 + 匾心）
    for (const s of [-1, 1]) sE5.push(boxG(1.1, 6.4, 1.0, 53.0, 3.2, s * 3.2, PAL.stoneMid, { jitter: 0.07 }));
    sE5.push(boxG(1.2, 1.0, 7.4, 53.0, 6.4, 0, PAL.stoneHi, { jitter: 0.06 }));
    emisGeoms.push(boxG(0.5, 0.5, 0.14, 53.15, 5.5, 0, PAL.goldDim, { ry: Math.PI / 4 }));               // 匾心暗金徽
  }

  // ================================================= F2 王座厅（蒙格特——可走圆 r13.1@66，断王座在坛）
  {
    const TC = 66;
    // 外壳：南北墙 + 东墙（王座壁）+ 檐口
    sE5.push(boxG(29.2, 11.5, 1.4, 66.4, 5.75, -15.5, PAL.wall, { jitter: 0.06 }));
    sE5.push(boxG(29.2, 11.5, 1.4, 66.4, 5.75, 15.5, PAL.wall, { jitter: 0.06 }));
    sE5.push(boxG(1.4, 11.5, 32.4, 80.8, 5.75, 0, PAL.wall, { jitter: 0.06 }));
    sE5.push(boxG(29.8, 0.62, 1.95, 66.4, 11.8, -15.5, PAL.wallHi));
    sE5.push(boxG(29.8, 0.62, 1.95, 66.4, 11.8, 15.5, PAL.wallHi));
    sE5.push(boxG(1.95, 0.62, 32.9, 80.8, 11.8, 0, PAL.wallHi));
    sE5.push(boxG(30.0, 2.2, 3.0, 66.4, 1.1, -16.6, PAL.wallDeep, { jitter: 0.08 }));
    sE5.push(boxG(30.0, 2.2, 3.0, 66.4, 1.1, 16.6, PAL.wallDeep, { jitter: 0.08 }));
    sE5.push(boxG(3.0, 2.2, 32.9, 82.0, 1.1, 0, PAL.wallDeep, { jitter: 0.08 }));
    // 王室柱列（南北各 6：柱身 + 柱础 + 柱头，z=±13.9 在可走圆外缘）
    for (const s of [-1, 1]) {
      for (let k = 0; k < 6; k++) {
        const px = 56.2 + k * 3.95;
        sE5.push(cylG(0.52, 0.6, 9.6, 12, px, 4.8, s * 13.9, PAL.stoneDark, { jitter: 0.07 }));
        sE5.push(boxG(1.5, 0.4, 1.5, px, 0.2, s * 13.9, PAL.stoneMid));
        sE5.push(boxG(1.7, 0.42, 1.7, px, 9.8, s * 13.9, PAL.stoneMid));
        sE5.push(boxG(0.2, 2.2, 0.14, px, 7.6, s * 13.76, PAL.dark));                                 // 柱身暗缝
      }
    }
    // 高侧窗：南北各 3 樘冷月（呼应教堂）+ 东墙圣金三联（Erdtree 暖金——王座厅的色温对极）
    for (const wx of [58.4, 64.4, 70.4]) {
      for (const s of [-1, 1]) {
        sE5.push(boxG(1.04, 3.3, 0.1, wx, 8.55, s * 14.76, PAL.dark, { jitter: 0.05 }));
        sE5.push(boxG(0.68, 0.68, 0.1, wx, 10.5, s * 14.76, PAL.dark, { rz: Math.PI / 4 }));
        coldGlowGeoms.push(boxG(0.68, 2.75, 0.07, wx, 8.4, s * 14.7, PAL.paneMoonB, { jitter: 0.04 }));
        coldGlowGeoms.push(boxG(0.44, 0.44, 0.07, wx, 10.36, s * 14.7, PAL.paneMoonB, { rz: Math.PI / 4 }));
        sE5.push(boxG(0.08, 2.6, 0.06, wx, 8.4, s * 14.64, PAL.stoneDeep));
        sE5.push(boxG(1.16, 0.18, 0.26, wx, 6.82, s * 14.72, PAL.stoneMid));
      }
    }
    for (const wz of [-4.6, 0, 4.6]) {
      sE5.push(boxG(0.1, 5.6, 1.5, 80.06, 7.4, wz, PAL.dark, { jitter: 0.05 }));
      emisGeoms.push(boxG(0.09, 4.7, 0.98, 80.0, 7.2, wz, wz === 0 ? 0xe8c87c : 0xd8b06a, { jitter: 0.04 }));   // 圣金窗格
      emisGeoms.push(boxG(0.09, 0.7, 0.7, 80.0, 9.9, wz, 0xe8c87c, { rz: Math.PI / 4 }));
      sE5.push(boxG(0.06, 4.4, 0.08, 80.0, 7.2, wz, PAL.stoneDeep));
      sE5.push(boxG(0.26, 0.2, 1.7, 80.12, 4.4, wz, PAL.stoneMid));                                   // 窗台
    }
    // 断王座（东坛三级阶上：高位背板 + 座身 + 双扶手 + 恶兆尖冠 + 断臂残缺 + 暗金饰线 + 暗红坐垫）
    sE5.push(boxG(3.4, 0.42, 7.2, 74.6, 0.21, 0, PAL.stoneMid, { jitter: 0.07 }));
    sE5.push(boxG(2.8, 0.42, 5.8, 75.3, 0.63, 0, PAL.stoneMid, { jitter: 0.07 }));
    sE5.push(boxG(2.2, 0.42, 4.4, 76.0, 1.05, 0, PAL.stoneHi, { jitter: 0.07 }));
    sE5.push(boxG(2.6, 4.6, 0.55, 77.5, 3.6, 0, PAL.stoneDeep, { jitter: 0.06 }));                    // 高背
    sE5.push(boxG(0.16, 4.2, 0.1, 77.18, 3.5, 0, PAL.goldDim));                                       // 背板饰线
    sE5.push(boxG(1.7, 0.55, 1.6, 76.6, 1.55, 0, PAL.stoneDark, { jitter: 0.08 }));                   // 座身
    fE45.push(boxG(1.5, 0.09, 1.3, 76.55, 1.86, 0, 0x3d1a1e, { jitter: 0.1 }));                       // 暗红坐垫
    sE5.push(boxG(0.42, 1.7, 1.5, 77.2, 2.5, 1.35, PAL.stoneMid, { jitter: 0.07 }));                  // 北扶手（完整）
    sE5.push(boxG(0.42, 1.05, 1.5, 77.2, 2.2, -1.35, PAL.stoneMid, { jitter: 0.07, rz: 0.28 }));      // 南扶手（断折倾斜）
    for (const [tx, tz, th] of [[77.5, 0.75, 1.5], [77.5, -0.75, 1.7], [77.5, 0, 2.1]] as const)
      sE5.push(coneG(0.14, th, 5, tx, 5.9 + (th - 1.5) * 0.1, tz, PAL.stoneDeep, { ry: rnd() * 3 })); // 恶兆尖冠
    sE5.push(dodG(0.3, 77.4, 5.7, 0.9, PAL.stoneMid, { ry: rnd() * 3, rz: 0.6 }));                    // 冠顶残砾
    // 王家火盆 ×2 见「火光件」段（煤床/火焰/点光随该段声明）
    // 王旗 ×4（南北壁悬垂：蓝底金绪，残破下缘——蒙格特的「黄金一党」）
    for (const [bx, s] of [[61.0, -1], [61.0, 1], [70.0, -1], [70.0, 1]] as const) {
      const bz = s * 15.06;
      sE5.push(boxG(0.1, 0.12, 1.7, bx, 8.6, bz, PAL.metal));                                          // 旗杆挑臂
      for (let strip = 0; strip < 3; strip++) {
        const sw = 0.52 - strip * 0.02, sh = rr(3.0, 4.2) - strip * 0.5;
        sE5.push(boxG(0.06, sh, sw, bx, 8.4 - sh / 2, bz + s * 0.06, strip === 1 ? PAL.flagSlateB : PAL.flagSlate, { jitter: 0.06 }));
        emisGeoms.push(boxG(0.05, 0.1, sw * 0.7, bx, 8.35 - sh, bz + s * 0.07, PAL.goldDim));          // 金绪残穗
      }
      sE5.push(boxG(0.05, 1.6, 0.4, bx + rr(-0.5, 0.5), rr(3.4, 5.2), s * 14.9, PAL.flagChar, { rz: rr(-0.2, 0.2) }));   // 破落垂片
    }
    // 战损：断柱倾滚（西北）+ 柱头碎堆 + 骑士蜷躯 ×2（近门与南柱脚，王座厅陷落的余响）
    sE5.push(cylG(0.58, 0.58, 3.4, 10, 59.6, 0.58, -10.6, PAL.stone, { ry: 0.8, jitter: 0.1 }));
    sE5.push(cylG(0.58, 0.58, 2.2, 10, 62.6, 0.58, -11.8, PAL.stone, { ry: 2.1, jitter: 0.1 }));
    for (let i = 0; i < 5; i++)
      sE5.push(dodG(rr(0.2, 0.4), 61.4 + rr(-1.4, 1.4), rr(0.15, 0.6), -10.9 + rr(-0.7, 0.7), pick([PAL.stoneMid, PAL.stoneDeep]), { rx: rnd() * 3, ry: rnd() * 3 }));
    for (const [kx, kz, kry] of [[57.4, 4.8, 2.4], [68.8, 11.2, -0.8]] as const) {
      sE5.push(dodG(0.34, kx, 0.32, kz, pick([PAL.rot1, 0x3a414b]), { rx: rnd() * 3, ry: kry, rz: rnd() * 3 }));
      sE5.push(boxG(0.24, 0.2, 0.2, kx + Math.sin(kry) * 0.3, 0.28, kz + Math.cos(kry) * 0.3, PAL.rot2, { ry: kry, jitter: 0.12 }));
      sE5.push(boxG(0.1, 1.15, 0.08, kx + 0.34, 0.5, kz, COLORS.steel, { rz: 1.2, ry: kry }));        // 随手弃置的断剑
      fE45.push(paint(new THREE.CircleGeometry(rr(0.5, 0.75), 12).rotateX(-Math.PI / 2).translate(kx, 0.036, kz), PAL.bloodB, 0.14));
    }
    // 御毯（门→坛：暗红褪金，磨破补丁——fE45 顶点色批）
    fE45.push(boxG(21.5, 0.012, 3.3, 64.6, 0.033, 0, 0x3d1a1e, { ry: 0.0, jitter: 0.05 }));
    for (const ez of [-1.62, 1.62]) fE45.push(boxG(21.5, 0.013, 0.18, 64.6, 0.034, ez, PAL.goldDim, { jitter: 0.06 }));
    for (let i = 0; i < 6; i++)
      fE45.push(boxG(rr(0.8, 1.6), 0.014, rr(0.5, 1.1), 55.5 + i * 3.4, 0.035, rr(-1.1, 1.1), pick([0x33231e, 0x2e211c]), { ry: rr(-0.3, 0.3), jitter: 0.12 }));   // 磨破
    // 厅地面：整幅石板 + 圆环纹（呼应教堂圣所，但徽记换暗金环——王权的几何而非接肢的轮辐）
    fE45.push(boxG(28.4, 0.4, 30.8, 66.4, -0.19, 0, PAL.cliff, { jitter: 0.1 }));
    fE45.push(paint(new THREE.CircleGeometry(13.7, 56).rotateX(-Math.PI / 2).translate(TC, 0.014, 0), PAL.stoneMid, 0.05));
    {
      const ringTones = [PAL.pathB, PAL.stoneDeep, PAL.pathA, PAL.stoneDeep, PAL.pathB];
      const rings: [number, number][] = [[2.6, 3.0], [5.6, 6.0], [8.6, 9.0], [11.6, 12.0], [13.1, 13.5]];
      rings.forEach(([r0, r1], i) =>
        fE45.push(paint(new THREE.RingGeometry(r0, r1, 56).rotateX(-Math.PI / 2).translate(TC, 0.024 + i * 0.002, 0), ringTones[i], 0.06)));
      fE45.push(paint(new THREE.RingGeometry(4.9, 5.2, 56).rotateX(-Math.PI / 2).translate(TC, 0.03, 0), PAL.goldDim, 0.1));
    }
    // 光柱：东窗圣金 ×3 洒向坛前（王座的高光时刻）+ 侧窗冷月 ×2
    {
      const v = new THREE.Vector3(-0.34, 0.78, 0.52).normalize();
      const tilt = Math.acos(v.y), yaw = Math.atan2(-v.z, v.x);
      const addShaft2 = (tx: number, ty: number, tz: number, w: number, h: number, warm: boolean): void => {
        const g = new THREE.PlaneGeometry(w, h, 1, 4);
        const cA = new THREE.Color(warm ? 0xd8b06a : 0x86aede), cB = new THREE.Color(warm ? 0x2e2618 : 0x1c2a3e);
        const p = g.attributes.position as THREE.BufferAttribute;
        const cols = new Float32Array(p.count * 3);
        const cc = new THREE.Color();
        for (let i = 0; i < p.count; i++) {
          const k = Math.min(1, Math.max(0, 0.5 - p.getY(i) / h));
          cc.copy(cA).lerp(cB, k * k);
          cols[i * 3] = cc.r; cols[i * 3 + 1] = cc.g; cols[i * 3 + 2] = cc.b;
        }
        g.rotateZ(-tilt);
        g.rotateY(yaw);
        g.translate(tx - v.x * h / 2, ty - v.y * h / 2, tz - v.z * h / 2);
        g.setAttribute("color", new THREE.BufferAttribute(cols, 3));
        shaftsGeoms.push(g);
      };
      addShaft2(78.6, 9.4, -4.6, 1.15, 9.0, true);
      addShaft2(78.6, 9.4, 0, 1.3, 9.2, true);
      addShaft2(78.6, 9.4, 4.6, 1.15, 9.0, true);
      addShaft2(58.4, 9.6, -14.0, 1.0, 9.0, false);
      addShaft2(70.4, 9.6, 14.0, 1.0, 9.0, false);
    }
    // 顶盖 + 桁架 ×4（木构剪影呼应教堂）+ 底盘岩体
    massGeoms.push(boxG(30.4, 0.5, 33.0, 66.4, 12.1, 0, PAL.roofB, { jitter: 0.1 }));
    for (const bx of [57.5, 62.5, 69.0, 74.0]) {
      sE5.push(boxG(0.34, 0.42, 27.6, bx, 11.6, 0, PAL.wood, { jitter: 0.06 }));
      for (const s of [-1, 1]) sE5.push(boxG(0.26, 0.26, 5.0, bx, 12.35, s * 10.2, PAL.wood, { rx: s * 0.34, jitter: 0.08 }));
    }
    massGeoms.push(boxG(31.0, 15, 34.4, 66.6, -7.7, 0, PAL.cliff, { jitter: 0.12 }));
  }

  // ---------------- 北渊：深渊 + 雾海中的下层城区（窗火点云） ----------------
  {
    const abyss = new THREE.Mesh(
      new THREE.CircleGeometry(115, 40).rotateX(-Math.PI / 2).translate(-2, -15, 2),
      track(new THREE.MeshStandardMaterial({ color: 0x10151b, roughness: 1 })),
    );
    abyss.receiveShadow = false;
    abyss.updateMatrix();
    abyss.matrixAutoUpdate = false;
    root.add(abyss);
  }
  const winTownPts: number[] = [];
  {
    const roofGeoms: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 40; i++) {
      const x = rr(-38, 42);
      const z = rr(19, 40);
      if (x > 12 && x < 42 && z < 34) continue;                  // 让开教堂正下方
      const w = rr(1.6, 4.8), h = rr(1.4, 4.4), d = rr(1.6, 4.8);
      roofGeoms.push(boxG(w, h, d, x, -15 + h / 2 - 0.2, z, pick([PAL.roofA, PAL.roofB, PAL.stoneDeep]), { ry: rnd() * Math.PI, jitter: 0.12 }));
      if (rnd() < 0.5) {
        const c = new THREE.Color(COLORS.ember).multiplyScalar(0.3 + rnd() * 0.45);
        winTownPts.push(x + rr(-w * 0.3, w * 0.3), -15 + h * 0.72, z + d * 0.52, c.r, c.g, c.b);
      }
    }
    for (let i = 0; i < 3; i++) roofGeoms.push(coneG(rr(0.9, 1.4), rr(2.5, 4), 5, rr(-20, 8), -12.6, rr(24, 34), PAL.roofB));
    root.add(batch(roofGeoms, stoneMat, "none"));
  }
  const winTownMat = track(new THREE.PointsMaterial({ size: 0.32, vertexColors: true, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false }));
  {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(winTownPts.filter((_, i) => i % 6 < 3)), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(winTownPts.filter((_, i) => i % 6 >= 3)), 3));
    root.add(new THREE.Points(g, winTownMat));
  }

  // ---------------- 火光件：壁炬×2（雾门墩）+ 火盆×2（玛尔基特房/残柱厅）+ 圣坛恩泽 ----------------
  const flameMat0 = track(new THREE.MeshBasicMaterial({ color: 0xffc56a, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
  const coalGeoms: THREE.BufferGeometry[] = [];
  const flames: FlameRef[] = [];
  /** 挂墙壁炬（雾门门墩内侧，风中的两点暖） */
  const sconce = (z: number): void => {
    sE2.push(boxG(0.1, 0.62, 0.1, -5.15, 3.0, z * 1.78, PAL.metal));
    sE2.push(cylG(0.24, 0.13, 0.2, 8, -5.15, 3.3, z * 1.55, PAL.metal));
    coalGeoms.push(dodG(0.14, -5.15, 3.38, z * 1.55, 0x000000));
    const mesh = new THREE.Mesh(coneG(0.16, 0.52, 7, -5.15, 3.6, z * 1.55, 0xffffff), track(flameMat0.clone()));
    (mesh.material as THREE.MeshBasicMaterial).fog = false;             // 雾门壁炬穿雾，之字坡上看得见门
    mesh.renderOrder = 6;
    root.add(mesh);
    const light = new THREE.PointLight(COLORS.ember, 6, 9, 2);
    light.position.set(-5.15, 3.75, z * 1.55);
    root.add(light);
    flames.push({ mesh, mat: mesh.material as THREE.MeshBasicMaterial, light, ph: z });
  };
  sconce(1);
  sconce(-1);
  /** 立式火盆：玛尔基特房墙顶步道（西南） */
  {
    const x = -3.4, z = -10.3, y = 3.9;
    sE3.push(boxG(0.5, 0.4, 0.5, x, y - 0.2, z, PAL.stoneMid));
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.5;
      sE3.push(cylG(0.03, 0.04, 0.95, 6, x + Math.cos(a) * 0.2, y + 0.45, z + Math.sin(a) * 0.2, PAL.metal, { ry: -a, rz: 0.2 }));
    }
    sE3.push(cylG(0.3, 0.16, 0.22, 9, x, y + 1.0, z, PAL.metal));
    coalGeoms.push(dodG(0.16, x, y + 1.1, z, 0x000000));
    const mesh = new THREE.Mesh(coneG(0.18, 0.55, 7, x, y + 1.36, z, 0xffffff), track(flameMat0.clone()));
    mesh.renderOrder = 6;
    root.add(mesh);
    const light = new THREE.PointLight(COLORS.ember, 7, 11, 2);
    light.position.set(x, y + 1.5, z);
    root.add(light);
    flames.push({ mesh, mat: mesh.material as THREE.MeshBasicMaterial, light, ph: 3.3 });
  }
  /** 残柱厅火盆（走道北缘，塌方堆前） */
  {
    const x = 18.7, z = -4.75, y = 0;
    sE4.push(cylG(0.34, 0.44, 0.5, 9, x, 0.25, z, PAL.stoneMid));
    sE4.push(cylG(0.42, 0.3, 0.28, 9, x, 0.62, z, PAL.metal));
    coalGeoms.push(dodG(0.17, x, 0.74, z, 0x000000));
    const mesh = new THREE.Mesh(coneG(0.19, 0.58, 7, x, 1.02, z, 0xffffff), track(flameMat0.clone()));
    mesh.renderOrder = 6;
    root.add(mesh);
    const light = new THREE.PointLight(COLORS.ember, 7, 10, 2);
    light.position.set(x, 1.2, z);
    root.add(light);
    flames.push({ mesh, mat: mesh.material as THREE.MeshBasicMaterial, light, ph: 5.1 });
  }
  /** 王座厅王家火盆（F2 门内夹道——青铜柱盆，厅内唯二暖光活源） */
  for (const s of [-1, 1]) {
    const bx = 55.6, bz = s * 3.6;
    sE5.push(cylG(0.36, 0.46, 0.5, 9, bx, 0.25, bz, PAL.stoneMid));
    sE5.push(cylG(0.44, 0.3, 0.3, 9, bx, 0.62, bz, 0x4a3d2c));
    coalGeoms.push(dodG(0.17, bx, 0.74, bz, 0x000000));
    const mesh = new THREE.Mesh(coneG(0.19, 0.58, 7, bx, 1.02, bz, 0xffffff), track(flameMat0.clone()));
    mesh.renderOrder = 6;
    root.add(mesh);
    const light = new THREE.PointLight(COLORS.ember, 7, 11, 2);
    light.position.set(bx, 1.2, bz);
    root.add(light);
    flames.push({ mesh, mat: mesh.material as THREE.MeshBasicMaterial, light, ph: 7.3 + s });
  }
  // 主线折点余烬短杠（炭芯批，0 新灯）：沿 STORMVEIL_WALK 指向下一折，西侧未燃火把保持微光以免把人引回封门。
  for (let i = 0; i < STORMVEIL_WALK.length - 1; i++) {
    const [x, z] = STORMVEIL_WALK[i];
    const [nx, nz] = STORMVEIL_WALK[i + 1];
    const dx = nx - x, dz = nz - z;
    const len = Math.hypot(dx, dz);
    const ry = Math.atan2(-dz, dx);
    const ts = len > 12 ? [0.34, 0.72] : [0.62];
    for (const t of ts) {
      const px = x + dx * t;
      if (px > -5.8) continue;                                         // 让开雾门门墩与壁炬
      coalGeoms.push(boxG(0.78, 0.08, 0.16, px, 0.1, z + dz * t, 0x000000, { ry }));
    }
  }
  const coalMat = track(new THREE.MeshStandardMaterial({ color: 0x2a1207, emissive: COLORS.ember, emissiveIntensity: 1.9, roughness: 1, flatShading: true }));
  {
    const m = batch(coalGeoms, coalMat, "none");
    m.matrixAutoUpdate = true;
    root.add(m);
  }
  /** 圣坛恩泽（暖金，静稳脉动——接肢教堂的「赐福」错觉；后殿 vignette 的主暖源） */
  const graceLight = new THREE.PointLight(0xe8c87c, 6.5, 18, 2);
  graceLight.position.set(39.9, 2.8, 0);
  root.add(graceLight);

  // ---------------- 自发光小批（暖窗/玫瑰窗/残烛/未燃火把/烛龛暖晕/裂缝余烬） ----------------
  const emisMat = track(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, fog: false }));
  root.add(batch(emisGeoms, emisMat, "none"));
  // 冷月窗格批（尖拱窗/玫瑰窗龛——建筑本体冷蓝，与暖批错相慢呼吸）
  const coldGlowMat = track(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.88, fog: false }));
  root.add(batch(coldGlowGeoms, coldGlowMat, "none"));
  // 尘埃光柱批（additive 半透明，顶亮底暗顶点色，整体缓涌）
  const shaftMat = track(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
  const shafts = batch(shaftsGeoms, shaftMat, "none");
  shafts.renderOrder = 4;
  root.add(shafts);

  // ---------------- 静态几何落批（5 空间分块 + 地面/山体，frustum 剔剪友好） ----------------
  root.add(batch(sE1, stoneMat, "both"));
  root.add(batch(sE2, stoneMat, "both"));
  root.add(batch(sE3, stoneMat, "both"));
  root.add(batch(sE4, stoneMat, "both"));
  root.add(batch(sE5, stoneMat, "both"));
  root.add(batch(fE1, stoneMat, "receive"));
  root.add(batch(fE2, stoneMat, "receive"));
  root.add(batch(fE3, stoneMat, "receive"));
  root.add(batch(fE45, stoneMat, "receive"));
  root.add(batch(massGeoms, stoneMat, "none"));

  // ---------------- 残旗 ×6（风暴狂摆：大墙×1/露台×1/环墙×1/残柱厅×1/教堂门×2） ----------------
  const flags: FlagRef[] = [];
  const flagDefs = [
    { w: 1.2, h: 1.9, x: -32.6, y: 12.4, z: -13.0, a: PAL.flagSlate, b: PAL.flagSlateB, ph: 1.2, sp: 3.1, amp: 1.5 },  // 大城墙腰
    { w: 0.95, h: 1.5, x: -13.8, y: 1.35, z: 6.7, a: PAL.flagChar, b: PAL.flagCharB, ph: 2.6, sp: 2.8, amp: 1.35 },    // 露台北堞
    { w: 1.05, h: 1.65, x: -7.6, y: 4.35, z: -9.8, a: PAL.flagSlate, b: PAL.flagSlateB, ph: 4.0, sp: 2.7, amp: 1.3 },   // 竞技场环墙
    { w: 0.9, h: 1.45, x: 18.4, y: 4.3, z: -5.4, a: PAL.flagGold, b: PAL.flagGoldB, ph: 0.4, sp: 2.6, amp: 1.3 },       // 残柱厅塌堆
    { w: 1.5, h: 2.3, x: 14.5, y: 8.9, z: 3.6, a: PAL.flagGold, b: PAL.flagGoldB, ph: 1.8, sp: 2.3, amp: 1.1 },         // 教堂西门北
    { w: 1.5, h: 2.3, x: 14.5, y: 8.9, z: -3.6, a: PAL.flagGold, b: PAL.flagGoldB, ph: 3.4, sp: 2.3, amp: 1.1 },        // 教堂西门南
  ];
  for (const d of flagDefs) {
    const { geo, orig } = flagGeo(d.w, d.h, d.a, d.b);
    const mesh = new THREE.Mesh(geo, track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true, side: THREE.DoubleSide })));
    mesh.position.set(d.x, d.y, d.z);
    mesh.rotation.y = Math.PI / 2;
    mesh.castShadow = true;
    root.add(mesh);
    flags.push({ mesh, orig, h: d.h, ph: d.ph, sp: d.sp, amp: d.amp });
  }
  // 旗杆
  root.add(batch([
    cylG(0.04, 0.055, 2.2, 6, -32.6, 12.4, -13.0, PAL.wood),
    cylG(0.035, 0.05, 1.7, 6, -13.8, 1.6, 6.7, PAL.wood),
    cylG(0.04, 0.05, 1.9, 6, -7.6, 4.7, -9.8, PAL.wood),
    cylG(0.035, 0.05, 1.8, 6, 18.4, 4.55, -5.4, PAL.wood),
    cylG(0.05, 0.07, 2.7, 6, 14.5, 9.15, 3.6, PAL.wood),
    cylG(0.05, 0.07, 2.7, 6, 14.5, 9.15, -3.6, PAL.wood),
  ], stoneMat, "cast"));

  // ---------------- 风暴风效：横飘风絮（快）+ 打旋枯叶（慢） 双 Points ----------------
  interface WindSys { pts: THREE.Points; base: Float32Array; spd: Float32Array; seedArr: Float32Array; n: number }
  const windSys: WindSys[] = [];
  const mkWind = (n: number, size: number, color: number, opacity: number, vMin: number, vMax: number, yBase: number, ySpan: number): void => {
    const pos = new Float32Array(n * 3);
    const spd = new Float32Array(n);
    const sd = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = rr(-42, 44);
      pos[i * 3 + 1] = yBase + rnd() * ySpan;
      pos[i * 3 + 2] = rr(-26, 26);
      spd[i] = rr(vMin, vMax);
      sd[i] = rnd() * Math.PI * 2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(g, track(new THREE.PointsMaterial({ size, color, transparent: true, opacity, depthWrite: false })));
    pts.frustumCulled = false;
    root.add(pts);
    windSys.push({ pts, base: new Float32Array(pos), spd, seedArr: sd, n });
  };
  mkWind(130, 0.06, 0x9fb0aa, 0.42, 7, 13, 0.3, 10);   // 风絮（高空横飘）
  mkWind(60, 0.13, 0x6d7264, 0.5, 4, 8, 0.15, 2.2);    // 枯叶碎屑（低空打旋）

  // ---------------- 地面雾片 ×4（Canvas 柔光，漂移 + 呼吸） ----------------
  const mists: MistRef[] = [];
  {
    const tex = softDiscTexture();
    const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const defs = [
      { x: -29.0, y: 0.3, z: 0.4, s: 7.0, o: 0.07, c: PAL.mistColor },
      { x: -14.0, y: 0.26, z: -0.6, s: 5.5, o: 0.06, c: PAL.mistColor },
      { x: 1.5, y: 0.32, z: 1.8, s: 6.5, o: 0.06, c: PAL.mistColor },
      { x: 27.5, y: 0.4, z: 0, s: 9.0, o: 0.05, c: 0x34302a },      // 教堂内：微暖腐金雾
    ];
    for (const d of defs) {
      const mat = track(new THREE.MeshBasicMaterial({ map: tex, color: d.c, transparent: true, opacity: d.o, depthWrite: false }));
      const mesh = new THREE.Mesh(plane, mat);
      mesh.position.set(d.x, d.y, d.z);
      mesh.scale.setScalar(d.s);
      mesh.renderOrder = 5;
      root.add(mesh);
      mists.push({ mesh, mat, bx: d.x, bz: d.z, dx: rr(1.4, 2.8), dz: rr(1.2, 2.4), ph: rnd() * 6.28, spx: rr(0.05, 0.1), spz: rr(0.04, 0.09), o: d.o });
    }
  }

  // ---------------- update：残旗狂摆 / 火光呼吸 / 风絮横飘 / 流云 / 旋带 / 雾片 ----------------
  let animT = 0;
  const update = (t: number, dt: number): void => {
    animT += dt;
    void t;
    const gust = 1 + 0.55 * Math.sin(animT * 0.9) + 0.25 * Math.sin(animT * 2.3 + 1.4);   // 风暴阵风包络
    for (const f of flags) {
      const attr = f.mesh.geometry.attributes.position as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      const g2 = 1 + 0.4 * Math.sin(animT * 0.33 + f.ph);
      for (let i = 0; i < attr.count; i++) {
        const ox = f.orig[i * 3], oy = f.orig[i * 3 + 1];
        const k = Math.min(1, Math.max(0, -oy / f.h));
        arr[i * 3 + 2] = (Math.sin(animT * f.sp + f.ph + ox * 1.9 + oy * 2.3) * 0.15
          + Math.sin(animT * f.sp * 0.62 + ox * 3.4 + 1.3) * 0.07
          + Math.sin(animT * f.sp * 1.7 + oy * 4.1) * 0.035) * k * gust * g2 * f.h * 0.5 * f.amp;
      }
      attr.needsUpdate = true;
      f.mesh.rotation.y = Math.PI / 2 + Math.sin(animT * 0.7 + f.ph) * 0.16;             // 整面旗受风扭摆
    }
    for (let i = 0; i < flames.length; i++) {
      const fl = flames[i];
      const s = 1 + Math.sin(animT * 11 + i * 2.1) * 0.18 + Math.sin(animT * 27 + i) * 0.08;
      fl.mesh.scale.set(1 + (s - 1) * 0.4, s, 1 + (s - 1) * 0.4);
      fl.mesh.rotation.z = Math.sin(animT * 2.1 + fl.ph) * 0.12;                          // 风吹火苗侧摆
      fl.mesh.rotation.x = Math.cos(animT * 1.7 + fl.ph * 0.8) * 0.09;
      fl.mat.opacity = 0.9 + 0.08 * Math.sin(animT * 13 + i * 1.7);
      fl.light.intensity = 5.6 + Math.sin(animT * 9.5 + i * 2.4) * 1.3 + Math.sin(animT * 23 + i) * 0.7;
    }
    coalMat.emissiveIntensity = 1.9 + Math.sin(animT * 7.3) * 0.35;
    graceLight.intensity = 6.2 + Math.sin(animT * 1.6) * 0.7 + Math.sin(animT * 4.1) * 0.3;
    {                                                                                      // 风絮/枯叶：横飘 + 打旋 + wrap
      for (const w of windSys) {
        const attr = w.pts.geometry.getAttribute("position") as THREE.BufferAttribute;
        const arr = attr.array as Float32Array;
        const span = 86;
        for (let i = 0; i < w.n; i++) {
          const j = i * 3;
          const x = arr[j] + w.spd[i] * dt * (0.7 + 0.3 * Math.sin(animT * 0.5 + w.seedArr[i]));
          arr[j] = -42 + (((x + 42) % span) + span) % span;
          arr[j + 1] = w.base[j + 1] + Math.sin(animT * (1.1 + (i % 5) * 0.17) + w.seedArr[i]) * (i % 7 === 0 ? 1.1 : 0.5);
          arr[j + 2] = w.base[j + 2] + Math.sin(animT * 0.8 + w.seedArr[i] * 2.1) * 1.6;
        }
        attr.needsUpdate = true;
      }
    }
    {                                                                                      // 流云：快漂 wrap + 边缘渐隐
      const span = CLOUD_SPAN.max - CLOUD_SPAN.min;
      for (const c of clouds) {
        const x = c.x0 + (((animT * c.sp) % span) + span) % span + CLOUD_SPAN.min;
        const k = Math.min(1, Math.max(0, Math.min((x - CLOUD_SPAN.min) / CLOUD_SPAN.fade, (CLOUD_SPAN.max - x) / CLOUD_SPAN.fade)));
        c.mesh.position.x = x;
        c.mat.opacity = c.o * k * k * (0.85 + 0.15 * Math.sin(animT * 0.6 + c.x0));
      }
    }
    for (const s of swirls) {                                                              // 风暴旋带缓转 + 呼吸
      s.inner.rotation.z += dt * s.spin * (0.8 + 0.2 * Math.sin(animT * 0.4 + s.ph));
      s.mat.opacity = 0.085 + 0.045 * (0.5 + 0.5 * Math.sin(animT * 0.5 + s.ph));
    }
    winFarMat.opacity = 0.72 + Math.sin(animT * 0.8) * 0.14 + Math.sin(animT * 2.3) * 0.08;
    winTownMat.opacity = 0.66 + Math.sin(animT * 1.1 + 2) * 0.15 + Math.sin(animT * 3.1) * 0.07;
    emisMat.opacity = 0.92 + Math.sin(animT * 2.2) * 0.08;                                 // 暖窗/烛火微闪
    coldGlowMat.opacity = 0.84 + Math.sin(animT * 1.1 + 1.9) * 0.09;                       // 冷月窗格慢呼吸（错相）
    shaftMat.opacity = 0.52 + 0.16 * Math.sin(animT * 0.45) + 0.05 * Math.sin(animT * 1.3); // 光柱浮尘缓涌
    {                                                                                      // 雾密度/色温室内外分层：进教堂渐透渐暖（Boss 房可读性）
      const fk = Math.min(1, Math.max(0, (camX - 14.5) / 10));
      const kk = fk * fk * (3 - 2 * fk);
      (scene.fog as THREE.FogExp2).density = 0.026 - 0.007 * kk;
      (scene.fog as THREE.FogExp2).color.copy(fogBase).lerp(fogIn, kk);
    }
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
