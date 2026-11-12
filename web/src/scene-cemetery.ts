/** 灰烬墓地场景（m4-T3 扩建：DS3 尺度 80m 级长卷）：冷灰石 + 余烬火光 + 荒芜
 * 与 scene-highwall 同构：{ anchors, update, dispose }——game.ts 场景注册表按此消费
 * 美术方向（对标 DS3 灰烬墓地 → 法兰要塞深处）：
 *   冷灰蓝石色系为底、火光橙为唯一强调色（C 区加一支法兰冷蓝）；全 roughness≥0.8 哑光
 *   层次：灰霭天穹 + 朦胧冷月 → 雾上浮的墓园围墙/破塔/圣殿残迹/枯树剪影 →
 *         墓园径长廊（袋形墓苑 ×2）→ 古达雾门双火盆 → 古达房可走 32.2m →
 *         门 B 黑拱 → 法兰哨路（下沉暗廊·蓝灯笼）→ 监视者厅可走 36.2m + 缓落飘灰
 *         → 碎星径 → 拉塔恩战场可走 180.2m
 * C 区美术深加工（对标 DS3 法兰要塞的病沼冷蓝意象；纯视觉表达，不改逻辑 y/zones）：
 *   下沉感——门 B 沉重黑拱 + 幽蓝门槛；C1 墙沿 x 渐高（总高 4.9→8.6m）、压顶横梁
 *   底高 3.95→3.60 越走越低（全程高于跟背相机不穿模）、地面色板渐暗、箭缝透光越走越弱；
 *   冷蓝语言——灯龛升级（影盒龛+垂链+悬灯+光晕 halo 批）、病沼薄雾片（半透明平面
 *   两层缓移）、墙脚苔纹/湿痕（顶点色渐变）、残旗撕裂下垂做旧；
 *   C2 要塞化——尖碑符文 emissive、断王座仪式（三层台阶+散落王冠+剑冢插地）、
 *   环缘残墙东北崩塌豁口望见天穹冷月、监视者雕像剪影（远景批，Boss 主题前呼）；
 *   骨堆叙事——乱骨加密 + 盔甲残骸（盾/矛/盔），路缘「深渊凝视者」跪尸剪影。
 * 分区（SceneAnchors v2，西→东；docs/design/m4-level-flow.md §3.1）：
 *   A1 出生台地(-142..-130) → A2 墓园径三段+袋形墓苑×2 → A3 古达房 r17(c=3.5，可走 32.2)
 *   → 门 B(19.6) → C1 法兰哨路 36m → C2 监视者房 r19(c=74，可走 36.2)
 *   → D1 碎星径 → D2 拉塔恩战场 r91(c=195，可走 180.2)
 * 三间 Boss 环墙内侧面贴可走圆（距圆心 r−0.9），只向外加厚，净高 ≥3.5m。
 * 走廊口按半宽 2.75m 留同宽门洞；洞弧上石楣从过头处接到墙顶，楣下铁栅内侧面同样贴可走圆，栅条从地面伸到过头。
 *   人尺度：三间房另铺 1–3m 石碎（不乘 A3k/C2k/D2k）。古达是墓石和断柱，监视者是冷灰石碎，
 *   拉塔恩外圈是短剑和焦黑石块；场心约 6m 留空，用来在加大后的空地上读出远近。
 *   直跑 spawn→雾门 130.5m ≈ 21s @6.2m/s（教学区 20-30s 预算内）
 * 预算：静态几何按顶点色 mergeGeometries 合批（6 空间分块），场景本体 ~16 draw call；
 *   火光 PointLight ×3（雾门火盆 ×2 + A1 烛龛），C 区灯笼/烛台/门 B 幽光全 emissive 呼吸
 * 跟随：天穹/冷月/流云随玩家 x/z 平移（半径 220，站在拉塔恩战场边缘时 180m 对岸仍在穹内；相机 far=480）；
 *   阴影定向灯 38×28m 窗口按 2m 网格吸附跟随（2048² 拉全图会痘影，见 m4 §4.2）
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { COLORS } from "./config";
import { createSceneGeom } from "./scene-geom";
import type { SceneAnchors, SceneZone } from "./scene-highwall";

/** 派生色板：冷灰蓝石阶 + 灰烬暖灰（ADR-0006 纪律）；强调色仅 ember 系（火盆火焰/炭芯）；
 *  C 区「深处」用更沉的 crypt 阶 + 法兰冷蓝（低饱和，压在冷灰族内不破纪律） */
const PAL = {
  stone: COLORS.stone, stoneMid: 0x34383f, stoneDark: COLORS.stoneDark, stoneDeep: 0x232529,
  mortar: 0x191b20, steel: 0x363b42, ash: 0x14110d,
  pathA: COLORS.groundPath, pathB: 0x2c2825, pathC: 0x31302c,
  crypt: 0x2b2f38, cryptMid: 0x232732, cryptDark: 0x1c1f27, cryptDeep: 0x14161c,
  cryptPath: 0x24272d, cryptPathB: 0x20232a, bone: 0x4a4436,
  bannerBlue: 0x2a3550, bannerBlueB: 0x1c2437, bannerFade: 0x151b26,
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

/** 与另外两个场景同一份实现；jitter 仍消耗本文件的 rnd。 */
const { paint, boxG, cylG, coneG, dodG, batch } = createSceneGeom(rnd);

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

/** 色阶插值（构建期少量调用，直接走 THREE.Color 往返 sRGB；C1 渐沉色板用） */
function mix(a: number, b: number, k: number): number {
  return new THREE.Color(a).lerp(new THREE.Color(b), Math.min(1, Math.max(0, k))).getHex();
}

/** 破旗面：撕裂下摆 + 湿重垂坠（顶边为挂点，向下渐朝墙侧贴/侧缘下垂；顶点色挂点饱和→下摆褪灰做旧） */
function tatteredBanner(w: number, h: number, colA: number, colB: number): THREE.BufferGeometry {
  const cols = 5, rows = 7;
  const g = new THREE.PlaneGeometry(w, h, cols, rows);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let iy = 0; iy <= rows; iy++) {
    for (let ix = 0; ix <= cols; ix++) {
      const i = iy * (cols + 1) + ix;
      const k = iy / rows;                                                        // 0=挂点 1=下摆
      p.setZ(i, p.getZ(i) - Math.pow(k, 1.7) * 0.26);                             // 湿重垂坠：下摆贴向墙侧
      if (iy === rows && ix % 2 === 1) p.setY(i, p.getY(i) + h * (0.07 + ((ix * 31) % 9) / 40));  // 撕裂缺口
      if (ix === 0 || ix === cols) p.setY(i, p.getY(i) + k * k * h * 0.05);       // 侧缘下垂
    }
  }
  g.translate(0, -h / 2, 0);                                                      // 顶边挂点 y=0
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
  return ng;
}

/** 墙脚苔纹/湿痕：贴墙竖向渐变条（底=苔色 → 顶=墙色咬合，顶缘不规则；顶点色渐变并入石构批，0 额外 dc） */
function mossPatch(dst: THREE.BufferGeometry[], x0: number, x1: number, s: number, h: number, faceZ: number): void {
  const w = x1 - x0;
  const g = new THREE.PlaneGeometry(w, h, Math.max(4, Math.round(w * 1.6)), 3);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const k = (p.getY(i) + h / 2) / h;                                            // 0=底 1=顶
    if (k > 0.76) p.setY(i, p.getY(i) - (k - 0.76) * (0.25 + ((i * 7) % 5) / 14) * h);  // 顶缘咬入墙体
  }
  g.rotateY(s > 0 ? Math.PI : 0);
  g.translate((x0 + x1) / 2, h / 2 - 0.03, s * faceZ);
  const ng = g.toNonIndexed();
  g.dispose();
  const pos = ng.attributes.position;
  const arr = new Float32Array(pos.count * 3);
  const moss = new THREE.Color(0x232b26), wall = new THREE.Color(PAL.cryptDark), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const k = Math.min(1, Math.max(0, (pos.getY(i) + 0.03) / h));
    c.copy(moss).lerp(wall, Math.pow(k, 0.8));
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  ng.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  dst.push(ng);
}

interface FlameRef { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; light: THREE.PointLight; ph: number }
interface CloudRef { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; sp: number; o: number }
interface MistRef { mesh: THREE.Mesh; bx: number; bz: number; dx: number; dz: number; ph: number; spx: number; spz: number }

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

  // ---------------- 分区布局（走廊半宽 2.75=净宽 5.5m，不改） ----------------
  // 可走直径 = 2*(r-0.9)。本房加大时西鼻 c-(r-0.9) 不动，圆心只向东移 Δr；
  // 东侧多出来的长度 Δx=2*Δr 把更东的区块整段平移，走廊长度不变、接口不被吞掉。
  // 古达 r17 可走 32.2（西鼻 -12.6）。监视者 r19 可走 36.2。拉塔恩 r91 可走 180.2
  // （原作沙丘约 1km，这里只取这个网页关卡装得下的战场）。
  const GATE_X = -10;
  const A3C0 = -1.5, A3R0 = 12, C2C0 = 57, C2R0 = 12, D2C0 = 94, D2R0 = 14;
  const A3R = 17;
  const A3C = A3C0 + (A3R - A3R0);                              // 3.5；西可走边 -12.6
  const DOOR_B = A3C + (A3R - 0.9);                             // 19.6 东可走边（A 区东界）
  const A3_DX = (A3R - A3R0) * 2;                               // 10：C 及以东整段东移
  const C2R = 19;
  const C2_W = C2C0 - (C2R0 - 0.9) + A3_DX;                     // 55.9 西可走边
  const C2C = C2_W + (C2R - 0.9);                               // 74
  const C2_E = C2C + (C2R - 0.9);                               // 92.1 东可走边
  const C2_DX = (C2R - C2R0) * 2;                               // 14：D 整段再东移
  const D_DX = A3_DX + C2_DX;                                   // 24
  const D2R = 91;
  const D2_W = D2C0 - (D2R0 - 0.9) + D_DX;                      // 104.9 西可走边
  const D2C = D2_W + (D2R - 0.9);                               // 195；东可走边 285.1
  const A3k = A3R / A3R0, C2k = C2R / C2R0, D2k = D2R / D2R0;
  // 带↔盘衔接口径：切换线处「带口截面 ⊆ 盘可走半径(r-0.9)」，主路径零跳变；
  // 袋形墓苑 r7.5 在 cx±6.0 切换（hypot(6,2.75)=6.6=r-0.9）。
  // C1.minX = 门B-0.4：未解锁推回值(上一区 maxX-0.4) 恰落在本带 minX 上，墙稳定在 A 东界-0.4。
  const HALF = 2.75, WALL_Z = 3.25;                                       // 钳制半宽 / 墙心 z
  /** 远景剪影相对旧圆心的净空保持不变（新距离 = 旧距离 + Δr），加大后的圆不吞掉剪影 */
  const expandXZ = (oldC: number, oldR: number, neuC: number, neuR: number, x: number, z: number): [number, number] => {
    const dx = x - oldC;
    const dist = Math.hypot(dx, z) || 1;
    const s = (dist + (neuR - oldR)) / dist;
    return [neuC + dx * s, z * s];
  };
  const zones: SceneZone[] = [
    { id: "cemetery:A", kind: "corridor", minX: -142, maxX: -101, half: HALF },                                  // A1 台地 + A2 西径
    { id: "cemetery:A", kind: "arena", minX: -101, maxX: -89, center: new THREE.Vector3(-95, 0, 0), r: 7.5 },    // 袋形墓苑 I
    { id: "cemetery:A", kind: "corridor", minX: -89, maxX: -51, half: HALF },                                    // A2 中径
    { id: "cemetery:A", kind: "arena", minX: -51, maxX: -39, center: new THREE.Vector3(-45, 0, 0), r: 7.5 },     // 袋形墓苑 II
    { id: "cemetery:A", kind: "corridor", minX: -39, maxX: GATE_X, half: HALF },                                 // A2 东径 → 雾门
    { id: "cemetery:A", kind: "arena", minX: GATE_X, maxX: DOOR_B, center: new THREE.Vector3(A3C, 0, 0), r: A3R },// A3 古达 可走 32.2
    { id: "cemetery:C", kind: "corridor", minX: DOOR_B - 0.4, maxX: C2_W, half: HALF },                          // C1 法兰哨路（长度不变）
    { id: "cemetery:C", kind: "arena", minX: C2_W, maxX: C2_E, center: new THREE.Vector3(C2C, 0, 0), r: C2R },   // C2 监视者 可走 36.2
    { id: "cemetery:D", kind: "corridor", minX: C2_E - 0.4, maxX: D2_W, half: HALF },                            // D1 碎星径（长度不变，监视者胜后）
    { id: "cemetery:D", kind: "arena", minX: D2_W, maxX: D2C + D2R, center: new THREE.Vector3(D2C, 0, 0), r: D2R }, // D2 碎星战场 可走 180.2（拉塔恩）
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
  // 雾：古达/监视者对岸（≤36m）在 0.030 下仍约三成固有色；碎星战场 180m 对岸要更薄，
  // 进 D1 后收到 0.0061，否则站在西鼻看不见东岸。出生地到古达仍是全雾。
  const FOG_NEAR = 0.030, FOG_FIELD = 0.0061;
  const cemFog = new THREE.FogExp2(COLORS.fog, FOG_NEAR);
  scene.fog = cemFog;

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

  // ---------------- 天穹随行组：大球内壁渐变 + 朦胧冷月 + 流云（跟玩家 x/z） ----------------
  // 拉塔恩可走直径 180.2。天球若只罩 105，人站在西缘朝东看，对岸落在穹外。
  // 220 罩住整段对岸，且小于相机 far 480，穹面不会被远平面裁掉。
  const SKY_R = 220;
  const skyGroup = new THREE.Group();
  skyGroup.position.set(-140.5, 0, 0);
  root.add(skyGroup);
  {
    const geo = new THREE.SphereGeometry(SKY_R, 32, 20);
    const pos = geo.attributes.position;
    const colArr = new Float32Array(pos.count * 3);
    const top = new THREE.Color(PAL.skyTop), hor = new THREE.Color(PAL.skyHorizon), un = new THREE.Color(PAL.skyUnder);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const ny = pos.getY(i) / SKY_R;
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
  { const [x, z] = expandXZ(A3C0, A3R0, A3C, A3R, -1.5, -19); wallArc(x, z, rr(13, 17)); }
  { const [x, z] = expandXZ(A3C0, A3R0, A3C, A3R, 4, 18); wallArc(x, z, rr(12, 16)); }
  { const [x, z] = expandXZ(C2C0, C2R0, C2C, C2R, 57, -18); wallArc(x, z, rr(12, 16)); }
  { const [x, z] = expandXZ(C2C0, C2R0, C2C, C2R, 62, 17); wallArc(x, z, rr(13, 17)); }
  const tower = (x: number, z: number, w: number, h: number): void => {
    farGeoms.push(boxG(w, h, w, x, h / 2 - 0.3, z, FAR.tower, { ry: rr(-0.1, 0.1), jitter: 0.07 }));
    for (let i = 0; i < 4; i++) if (rnd() < 0.7)         // 断口残垛
      farGeoms.push(boxG(w * 0.22, rr(0.6, 1.4), w * 0.22, x + rr(-w * 0.32, w * 0.32), h - 0.3 + rr(0.2, 0.6), z + rr(-w * 0.32, w * 0.32), FAR.teeth, { ry: rnd() * 3 }));
  };
  tower(-134, 14, 3.4, 12);
  tower(-70, -15, 3.0, 9.5);
  tower(-24, 15, 2.6, 7);
  { const [x, z] = expandXZ(A3C0, A3R0, A3C, A3R, 16, -15); tower(x, z, 3.2, 11); }   // A3 背景破塔（门 B 拱外北侧）
  tower(44 + A3_DX, 16, 2.8, 8.5);                       // C1 哨路远塔，随哨路东移
  { const [x, z] = expandXZ(C2C0, C2R0, C2C, C2R, 78, -9); tower(x, z, 3.4, 13); }  // C2 尽头王座塔影
  for (const s of [-1, 1]) {                             // 圣殿残柱（A3 东沿，净空随新半径外推）
    const [x, z] = expandXZ(A3C0, A3R0, A3C, A3R, 18.5, s * 5.2);
    farGeoms.push(boxG(1.3, 7.5, 1.3, x, 3.45, z, FAR.chapel, { jitter: 0.06 }));
  }
  { const [x, z] = expandXZ(A3C0, A3R0, A3C, A3R, 18.9, 0); farGeoms.push(boxG(9.5, 1.1, 1.5, x, 7.6, z, FAR.chapel, { rz: 0.06, jitter: 0.06 })); } // 断拱梁
  { const [x, z] = expandXZ(A3C0, A3R0, A3C, A3R, 18.7, -1.2); farGeoms.push(boxG(1.0, 1.0, 1.2, x, 8.6, z, FAR.teeth)); } // 梁上残块
  { const [x, z] = expandXZ(C2C0, C2R0, C2C, C2R, 74, -5.4); farGeoms.push(boxG(2.6, 6.5, 0.9, x, 3.0, z, FAR.crypt, { ry: 0.2 })); } // 监视者王座剪影 ×2
  { const [x, z] = expandXZ(C2C0, C2R0, C2C, C2R, 74.6, 5.0); farGeoms.push(boxG(2.2, 5.2, 0.9, x, 2.4, z, FAR.crypt, { ry: -0.15 })); }
  const watcher = (x: number, z: number, s: number, ry: number): void => {    // 监视者雕像剪影（Boss 房守望者主题前呼）
    const tone = 0x0c0f16, fx = Math.sin(ry), fz = Math.cos(ry);
    farGeoms.push(boxG(0.5 * s, 0.16 * s, 0.5 * s, x, 0.08 * s, z, tone, { ry }));                        // 基座
    farGeoms.push(boxG(0.6 * s, 2.2 * s, 0.52 * s, x, 1.16 * s, z, tone, { ry, jitter: 0.05 }));          // 长外套躯干
    farGeoms.push(boxG(0.34 * s, 0.36 * s, 0.38 * s, x, 2.42 * s, z, tone, { ry }));                      // 兜帽首
    farGeoms.push(boxG(0.055 * s, 2.7 * s, 0.1 * s, x + fx * 0.42 * s, 1.34 * s, z + fz * 0.42 * s, 0x0a0d13, { ry }));  // 拄地大剑
    farGeoms.push(boxG(0.3 * s, 0.06 * s, 0.16 * s, x + fx * 0.42 * s, 2.6 * s, z + fz * 0.42 * s, 0x0a0d13, { ry }));  // 剑格
  };
  { const [x, z] = expandXZ(C2C0, C2R0, C2C, C2R, 70.5, -13.5); watcher(x, z, 1.5, -Math.PI / 2); } // C2 东北崩塌豁口正中立影
  { const [x, z] = expandXZ(C2C0, C2R0, C2C, C2R, 78.5, 1.5); watcher(x, z, 1.2, -Math.PI / 2 + 0.2); }
  { const [x, z] = expandXZ(C2C0, C2R0, C2C, C2R, 71.5, 11.5); watcher(x, z, 0.95, -Math.PI / 2 - 0.3); }
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
  { const [x, z] = expandXZ(A3C0, A3R0, A3C, A3R, 5, 13); deadTree(x, z, 1.2, -0.12); }
  deadTree(36 + A3_DX, -12, 1.0, 0.1);
  { const [x, z] = expandXZ(C2C0, C2R0, C2C, C2R, 66, 13); deadTree(x, z, 1.15, -0.13); }
  root.add(batch(farGeoms, track(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: false })), "none"));

  // ---------------- 主石构 + 地面：按空间分 5 块合批（frustum 剔剪），共享 1 个顶点色材质 ----------------
  const stoneMat = track(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true, side: THREE.DoubleSide }));
  const structW: THREE.BufferGeometry[] = [];   // 西段：A1 台地 + A2 西径 + 墓苑 I + A2 中径
  const structE: THREE.BufferGeometry[] = [];   // 东段：墓苑 II + A2 东径 + 雾门 + A3 古达房 + 门 B
  const structC: THREE.BufferGeometry[] = [];   // C 区：法兰哨路 + 监视者厅
  const structD: THREE.BufferGeometry[] = [];   // D 区：碎星径 + 碎星战场（拉塔恩）
  const floorW: THREE.BufferGeometry[] = [];
  const floorE: THREE.BufferGeometry[] = [];

  // —— 火光件（先声明供各区使用）：余烬炭芯批 / 法兰冷蓝批 / 火盆 / 壁烛 ——
  // 雾门双火盆专用：穿雾仍是东向信标（本场景没有别的火苗 mesh）
  const flameMat0 = track(new THREE.MeshBasicMaterial({ color: 0xffc56a, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  const coalGeoms: THREE.BufferGeometry[] = [];         // 余烬炭芯（emissive 呼吸，A 区火盆/烛芯）
  const blueGeoms: THREE.BufferGeometry[] = [];         // 法兰冷蓝光芯（C 区灯笼/烛台/门 B 幽光，emissive 呼吸代灯）
  const purpleGeoms: THREE.BufferGeometry[] = [];       // 重力紫光裂（D 区陨石裂纹/紫徽，emissive 呼吸代灯）
  const flames: FlameRef[] = [];
  const glowLights: { light: THREE.PointLight; ph: number; base: number }[] = [];  // 小光源（烛龛/幽蓝门槛/王座），仅光强呼吸
  const haloGeoms: THREE.BufferGeometry[] = [];          // 冷蓝光晕片（灯龛/门槛/烛台，additive 合一批随 blue 批呼吸）
  const haloQ = (x: number, y: number, z: number, size: number, ry: number): void => {
    haloGeoms.push(new THREE.PlaneGeometry(size, size).rotateY(ry).translate(x, y, z));
  };
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

  /**
   * Boss 环墙。内侧面贴可走圆 walk=r−0.9，厚度只向外加。
   * 走廊口（|z|≤HALF）留同宽门洞。洞弧石楣从 barTop 接到墙顶，楣下铁栅贴同一半径，
   * 栅条从地面伸到石楣（高于头顶）。全程不调用 rnd，避免搅乱后面的确定性散布。
   */
  const arenaRing = (
    dst: THREE.BufferGeometry[],
    cx: number,
    walk: number,
    doors: ReadonlyArray<"east" | "west">,
    body: number,
    alt: number,
    capCol: number,
    wallH: number,
    thick: number,
    ruin: boolean,
  ): void => {
    const capH = 0.22;
    const barTop = 2.8;
    const barT = 0.14;
    const barW = 0.11;
    const phi = Math.asin(HALF / walk);
    const cuts: Array<[number, number]> = [];
    if (doors.includes("east")) cuts.push([-phi, phi]);
    if (doors.includes("west")) {
      cuts.push([-Math.PI, -Math.PI + phi]);
      cuts.push([Math.PI - phi, Math.PI]);
    }
    const remain = (a0: number, a1: number): Array<[number, number]> => {
      let parts: Array<[number, number]> = [[a0, a1]];
      for (const [c0, c1] of cuts) {
        const next: Array<[number, number]> = [];
        for (const [p0, p1] of parts) {
          if (p1 <= c0 || p0 >= c1) { next.push([p0, p1]); continue; }
          if (p0 < c0) next.push([p0, c0]);
          if (p1 > c1) next.push([c1, p1]);
        }
        parts = next;
      }
      return parts;
    };
    /** 切向长 len 的石块。内侧面在 walk（中心半径 = walk + t/2），radShift 只向外偏。 */
    const slab = (am: number, len: number, y0: number, h: number, tone: number, t: number, radShift = 0): void => {
      if (len < 0.05 || h <= 0.02) return;
      const rad = walk + t / 2 + radShift;
      dst.push(boxG(len, h, t, cx + Math.cos(am) * rad, y0 + h / 2, Math.sin(am) * rad, tone, { ry: -am + Math.PI / 2 }));
    };
    const chord = (a0: number, a1: number): number => 2 * walk * Math.sin((a1 - a0) / 2) - 0.02;
    const dA = 2.55 / (walk + thick / 2);
    let segI = 0;
    for (let a0 = -Math.PI; a0 < Math.PI - 1e-8;) {
      const a1 = Math.min(Math.PI, a0 + dA);
      const h = ruin ? wallH + (segI % 7) * 0.16 : wallH;
      const tone = segI % 5 === 0 ? alt : body;
      for (const [b0, b1] of remain(a0, a1)) {
        const len = chord(b0, b1);
        const am = (b0 + b1) / 2;
        slab(am, len, 0, h - capH, tone, thick);
        slab(am, len, h - capH, capH, capCol, thick);
        if (!ruin && b1 - b0 > dA * 0.86 && segI % 2 === 0) slab(am, 0.56, h, 0.46, capCol, thick);
      }
      segI++;
      a0 = a1;
    }
    // 门洞按中线整段铺。奇数根栅，正中一根压在走廊中线上——西口若从 ±π 劈开，中线会漏一条空缝。
    const grateDoor = (mid: number, half: number): void => {
      let n = Math.max(3, Math.round((walk * 2 * half) / 0.3));
      if (n % 2 === 0) n += 1;
      const step = (2 * half) / n;
      for (let i = 0; i < n; i++) slab(mid - half + step * (i + 0.5), barW, 0, barTop, PAL.steel, barT);
      const piece = Math.min(dA, 2 * half);
      for (let t = -half; t < half - 1e-8;) {
        const t1 = Math.min(half, t + piece);
        const am = mid + (t + t1) / 2;
        const len = 2 * walk * Math.sin((t1 - t) / 2) - 0.015;
        slab(am, len, 1.22, 0.08, PAL.steel, barT, 0.015);
        slab(am, len, barTop - 0.08, 0.08, PAL.steel, barT, 0.015);
        slab(am, len, barTop, wallH - barTop - capH, body, thick);
        slab(am, len, wallH - capH, capH, capCol, thick);
        t = t1;
      }
    };
    if (doors.includes("east")) grateDoor(0, phi);
    if (doors.includes("west")) grateDoor(Math.PI, phi);
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
      glowLights.push({ light, ph: 1.1, base: 4.5 });
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

  // —— A3 古达 Boss 房（r17，c=3.5，可走 32.2）：环墙内侧面贴可走圆 16.1，西雾门/东门 B 留走廊宽门洞 ——
  {
    const E = structE, cx = A3C;
    arenaRing(E, cx, A3R - 0.9, ["west", "east"], PAL.stoneDark, PAL.stone, PAL.stoneMid, 4, 1.05, false);
    const colR = (A3R - 0.9) + 1.25;                     // 残柱让到环墙外皮之外，不再从内侧面戳进可走圆
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * Math.PI * 2 + 0.28;
      if (Math.abs(Math.cos(a)) > 0.86) continue;        // 让开东西两口（雾门/门 B）
      const x = cx + Math.cos(a) * colR, z = Math.sin(a) * colR;
      const h = 1.5 + ((i * 7919) % 100) / 100 * 2.0;
      E.push(boxG(0.85, 0.26, 0.85, x, 0.13, z, PAL.stoneMid, { jitter: 0.08 }));
      E.push(cylG(0.3, 0.35, h, 9, x, 0.26 + h / 2, z, PAL.stone, { jitter: 0.1 }));
      E.push(boxG(0.56, 0.34, 0.56, x, 0.36 + h, z, PAL.stoneMid, { ry: rnd() * 3, rz: rr(-0.08, 0.08), jitter: 0.1 }));
    }
    for (let i = 0; i < 16; i++) {                       // 外环墓群（墙界之外）
      const a = (i / 16) * Math.PI * 2 + 0.22;
      if (Math.abs(Math.cos(a)) > 0.82) continue;
      grave(E, cx + Math.cos(a) * rr(A3R + 1.5, A3R + 4.5), Math.sin(a) * rr(A3R + 1.5, A3R + 4.5));
    }
    rubble(E, cx + 3.5, -4.8, 0.7, 7); rubble(E, cx - 4.6, 5.2, 0.6, 6); rubble(E, cx + 6.8, 2.2, 0.6, 5);
    // 门 B（A 区东界 → C 区）：沉重黑拱 + 幽蓝门槛——「坠入深处」的门洞（进出无碰撞，深处由主线程 zoneUnlocks 把关）
    for (const s of [-1, 1]) {
      E.push(boxG(1.6, 1.0, 1.7, DOOR_B + 0.1, 0.5, s * 2.55, PAL.cryptDeep, { jitter: 0.08 }));      // 外扩沉底基座
      E.push(boxG(1.15, 4.7, 1.15, DOOR_B + 0.15, 3.3, s * 2.08, PAL.cryptMid, { jitter: 0.07 }));    // 主门墩（高拔沉重）
      E.push(boxG(1.5, 0.3, 1.5, DOOR_B + 0.15, 5.8, s * 2.08, PAL.crypt));                           // 墩冠
      E.push(boxG(0.62, 4.0, 0.5, DOOR_B - 0.1, 2.0, s * 2.28, PAL.cryptDark, { jitter: 0.06 }));     // 内衬门颊（收口）
      for (let k = 0; k < 3; k++)                                                                     // 门颊断垂链
        E.push(boxG(0.045, 0.15, 0.045, DOOR_B + 0.28, 3.4 - k * 0.14, s * 1.66, PAL.steel, { rz: k % 2 ? 0.45 : -0.45 }));
    }
    E.push(boxG(1.35, 0.64, 5.6, DOOR_B + 0.15, 6.2, 0, PAL.cryptMid, { rz: 0.015, jitter: 0.07 }));  // 主楣
    E.push(boxG(1.05, 1.15, 4.5, DOOR_B + 0.15, 7.05, 0, PAL.cryptDark, { jitter: 0.08 }));           // 楣上堵墙
    E.push(boxG(1.65, 0.32, 6.0, DOOR_B + 0.15, 7.75, 0, PAL.crypt));                                 // 顶冠板
    E.push(boxG(0.6, 0.55, 0.6, DOOR_B + 0.1, 8.15, -1.1, PAL.cryptMid, { ry: 0.4, rz: 0.15 }));      // 冠上残块 ×2
    E.push(boxG(0.55, 0.5, 0.55, DOOR_B + 0.2, 8.05, 1.3, PAL.cryptMid, { ry: 0.8, rz: -0.1 }));
    E.push(boxG(0.7, 4.1, 3.75, DOOR_B + 0.5, 2.05, 0, PAL.cryptDeep));                               // 拱腔衬壁
    E.push(boxG(0.5, 3.7, 3.35, DOOR_B + 0.74, 1.85, 0, 0x0a0c10));                                   // 拱内黑洞（近黑）
    blueGeoms.push(boxG(0.14, 3.4, 3.15, DOOR_B + 0.98, 1.7, 0, 0x000000));                           // 门洞幽蓝竖光（蓝批）
    blueGeoms.push(boxG(1.6, 0.05, 3.5, DOOR_B + 0.6, 0.03, 0, 0x000000));                            // 门槛地面幽光带（蓝批）
    haloQ(DOOR_B + 0.86, 1.8, 0, 2.7, -Math.PI / 2);                                                  // 门槛光晕（西望可见，halo 批）
    {
      const light = new THREE.PointLight(0x4a6f94, 2.6, 7, 2);       // 门槛幽蓝微光（场景第 4 盏 ≤5 预算）
      light.position.set(DOOR_B + 1.3, 1.6, 0);
      root.add(light);
      glowLights.push({ light, ph: 2.3, base: 2.6 });
    }
    rubble(E, DOOR_B - 0.9, 2.9, 0.5, 4); rubble(E, DOOR_B - 0.6, -3.0, 0.45, 3);                     // 门前塌落碎石
  }

  // —— C1 法兰哨路（门 B..C2 西鼻，36m 下沉暗廊，整段随 A3 东移）：墙沿 x 渐高、压顶横梁渐低、地面渐暗、缝光渐弱 ——
  {
    const C = structC;
    const X0 = DOOR_B + 0.4, X1 = C2_W - 0.4;
    /** 深度系数：0=门 B（地平）→ 1=C2 口（沉底）——纯视觉表达，不改逻辑 y */
    const depth = (x: number): number => Math.min(1, Math.max(0, (x - X0) / (X1 - X0)));
    // —— 两侧墙体：下段整石（3.4→4.9m）+ 上段高墙影（+1.5→+3.7m）——总高 4.9→8.6m，越走越像沉入壑底 ——
    for (const s of [-1, 1]) {
      let x = X0;
      while (x < X1 - 0.01) {
        const seg = Math.min(rr(3.8, 5.6), X1 - x);
        const mx = x + seg / 2, d = depth(mx);
        const h = 3.4 + d * 1.5 + rr(-0.1, 0.16);
        C.push(boxG(seg - 0.08, h, 0.62, mx, h / 2, s * WALL_Z, mix(PAL.cryptDark, PAL.cryptDeep, d * 0.75), { jitter: 0.09 }));
        C.push(boxG(seg, 0.22, 0.88, mx, h + 0.11, s * WALL_Z, PAL.cryptMid));        // 压顶
        if (rnd() < 0.4)                                                              // 塌落墙冠
          C.push(boxG(seg * rr(0.22, 0.45), rr(0.5, 1.1), 0.5, x + seg * rr(0.25, 0.75), h + 0.5, s * (WALL_Z - 0.06), PAL.cryptMid, { ry: rnd() * 0.4, jitter: 0.12 }));
        const hu = 1.5 + d * 2.2 + rr(0, 0.7);                                        // 上段墙影（更高一层剪影）
        C.push(boxG(seg - rr(0.4, 1.2), hu, 0.42, mx, h + 0.2 + hu / 2, s * (WALL_Z + 0.32), PAL.cryptDeep, { jitter: 0.1 }));
        if (rnd() < 0.5)                                                              // 上段残垛天际线
          C.push(boxG(rr(0.5, 0.9), rr(0.4, 0.9), 0.4, x + rr(seg * 0.15, seg * 0.85), h + 0.2 + hu + rr(0.2, 0.55), s * (WALL_Z + 0.32), PAL.cryptMid, { jitter: 0.14 }));
        x += seg;
      }
      // 外侧扶壁 + 箭缝暗龛（缝内幽蓝越走越弱、东段过半熄灭——深处的窗不再透光）
      for (let bx = X0 + 1.2; bx < X1 - 0.6; bx += rr(2.8, 3.6)) {
        const d = depth(bx), bh = 3.6 + d * 1.6;
        C.push(boxG(0.7, bh, 1.1, bx, bh / 2, s * (WALL_Z + 0.62), PAL.cryptDeep, { jitter: 0.08 }));
        C.push(boxG(0.16, 0.8, 0.14, bx, 3.02, s * 2.94, PAL.cryptDeep));
        if (rnd() < 0.92 - d * 0.62)
          blueGeoms.push(boxG(0.05, 0.62 * (1 - d * 0.4), 0.1, bx, 3.02, s * 2.88, 0x000000));
      }
    }
    // —— 压顶横梁：底高 3.95→3.60 渐压渐低（坠入深处的窒息感；底高全程高于跟背相机 y≈3.42
    //    + near 0.1 余量，仅遮挡取景不穿模——highwall 断梁同口径）+ 梁上残块 / 垂链 ——
    for (let bx = X0 + 3.4; bx < X1 - 1.6; bx += rr(6.2, 8.2)) {
      const y = 3.95 - depth(bx) * 0.35 + rr(-0.05, 0.05);
      C.push(boxG(0.66, 0.44, 6.15, bx, y + 0.22, 0, PAL.cryptDeep, { ry: rr(-0.05, 0.05), jitter: 0.08 }));
      C.push(boxG(0.74, 0.16, 6.3, bx, y + 0.5, 0, PAL.cryptMid));                    // 梁上沿
      if (rnd() < 0.55)                                                               // 梁下垂链三环
        for (let k = 0; k < 3; k++)
          C.push(boxG(0.045, 0.15, 0.045, bx + rr(-0.2, 0.2), y - 0.1 - k * 0.13, rr(-1.4, 1.4), PAL.steel, { rz: k % 2 ? 0.45 : -0.45 }));
      if (rnd() < 0.4)                                                                // 梁上残块
        C.push(boxG(rr(0.5, 0.9), rr(0.25, 0.45), 0.6, bx + rr(-0.3, 0.3), y + 0.85, rr(-1.8, 1.8), PAL.cryptMid, { ry: rnd() * 3, jitter: 0.12 }));
    }
    // —— 壁挂蓝灯笼龛 ×4（法兰冷蓝）：影盒龛 + 三环吊链 + 悬灯 + 光晕（halo 批）+ 龛下湿痕 ——
    const lantern = (x: number, s: number): void => {
      C.push(boxG(1.06, 1.66, 0.1, x, 2.6, s * 3.04, 0x0a0c10, { jitter: 0.05 }));    // 龛底暗背板（影盒）
      C.push(boxG(0.16, 1.52, 0.34, x - 0.56, 2.6, s * 2.88, PAL.cryptMid, { jitter: 0.08 }));  // 龛柱 ×2
      C.push(boxG(0.16, 1.52, 0.34, x + 0.56, 2.6, s * 2.88, PAL.cryptMid, { jitter: 0.08 }));
      C.push(boxG(1.32, 0.2, 0.4, x, 3.44, s * 2.88, PAL.cryptMid));                  // 龛楣
      C.push(boxG(1.36, 0.32, 0.3, x, 1.72, s * 2.88, PAL.cryptDeep, { jitter: 0.1 }));// 龛下哑座
      for (let k = 0; k < 3; k++)                                                     // 三环吊链
        C.push(boxG(0.05, 0.14, 0.05, x, 3.24 - k * 0.13, s * 2.84, PAL.steel, { rz: k % 2 ? 0.5 : -0.5 }));
      C.push(boxG(0.3, 0.07, 0.3, x, 2.86, s * 2.84, PAL.cryptDeep));                 // 灯顶盖
      C.push(boxG(0.24, 0.36, 0.24, x, 2.64, s * 2.84, PAL.cryptDeep, { jitter: 0.06 }));  // 灯笼笼身
      C.push(boxG(0.13, 0.1, 0.13, x, 2.42, s * 2.84, PAL.cryptDeep));                // 灯底尖
      blueGeoms.push(boxG(0.17, 0.27, 0.17, x, 2.63, s * 2.81, 0x000000));            // 冷蓝光芯（蓝批呼吸）
      haloQ(x, 2.62, s * 2.76, 1.15, s > 0 ? Math.PI : 0);                            // 光晕（halo 批）
      mossPatch(C, x - 0.55, x + 0.55, s, 0.95, 2.935);                               // 龛下湿痕
    };
    lantern(15 + A3_DX, 1); lantern(23 + A3_DX, -1); lantern(31 + A3_DX, 1); lantern(39 + A3_DX, -1);
    // —— 法兰残旗 ×2：撕裂多边形 + 湿重下垂（顶点色做旧渐变，静态并入石构批）——
    const banner = (x: number, s: number): void => {
      C.push(cylG(0.045, 0.06, 5.2, 7, x, 2.6, s * 3.05, 0x2c2620, { rz: rr(-0.05, 0.05), jitter: 0.1 }));
      C.push(cylG(0.03, 0.03, 1.15, 5, x, 4.75, s * 2.62, 0x2c2620, { rx: Math.PI / 2, ry: s * 0.35 }));
      const fg = tatteredBanner(0.85, rr(1.25, 1.6), s > 0 ? PAL.bannerBlue : PAL.bannerBlueB, PAL.bannerFade);
      if (s > 0) fg.rotateY(Math.PI);                                                 // 垂坠方向统一朝墙侧
      fg.rotateY(rr(-0.12, 0.12));
      fg.translate(x, 4.68, s * 2.44);
      C.push(fg);
    };
    banner(19 + A3_DX, 1); banner(35 + A3_DX, -1);
    // —— 骨堆叙事：乱骨+颅骨加密（监视者的旧部）——
    const bones = (x: number, s: number): void => {
      for (let i = 0; i < 8; i++)
        C.push(boxG(rr(0.06, 0.17), rr(0.05, 0.12), rr(0.06, 0.15), x + rr(-0.75, 0.75), 0.07, s * rr(2.0, 2.8), PAL.bone, { ry: rnd() * 3, rz: rnd() * 3, jitter: 0.15 }));
      C.push(dodG(rr(0.16, 0.24), x, 0.16, s * 2.35, PAL.bone, { ry: rnd() * 3 }));
      C.push(boxG(0.16, 0.13, 0.15, x + rr(-0.5, 0.5), 0.1, s * rr(2.1, 2.6), PAL.bone, { ry: rnd() * 3 }));   // 颅骨
    };
    bones(12.5 + A3_DX, -1); bones(27 + A3_DX, 1); bones(33.5 + A3_DX, -1); bones(43 + A3_DX, 1);
    // —— 盔甲残骸（盾/矛/盔/断剑散件，合批剪影）——
    const armor = (x: number, s: number): void => {
      C.push(cylG(0.3, 0.3, 0.05, 10, x, 0.3, s * 2.6, 0x2b2f37, { rx: Math.PI / 2 - 0.3, ry: rnd() * 3 }));    // 倚墙圆盾
      C.push(cylG(0.34, 0.34, 0.04, 10, x, 0.33, s * 2.62, 0x232730, { rx: Math.PI / 2 - 0.3, ry: rnd() * 3 }));// 盾缘
      C.push(cylG(0.022, 0.03, 2.5, 6, x + 0.45, 1.1, s * 2.5, 0x2c2620, { rz: 0.42 }));                         // 斜倚长矛
      C.push(boxG(0.07, 0.3, 0.07, x + 0.94, 2.24, s * 2.32, PAL.steel, { rz: 0.42 }));                          // 矛尖
      C.push(boxG(0.2, 0.15, 0.2, x - 0.5, 0.09, s * 2.3, 0x2b2f37, { ry: rnd() * 3, rz: 0.2 }));                // 滚落头盔
      C.push(boxG(0.05, rr(0.5, 0.8), 0.02, x + rr(-0.8, 0.8), 0.28, s * rr(2.2, 2.7), PAL.steel, { ry: rnd() * 3, rz: rr(0.3, 0.7) }));  // 断剑
    };
    armor(21.5 + A3_DX, -1); armor(37 + A3_DX, 1);
    // —— 路缘「深渊凝视者」跪尸（低模剪影批：跪伏躬身，面朝深处）——
    const kneeler = (x: number, z: number, ry: number): void => {
      const tone = 0x191c23, fx = Math.sin(ry), fz = Math.cos(ry);
      C.push(boxG(0.46, 0.13, 0.66, x, 0.065, z, tone, { ry, jitter: 0.1 }));                     // 后折小腿
      C.push(boxG(0.32, 0.55, 0.36, x + fx * 0.1, 0.36, z + fz * 0.1, tone, { ry, rx: 0.62 }));   // 深躬躯干
      C.push(boxG(0.2, 0.2, 0.22, x + fx * 0.3, 0.62, z + fz * 0.3, tone, { ry, rx: 0.85 }));     // 低垂的头
      C.push(boxG(0.08, 0.42, 0.08, x + fz * 0.16 + fx * 0.26, 0.28, z - fx * 0.16 + fz * 0.26, tone, { ry, rz: 0.35 }));  // 撑地手臂 ×2
      C.push(boxG(0.08, 0.42, 0.08, x - fz * 0.16 + fx * 0.26, 0.28, z + fx * 0.16 + fz * 0.26, tone, { ry, rz: -0.35 }));
    };
    kneeler(17.8 + A3_DX, -2.25, Math.PI / 2 + 0.18);
    kneeler(38.4 + A3_DX, 2.3, Math.PI / 2 - 0.24);
    rubble(C, 21 + A3_DX, -1.8, 0.55, 5); rubble(C, 41.5 + A3_DX, 1.9, 0.5, 4);
    mossPatch(C, X0 + 1.2, X0 + 4.6, -1, 1.15, 2.935);                                // 墙脚苔纹湿痕 ×3
    mossPatch(C, 28.6 + A3_DX, 32.4 + A3_DX, 1, 1.3, 2.935);
    mossPatch(C, X1 - 5.2, X1 - 1.6, -1, 1.0, 2.935);
  }

  // —— C2 监视者 Boss 房（r19，c=74，可走 36.2）：环墙内侧面贴可走圆 18.1，西哨路/东碎星径留走廊宽门洞 ——
  {
    const C = structC, cx = C2C;
    arenaRing(C, cx, C2R - 0.9, ["west", "east"], PAL.crypt, PAL.cryptDark, PAL.cryptMid, 4.2, 0.85, false);
    const obeliskR = (C2R - 0.9) - 1.45;                // 尖碑退到墙内，不穿可走圆上的环墙
    for (let i = 0; i < 10; i++) {                       // 尖碑环（让开西口；朝场一面刻法兰符文 emissive）
      const a = (i / 10) * Math.PI * 2 + 0.31;
      if (Math.cos(a) > 0.86) continue;
      const x = cx + Math.cos(a) * obeliskR, z = Math.sin(a) * obeliskR;
      const h = 2.2 + ((i * 7919) % 100) / 100 * 1.3;
      const ry0 = -a + Math.PI / 2;                      // 碑身切向对齐（符文面贴实）
      const sd = rr(0.35, 0.5);
      C.push(boxG(rr(0.5, 0.7), 0.3, rr(0.5, 0.7), x, 0.15, z, PAL.cryptMid, { ry: rnd() * 3, jitter: 0.1 }));
      C.push(boxG(rr(0.4, 0.55), h, sd, x, 0.3 + h / 2, z, pick([PAL.crypt, PAL.cryptMid, PAL.cryptDark]), { ry: ry0 + rr(-0.06, 0.06), rz: rr(-0.06, 0.06), jitter: 0.12 }));
      if (rnd() < 0.5) C.push(coneG(0.22, rr(0.3, 0.6), 4, x, 0.3 + h + 0.2, z, PAL.cryptDark, { ry: rnd() * 3 }));  // 尖顶残段
      for (let k = 0; k < 2 + (i % 2); k++)              // 符文刻痕（蓝批呼吸，逐碑错位）
        blueGeoms.push(boxG(rr(0.05, 0.1), rr(0.18, 0.4), 0.05,
          x - Math.cos(a) * (sd / 2 + 0.028), 0.85 + k * 0.62 + rnd() * 0.2, z - Math.sin(a) * (sd / 2 + 0.028), 0x000000, { ry: ry0 }));
    }
    // 外裙残墙（仍在环墙外侧 r+0.45，不担任可走圆边界）。东口会切进碎星径的那几段拨到廊墙外。
    const RIM = C2R + 0.45, moonA = -0.59, doorA = Math.atan2(-13.2, 2.2);
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + 0.09;
      if (Math.cos(a) < -0.82) continue;                                     // 让开西口（走廊衔接）
      if (Math.abs(a - doorA) < 0.36) continue;                              // 让开南侧封门位
      const brk = Math.abs(a - moonA) < 0.42;                                // 崩塌豁口段（冷月方位）
      if (brk && rnd() < 0.7) continue;                                      // 豁口仅存残牙
      let placeA = a;
      if (Math.cos(a) > 0.5 && Math.abs(Math.sin(a) * RIM) < HALF + 1.2) {
        const s = Math.sin(a) < 0 ? -1 : 1;
        placeA = s * Math.asin((HALF + 2.6) / RIM);                          // 3m 宽的残段不要横在东走廊里
      }
      const h = brk ? rr(0.5, 1.1) : rr(2.0, 3.1);
      C.push(boxG(3.0, h, 0.55, cx + Math.cos(placeA) * RIM, h / 2, Math.sin(placeA) * RIM, pick([PAL.cryptDark, PAL.cryptDeep]), { ry: -placeA + Math.PI / 2 + rr(-0.07, 0.07), rz: brk ? rr(-0.1, 0.1) : rr(-0.03, 0.03), jitter: 0.1 }));
      if (!brk && rnd() < 0.45) {                                            // 墙头残垛（顶高 ≤3.35 常态低于跟背相机）
        const mh = rr(0.35, 0.6);
        C.push(boxG(0.6, mh, 0.45, cx + Math.cos(placeA) * (RIM - 0.05), h + 0.15 + mh / 2, Math.sin(placeA) * (RIM - 0.05), PAL.cryptMid, { ry: -placeA + Math.PI / 2, jitter: 0.14 }));
      }
    }
    rubble(C, cx + Math.cos(moonA) * (RIM - 1.95), Math.sin(moonA) * (RIM - 1.95), 0.85, 7); // 豁口内侧塌落碎石（环内 1.95m，同旧 12.45-10.5）
    // —— 东沿断王座：三层仪式台阶 + 高背主座 + 两侧残座 + 散落王冠 + 剑冢插地（贴新东沿）——
    const TX = cx + (C2R - 0.9) - 3.55;                  // 靠背东面停在可走圆内侧，东口铁栅不穿王座
    C.push(boxG(6.6, 0.2, 7.8, TX - 0.5, 0.1, 0, PAL.cryptMid, { jitter: 0.07 }));       // 一层台
    C.push(boxG(5.4, 0.2, 6.0, TX + 0.2, 0.3, 0, PAL.cryptMid, { jitter: 0.07 }));       // 二层台
    C.push(boxG(4.2, 0.22, 4.3, TX + 0.9, 0.5, 0, PAL.crypt, { jitter: 0.07 }));         // 三层台
    C.push(boxG(1.65, 0.55, 1.5, TX + 1.9, 0.88, 0, PAL.cryptMid));                      // 座石
    C.push(boxG(1.5, 3.2, 0.52, TX + 2.55, 2.52, 0, PAL.cryptDark, { rz: -0.025, jitter: 0.09 }));  // 高靠背
    C.push(boxG(0.95, 0.72, 0.42, TX + 2.5, 4.2, 0, PAL.cryptMid, { ry: 0.05 }));        // 背顶残冠
    blueGeoms.push(boxG(0.06, 1.7, 0.1, TX + 2.27, 2.5, 0, 0x000000));                   // 靠背符文刻痕
    for (const s of [-1, 1]) {                                                           // 扶手 ×2
      C.push(boxG(0.52, 0.6, 1.3, TX + 1.9, 1.42, s * 0.86, PAL.cryptMid, { jitter: 0.06 }));
      C.push(boxG(0.58, 0.16, 1.42, TX + 1.9, 1.76, s * 0.86, PAL.crypt));
    }
    for (const s of [-1, 1]) {                                                           // 两侧半塌残座
      const z = s * 3.5;
      C.push(boxG(1.4, 0.5, 1.25, TX + 0.7, 0.72, z, PAL.cryptMid, { jitter: 0.08 }));
      C.push(boxG(1.3, rr(1.7, 2.3), 0.5, TX + 1.2, 1.75, z, PAL.cryptDark, { rz: s * 0.09, jitter: 0.1 }));
      if (rnd() < 0.7) C.push(boxG(0.5, rr(0.6, 1.1), 0.4, TX + 1.15, rr(1.2, 1.9), z + rr(-0.4, 0.4), PAL.cryptMid, { ry: rnd() * 3 }));
    }
    const crown = (x: number, y: number, z: number): void => {                           // 散落王冠（暗金做旧）
      C.push(cylG(0.16, 0.175, 0.1, 9, x, y + 0.05, z, 0x39331f));
      for (let k = 0; k < 5; k++) {
        const ca = (k / 5) * Math.PI * 2 + 0.4;
        C.push(coneG(0.03, 0.1, 4, x + Math.cos(ca) * 0.15, y + 0.12, z + Math.sin(ca) * 0.15, 0x453d29));
      }
    };
    crown(TX - 1.1, 0.61, 1.9);                                                          // 三层台上滚落的王冠
    crown(TX - 2.6, 0.0, -1.2);                                                          // 剑冢旁半埋的王冠
    const sword = (x: number, z: number, ry: number, leanX: boolean, tilt: number, len: number): void => {  // 剑冢：插地断剑
      const dx = leanX ? -Math.sin(tilt) * len / 2 : 0, dz = leanX ? 0 : Math.sin(tilt) * len / 2;
      C.push(boxG(0.055, len, 0.02, x + dx, Math.cos(tilt) * len / 2, z + dz, 0x33383f, { ry, rz: leanX ? tilt : 0, rx: leanX ? 0 : tilt }));
      if (len > 0.55)
        C.push(boxG(0.24, 0.045, 0.05, x + dx * 1.5, Math.cos(tilt) * len * 0.76, z + dz * 1.5, 0x2c3038, { ry, rz: leanX ? tilt : 0, rx: leanX ? 0 : tilt }));
    };
    for (const [dx, sz, ry, leanX, tilt, len] of [
      [-3.5, -2.5, 0.4, 0, 0.28, 1.05], [-2.6, -1.5, 1.2, 1, 0.22, 0.9], [-3.7, -0.4, 2.2, 0, 0.38, 1.2],
      [-2.1, 0.6, 0.8, 1, 0.3, 0.85], [-3.3, 1.7, 2.8, 0, 0.2, 1.0], [-1.8, 2.6, 1.9, 1, 0.42, 0.7],
      [-4.5, 0.9, 0.1, 0, 0.5, 0.6], [-1.4, -0.9, 1.5, 1, 0.55, 0.4], [-3.9, 2.4, 2.5, 0, 0.15, 0.95],
    ] as const) sword(TX + dx, sz, ry, leanX === 1, tilt, len);   // 相对旧座石 TX=66.7 的偏移，跟着新东沿走
    const candelabra = (a: number): void => {            // 蓝烛台（三脚 + 光芯 + 光晕；旧 r-1.6，仍在可走边内侧 0.7m）
      const x = cx + Math.cos(a) * (C2R - 1.6), z = Math.sin(a) * (C2R - 1.6);
      for (let i = 0; i < 3; i++) {
        const la = (i / 3) * Math.PI * 2 + 0.5;
        C.push(cylG(0.03, 0.04, 1.2, 5, x + Math.cos(la) * 0.2, 0.58, z + Math.sin(la) * 0.2, PAL.bone, { ry: -la, rz: 0.22 }));
      }
      C.push(cylG(0.3, 0.16, 0.22, 8, x, 1.24, z, PAL.cryptDeep));
      blueGeoms.push(dodG(0.15, x, 1.38, z, 0x000000));
      haloQ(x, 1.34, z, 0.85, Math.atan2(-Math.cos(a), -Math.sin(a)));                  // 光晕朝场心
    };
    candelabra(2.2); candelabra(3.6); candelabra(4.9);
    {
      const light = new THREE.PointLight(0x4a6f94, 2.2, 8, 2);   // 王座幽蓝微光（场景第 5 盏 ≤5 预算）
      light.position.set(TX + 1.2, 2.6, 0);
      root.add(light);
      glowLights.push({ light, ph: 4.1, base: 2.2 });
    }
    const doorS = RIM / (C2R0 + 0.45);                   // 南缘封门沿同一射线贴到新环外（旧环 12.45）
    C.push(boxG(2.0, 2.4, 0.6, cx + 2.2 * doorS, 1.2, -13.2 * doorS, PAL.cryptMid, { ry: 0.3, jitter: 0.1 }));   // 南缘封死侧门（监视者胜后的 C2→A2 捷径位，T6 开）
    C.push(boxG(1.4, 1.8, 0.4, cx + 2.0 * doorS, 0.9, -13.5 * doorS, PAL.cryptDeep, { ry: 0.3 }));
    rubble(C, cx - 4.5, -6.2, 0.6, 6); rubble(C, cx + 5.5, 6.5, 0.6, 6); rubble(C, cx - 7.5, 3.5, 0.5, 5);
  }

  // —— 地面：台地/石板长卷/墓苑/竞技场环纹/暗廊/王座厅 + 大地（receive 批，西/东两分块） ——
  {
    const W = floorW, E = floorE;
    W.push(boxG(110, 0.12, 74, -91, -0.07, 0, 0x14161b, { jitter: 0.05 }));              // 大地·西半（远景基面）
    const gX0 = -36, gX1 = D2C + D2R + 24;                                              // 东半铺过拉塔恩圆边，相机在可走边外仍踩得到地
    E.push(boxG(gX1 - gX0, 0.12, (D2R + 24) * 2, (gX0 + gX1) / 2, -0.07, 0, 0x14161b, { jitter: 0.05 })); // 大地·东半
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
    E.push(paint(new THREE.CircleGeometry(A3R + 0.2, 48).rotateX(-Math.PI / 2).translate(A3C, 0.001, 0), COLORS.ground, 0.05));  // A3 场地（旧 r+0.2）
    E.push(paint(new THREE.RingGeometry(2.6 * A3k, 3.0 * A3k, 44).rotateX(-Math.PI / 2).translate(A3C, 0.012, 0), 0x1c2026, 0.06));     // A3 环纹 ×2
    E.push(paint(new THREE.RingGeometry(8.4 * A3k, 8.9 * A3k, 44).rotateX(-Math.PI / 2).translate(A3C, 0.014, 0), 0x1b1f24, 0.06));
    W.push(paint(new THREE.CircleGeometry(1.0, 20).rotateX(-Math.PI / 2).translate(-140.5, 0.015, 0), PAL.ash, 0.12));      // 篝火灰圈
    {   // C1 暗廊石板：沿 x 色板渐沉（cryptPath→近黑），偶发塌陷缺板露出暗床——越走越深的地面
      let i = 0;
      for (let x = DOOR_B + 0.3; x < C2_W - 0.2; x += 1.15) {
        const d = Math.min(1, Math.max(0, (x - DOOR_B - 0.3) / (C2_W - 0.5 - DOOR_B)));
        if (rnd() < 0.05) { i++; continue; }             // 缺板（塌陷裸床）
        E.push(boxG(1.06, 0.07, 5.9, x + 0.53, 0.004 + (i % 2) * 0.004, rr(-0.02, 0.02), mix(PAL.cryptPath, 0x15171d, d * 0.85), { jitter: 0.07 }));
        i++;
      }
    }
    E.push(paint(new THREE.CircleGeometry(C2R + 0.2, 48).rotateX(-Math.PI / 2).translate(C2C, 0.001, 0), 0x191c22, 0.05));       // C2 场地（旧 r+0.2）
    E.push(paint(new THREE.RingGeometry(3.1 * C2k, 3.55 * C2k, 44).rotateX(-Math.PI / 2).translate(C2C, 0.012, 0), 0x232a38, 0.07));    // C2 深蓝徽环（法兰纹）
    E.push(paint(new THREE.RingGeometry(9.0 * C2k, 9.4 * C2k, 44).rotateX(-Math.PI / 2).translate(C2C, 0.014, 0), 0x1d2129, 0.06));
    for (const [px, pz] of [[14 + A3_DX, 1.9], [22 + A3_DX, -2.0], [30 + A3_DX, 1.8], [38 + A3_DX, -1.9], [44 + A3_DX, 1.2], [C2C - 6, -5.5], [C2C + 2, 6.2], [C2C + 7.5, -3.0]] as const)
      E.push(paint(new THREE.CircleGeometry(rr(0.55, 1.1), 14).rotateX(-Math.PI / 2).translate(px, 0.021, pz), 0x1b222b, 0.1));   // 病沼湿痕（冷青暗斑）
    // —— D 区地板：碎星径荒灰石板（焦红渐入）+ D2 战场场地/陨坑焦痕/重力紫徽环 ——
    {
      let i = 0;
      for (let x = C2_E + 0.2; x < D2_W - 0.2; x += 1.15) {
        const d = Math.min(1, Math.max(0, (x - C2_E) / (D2_W - C2_E)));
        E.push(boxG(1.06, 0.07, 5.9, x + 0.53, 0.004 + (i % 2) * 0.004, rr(-0.02, 0.02), mix(0x282226, 0x1e1a1c, d), { jitter: 0.07 }));
        i++;
      }
      E.push(paint(new THREE.CircleGeometry(D2R + 0.2, 64).rotateX(-Math.PI / 2).translate(D2C, 0.001, 0), 0x1b181c, 0.05));      // D2 战场场地铺到新圆边（旧 r+0.2）
      E.push(paint(new THREE.RingGeometry(4.2 * D2k, 4.8 * D2k, 64).rotateX(-Math.PI / 2).translate(D2C, 0.012, 0), 0x2e2440, 0.08));    // 重力紫徽环（拉塔恩纹）
      E.push(paint(new THREE.RingGeometry(10.6 * D2k, 11.2 * D2k, 64).rotateX(-Math.PI / 2).translate(D2C, 0.014, 0), 0x231d28, 0.07));
      for (const [ox, oz, cr] of [[-6.5, -5.0, 2.2], [5.5, 4.5, 1.7], [2.0, -8.0, 1.2], [-3.0, 8.0, 0.9]] as const) {   // 陨坑焦痕 ×4，按新半径铺开
        const cx2 = D2C + ox * D2k, cz2 = oz * D2k, rk = cr * D2k;
        E.push(paint(new THREE.CircleGeometry(rk, 24).rotateX(-Math.PI / 2).translate(cx2, 0.02, cz2), 0x121014, 0.16));
        E.push(paint(new THREE.RingGeometry(rk, rk + 0.35 * D2k, 24).rotateX(-Math.PI / 2).translate(cx2, 0.022, cz2), 0x241d20, 0.12));
      }
    }
  }

  // —— D 区石构（碎星战场：C2 东口塌方 → 荒径 → r91 战场；剑冢+陨石+断柱，重力紫 shard 走独立 emissive 批） ——
  {
    const D = structD;
    // D1 荒径墙体（碎星径：残墙更矮更破——被「星坠」砸过的痕迹）
    wallRun(D, C2_E + 0.2, D2_W - 0.3, 1.7, 2.4);
    // C2 东口塌方过渡：豁口巨石 + 探出的断梁
    D.push(dodG(1.6, C2_E + 0.2, 0.8, -1.6, PAL.stoneDeep, { ry: 0.5 }));
    D.push(dodG(1.1, C2_E + 0.7, 0.5, 1.9, PAL.stoneDeep, { ry: 1.8 }));
    D.push(boxG(3.4, 0.4, 0.5, C2_E + 1.4, 2.6, -1.2, PAL.stoneMid, { rz: 0.18, ry: 0.3, jitter: 0.1 }));   // 探出断梁
    rubble(D, C2_E + 2.0, 0.2, 0.6, 6);
    // 可走圆上的残墙（内侧面 = r−0.9 = 90.1）。西口只留碎星径那么宽，其余一圈都有石头。
    arenaRing(D, D2C, D2R - 0.9, ["west"], PAL.stoneDark, PAL.stoneDeep, PAL.stoneMid, 3.5, 1.05, true);
    // 外扶壁：仍消耗原来的三段 rnd，贴在环墙外侧，不再悬在可走圆外面当空气墙。
    for (let i = 0; i < 18; i++) {
      const a = Math.PI + (Math.PI * 2 * i) / 18;
      const mouth = Math.cos(a % (Math.PI * 2)) < -0.883;   // 西口 ±28°（比走廊门洞宽，扶壁不挡门）
      if (mouth || rnd() < 0.22) continue;
      const rRoll = rr(D2R - 0.1, D2R + 0.8);
      const hRoll = rr(1.2, 3.0);
      const yRoll = rr(0.6, 1.5);
      const h = 3.55 + (hRoll - 1.2) / 1.8 * 1.1 + Math.abs(yRoll - 1.05) * 0.02;
      const r = (D2R - 0.9) + 1.675 + (rRoll - (D2R + 0.35)) * 0.04;
      D.push(boxG(2.4, h, 0.85, D2C + Math.cos(a) * r, h / 2, Math.sin(a) * r, PAL.stoneDark, { ry: -a + Math.PI / 2, jitter: 0.12 }));
    }
    // 陨石半埋 ×3（紫纹巨砾——「星坠」的实体证词；位置随陨坑铺到新战场，裂纹走 purpleGeoms）
    for (const [ox, oz, ms] of [[-6.5, -5.0, 1.05], [5.5, 4.5, 0.85], [2.0, -8.0, 0.6]] as const) {
      const mx = D2C + ox * D2k, mz = oz * D2k;
      D.push(dodG(ms, mx, ms * 0.45, mz, 0x241f2a, { ry: rnd() * 3, rx: rnd() * 0.4 }));
      for (let k = 0; k < 3; k++)
        purpleGeoms.push(dodG(ms * 0.16, mx + rr(-ms * 0.5, ms * 0.5), ms * 0.4 + rr(-0.1, 0.2), mz + rr(-ms * 0.5, ms * 0.5), 0x1a1424, { ry: rnd() * 3, rz: rnd() * 3 }));
    }
    // 剑冢插地 ×12（碎星祭的献剑——战场遍地）
    for (let i = 0; i < 12; i++) {
      const a = rnd() * Math.PI * 2, r = rr(4.5, 11.5) * D2k;
      D.push(boxG(0.06, rr(0.8, 1.25), 0.024, D2C + Math.cos(a) * r, 0.45, Math.sin(a) * r, PAL.steel, { ry: rnd() * 3, rz: rr(-0.35, 0.35) }));
      if (rnd() < 0.4) D.push(boxG(0.16, 0.05, 0.05, D2C + Math.cos(a) * r, 0.62, Math.sin(a) * r, PAL.steel, { ry: rnd() * 3 }));   // 护手残段
    }
    // 断柱环 ×5（战前廊柱的残段——高低参差）
    for (const a of [0.4, 1.7, 2.9, 4.2, 5.4])
      D.push(cylG(0.34, 0.4, rr(0.8, 2.6), 7, D2C + Math.cos(a) * rr(8.5, 10.5) * D2k, 0.5, Math.sin(a) * rr(8.5, 10.5) * D2k, PAL.stoneDeep, { jitter: 0.1 }));
    // 坠骑残骸（碎星祭的战马与骑士——东北；整组按半径外推，零件相对位置不动）
    const hx = D2C + 7.9 * D2k, hz = -8.35 * D2k;
    D.push(boxG(1.6, 0.55, 0.5, hx - 0.4, 0.3, hz - 0.15, 0x26222a, { ry: -0.8, jitter: 0.12 }));
    D.push(boxG(0.5, 0.9, 0.35, hx + 0.4, 0.45, hz + 0.15, 0x26222a, { ry: -0.5, rz: 0.3 }));
    // 路缘碎石（D1 荒径，整段东移）
    for (const [rx2, rz2] of [[72 + D_DX, -2.6], [76 + D_DX, 2.7], [79 + D_DX, -2.5]] as const) rubble(D, rx2, rz2, 0.4, 3);
  }
  // —— 人尺度地面（1–3m，不乘 A3k / C2k / D2k）——
  // 房间加大后剑冢、陨坑、环纹都贴到外环，场地中间没有可用来估距离的东西。
  // 场心约 6m 留空。这一段把 rnd 旁路用完即拨回，后面的雾斑和飘灰序列不变。
  {
    const seedAt = seed;
    const CLEAR = 6;
    const slot = (
      cx: number, n: number, r0: number, r1: number,
      skip?: (dx: number, dz: number) => boolean,
    ): Array<[number, number]> => {
      const pts: Array<[number, number]> = [];
      const step = (Math.PI * 2) / n;
      const spin = rnd() * step;
      const inner = Math.max(r0, CLEAR + 0.35);
      const outer = Math.max(r1, inner);
      for (let i = 0; i < n; i++) {
        const a = spin + i * step + rr(-step * 0.28, step * 0.28);
        const rad = rr(inner, outer);
        const dx = Math.cos(a) * rad, dz = Math.sin(a) * rad;
        if (Math.hypot(dx, dz) < CLEAR || (skip && skip(dx, dz))) continue;
        pts.push([cx + dx, dz]);
      }
      return pts;
    };
    const tomb = (dst: THREE.BufferGeometry[], x: number, z: number): void => {
      const ry = rnd() * Math.PI * 2;
      const lean = { rx: rr(-0.08, 0.08), rz: rr(-0.1, 0.1) };
      dst.push(boxG(0.64, 0.16, 0.5, x, 0.08, z, PAL.stoneDeep, { ry, jitter: 0.08 }));
      if (rnd() < 0.58) {
        const h = rr(1.05, 1.7);
        dst.push(boxG(rr(0.48, 0.66), h, 0.16, x, 0.16 + h / 2, z, pick([PAL.stone, PAL.stoneMid, PAL.stoneDark]), { ry, ...lean, jitter: 0.1 }));
        if (rnd() < 0.5) dst.push(boxG(0.6, 0.12, 0.22, x, 0.2 + h, z, PAL.stoneMid, { ry, ...lean }));
      } else {
        const h = rr(1.15, 1.85);
        dst.push(boxG(0.16, h, 0.16, x, 0.16 + h / 2, z, pick([PAL.stoneMid, PAL.stoneDark]), { ry, ...lean, jitter: 0.1 }));
        dst.push(boxG(0.54, 0.13, 0.15, x, 0.16 + h * 0.68, z, PAL.stoneMid, { ry, ...lean }));
      }
    };
    const pillarStub = (dst: THREE.BufferGeometry[], x: number, z: number): void => {
      const h = rr(1.2, 2.45);
      const lean = rr(-0.06, 0.06);
      dst.push(boxG(0.82, 0.18, 0.82, x, 0.09, z, PAL.stoneDeep, { ry: rnd() * 0.6, jitter: 0.08 }));
      dst.push(cylG(0.28, 0.34, h, 8, x, 0.18 + h / 2, z, pick([PAL.stone, PAL.stoneMid]), { rx: rr(-0.04, 0.04), rz: lean, jitter: 0.1 }));
      if (rnd() < 0.75) {
        const a = rnd() * Math.PI * 2;
        const dist = rr(0.55, 1.05);
        const drum = rr(0.38, 0.62);
        dst.push(cylG(0.26, 0.26, drum, 8, x + Math.cos(a) * dist, 0.2, z + Math.sin(a) * dist, PAL.stoneDark, { rx: Math.PI / 2 + rr(-0.3, 0.3), ry: a, jitter: 0.1 }));
      }
    };
    // 古达：墓石 + 断柱，停在柱环内侧；雾门和门 B 的东西口让开
    const a3Mouth = (dx: number, dz: number): boolean => dx < -11.2 || dx > 12 || (Math.abs(dx) > 10.5 && Math.abs(dz) < 2.2);
    for (const [x, z] of slot(A3C, 12, 7.0, 13.4, a3Mouth)) tomb(structE, x, z);
    for (const [x, z] of slot(A3C, 8, 8.2, 12.6, a3Mouth)) pillarStub(structE, x, z);

    // 监视者：已有冷灰石碎（rubble 的 dodG + stone 阶），簇径约 1–3m，不进断王座
    const coldShard = (x: number, z: number): void => {
      const s = rr(0.5, 0.95);
      structC.push(dodG(s, x, s * 0.58, z, pick([PAL.stoneDark, PAL.stoneMid, PAL.stoneDeep]), { rx: rnd() * 2.4, ry: rnd() * 3, rz: rnd() * 2.4, jitter: 0.16 }));
      const len = rr(1.05, 2.2), bh = rr(0.3, 0.66);
      structC.push(boxG(len, bh, rr(0.55, 1.05), x + rr(-0.2, 0.2), bh * 0.42, z + rr(-0.2, 0.2), pick([PAL.stoneDark, PAL.stoneDeep, PAL.mortar]), { ry: rnd() * Math.PI, rx: rr(-0.16, 0.16), rz: rr(-0.12, 0.12), jitter: 0.12 }));
      rubble(structC, x, z, rr(0.45, 0.85), 4);
    };
    for (const [x, z] of slot(C2C, 13, 8.0, 14.6, (dx, dz) => dx > 10.6 && Math.abs(dz) < 5)) coldShard(x, z);

    // 拉塔恩外圈：短剑 + 焦黑石块，三层半径，180m 地上能同时看见近处和远处。西口中线让开。
    const shortSword = (x: number, z: number): void => {
      const len = rr(1.12, 1.6);
      const tilt = rr(0.1, 0.4);
      const ry = rnd() * Math.PI * 2;
      const leanX = rnd() < 0.5;
      const dx = leanX ? -Math.sin(tilt) * len / 2 : 0;
      const dz = leanX ? 0 : Math.sin(tilt) * len / 2;
      const opt = { ry, rz: leanX ? tilt : 0, rx: leanX ? 0 : tilt };
      structD.push(boxG(0.042, len, 0.016, x + dx, Math.cos(tilt) * len / 2, z + dz, PAL.steel, opt));
      structD.push(boxG(0.18, 0.038, 0.046, x + dx * 1.55, Math.cos(tilt) * len * 0.72, z + dz * 1.55, PAL.steel, opt));
    };
    const charred = (x: number, z: number): void => {
      const tone = pick([0x121014, 0x1b181c, 0x1e1a1c, 0x241d20, PAL.ash]);
      if (rnd() < 0.55) {
        const w = rr(1.1, 2.5), h = rr(0.38, 1.05), d = rr(0.75, 1.65);
        structD.push(boxG(w, h, d, x, h * 0.42, z, tone, { ry: rnd() * Math.PI, rx: rr(-0.1, 0.1), rz: rr(-0.12, 0.12), jitter: 0.12 }));
      } else {
        const s = rr(0.55, 1.15);
        structD.push(dodG(s, x, s * 0.6, z, tone, { rx: rnd() * 2, ry: rnd() * 3, rz: rnd() * 2, jitter: 0.14 }));
      }
    };
    const westGate = (dx: number, dz: number): boolean => dx < -76 && Math.abs(dz) < 3.2;
    for (const [r0, r1, n] of [[36, 50, 20], [54, 70, 26], [76, 87.5, 28]] as const) {
      for (const [x, z] of slot(D2C, n, r0, r1, westGate)) (rnd() < 0.46 ? shortSword : charred)(x, z);
    }
    seed = seedAt;
  }

  root.add(batch(structW, stoneMat, "both"));
  root.add(batch(structE, stoneMat, "both"));
  root.add(batch(structC, stoneMat, "both"));
  root.add(batch(structD, stoneMat, "both"));
  root.add(batch(floorW, stoneMat, "receive"));
  root.add(batch(floorE, stoneMat, "receive"));
  // 主路余烬短杠（并入炭芯批，0 新灯）：只铺走廊中线与墓苑东西穿行，侧龛死路不加。东向 +X = 古达雾门。
  for (const x of [-122, -112, -98, -92, -82, -72, -62, -54, -48, -42, -34, -24, -16, -12]) {
    coalGeoms.push(boxG(0.78, 0.08, 0.16, x, 0.1, 0, 0x000000));
  }
  const coalMat = track(new THREE.MeshStandardMaterial({ color: 0x2a1207, emissive: COLORS.ember, emissiveIntensity: 1.9, roughness: 1, flatShading: true }));
  root.add(batch(coalGeoms, coalMat, "none"));
  const blueMat = track(new THREE.MeshStandardMaterial({ color: 0x0d1420, emissive: 0x4a6f94, emissiveIntensity: 1.5, roughness: 1, flatShading: true }));
  root.add(batch(blueGeoms, blueMat, "none"));
  // 重力紫光裂批（D 区碎星战场：陨石裂纹微光——拉塔恩的重力紫，破例强调色同玻尔多冰蓝条款）
  const purpleMat = track(new THREE.MeshStandardMaterial({ color: 0x120e18, emissive: 0x8a6fd1, emissiveIntensity: 1.1, roughness: 1, flatShading: true }));
  root.add(batch(purpleGeoms, purpleMat, "none"));
  // 冷蓝光晕批（灯龛/门 B 门槛/烛台；additive 合一批，随 blue 批同相位呼吸——同一盏灯的芯与晕）
  const haloMat = track(new THREE.MeshBasicMaterial({ map: softDiscTexture(), color: 0x6f92b8, transparent: true, opacity: 0.34, blending: THREE.AdditiveBlending, depthWrite: false }));
  {
    const h = batch(haloGeoms, haloMat, "none");
    h.renderOrder = 5;
    root.add(h);
  }
  // 病沼薄雾（C 区）：半透明平面两层缓移（低层浓/高层淡；漂移呼吸，非外部资源）
  const mistTex = softDiscTexture();
  const mistPlane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const mistMatLow = track(new THREE.MeshBasicMaterial({ map: mistTex, color: 0x233240, transparent: true, opacity: 0.085, depthWrite: false }));
  const mistMatHigh = track(new THREE.MeshBasicMaterial({ map: mistTex, color: 0x1c2a38, transparent: true, opacity: 0.05, depthWrite: false }));
  const mists: MistRef[] = [];
  const mistAt = (x: number, y: number, z: number, s: number, low: boolean): void => {
    const mesh = new THREE.Mesh(mistPlane, low ? mistMatLow : mistMatHigh);
    mesh.position.set(x, y, z);
    mesh.scale.setScalar(s);
    mesh.renderOrder = 5;
    root.add(mesh);
    mists.push({ mesh, bx: x, bz: z, dx: rr(1.4, 2.8), dz: rr(1.0, 2.2), ph: rnd() * 6.28, spx: rr(0.04, 0.09), spz: rr(0.03, 0.07) });
  };
  mistAt(11.2 + A3_DX, 0.24, 0, 3.2, true);             // 门 B 门槛溢出的冷息
  mistAt(14.5 + A3_DX, 0.22, 0.5, 4.6, true); mistAt(19.5 + A3_DX, 0.5, -0.5, 5.2, false);
  mistAt(26.5 + A3_DX, 0.2, 0.4, 5.0, true); mistAt(33 + A3_DX, 0.55, -0.4, 5.6, false);
  mistAt(40.5 + A3_DX, 0.26, 0.2, 4.8, true);
  mistAt(C2C, 0.3, 0, 9.5 * C2k, true);                 // C2 病沼中心雾盘（随厅径放大）

  // ---------------- 灰烬斑：走廊/墓苑/竞技场的半透明暗斑（单 Mesh 单材质） ----------------
  {
    const patchGeoms: THREE.BufferGeometry[] = [];
    for (const px of [-124, -110, -84, -70, -56, -34, -22]) {
      patchGeoms.push(new THREE.CircleGeometry(rr(0.8, 1.5), 16).rotateX(-Math.PI / 2).translate(px + rr(-1, 1), 0.02, rr(-1.6, 1.6)));
      patchGeoms.push(new THREE.CircleGeometry(rr(0.6, 1.2), 16).rotateX(-Math.PI / 2).translate(px + rr(-2, 2), 0.02, rr(-1.6, 1.6)));
    }
    for (const [px, pz, pr] of [[-95, 2.5, 1.8], [-45, -2.0, 1.6], [A3C + 2, -3, 2.0], [C2C - 1, 2, 2.2]] as const)
      patchGeoms.push(new THREE.CircleGeometry(pr, 18).rotateX(-Math.PI / 2).translate(px, 0.02, pz));
    for (const px of [16 + A3_DX, 28 + A3_DX, 40 + A3_DX]) patchGeoms.push(new THREE.CircleGeometry(rr(0.7, 1.3), 16).rotateX(-Math.PI / 2).translate(px, 0.02, rr(-1.4, 1.4)));
    const patches = new THREE.Mesh(mergeGeometries(patchGeoms, false)!, track(new THREE.MeshBasicMaterial({ color: 0x0a0b0e, transparent: true, opacity: 0.4, depthWrite: false })));
    for (const g of patchGeoms) g.dispose();
    root.add(patches);
  }

  // ---------------- 飘灰：110 粒缓落灰烬（全图分布，Points + 位置数组直写，区域内循环） ----------------
  const ASH_N = 110;
  const ASH_X0 = -146, ASH_X1 = D2C + D2R;
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
      fl.mat.opacity = 0.9 + 0.08 * Math.sin(animT * 13 + i * 1.7);
      fl.light.intensity = 5.2 + Math.sin(animT * 9.5 + i * 2.4) * 1.2 + Math.sin(animT * 23 + i) * 0.6;
    }
    coalMat.emissiveIntensity = 1.9 + Math.sin(animT * 7.3) * 0.35;         // 炭芯呼吸（火盆/拱门烛/路心短杠）
    blueMat.emissiveIntensity = 1.35 + Math.sin(animT * 4.1 + 1.7) * 0.35;  // 幽蓝呼吸（C 区冷灯，异相位）
    purpleMat.emissiveIntensity = 0.95 + Math.sin(animT * 2.6 + 0.9) * 0.3; // 重力紫呼吸（D 区陨裂，缓相位）
    for (const gl of glowLights)                                            // 烛龛/幽蓝点光：按基准强度呼吸（无火苗件）
      gl.light.intensity = gl.base * (1 + Math.sin(animT * 8.3 + gl.ph) * 0.18 + Math.sin(animT * 21 + gl.ph * 2) * 0.09);
    for (const m of mists) {                                                 // 病沼薄雾：绕基点缓移（低/高层各自漂）
      m.mesh.position.x = m.bx + Math.sin(animT * m.spx + m.ph) * m.dx;
      m.mesh.position.z = m.bz + Math.cos(animT * m.spz + m.ph * 1.7) * m.dz;
    }
    mistMatLow.opacity = 0.085 + Math.sin(animT * 0.21) * 0.02;              // 雾层呼吸（异相位）
    mistMatHigh.opacity = 0.05 + Math.sin(animT * 0.17 + 1.2) * 0.014;
    haloMat.opacity = 0.3 + Math.sin(animT * 4.1 + 1.7) * 0.08;              // 光晕与 blue 批同相位脉动
    {                                                    // 流云：wrap 循环漂移 + 边缘渐隐（随行组局部坐标）
      const span = CLOUD.max - CLOUD.min;
      const x = CLOUD.min + (((animT * cloud.sp) % span) + span) % span;
      const k = Math.min(1, Math.max(0, Math.min((x - CLOUD.min) / CLOUD.fade, (CLOUD.max - x) / CLOUD.fade)));
      cloud.mesh.position.x = x;
      cloud.mat.opacity = cloud.o * k * k;
    }
    // 天穹/冷月随玩家 x/z（半径 220 罩住 180m 对岸；相机 far=480）；阴影窗 2m 网格吸附（防像素质心抖动）
    if (!playerRef || playerRef.parent === null) playerRef = scene.getObjectByName("Undead") ?? null;
    if (playerRef) {
      playerRef.getWorldPosition(scratch);
      skyGroup.position.x = scratch.x;
      skyGroup.position.z = scratch.z;
      const sx = Math.round(scratch.x / 2) * 2;
      moonLight.position.set(sx + 19, 6, -7);
      moonTarget.position.set(sx - 2, 0, 0);
      const fk = Math.min(1, Math.max(0, (scratch.x - C2_E) / (D2_W - C2_E)));
      cemFog.density = FOG_NEAR + (FOG_FIELD - FOG_NEAR) * fk;   // D1 渐入，战场上能看见 180m 对岸
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
