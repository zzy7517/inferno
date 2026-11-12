/** 投射物池（M3：沙力万暗月矢/纵横月焰）—— BossBase 子类经 host 发射，game 每帧驱动命中
 *  约定：飞行物为发光小球，水平直线（可选微下坠），命中玩家走 onHit 总线同一套手感档案
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

interface Proj {
  mesh: THREE.Mesh;
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
      p = { mesh, vx: 0, vy: 0, vz: 0, life: 0, def, dead: true, from: new THREE.Vector3() };
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
    (p.mesh.material as THREE.MeshBasicMaterial).color.set(def.color ?? 0xb8c4e8);
    const h = def.speed;
    p.vx = Math.sin(yaw) * h; p.vz = Math.cos(yaw) * h; p.vy = 0;
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
      }
    }
  }

  private kill(p: Proj): void {
    p.dead = true;
    p.mesh.visible = false;
  }

  clear(): void { for (const p of this.pool) this.kill(p); }

  get activeCount(): number { return this.pool.reduce((n, p) => n + (p.dead ? 0 : 1), 0); }
}
