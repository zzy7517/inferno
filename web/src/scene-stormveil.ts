/** 场景三「史东薇尔城垣」——T1 灰盒占位（T7 全量美术重建，见 design/m4-level-flow.md §4.1）
 * 空间语法与墓地/高墙一致：出生/篝火(x≈-12.4) → 走廊(净宽 3.5m，雾门 x=-5) → 圆形 Boss 竞技场(r=6.6，中心 x=0.6)
 * 灰盒目标：让城垣可传送/可战斗/可验收，不求观感；风暴青灰色调 + 风雾氛围示意。
 * 预算：~20 draw call 直出（无合并），无贴图无外部资源；T7 落地时本文件整体替换。
 */
import * as THREE from "three";
import type { SceneAnchors } from "./scene-highwall";

export interface SceneResult {
  anchors: SceneAnchors;
  update?: (t: number, dt: number) => void;
  dispose: () => void;
}

const PAL = {
  stormHi: 0x3d4652, storm: 0x31394a, stormDeep: 0x222833,
  stone: 0x3a3f47, stoneDark: 0x272b31, mortar: 0x191c21,
  ground: 0x2c2f33, path: 0x33322c,
  skyTop: 0x0d131c, skyHorizon: 0x2c3646, skyUnder: 0x161b24,
  mist: 0x4a5566,
};

const group = new THREE.Group();

export function buildStormveil(scene: THREE.Scene): SceneResult {
  const anchors: SceneAnchors = {
    spawn: new THREE.Vector3(-12.4, 0, 0),
    bonfire: new THREE.Vector3(-12.4, 0, 0),
    fogGate: new THREE.Vector3(-5, 0, 0),
    bossArena: new THREE.Vector3(0.6, 0, 0),
    arenaRadius: 6.6,
    corridorMinX: -5,
  };

  const std = (color: number, rough = 0.95) =>
    new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.02 });

  // 天穹（风暴青灰渐变感的双层球）
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(90, 24, 16),
    new THREE.MeshBasicMaterial({ color: PAL.skyHorizon, side: THREE.BackSide, fog: false }),
  );
  const skyCore = new THREE.Mesh(
    new THREE.SphereGeometry(60, 24, 16),
    new THREE.MeshBasicMaterial({ color: PAL.skyUnder, side: THREE.BackSide, fog: false }),
  );
  group.add(sky, skyCore);

  // 地面 + 走廊石板
  const ground = new THREE.Mesh(new THREE.BoxGeometry(44, 0.4, 30), std(PAL.ground));
  ground.position.y = -0.2;
  const path = new THREE.Mesh(new THREE.BoxGeometry(30, 0.06, 3.5), std(PAL.path));
  path.position.set(-4, 0.02, 0);
  group.add(ground, path);

  // 竞技场：石环墙 + 立柱
  const arenaFloor = new THREE.Mesh(new THREE.CylinderGeometry(7.6, 7.6, 0.12, 40), std(PAL.stone));
  arenaFloor.position.set(0.6, 0.05, 0);
  group.add(arenaFloor);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.9, 5.5, 0.9), std(PAL.stoneDark));
    pillar.position.set(0.6 + Math.cos(a) * 8.4, 2.75, Math.sin(a) * 8.4);
    pillar.rotation.y = -a;
    group.add(pillar);
  }

  // 走廊双墙（净宽 3.5m，x∈[-14,-5]）
  for (const sz of [-1, 1]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(9.5, 4.6, 0.8), std(PAL.stone));
    wall.position.set(-9.4, 2.3, sz * 2.15);
    group.add(wall);
  }

  // 远景：城垣剪影（大体积低细节，fog:false 压暗成层）
  const ridge = (w: number, h: number, d: number, x: number, z: number, c: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
      new THREE.MeshBasicMaterial({ color: c, fog: false }));
    m.position.set(x, h / 2, z);
    group.add(m);
  };
  ridge(26, 16, 6, 18, -22, 0x1a2230);
  ridge(12, 24, 6, 30, -14, 0x141b26);   // 主塔
  ridge(20, 10, 5, -6, -24, 0x1c2431);
  ridge(16, 13, 5, -30, -18, 0x18202c);

  // 风雾粒子（T7 换风暴风效；这里给最低限度的空气感）
  const MIST_N = 40;
  const mistPos = new Float32Array(MIST_N * 3);
  const mistSeed = new Float32Array(MIST_N);
  for (let i = 0; i < MIST_N; i++) {
    mistPos[i * 3] = -14 + Math.random() * 30;
    mistPos[i * 3 + 1] = 0.4 + Math.random() * 3.2;
    mistPos[i * 3 + 2] = -10 + Math.random() * 20;
    mistSeed[i] = Math.random() * Math.PI * 2;
  }
  const mistGeo = new THREE.BufferGeometry();
  mistGeo.setAttribute("position", new THREE.BufferAttribute(mistPos, 3));
  const mist = new THREE.Points(mistGeo,
    new THREE.PointsMaterial({ color: PAL.mist, size: 0.16, transparent: true, opacity: 0.4 }));
  group.add(mist);

  // 光：风暴顶光 + 冷侧光（火光由篝火/雾门系统自带）
  const hemi = new THREE.HemisphereLight(PAL.skyHorizon, PAL.stormDeep, 0.75);
  const key = new THREE.DirectionalLight(0x9fb2cc, 1.0);
  key.position.set(10, 18, -8);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = key.shadow.camera.bottom = -20;
  key.shadow.camera.right = key.shadow.camera.top = 20;
  key.shadow.camera.updateProjectionMatrix();
  group.add(hemi, key);

  scene.add(group);
  scene.fog = new THREE.Fog(PAL.skyUnder, 18, 70);

  return {
    anchors,
    update: (t: number, _dt: number) => {
      const pos = mistGeo.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < MIST_N; i++) {
        pos.setX(i, -14 + ((mistPos[i * 3] + t * 1.4 + 44) % 30));   // 缓慢横漂的风雾
        pos.setY(i, mistPos[i * 3 + 1] + Math.sin(t * 0.7 + mistSeed[i]) * 0.3);
      }
      pos.needsUpdate = true;
    },
    dispose: () => {
      scene.remove(group);
      scene.fog = null;
      group.traverse(o => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = (m as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach(x => x.dispose());
        else if (mat) mat.dispose();
      });
    },
  };
}
