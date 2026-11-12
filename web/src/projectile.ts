/** 投射物池（M3：沙力万暗月矢/纵横月焰）—— BossBase 子类经 host 发射，game 每帧驱动命中
 *  约定：飞行物为发光小球，水平直线（可选微下坠），命中玩家走 onHit 总线同一套手感档案。
 *  身后 3 颗同色余烬沿速度拉成短拖尾，箭和月焰在入身前就能看出飞来的方向。
 *  余烬只在池槽位第一次分配时创建，命中 / 到期 / 落地 / 飞出出生点距离都随 kill 摘掉。
 *  速度、伤害、命中半径、寿命、泄漏距离（出生点 90m）不变。
 */
import * as THREE from "three";

export interface ProjDef {
  speed: number;        // m/s
  radius: number;       // 命中半径（含玩家身位）
  dmg: number;
  feelKey: string;      // 命中手感档案（FEEL）
  life: number;         // 存活 s（超时消散）
  color?: number;       // 发光色（默认冷月白）
  drop?: number;        // 每秒垂直下坠（0=平飞）
}

/** 珠心在弹心身后的距离（米）。半长 0.55，前后叠成约 2.8m 的短迹，不伸到弹头前面。 */
const TRAIL_AT = [0.7, 1.45, 2.25];
const TRAIL_GIRTH = [0.85, 0.58, 0.34]; // × 弹体视觉半径，向后收细
const TRAIL_OP = [0.72, 0.4, 0.18];
const TRAIL_HALF = 0.55;
const trailGeo = new THREE.SphereGeometry(1, 8, 6);
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

interface Proj {
  mesh: THREE.Mesh;
  trail: THREE.Mesh[];
  vx: number; vy: number; vz: number;
  life: number;
  def: ProjDef;
  dead: boolean;
  from: THREE.Vector3;   // 出生点：泄漏防护按飞行距离算（竞技场已在 x≈95，世界原点距离会误杀）
}

export class Projectiles {
  private pool: Proj[] = [];
  private group = new THREE.Group();

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  spawn(pos: THREE.Vector3, yaw: number, def: ProjDef): void {
    let p = this.pool.find(q => q.dead);
    if (!p) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(1, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      this.group.add(mesh);
      const trail: THREE.Mesh[] = [];
      for (let i = 0; i < TRAIL_AT.length; i++) {
        const t = new THREE.Mesh(trailGeo, new THREE.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: TRAIL_OP[i],
          blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        t.visible = false;
        t.frustumCulled = false;
        this.group.add(t);
        trail.push(t);
      }
      p = { mesh, trail, vx: 0, vy: 0, vz: 0, life: 0, def, dead: true, from: new THREE.Vector3() };
      this.pool.push(p);
    }
    p.dead = false;
    p.life = def.life;
    p.def = def;
    p.from.copy(pos);
    const s = def.radius * 0.6;
    p.mesh.scale.setScalar(s);
    p.mesh.position.copy(pos);
    p.mesh.visible = true;
    const color = def.color ?? 0xb8c4e8;
    (p.mesh.material as THREE.MeshBasicMaterial).color.set(color);
    for (const t of p.trail) (t.material as THREE.MeshBasicMaterial).color.set(color);
    const h = def.speed;
    p.vx = Math.sin(yaw) * h; p.vz = Math.cos(yaw) * h; p.vy = 0;
    this.placeTrail(p);
  }

  /** 返回本帧命中的投射物（调用方走 onHit 总线）；iframed 时穿过了不消耗 */
  update(dt: number, playerPos: THREE.Vector3, iframed: boolean, onHit: (def: ProjDef, point: THREE.Vector3, dir: THREE.Vector3) => void): void {
    for (const p of this.pool) {
      if (p.dead) continue;
      p.life -= dt;
      if (p.def.drop) p.vy -= p.def.drop * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      const m = p.mesh.position;
      const hitR = p.def.radius + 0.45;                 // 玩家身位
      const inBand = m.y > 0.15 && m.y < 1.85;          // 玩家高度带
      const dx = m.x - playerPos.x, dz = m.z - playerPos.z;
      if (!iframed && inBand && dx * dx + dz * dz < hitR * hitR) {
        const dir = new THREE.Vector3(p.vx, 0, p.vz).normalize();
        onHit(p.def, m.clone(), dir);
        this.kill(p);
      } else if (p.life <= 0 || m.y < 0 || m.distanceToSquared(p.from) > 8100) {
        this.kill(p);
      } else {
        this.placeTrail(p);
      }
    }
  }

  /** 沿当前速度把余烬摆到弹后。几何和材质是槽位上的，这里只改变换。 */
  private placeTrail(p: Proj): void {
    const sp = Math.hypot(p.vx, p.vy, p.vz);
    if (sp < 1e-4) {
      for (const t of p.trail) t.visible = false;
      return;
    }
    _fwd.set(p.vx / sp, p.vy / sp, p.vz / sp);
    const head = p.mesh.position;
    const body = p.mesh.scale.x;
    for (let i = 0; i < p.trail.length; i++) {
      const t = p.trail[i];
      const d = TRAIL_AT[i];
      t.position.set(head.x - _fwd.x * d, head.y - _fwd.y * d, head.z - _fwd.z * d);
      const g = body * TRAIL_GIRTH[i];
      t.scale.set(g, TRAIL_HALF, g);
      t.quaternion.setFromUnitVectors(_up, _fwd);
      t.visible = true;
    }
  }

  private kill(p: Proj): void {
    p.dead = true;
    p.mesh.visible = false;
    for (const t of p.trail) t.visible = false;
  }

  clear(): void { for (const p of this.pool) this.kill(p); }

  get activeCount(): number { return this.pool.reduce((n, p) => n + (p.dead ? 0 : 1), 0); }
}
