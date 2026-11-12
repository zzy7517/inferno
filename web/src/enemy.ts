/** 小怪系统（docs/design/enemies.md）：EnemyBase 状态机 + 活尸/侍从/乌鸦 + EnemyManager
 *  范式对齐 BossBase（boss-base.ts）：idle→tel→act→rec 招式节拍复用 config.MoveDef 注册表
 *  （enemies-config.ts 已把 hollow / squire / crow 前缀招式并入 MOVES/FEEL，调校台热调零适配），
 *  但整体轻一个量级——无削韧/阶段/弹反，受击即打断；网格 ≤15/只、几何材质模块级共享。
 *  game.ts 接线见文档「接线指南」；本模块不依赖 game。
 */
import * as THREE from "three";
import { MOVES, MoveDef, P } from "./config";
import { ENEMY_STATS, MOVES_ENEMY, EnemyStats, EnemyKind, EnemySpawnSpec } from "./enemies-config";
import type { Vfx } from "./vfx";
import { AU } from "./audio";
import { smooth, seg, clampMag, angleWithin } from "./boss-base";

export type { EnemyKind, EnemySpawnSpec, EnemyStats } from "./enemies-config";
export { ENEMY_STATS, MOVES_ENEMY, FEEL_ENEMY, ENEMY_PRESETS } from "./enemies-config";

export type EnemyState = "idle" | "alert" | "combat" | "backstab" | "dead";
export type EnemySub = "idle" | "tel" | "act" | "rec";

/** 宿主回调：对齐 game 已有模式（BossHost.onBossHit / game.hitBus 扇出），接线零适配 */
export interface EnemyHost {
  /** 敌人被玩家命中：feelKey 为玩家攻击手感档案（pR1a/pR2…；打盾弹开为 eGuard、背刺为 pRip）——
   *  接线侧按 FEEL 做六通道扇出（顿帧/震屏/粒子/音效/红屏/手柄，同 game.hitBoss 的反馈段） */
  onHit: (feelKey: string, point: THREE.Vector3) => void;
  /** 敌人攻击命中玩家：接线侧 player.applyHit(dmg, dir, move)（move.feel 驱动受击手感） */
  onHitPlayer: (dmg: number, dir: THREE.Vector3, move: MoveDef) => void;
  /** 敌人死亡掉魂：接线侧 player.souls += souls */
  onDeath: (souls: number, pos: THREE.Vector3) => void;
  shake: (amp: number) => void;
}

/** 当前 Boss 房的可走圆（r = zone.r - 0.9）。playerInside：玩家在这个圆里（封门本帧暂时跨出也算）。 */
export interface BossRoomSeal {
  x: number;
  z: number;
  r: number;
  playerInside: boolean;
}

/** 推出圆外时沿半径多留的空隙，避免贴着边界一帧跨入、下一帧被弹出。 */
const BOSS_ROOM_MARGIN = 0.35;

function bossRoomDist(x: number, z: number, room: { x: number; z: number }): number {
  return Math.hypot(x - room.x, z - room.z);
}

/** 点已在圆外则原样返回；否则沿半径放到 r 外再加一点余量。落在圆心时用 fallback 方向。 */
function pushXZOut(x: number, z: number, room: BossRoomSeal, fallbackX = 1, fallbackZ = 0): { x: number; z: number } {
  let dx = x - room.x;
  let dz = z - room.z;
  let dist = Math.hypot(dx, dz);
  if (dist >= room.r) return { x, z };
  if (dist < 1e-4) {
    dx = fallbackX;
    dz = fallbackZ;
    dist = Math.hypot(dx, dz);
    if (dist < 1e-4) { dx = 1; dz = 0; dist = 1; }
  }
  const k = (room.r + BOSS_ROOM_MARGIN) / dist;
  return { x: room.x + dx * k, z: room.z + dz * k };
}

/** 玩家在封门圆内、这只小怪在圆外：不进仇恨，也不许追进去。 */
function playerShutOut(room: BossRoomSeal | null, x: number, z: number): boolean {
  return !!room?.playerInside && bossRoomDist(x, z, room) >= room.r;
}

// ---------------- 共享几何/材质（模块级缓存：全部敌人实例复用，dispose 只摘树不释放） ----------------
const GEOS = new Map<string, THREE.BufferGeometry>();
const MATS = new Map<string, THREE.MeshStandardMaterial>();

function boxGeo(w: number, h: number, d: number): THREE.BoxGeometry {
  const key = `b:${w},${h},${d}`;
  let g = GEOS.get(key);
  if (!g) { g = new THREE.BoxGeometry(w, h, d); GEOS.set(key, g); }
  return g as THREE.BoxGeometry;
}
function mat(key: string, make: () => THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  let m = MATS.get(key);
  if (!m) { m = make(); MATS.set(key, m); }
  return m;
}

export abstract class EnemyBase {
  readonly root = new THREE.Group();
  state: EnemyState = "idle";
  sub: EnemySub = "idle";
  move: MoveDef | null = null;
  t = 0;
  hp: number;
  yaw: number;
  gone = false;                 // 已摘树（死亡沉底或 dispose），管理器下一帧移除

  protected cds: Record<string, number> = {};
  protected hitFired = 0;
  protected hurtT = 0;          // 受击硬直（打断移动/选招）
  private airborne = false;     // 上挑浮空：只积分 y，落回 0 结束
  private launchY = 0;
  private launchVy = 0;
  protected walkPhase = 0;      // 步态相位
  protected walking = false;
  protected elapsed = 0;
  protected spawnPos = new THREE.Vector3();
  protected patrolTarget = new THREE.Vector3();
  protected patrolT = 0;
  protected lungeFrom = new THREE.Vector3();
  protected lungeTo = new THREE.Vector3();

  protected constructor(
    protected scene: THREE.Scene,
    protected vfx: Vfx,
    pos: THREE.Vector3,
    protected host: EnemyHost,
    readonly stats: EnemyStats,
    facing = -Math.PI / 2,
  ) {
    this.hp = stats.hp;
    this.yaw = facing;
    this.root.position.copy(pos);
    this.spawnPos.copy(pos);
    this.patrolTarget.copy(pos);
    scene.add(this.root);
    // 注：此处不可调用 buildBody/applyPose——子类字段此时尚未初始化（同 BossBase）；
    // 子类构造函数在 super() 之后调用 this.assemble() 完成搭建
  }

  /** 子类构造函数末尾调用：搭建外观并应用初始姿态 */
  protected assemble(): void {
    this.buildBody();
    this.applyPose();
  }

  // ---------------- 子类定制点 ----------------
  /** 外观搭建：网格挂 this.root（用 this.box 共享缓存） */
  protected abstract buildBody(): void;
  /** 把 yaw/姿态写到骨架（update 每帧末尾调用） */
  protected abstract applyPose(): void;
  /** 每帧视觉（拍翅/悬停/呼吸），状态机之前调用 */
  protected abstract updateVisuals(dt: number): void;
  /** 招式姿态：tel/act/rec 三段（t 为段内计时） */
  protected abstract movePose(m: MoveDef, sub: EnemySub, t: number): void;
  /** 瘫倒姿态（dead 前 0.8s） */
  protected abstract updateDeathPose(dt: number): void;
  /** 选招：按距离+冷却，返回 null 则继续逼近 */
  protected abstract pickMove(dist: number): MoveDef | null;
  /** 战斗 idle 步进（转身/逼近/拉开；crow 覆写为飞行绕行） */
  protected combatStep(dt: number, to: THREE.Vector3, dist: number, dirYaw: number): void {
    this.turnToward(dirYaw, dt, 1);
    if (dist > this.stats.preferredDist) {
      this.root.position.addScaledVector(to, this.stats.combatSpeed * dt);
      this.onWalk(dt);
    }
  }
  /** 步态（走路时每帧调用） */
  protected onWalk(dt: number): void { this.walking = true; this.walkPhase += dt * 7; }

  /** 冷却过滤 + 权重抽取（子类 pickMove 用） */
  protected weightedPick(pool: [MoveDef, number][]): MoveDef | null {
    const cands = pool.filter(([m, w]) => w > 0 && (this.cds[m.name] ?? 0) <= 0);
    if (!cands.length) return null;
    const sum = cands.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * sum;
    for (const [m, w] of cands) { r -= w; if (r <= 0) return m; }
    return cands[0][0];
  }

  // ---------------- 通用工具 ----------------
  protected turnToward(dirYaw: number, dt: number, mul = 1): void {
    let d = dirYaw - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.yaw += clampMag(d, this.stats.turnRate * mul * dt);
  }
  /** 受击粒子/背刺锚点 */
  hitPoint(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(this.root.position.x, this.root.position.y + this.stats.hitY, this.root.position.z);
  }
  /** 共享缓存方盒（castShadow 开） */
  protected box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
    const mesh = new THREE.Mesh(boxGeo(w, h, d), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    return mesh;
  }
  get alive(): boolean { return this.state !== "dead" && !this.gone; }

  // ---------------- 公共 API ----------------
  /** 玩家命中敌人。fromDir=玩家→敌人方向（击退用）。返回 blocked=打盾被弹开（不掉血）。
   *  opts.isKick：正面盾挡被踢崩（按本次伤害掉血，结束格挡）。opts.launcher：向上浮空，落回 y=0 结束。 */
  takeHit(dmg: number, poise = 0, feelKey = "pR1a", fromDir?: THREE.Vector3, opts?: { isKick?: boolean; launcher?: boolean }): { died: boolean; blocked: boolean } {
    void poise;   // 小怪无削韧系统：受击即打断（hurtT），见 enemies.md
    if (this.state === "dead" || this.gone) return { died: false, blocked: false };
    // 盾挡：持盾敌人在盾挡姿态 act 窗口内、攻击来自正面。普通攻击弹开；踢击打崩该姿态。
    const guarding = !!(this.stats.guard && this.state === "combat" && this.sub === "act" && this.move?.name === this.stats.guardMove);
    const frontal = !fromDir || angleWithin(Math.atan2(fromDir.x, fromDir.z), this.yaw + Math.PI, 1.1);
    if (guarding && frontal && !opts?.isKick) {
      this.host.onHit("eGuard", this.hitPoint());
      return { died: false, blocked: true };
    }
    const brokeGuard = guarding && frontal && !!opts?.isKick;
    this.hp = Math.max(0, this.hp - dmg);
    this.host.onHit(feelKey, this.hitPoint());
    if (this.hp <= 0) { this.die(); return { died: true, blocked: false }; }
    if (brokeGuard) {
      // 踢击打崩盾挡：掉血就是这次传入的伤害，结束格挡姿态，硬直长于普通受击 0.22s
      this.hurtT = 0.6;
      this.sub = "idle";
      this.move = null;
      this.t = 0;
    } else {
      // 受击硬直 + 打断前摇/后摇（判定段已出招不打断）
      this.hurtT = 0.22;
      if (this.state === "idle" || this.state === "alert") { this.state = "combat"; this.sub = "idle"; }
      if (this.sub === "tel" || this.sub === "rec") { this.sub = "idle"; this.move = null; }
    }
    if (fromDir) this.root.position.addScaledVector(fromDir, 0.25);
    if (opts?.launcher) this.beginLaunch();
    return { died: false, blocked: false };
  }

  /** 上挑：只给向上初速。重力与玩家击飞相同（18），地面敌人约 0.67s 落回 y=0。不加水平速度。 */
  private beginLaunch(): void {
    if (!this.airborne) this.launchY = Math.max(0, this.root.position.y);
    this.airborne = true;
    this.launchVy = 6;
  }

  /** 浮空只写 root.y。察觉距离、视锥、alert 0.45s、脱战 16m 都不在这里改。 */
  private stepLaunch(dt: number): void {
    if (!this.airborne || this.state === "dead") return;
    this.launchVy -= 18 * dt;
    this.launchY += this.launchVy * dt;
    if (this.launchY <= 0) {
      this.launchY = 0;
      this.launchVy = 0;
      this.airborne = false;
    }
    this.root.position.y = this.launchY;
    this.onFloatY(this.launchY);
  }

  /** 子类同步自身高度缓存。乌鸦用它把 flyY 跟到浮空高度，落地后从 0 爬回悬停。 */
  protected onFloatY(y: number): void { void y; }

  /** 背刺：玩家在敌人背后 ±backstabArc、距离 ≤ backstabRange、敌人非判定段 → 一次 3× 伤害 + 1.2s 硬直。
   *  game 接线：interact 里对最近敌人调用（或走 EnemyManager.tryBackstab） */
  tryBackstab(playerPos: THREE.Vector3, playerYaw: number): { dmg: number; died: boolean } | null {
    if (this.state === "dead" || this.state === "backstab" || this.gone) return null;
    if (this.state === "combat" && this.sub === "act") return null;
    const to = new THREE.Vector3().subVectors(playerPos, this.root.position);
    to.y = 0;
    if (to.length() > this.stats.backstabRange + this.stats.radius) return null;
    const dirYaw = Math.atan2(to.x, to.z);
    if (!angleWithin(dirYaw, this.yaw + Math.PI, this.stats.backstabArc)) return null;   // 必须在背后
    if (!angleWithin(playerYaw, dirYaw + Math.PI, 1.3)) return null;                      // 玩家需大致面向敌人（±75°）
    this.hp = Math.max(0, this.hp - this.stats.backstabDmg);
    this.host.onHit("pRip", this.hitPoint());   // 处决级六通道手感
    const died = this.hp <= 0;
    if (died) this.die();
    else { this.state = "backstab"; this.sub = "idle"; this.move = null; this.t = 0; }
    return { dmg: this.stats.backstabDmg, died };
  }

  /** 销毁：几何/材质为模块级共享缓存，这里只摘树（场景切换时由模块生命周期兜底） */
  dispose(): void {
    this.root.removeFromParent();
    this.gone = true;
  }

  protected die(): void {
    this.state = "dead"; this.sub = "idle"; this.move = null; this.t = 0;
    this.airborne = false;
    this.launchVy = 0;
    this.host.onDeath(this.stats.souls, this.root.position.clone());
  }

  // ---------------- 主更新 ----------------
  update(dt: number, playerPos: THREE.Vector3, playerIframed: boolean, room: BossRoomSeal | null = null): void {
    for (const k in this.cds) this.cds[k] = Math.max(0, this.cds[k] - dt);
    if (this.hurtT > 0) this.hurtT -= dt;
    this.elapsed += dt;
    this.walking = false;
    this.updateVisuals(dt);

    // 人在封门圆内：房外小怪退出 alert/combat，本帧不再朝玩家迈步进圆
    if ((this.state === "alert" || this.state === "combat") && playerShutOut(room, this.root.position.x, this.root.position.z)) {
      this.state = "idle";
      this.sub = "idle";
      this.move = null;
      this.t = 0;
      this.patrolT = 0;
    }

    switch (this.state) {
      case "idle": this.updateIdle(dt, playerPos, room); break;
      case "alert": {
        this.t += dt;
        const dirYaw = this.dirYawTo(playerPos);
        this.turnToward(dirYaw, dt, 2);
        if (this.t >= 0.45) { this.state = "combat"; this.sub = "idle"; this.t = 0; }
        break;
      }
      case "combat": this.updateCombat(dt, playerPos, playerIframed); break;
      case "backstab":
        this.t += dt;
        if (this.t >= 1.2) {
          this.sub = "idle";
          this.t = 0;
          if (playerShutOut(room, this.root.position.x, this.root.position.z)) {
            this.state = "idle";
            this.move = null;
            this.patrolT = 0;
          } else this.state = "combat";
        }
        break;
      case "dead": {
        this.t += dt;
        if (this.t < 0.8) this.updateDeathPose(dt);
        else {
          this.root.position.y -= dt * 0.9;          // 沉入地面
          if (this.t >= 1.8) this.dispose();         // 摘树，管理器随后移除
        }
        break;
      }
    }
    this.stepLaunch(dt);
    this.applyPose();
  }

  private dirYawTo(playerPos: THREE.Vector3): number {
    const dx = playerPos.x - this.root.position.x;
    const dz = playerPos.z - this.root.position.z;
    return Math.atan2(dx, dz);
  }

  /** idle：察觉（视锥）+ 巡逻 */
  protected updateIdle(dt: number, playerPos: THREE.Vector3, room: BossRoomSeal | null = null): void {
    const to = new THREE.Vector3().subVectors(playerPos, this.root.position);
    to.y = 0;
    const dist = to.length();
    const dirYaw = Math.atan2(to.x, to.z);
    // 玩家入 aggroRange 且在视锥内（贴身 2.2m 全向察觉）→ alert。封门圆内不拉房外仇恨。
    if (!playerShutOut(room, this.root.position.x, this.root.position.z) && dist < this.stats.aggroRange && (angleWithin(this.yaw, dirYaw, this.stats.fov) || dist < 2.2)) {
      this.state = "alert"; this.t = 0;
      AU.telegraph();
      return;
    }
    if (this.stats.patrol <= 0) return;   // 站桩（守位侍从）
    // 巡逻：绕出生点闲逛。目标不许落在 Boss 房圆内。
    this.patrolT -= dt;
    if (this.patrolT <= 0) {
      const a = Math.random() * Math.PI * 2;
      const r = this.stats.patrol * (0.3 + Math.random() * 0.7);
      this.patrolTarget.set(this.spawnPos.x + Math.sin(a) * r, 0, this.spawnPos.z + Math.cos(a) * r);
      this.patrolT = 2.5 + Math.random() * 3;
    }
    if (room) {
      const p = pushXZOut(this.patrolTarget.x, this.patrolTarget.z, room);
      this.patrolTarget.set(p.x, 0, p.z);
    }
    const toT = new THREE.Vector3().subVectors(this.patrolTarget, this.root.position);
    toT.y = 0;
    if (toT.length() > 0.25) {
      this.turnToward(Math.atan2(toT.x, toT.z), dt, 0.6);
      this.root.position.addScaledVector(toT.normalize(), this.stats.walkSpeed * 0.55 * dt);
      this.onWalk(dt * 0.7);
    }
  }

  protected updateCombat(dt: number, playerPos: THREE.Vector3, playerIframed: boolean): void {
    const to = new THREE.Vector3().subVectors(playerPos, this.root.position);
    to.y = 0;
    const dist = to.length();
    const dirYaw = Math.atan2(to.x, to.z);
    // 脱战：玩家远离 16m → 回巡逻
    if (dist > 16) { this.state = "idle"; this.sub = "idle"; this.move = null; this.patrolT = 0; return; }

    if (this.sub === "idle") {
      if (this.hurtT <= 0) {
        this.combatStep(dt, to.clone().normalize(), dist, dirYaw);
        if ((this.cds["gap"] ?? 0) <= 0) {
          const pick = this.pickMove(dist);
          if (pick) this.startMove(pick, to, dist);
        }
      }
      return;
    }

    const m = this.move as MoveDef;
    this.t += dt;

    if (this.sub === "tel") {
      this.movePose(m, "tel", this.t);
      if (m.lunge) {
        // 前冲放前摇后 60%：act 起点已贴近玩家（同 vordtCharge 思路，range 判定即真实接触）
        const k = smooth(seg(this.t, m.startup * 0.4, m.startup));
        this.root.position.lerpVectors(this.lungeFrom, this.lungeTo, k);
      }
      if (this.t >= m.startup) {
        this.sub = "act"; this.t = 0;
        AU.whoosh(1);
        if (m.dmg > 0) this.onMoveActive(m);
      }
      return;
    }

    if (this.sub === "act") {
      this.movePose(m, "act", this.t);
      // 多段判定：第 k 段在 active*0.4 + k*hitInterval 触发（与 BossBase 同式，hits=1 退化为单段）
      const hits = m.hits ?? 1;
      const firstAt = m.active * 0.4;
      const interval = m.hitInterval ?? 0.45;
      while (this.hitFired < hits && this.t >= Math.min(firstAt + this.hitFired * interval, m.active)) {
        this.hitFired++;
        if (m.dmg > 0 && dist <= m.range + 0.35 && angleWithin(this.yaw, dirYaw, m.arc / 2) && !playerIframed) {
          this.host.onHitPlayer(m.dmg, to.clone().normalize(), m);
        }
      }
      if (this.t >= m.active) { this.sub = "rec"; this.t = 0; }
      return;
    }

    // rec
    this.movePose(m, "rec", this.t);
    if (this.t >= m.recovery) {
      this.sub = "idle"; this.move = null;
      this.cds["gap"] = 0.35;   // 招间小停顿，避免无缝连发
    }
  }

  protected startMove(m: MoveDef, toPlayer: THREE.Vector3, dist: number): void {
    this.move = m; this.sub = "tel"; this.t = 0; this.hitFired = 0;
    this.cds[m.name] = m.cd;
    if (m.lunge) {
      this.lungeFrom.copy(this.root.position);
      const step = Math.min(m.lunge, Math.max(0, dist - 0.9));   // 不冲过玩家
      this.lungeTo.copy(this.root.position).addScaledVector(toPlayer.clone().normalize(), step);
    }
    AU.telegraph();
  }

  /** 判定段开始的挥砍轨迹（子类按武器挂） */
  protected onMoveActive(m: MoveDef): void { void m; }
}

// ================================================================
// 活尸 Hollow（灰烬墓地）：佝偻烂剑兵——慢速逼近，单挥/二连，背刺可秒
// ================================================================
export class Hollow extends EnemyBase {
  private body = new THREE.Group();
  private torso = new THREE.Group();
  private headG = new THREE.Group();
  private armR = new THREE.Group();
  private armL = new THREE.Group();
  private legR = new THREE.Group();
  private legL = new THREE.Group();
  private swordG = new THREE.Group();
  private eyeMat!: THREE.MeshStandardMaterial;

  constructor(scene: THREE.Scene, vfx: Vfx, pos: THREE.Vector3, host: EnemyHost, facing = -Math.PI / 2) {
    super(scene, vfx, pos, host, ENEMY_STATS.hollow, facing);
    this.assemble();
  }

  protected override buildBody(): void {
    const flesh = mat("hollow.flesh", () => new THREE.MeshStandardMaterial({ color: 0x6e6757, roughness: 1, flatShading: true }));
    const rags = mat("hollow.rags", () => new THREE.MeshStandardMaterial({ color: 0x39352c, roughness: 1, flatShading: true }));
    const rust = mat("hollow.rust", () => new THREE.MeshStandardMaterial({ color: 0x574f40, roughness: 0.85, metalness: 0.15, flatShading: true }));
    this.eyeMat = mat("hollow.eye", () => new THREE.MeshStandardMaterial({ color: 0x100c0a, emissive: 0xff8c3a, emissiveIntensity: 0.45, roughness: 0.5 }));

    // 腿（细瘦弯膝）
    for (const [g, sx] of [[this.legR, 1], [this.legL, -1]] as [THREE.Group, number][]) {
      g.position.set(sx * 0.12, 0.66, 0);
      g.add(this.box(0.13, 0.62, 0.16, rags, 0, -0.32, 0));
      this.body.add(g);
    }
    // 躯干（佝偻前倾）+ 破布
    this.torso.position.set(0, 0.92, 0);
    this.torso.add(this.box(0.4, 0.5, 0.26, flesh, 0, 0.12, 0));
    this.torso.add(this.box(0.44, 0.3, 0.3, rags, 0, -0.16, 0));
    // 头 + 兜帽 + 余烬眼
    this.headG.position.set(0, 0.44, 0.06);
    this.headG.add(this.box(0.2, 0.22, 0.22, flesh));
    this.headG.add(this.box(0.26, 0.13, 0.26, rags, 0, 0.13, -0.03));
    this.headG.add(this.box(0.05, 0.035, 0.02, this.eyeMat, 0.055, 0.02, 0.11));
    this.headG.add(this.box(0.05, 0.035, 0.02, this.eyeMat, -0.055, 0.02, 0.11));
    this.torso.add(this.headG);
    // 右臂 + 烂剑（缺半截的锈刃）
    this.armR.position.set(0.24, 0.34, 0);
    this.armR.add(this.box(0.11, 0.5, 0.12, flesh, 0, -0.22, 0));
    this.swordG.position.set(0, -0.5, 0.04);
    const blade = this.box(0.05, 0.66, 0.014, rust, 0, 0.28, 0.08);
    blade.rotation.x = 0.35;
    this.swordG.add(this.box(0.09, 0.05, 0.05, rust, 0, -0.06, 0), blade);
    this.armR.add(this.swordG);
    this.torso.add(this.armR);
    // 左臂（爪状前伸）
    this.armL.position.set(-0.24, 0.34, 0);
    this.armL.add(this.box(0.1, 0.48, 0.11, flesh, 0, -0.2, 0));
    this.torso.add(this.armL);
    this.body.add(this.torso);
    this.root.add(this.body);
  }

  protected override updateVisuals(dt: number): void {
    void dt;
    this.eyeMat.emissiveIntensity = 0.45 + Math.sin(this.elapsed * 3.1) * 0.15;
    this.body.position.y = this.walking ? Math.abs(Math.sin(this.walkPhase)) * 0.04 : Math.sin(this.elapsed * 1.7) * 0.015;
  }

  protected override movePose(m: MoveDef, sub: EnemySub, t: number): void {
    void m; void sub; void t;   // 挥剑姿态在 applyPose 内按 move/sub/t 统一解算
  }

  protected override applyPose(): void {
    this.root.rotation.y = this.yaw;
    // 站姿基准：佝偻、烂剑下垂
    let hunch = 0.42, twist = 0, armRx = -0.5, armRz = 0.15, headX = -0.22;
    if (this.walking) {
      this.legR.rotation.x = Math.sin(this.walkPhase) * 0.55;
      this.legL.rotation.x = -Math.sin(this.walkPhase) * 0.55;
    } else { this.legR.rotation.x = this.legL.rotation.x = 0; }

    const m = this.move;
    if (this.state === "combat" && m) {
      if (m.name === "hollowSlash" || m.name === "hollowDouble") {
        if (this.sub === "tel") {
          const k = smooth(seg(this.t, m.startup * 0.3, m.startup));
          armRx = -0.5 + (-2.1) * k; twist = 0.55 * k; hunch += 0.12 * k;
        } else if (this.sub === "act") {
          const k = smooth(seg(this.t, 0, m.active * 0.7));
          armRx = -2.6 + 3.4 * k; twist = 0.55 - 0.95 * k; hunch += 0.12 + 0.2 * k;
          // 二连：第二段反手回撩
          if (m.name === "hollowDouble" && this.hitFired >= 1) {
            armRx = 0.8 - 2.6 * smooth(seg(this.t, m.hitInterval ?? 0.24, (m.hitInterval ?? 0.24) + 0.18));
            twist = -0.4 + 0.7 * smooth(seg(this.t, m.hitInterval ?? 0.24, (m.hitInterval ?? 0.24) + 0.18));
          }
        } else {
          const k = smooth(seg(this.t, 0, m.recovery * 0.7));
          armRx = 0.8 - 1.3 * k; twist = -0.4 + 0.4 * k; hunch += 0.32 - 0.32 * k;
        }
      }
    } else if (this.state === "alert") { armRx = -1.3; twist = 0.2; }
    else if (this.state === "backstab") { hunch = 1.0 + Math.min(0.3, this.t * 0.5); armRx = 1.2; armRz = 0.6; headX = 0.4; }
    else if (this.state === "dead") { hunch = 1.35; armRx = 1.5; armRz = 0.9; headX = 0.55; twist = 0.3; }

    // 受击：佝偻躯干甩成短后仰，双肩内收。hurtT 归零后回到上面算出的姿态。
    let armLz = -0.2;
    if (this.hurtT > 0 && this.state !== "dead") {
      hunch -= 0.8;
      headX -= 0.35;
      armRx += 0.4;
      armRz -= 0.55;
      armLz = 0.35;
    }
    this.torso.rotation.set(hunch, twist, 0);
    this.headG.rotation.x = headX;
    this.armR.rotation.set(armRx, 0, armRz);
    this.armL.rotation.set(-0.45 - hunch * 0.3, 0, armLz);
    this.swordG.rotation.x = 0.5;
  }

  protected override updateDeathPose(dt: number): void {
    if (Math.random() < dt * 8) this.vfx.dust.burst(this.hitPoint(), 3, 1.5, 0.5);
  }

  protected override pickMove(dist: number): MoveDef | null {
    if (dist > 2.5) return null;
    return this.weightedPick([
      [MOVES_ENEMY.hollowSlash, 3],
      [MOVES_ENEMY.hollowDouble, 2],
    ]);
  }

  protected override onMoveActive(m: MoveDef): void {
    if (m.dmg > 0) this.vfx.slash(this.hitPoint(), this.yaw, m.range * 0.75, false);
  }
}

// ================================================================
// 教堂骑士侍从 Squire（高墙）：直剑+鸢盾——三连纪律连段，盾挡弹开轻击
// ================================================================
export class Squire extends EnemyBase {
  private body = new THREE.Group();
  private torso = new THREE.Group();
  private headG = new THREE.Group();
  private armR = new THREE.Group();
  private armL = new THREE.Group();
  private swordG = new THREE.Group();
  private shieldG = new THREE.Group();
  private legR = new THREE.Group();
  private legL = new THREE.Group();

  constructor(scene: THREE.Scene, vfx: Vfx, pos: THREE.Vector3, host: EnemyHost, facing = -Math.PI / 2) {
    super(scene, vfx, pos, host, ENEMY_STATS.squire, facing);
    this.assemble();
  }

  protected override buildBody(): void {
    const plate = mat("squire.plate", () => new THREE.MeshStandardMaterial({ color: 0x4a525e, roughness: 0.55, metalness: 0.3, flatShading: true }));
    const dark = mat("squire.dark", () => new THREE.MeshStandardMaterial({ color: 0x2e333c, roughness: 0.8, flatShading: true }));
    const tabard = mat("squire.tabard", () => new THREE.MeshStandardMaterial({ color: 0x3d3a46, roughness: 1, flatShading: true }));
    const wood = mat("squire.wood", () => new THREE.MeshStandardMaterial({ color: 0x54432e, roughness: 0.9, flatShading: true }));
    const steel = mat("squire.steel", () => new THREE.MeshStandardMaterial({ color: 0x8f99a3, roughness: 0.4, metalness: 0.5, flatShading: true }));

    // 腿 + 铁靴
    for (const [g, sx] of [[this.legR, 1], [this.legL, -1]] as [THREE.Group, number][]) {
      g.position.set(sx * 0.15, 0.78, 0);
      g.add(this.box(0.16, 0.7, 0.18, dark, 0, -0.36, 0));
      g.add(this.box(0.18, 0.12, 0.3, plate, 0, -0.72, 0.05));
      this.body.add(g);
    }
    // 躯干：胸甲 + 前襟披布（教堂纹样留白）
    this.torso.position.set(0, 1.08, 0);
    this.torso.add(this.box(0.46, 0.52, 0.3, plate, 0, 0.14, 0));
    this.torso.add(this.box(0.3, 0.5, 0.06, tabard, 0, -0.06, 0.17));
    // 头：桶盔 + 观察缝
    this.headG.position.set(0, 0.52, 0);
    this.headG.add(this.box(0.26, 0.28, 0.28, plate));
    this.headG.add(this.box(0.27, 0.05, 0.06, dark, 0, 0.03, 0.13));
    this.torso.add(this.headG);
    // 肩甲
    this.torso.add(this.box(0.2, 0.14, 0.32, steel, 0.3, 0.36, 0), this.box(0.2, 0.14, 0.32, steel, -0.3, 0.36, 0));
    // 右臂 + 直剑（十字护手）
    this.armR.position.set(0.3, 0.3, 0);
    this.armR.add(this.box(0.13, 0.5, 0.14, dark, 0, -0.22, 0));
    this.swordG.position.set(0, -0.5, 0.02);
    this.swordG.add(
      this.box(0.05, 0.85, 0.015, steel, 0, 0.4, 0.05),     // 刃
      this.box(0.2, 0.04, 0.05, steel, 0, -0.04, 0.05),     // 护手
    );
    this.armR.add(this.swordG);
    this.torso.add(this.armR);
    // 左臂 + 鸢盾
    this.armL.position.set(-0.3, 0.3, 0);
    this.armL.add(this.box(0.13, 0.5, 0.14, dark, 0, -0.22, 0));
    this.shieldG.position.set(0, -0.35, 0.1);
    this.shieldG.add(this.box(0.05, 0.62, 0.46, wood));
    this.shieldG.add(this.box(0.06, 0.1, 0.48, steel, 0, 0.26, 0));
    this.armL.add(this.shieldG);
    this.torso.add(this.armL);
    this.body.add(this.torso);
    this.root.add(this.body);
  }

  protected override updateVisuals(dt: number): void {
    this.body.position.y = this.walking ? Math.abs(Math.sin(this.walkPhase)) * 0.035 : 0;
    void dt;
  }

  protected override movePose(m: MoveDef, sub: EnemySub, t: number): void {
    void m; void sub; void t;
  }

  protected override applyPose(): void {
    this.root.rotation.y = this.yaw;
    // 站姿基准：立正持盾，剑尖朝下斜
    let hunch = 0.08, twist = 0, armRx = -0.4, armLx = -1.0, armLy = 0.5, reach = 0;
    let armRz = 0.1, armLz = -0.15;
    if (this.walking) {
      this.legR.rotation.x = Math.sin(this.walkPhase) * 0.4;
      this.legL.rotation.x = -Math.sin(this.walkPhase) * 0.4;
    } else { this.legR.rotation.x = this.legL.rotation.x = 0; }

    const m = this.move;
    if (this.state === "combat" && m) {
      if (m.name === "squireCombo") {
        if (this.sub === "tel") {
          const k = smooth(seg(this.t, m.startup * 0.3, m.startup));
          armRx = -0.4 - 1.7 * k; twist = 0.55 * k;
        } else if (this.sub === "act") {
          // 三连：横斩 → 回斩 → 突刺（按判定段切换，与 hitFired 对齐）
          const seg1 = smooth(seg(this.t, 0, 0.2));
          const seg2 = smooth(seg(this.t, m.hitInterval ?? 0.22, (m.hitInterval ?? 0.22) + 0.2));
          const seg3 = smooth(seg(this.t, (m.hitInterval ?? 0.22) * 2, (m.hitInterval ?? 0.22) * 2 + 0.18));
          armRx = -2.1 + 2.6 * seg1 - 3.4 * seg2 + 2.9 * seg3;
          twist = 0.55 - 1.15 * seg1 + 1.6 * seg2 - 0.9 * seg3;
          reach = 0.25 * seg3; hunch = 0.08 + 0.18 * seg3;
        } else {
          const k = smooth(seg(this.t, 0, m.recovery * 0.7));
          armRx = 0.8 - 1.2 * k; twist = -0.35 + 0.35 * k; hunch = 0.26 - 0.18 * k; reach = 0.25 * (1 - k);
        }
      } else if (m.name === "squireGuard") {
        // 盾挡姿态：举盾护中、微蹲
        if (this.sub === "tel") {
          const k = smooth(seg(this.t, 0, m.startup));
          armLx = -1.0 - 0.5 * k; armLy = 0.5 - 0.5 * k; hunch = 0.08 + 0.1 * k;
        } else if (this.sub === "act") {
          armLx = -1.5; armLy = 0; hunch = 0.18;
          armLx += Math.sin(this.t * 3) * 0.03;   // 持盾微颤
        } else {
          const k = smooth(seg(this.t, 0, m.recovery));
          armLx = -1.5 + 0.5 * k; armLy = 0.5 * k; hunch = 0.18 - 0.1 * k;
        }
      }
    } else if (this.state === "alert") { armRx = -1.2; armLx = -1.2; }
    else if (this.state === "backstab") { hunch = 0.7 + Math.min(0.3, this.t * 0.5); armLx = -0.3; armRx = 0.8; }
    else if (this.state === "dead") { hunch = 1.2; armLx = 0.4; armRx = 1.0; twist = 0.35; }

    // 受击：胸甲短促后仰，剑臂与盾臂同时收肩。hurtT 归零后回到上面算出的姿态。
    if (this.hurtT > 0 && this.state !== "dead") {
      hunch -= 0.8;
      armRx += 0.45;
      armLx += 0.6;
      armRz = -0.55;
      armLz = 0.5;
    }
    this.torso.rotation.set(hunch, twist, 0);
    this.torso.position.z = reach;
    this.headG.rotation.x = -hunch * 0.5;
    this.armR.rotation.set(armRx, 0, armRz);
    this.armL.rotation.set(armLx, armLy, armLz);
  }

  protected override updateDeathPose(dt: number): void {
    if (Math.random() < dt * 8) this.vfx.dust.burst(this.hitPoint(), 3, 1.5, 0.5);
  }

  protected override pickMove(dist: number): MoveDef | null {
    if (dist > 2.8) return null;
    return this.weightedPick([
      [MOVES_ENEMY.squireCombo, 3],
      [MOVES_ENEMY.squireGuard, 1.2],
    ]);
  }

  protected override onMoveActive(m: MoveDef): void {
    if (m.name === "squireCombo") this.vfx.slash(this.hitPoint(), this.yaw, m.range * 0.72, false, 0xcfd8e8);
  }
}

// ================================================================
// 咒腐乌鸦 Crow（高墙）：飞行单位——y≈1.2 悬停巡飞，扑击贴身 / 俯冲突进
// ================================================================
export class Crow extends EnemyBase {
  private bodyG = new THREE.Group();
  private headG = new THREE.Group();
  private wingL = new THREE.Group();
  private wingR = new THREE.Group();
  private tail = new THREE.Group();
  private flapPhase = 0;
  private flyY = 1.2;           // 当前飞行高度（弹性趋近目标）
  private eyeMat!: THREE.MeshStandardMaterial;

  constructor(scene: THREE.Scene, vfx: Vfx, pos: THREE.Vector3, host: EnemyHost, facing = -Math.PI / 2) {
    super(scene, vfx, pos, host, ENEMY_STATS.crow, facing);
    this.flyY = ENEMY_STATS.crow.hover ?? 1.2;
    this.assemble();
  }

  protected override buildBody(): void {
    const feather = mat("crow.feather", () => new THREE.MeshStandardMaterial({ color: 0x241f28, roughness: 0.95, flatShading: true }));
    const beakM = mat("crow.beak", () => new THREE.MeshStandardMaterial({ color: 0x4a4034, roughness: 0.7, flatShading: true }));
    this.eyeMat = mat("crow.eye", () => new THREE.MeshStandardMaterial({ color: 0x140a08, emissive: 0xb0542f, emissiveIntensity: 0.8, roughness: 0.4 }));

    // 躯体（浑圆佝偻）+ 头喙 + 咒火红眼
    this.bodyG.add(this.box(0.36, 0.34, 0.6, feather, 0, 0, 0));
    this.headG.position.set(0, 0.12, 0.36);
    this.headG.add(this.box(0.22, 0.2, 0.22, feather));
    this.headG.add(this.box(0.06, 0.06, 0.18, beakM, 0, -0.02, 0.18));
    this.headG.add(this.box(0.045, 0.045, 0.02, this.eyeMat, 0.07, 0.05, 0.1));
    this.headG.add(this.box(0.045, 0.045, 0.02, this.eyeMat, -0.07, 0.05, 0.1));
    this.bodyG.add(this.headG);
    // 双翼（侧群组，rotation.z 扑扇）
    this.wingR.position.set(0.17, 0.06, 0);
    this.wingR.add(this.box(0.52, 0.04, 0.32, feather, 0.27, 0, -0.02));
    this.wingL.position.set(-0.17, 0.06, 0);
    this.wingL.add(this.box(0.52, 0.04, 0.32, feather, -0.27, 0, -0.02));
    this.bodyG.add(this.wingR, this.wingL);
    // 尾羽（扇状）
    this.tail.position.set(0, 0.04, -0.34);
    this.tail.add(this.box(0.3, 0.04, 0.4, feather, 0, 0.02, -0.2));
    this.bodyG.add(this.tail);
    // 收拢的爪
    this.bodyG.add(this.box(0.05, 0.16, 0.05, beakM, 0.08, -0.22, 0.08), this.box(0.05, 0.16, 0.05, beakM, -0.08, -0.22, 0.08));
    this.root.add(this.bodyG);
  }

  protected override updateVisuals(dt: number): void {
    // 悬停高度：按状态定目标，弹性趋近（扑击/俯冲压低、俯冲前爬升）
    let ty = (this.stats.hover ?? 1.2) + Math.sin(this.elapsed * 2.1) * 0.08;
    let rate = 6;
    const m = this.move;
    if (this.state === "combat" && m && (m.name === "crowPounce" || m.name === "crowDive")) {
      if (this.sub === "tel") { ty = (this.stats.hover ?? 1.2) + (m.name === "crowDive" ? 0.5 : 0.25); rate = 5; }
      else if (this.sub === "act") { ty = m.name === "crowDive" ? 0.35 : 0.5; rate = 14; }
      else { rate = 5; }
    }
    if (this.state !== "dead") {
      this.flyY += (ty - this.flyY) * Math.min(1, dt * rate);
      this.root.position.y = this.flyY;
    }
    // 拍翅：战斗中更急促
    this.flapPhase += dt * (this.state === "combat" ? 13 : 8);
    const flap = Math.sin(this.flapPhase) * (this.state === "dead" ? 0.1 : 0.55);
    this.wingR.rotation.z = -0.25 - flap;
    this.wingL.rotation.z = 0.25 + flap;
    this.eyeMat.emissiveIntensity = 0.8 + Math.sin(this.elapsed * 5) * 0.25;
  }

  protected override onFloatY(y: number): void { this.flyY = y; }

  protected override movePose(m: MoveDef, sub: EnemySub, t: number): void {
    // 俯仰：扑击/俯冲 tel 仰头爬升、act 头朝下扑咬、rec 拉起
    let pitch = 0;
    if (sub === "tel") pitch = -0.3 * smooth(seg(t, 0, m.startup));
    else if (sub === "act") pitch = m.name === "crowDive" ? 0.85 : 0.5;
    else pitch = -0.15 * smooth(seg(t, 0, m.recovery));
    if (m.name !== "crowPounce" && m.name !== "crowDive") pitch = 0;
    this.bodyG.rotation.x = pitch;
    this.tail.rotation.x = pitch * 0.5;
  }

  protected override applyPose(): void {
    this.root.rotation.y = this.yaw;
    if (this.state !== "combat") this.bodyG.rotation.x *= 0.9;   // 非战斗段俯仰缓回
    // 受击：整鸟短促后仰，双翼上收。不改 bodyG 俯仰（扑击仍归 movePose）。
    // hurtT 归零后根节点俯仰归零，翅膀交回 updateVisuals 的扑扇。
    if (this.hurtT > 0 && this.state !== "dead") {
      this.root.rotation.x = -0.7;
      this.headG.rotation.x = -0.35;
      this.wingR.rotation.z = 1.2;
      this.wingL.rotation.z = -1.2;
    } else {
      this.root.rotation.x = 0;
      this.headG.rotation.x = 0;
    }
  }

  /** 飞行步进：逼近到站距外，被贴脸（<1.8m）则拉开距离重新起飞 */
  protected override combatStep(dt: number, to: THREE.Vector3, dist: number, dirYaw: number): void {
    this.turnToward(dirYaw, dt, 1);
    if (dist > this.stats.preferredDist) {
      this.root.position.addScaledVector(to, this.stats.combatSpeed * dt);
    } else if (dist < 1.8) {
      this.root.position.addScaledVector(to, -this.stats.combatSpeed * 0.8 * dt);   // 拉开
    }
  }

  protected override updateDeathPose(dt: number): void {
    // 坠地：快速跌到地面（0.8s 瘫倒段内），随后基类接管沉入
    this.flyY = Math.max(0, this.flyY - 9 * dt);
    this.root.position.y = this.flyY;
    this.bodyG.rotation.x = 0.6;
    if (Math.random() < dt * 10) this.vfx.dust.burst(this.hitPoint(), 2, 1.2, 0.4);
  }

  protected override pickMove(dist: number): MoveDef | null {
    const pounce = MOVES_ENEMY.crowPounce, dive = MOVES_ENEMY.crowDive;
    if (dist < 2.8 && (this.cds[pounce.name] ?? 0) <= 0) return pounce;
    if (dist >= 3.2 && dist <= 9 && (this.cds[dive.name] ?? 0) <= 0) return dive;
    return null;   // 空中盘旋等待
  }

  protected override onMoveActive(m: MoveDef): void {
    if (m.name === "crowDive") this.vfx.dust.burst(this.hitPoint(), 4, 1.8, 0.5);
  }
}

// ================================================================
// EnemyManager：群战编排——spawn/update/clear/dispose + 玩家侧命中/背刺入口
// ================================================================
export class EnemyManager {
  readonly enemies: EnemyBase[] = [];

  constructor(private scene: THREE.Scene, private vfx: Vfx, private host: EnemyHost) {}

  /** 布怪：接受裸 kind 或完整 spec（facing/patrol 覆盖） */
  spawn(spec: EnemyKind | EnemySpawnSpec, pos: THREE.Vector3): EnemyBase {
    const s: EnemySpawnSpec = typeof spec === "string" ? { kind: spec } : spec;
    const Ctor = s.kind === "hollow" ? Hollow : s.kind === "squire" ? Squire : Crow;
    const e = new Ctor(this.scene, this.vfx, pos, this.host, s.facing ?? -Math.PI / 2);
    if (s.patrol !== undefined) e.stats.patrol = s.patrol;
    this.enemies.push(e);
    return e;
  }

  /** 主更新：状态机 + 与玩家推挤（敌人侧让位，minD 同 boss 模式；玩家侧由 game.clampWorld 对称处理）。
   *  敌人间不做碰撞（省性能）。playerIframed=true 时敌人攻击不结算（翻滚无敌帧）。
   *  room 为当前 Boss 房可走圆：本帧从圆外走进去的，沿半径推回圆外。 */
  update(dt: number, playerPos: THREE.Vector3, playerIframed = false, room: BossRoomSeal | null = null): void {
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      const x0 = e.root.position.x, z0 = e.root.position.z;
      const wasOut = !!room && bossRoomDist(x0, z0, room) >= room.r;
      e.update(dt, playerPos, playerIframed, room);
      if (e.state !== "dead") {
        const dx = playerPos.x - e.root.position.x;
        const dz = playerPos.z - e.root.position.z;
        const minD = e.stats.radius + P.playerRadius;
        const len = Math.hypot(dx, dz);
        if (len < minD && len > 1e-4) {
          const k = (minD - len) / len;
          e.root.position.x -= dx * k;
          e.root.position.z -= dz * k;
        }
        if (wasOut && room && bossRoomDist(e.root.position.x, e.root.position.z, room) < room.r) {
          const p = pushXZOut(e.root.position.x, e.root.position.z, room, x0 - room.x, z0 - room.z);
          e.root.position.x = p.x;
          e.root.position.z = p.z;
        }
      }
      if (e.gone) this.enemies.splice(i, 1);
    }
  }

  /** 玩家攻击扇面命中（几何同 player.tryHitBoss：距离+±63° 夹角）。
   *  对每个命中的敌人结算 takeHit（含盾挡弹开），返回命中/弹开数——接线侧据此给玩家格挡硬直等。
   *  def 只把 isKick / launcher 交给 takeHit。Boss 不走这条。 */
  tryHit(pos: THREE.Vector3, yaw: number, dmg: number, poise = 0, feelKey = "pR1a", def?: { isKick?: boolean; launcher?: boolean }): { hits: number; blocked: number } {
    let hits = 0, blocked = 0;
    for (const e of this.enemies) {
      if (e.state === "dead" || e.gone) continue;
      const to = new THREE.Vector3().subVectors(e.root.position, pos);
      to.y = 0;
      if (to.length() > 2.4 + e.stats.radius) continue;
      let diff = Math.atan2(to.x, to.z) - yaw;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      if (Math.abs(diff) > 1.1) continue;
      const r = e.takeHit(dmg, poise, feelKey, to.normalize(), { isKick: def?.isKick, launcher: def?.launcher });
      if (r.blocked) blocked++;
      else hits++;
    }
    return { hits, blocked };
  }

  /** 面前半角内最近的活怪，供近战软吸附。没有则 null。 */
  nearestAhead(from: THREE.Vector3, yaw: number, maxDist: number, halfAng: number): EnemyBase | null {
    let best: EnemyBase | null = null;
    let bestD = maxDist;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const dx = e.root.position.x - from.x;
      const dz = e.root.position.z - from.z;
      const d = Math.hypot(dx, dz);
      if (d > bestD || d < 0.2) continue;
      let ang = Math.atan2(dx, dz) - yaw;
      ang = Math.atan2(Math.sin(ang), Math.cos(ang));
      if (Math.abs(ang) > halfAng) continue;
      best = e;
      bestD = d;
    }
    return best;
  }

  /** 背刺入口：取距离最近且可背刺的敌人结算（game.interact 的 E 键调用） */
  tryBackstab(playerPos: THREE.Vector3, playerYaw: number): { dmg: number; died: boolean } | null {
    let best: EnemyBase | null = null;
    let bestD = Infinity;
    for (const e of this.enemies) {
      if (e.state === "dead" || e.gone) continue;
      const d = e.root.position.distanceTo(playerPos);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best?.tryBackstab(playerPos, playerYaw) ?? null;
  }

  /** 清场（篝火休息/场景切换）：全部摘树移除 */
  clear(): void {
    for (const e of this.enemies) e.dispose();
    this.enemies.length = 0;
  }

  dispose(): void { this.clear(); }
}

// 招式名→MoveDef 查找（接线侧 HUD/调试用）
export function enemyMove(name: string): MoveDef | undefined {
  return MOVES[name];
}
