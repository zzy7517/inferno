/** 把 Blender 导出的 Boss 挂回代码里的躯干和手臂。
 *  挂点的局部变换抄到已经接好的组上，网格和判定空物体跟着走。
 *  applyPose 仍去转这些组。找不到挂点或判定点就抛错，不退回方块人。
 */
import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";

const assets = new Map<string, GLTF>();

export function setBossGltf(map: Record<string, GLTF>): void {
  for (const [id, gltf] of Object.entries(map)) assets.set(id, gltf);
}

export function getBossGltf(id: string): GLTF {
  const gltf = assets.get(id);
  if (!gltf) throw new Error(`缺少 Boss 模型 ${id}`);
  return gltf;
}

export interface BossRig {
  node(name: string): THREE.Object3D;
  mesh(name: string): THREE.Mesh;
  mat(name: string): THREE.MeshStandardMaterial;
}

/** 蛇节沿局部 +Z 的长度。头不拉长，颈用它接到头。 */
export function extentZ(mesh: THREE.Mesh): number {
  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox;
  if (!box) throw new Error(`${mesh.name} 没有包围盒`);
  return box.max.z - box.min.z;
}

export function mountBoss(gltf: GLTF, hosts: Record<string, THREE.Object3D>, markers: readonly string[]): BossRig {
  const clone = gltf.scene.clone(true);
  const sharedMat = new Map<string, THREE.Material>();
  clone.traverse(obj => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry = mesh.geometry.clone();
    mesh.castShadow = true;
    const copyMat = (src: THREE.Material): THREE.Material => {
      let next = sharedMat.get(src.uuid);
      if (!next) {
        next = src.clone();
        const std = next as THREE.MeshStandardMaterial;
        if (std.isMeshStandardMaterial) std.flatShading = true;
        sharedMat.set(src.uuid, next);
      }
      return next;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(copyMat) : copyMat(mesh.material);
  });

  const byName = new Map<string, THREE.Object3D>();
  clone.traverse(obj => {
    if (!obj.name) return;
    if (byName.has(obj.name)) throw new Error(`Boss 模型名字重复：${obj.name}`);
    byName.set(obj.name, obj);
  });

  for (const [name, host] of Object.entries(hosts)) {
    const slot = byName.get(name);
    if (!slot) throw new Error(`Boss 模型缺少挂点 ${name}`);
    host.position.copy(slot.position);
    host.quaternion.copy(slot.quaternion);
    host.scale.copy(slot.scale);
  }

  const hosted = new Set(Object.keys(hosts));
  for (const [name, host] of Object.entries(hosts)) {
    const slot = byName.get(name);
    if (!slot) continue;
    for (const child of [...slot.children]) {
      if (hosted.has(child.name)) continue;
      host.add(child);
    }
  }

  const node = (name: string): THREE.Object3D => {
    const found = byName.get(name);
    if (!found || !found.parent) throw new Error(`Boss 模型缺少 ${name}`);
    return found;
  };
  for (const name of markers) node(name);

  const mesh = (name: string): THREE.Mesh => {
    const found = node(name);
    if (!(found as THREE.Mesh).isMesh) throw new Error(`${name} 不是网格`);
    return found as THREE.Mesh;
  };

  const mat = (name: string): THREE.MeshStandardMaterial => {
    let found: THREE.MeshStandardMaterial | undefined;
    const visit = (obj: THREE.Object3D) => {
      const m = obj as THREE.Mesh;
      if (m.isMesh) {
        const list = Array.isArray(m.material) ? m.material : [m.material];
        for (const item of list) {
          const std = item as THREE.MeshStandardMaterial;
          if (std?.name === name && std.isMeshStandardMaterial) found = std;
        }
      }
      for (const child of obj.children) visit(child);
    };
    for (const host of Object.values(hosts)) visit(host);
    if (!found) throw new Error(`Boss 模型缺少材质 ${name}`);
    return found;
  };

  return { node, mesh, mat };
}
