/** 灰烬墓地场景：走廊 + 圆形竞技场 + 残柱 + 墓地灯光与夜雾
 * 与 scene-highwall 同构：{ anchors, update, dispose }——game.ts 场景注册表按此消费
 */
import * as THREE from "three";
import { COLORS } from "./config";
import type { SceneAnchors } from "./scene-highwall";

export function buildCemetery(scene: THREE.Scene): {
  anchors: SceneAnchors;
  update: null;
  dispose: () => void;
} {
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
  const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
    root.add(m);
    return m;
  };

  // 墓地灯光：冷月光主灯（带阴影）+ 半天环境光
  const moon = new THREE.DirectionalLight(COLORS.moon, 2.0);
  moon.position.set(6, 9, 4);
  moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  Object.assign(moon.shadow.camera, { left: -16, right: 16, top: 12, bottom: -8 });
  root.add(moon);
  root.add(new THREE.HemisphereLight(0x2c3548, 0x141210, 0.55));

  // 走廊地面与墙
  const stoneMat = track(new THREE.MeshStandardMaterial({ color: COLORS.stoneDark, roughness: 1, flatShading: true }));
  const pathMat = track(new THREE.MeshStandardMaterial({ color: COLORS.groundPath, roughness: 1 }));
  box(9.6, 0.2, 3.6, pathMat, -9.6, -0.1, 0);
  box(9.6, 2.4, 0.5, stoneMat, -9.6, 1.2, 2.0);
  box(9.6, 2.4, 0.5, stoneMat, -9.6, 1.2, -2.0);

  // 竞技场
  const arenaMat = track(new THREE.MeshStandardMaterial({ color: COLORS.ground, roughness: 0.95 }));
  const arena = new THREE.Mesh(new THREE.CircleGeometry(6.6, 48), arenaMat);
  arena.rotation.x = -Math.PI / 2;
  arena.position.set(0.6, 0.001, 0);
  arena.receiveShadow = true;
  root.add(arena);

  // 竞技场残柱
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + 0.35;
    if (Math.abs(a - Math.PI) < 0.5) continue;    // 留出门口（-X 朝走廊）
    const r = 6.1;
    const h = 1.2 + ((i * 7919) % 100) / 100 * 1.8;
    box(0.7, h, 0.7, stoneMat, 0.6 + Math.cos(a) * r, h / 2, Math.sin(a) * r);
  }

  // 大地面（远景）
  const vastMat = track(new THREE.MeshStandardMaterial({ color: 0x14161b, roughness: 1 }));
  const vast = new THREE.Mesh(new THREE.CircleGeometry(60, 32), vastMat);
  vast.rotation.x = -Math.PI / 2;
  vast.position.y = -0.05;
  root.add(vast);

  const dispose = (): void => {
    scene.background = prevBg;
    scene.fog = prevFog;
    root.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    for (const mt of mats) mt.dispose();
    root.removeFromParent();
  };

  return { anchors, update: null, dispose };
}
