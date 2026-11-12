/** 三场景共用的几何上色与合批。色微扰走各场景传入的 rnd，种子不共享。 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export interface GOpt { rx?: number; ry?: number; rz?: number; jitter?: number; open?: boolean; t0?: number; tl?: number }

/** 绑定调用方自己的 rnd，返回与原场景内联实现同签名的上色/合批函数。 */
export function createSceneGeom(rnd: () => number) {
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

  return { paint, boxG, cylG, coneG, dodG, batch };
}
