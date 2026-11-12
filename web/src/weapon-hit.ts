/** 武器判定：水平面上，刃（或这一帧扫过的区域）碰到目标圆柱就算命中。
 *  距离用目标身体半径，不再用脚底往前的固定扇形。 */

export interface Seg {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
}

export interface Strike {
  /** 这一帧的刃：a 靠护手，b 是尖。踢击时 a、b 都是靴子。 */
  now: Seg;
  /** 上一帧的刃。两帧之间补几段，快挥也不会从身子里穿过去。 */
  prev: Seg | null;
  /** 刃宽的一半，米。贴着刃缘也算打到。 */
  pad: number;
}

const SWEEP_STEPS = 4;

function distToSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): { d: number; t: number } {
  const abx = bx - ax, abz = bz - az;
  const apx = px - ax, apz = pz - az;
  const ab2 = abx * abx + abz * abz;
  let t = ab2 > 1e-8 ? (apx * abx + apz * abz) / ab2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = ax + abx * t - px;
  const dz = az + abz * t - pz;
  return { d: Math.hypot(dx, dz), t };
}

function lerpSeg(p: Seg, n: Seg, t: number): Seg {
  return {
    ax: p.ax + (n.ax - p.ax) * t, ay: p.ay + (n.ay - p.ay) * t, az: p.az + (n.az - p.az) * t,
    bx: p.bx + (n.bx - p.bx) * t, by: p.by + (n.by - p.by) * t, bz: p.bz + (n.bz - p.bz) * t,
  };
}

/** 目标圆心（脚底）到刃的水平距离 ≤ 身体半径 + 刃宽。返回刃上的接触点，供火花用。 */
export function strikeContact(tx: number, tz: number, radius: number, s: Strike): { x: number; y: number; z: number } | null {
  const reach = radius + s.pad;
  const segs: Seg[] = [s.now];
  if (s.prev) {
    for (let i = 1; i <= SWEEP_STEPS; i++) segs.push(lerpSeg(s.prev, s.now, i / SWEEP_STEPS));
  }
  let bestD = Infinity;
  let bestSeg = s.now;
  let bestT = 0;
  for (const seg of segs) {
    const hit = distToSeg(tx, tz, seg.ax, seg.az, seg.bx, seg.bz);
    if (hit.d < bestD) { bestD = hit.d; bestSeg = seg; bestT = hit.t; }
  }
  if (bestD > reach) return null;
  return {
    x: bestSeg.ax + (bestSeg.bx - bestSeg.ax) * bestT,
    y: bestSeg.ay + (bestSeg.by - bestSeg.ay) * bestT,
    z: bestSeg.az + (bestSeg.bz - bestSeg.az) * bestT,
  };
}
