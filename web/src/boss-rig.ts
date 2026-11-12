/** 把 Blender 脚本（tools/blender/build_bosses.py）导出的关节网格接上 Boss 的 Pose。
 * 关节名和局部位置与运行时一致；招式仍由代码转这些关节，不播骨骼动画。
 * 每个实例克隆几何和材质，销毁时不会拆掉模板。 */
import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";

const assets = new Map<string, GLTF>();

export function setBossAssets(map: Record<string, GLTF>): void {
  for (const [id, gltf] of Object.entries(map)) assets.set(id, gltf);
}

export function spawnBoss(id: string, rootName: string): THREE.Object3D {
  const gltf = assets.get(id);
  if (!gltf) throw new Error(`缺少 Boss 模型 ${id}`);
  const src = gltf.scene.getObjectByName(rootName);
  if (!src) throw new Error(`Boss 模型 ${id} 没有关节 ${rootName}`);
  const root = src.clone(true);
  const mats = new Map<THREE.Material, THREE.Material>();
  root.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.geometry = mesh.geometry.clone();
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const cloned = list.map(mt => {
      let copy = mats.get(mt);
      if (!copy) {
        copy = mt.clone();
        mats.set(mt, copy);
      }
      return copy;
    });
    mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0];
  });
  return root;
}

export function part(root: THREE.Object3D, name: string): THREE.Object3D {
  const o = root.getObjectByName(name);
  if (!o) throw new Error(`Boss 骨架缺少 ${name}`);
  return o;
}

export function partMat(root: THREE.Object3D, name: string): THREE.MeshStandardMaterial {
  let found: THREE.MeshStandardMaterial | undefined;
  root.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || found) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mt of list) {
      if (mt.name === name) found = mt as THREE.MeshStandardMaterial;
    }
  });
  if (!found) throw new Error(`Boss 材质缺少 ${name}`);
  return found;
}

/** g_serp0、v_ice0、w_cape0 这种从 0 连续编号的网格。 */
export function numbered(root: THREE.Object3D, prefix: string): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  for (let i = 0; ; i++) {
    const o = root.getObjectByName(`${prefix}${i}`) as THREE.Mesh | undefined;
    if (!o?.isMesh) break;
    out.push(o);
  }
  return out;
}
