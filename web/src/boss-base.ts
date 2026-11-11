/** BossBase：通用 Boss 机制基类（自 boss.ts 抽出，行为零变化）
 * 基类负责：状态机骨架（statue/rising/combat/stagger/parried/transform/dead + idle→tel→act→rec 招式循环）、
 * 削韧→破绽、弹反判定、阶段转换框架、死亡、命中判定（距离+夹角）、走近/弱追踪转向、冷却表
 * 外观/姿态/选招/唤醒与变身演出由子类实现（见 boss.ts 古达；后续玻尔多/深渊监视者/沙力万同理）
 */
import * as THREE from "three";
import { MOVES, MoveDef, BOSS } from "./config";
import { Vfx } from "./vfx";
import { AU } from "./audio";
import type { ProjDef } from "./projectile";

export type BossState = "statue" | "rising" | "combat" | "stagger" | "parried" | "transform" | "dead";

export interface BossHost {
  onBossHit: (dmg: number, dir: THREE.Vector3, point: THREE.Vector3, move: MoveDef) => void;
  onBossReveal: () => void;          // 血条亮相
  onBossTransform: (point: THREE.Vector3) => void;  // 变身震波伤害判定由 game 处理
  onBossDeath: () => void;
  shake: (amp: number) => void;
  /** 发射投射物（沙力万暗月矢等）；由 game 接到 Projectiles 池，命中自动走手感档案总线 */
  fireProjectile?: (pos: THREE.Vector3, yaw: number, def: ProjDef) => void;
}

/** Boss 通用数值（与 config.BOSS 同构；后续 Boss 各自的配置表按此形状传入） */
export interface BossStats {
  hp: number;
  poiseMax: number; poiseDecay: number; staggerDur: number; staggerMul: number;
  parriedDur: number;
  phase2At: number;          // HP 比例阈值
  walkSpeed: number; turnRate: number;
}

export abstract class BossBase {
  readonly root = new THREE.Group();

  state: BossState = "statue";
  sub = "idle";                       // combat 内: idle/tel/act/rec
  move: MoveDef | null = null;
  t = 0;
  hp: number;
  phase = 1;
  poise = 0;
  yaw: number;                        // 面向（弱追踪转向更新）

  protected cfg: BossStats;
  protected readonly facing0: number; // 初始面向（reset 恢复用）
  protected cds: Record<string, number> = {};
  protected hitDone = false;
  protected hitFired = 0;              // 多段判定已触发段数
  protected deathT = 0;
  // 变身演出时序（子类可按需覆盖）
  protected transformHitAt = 0.85;    // 震波回调时刻
  protected transformDur = 1.8;       // 演出总时长，到点切回 combat

  protected constructor(scene: THREE.Scene, protected vfx: Vfx, pos: THREE.Vector3, protected host: BossHost, cfg: BossStats = BOSS, facing = -Math.PI / 2) {
    this.cfg = cfg;
    this.hp = cfg.hp;
    this.facing0 = facing;
    this.yaw = facing;
    this.root.position.copy(pos);
    scene.add(this.root);
    // 注：此处不可调用 buildBody/applyPose——子类字段此时尚未初始化；
    // 子类构造函数在 super() 之后调用 this.assemble() 完成搭建
  }

  /** 子类构造函数末尾调用：搭建外观并应用初始姿态 */
  protected assemble(): void {
    this.buildBody();
    this.applyPose();
  }

  // ---------------- 子类必须实现（abstract 定制点） ----------------
  /** 外观搭建：石像/武器/特效网格，全部挂到 this.root 之下 */
  protected abstract buildBody(): void;
  /** 姿态应用：把 yaw/内部姿态写到骨架（update 每帧末尾调用） */
  protected abstract applyPose(): void;
  /** 命中锚点（受击粒子/挥砍起点） */
  protected abstract chestPart(): THREE.Object3D;
  /** 锁定锚点（HUD 锁定标记投影） */
  protected abstract headPart(): THREE.Object3D;
  /** 选招：按距离/冷却/阶段选招，返回 null 则本帧继续 idle（走近+转向） */
  protected abstract pickMove(dist: number): MoveDef | null;
  /** 招式姿态动画：tel/act/rec 三段（t 为段内计时，total 为整招时长） */
  protected abstract movePose(m: MoveDef, sub: string, t: number, total: number): void;
  /** 唤醒演出（rising 状态全权交给子类）：含 this.t 推进、onBossReveal 时机与切回 combat */
  protected abstract updateRising(dt: number): void;

  // ---------------- 子类可覆盖的默认实现 ----------------
  /** 唤醒瞬间（pull 触发，statue→rising）：默认起身音 */
  protected onAwaken(): void { AU.rise(); }
  /** 每帧视觉（眼睛呼吸等），在状态机之前调用 */
  protected updateVisuals(): void { }
  /** idle 走近时每帧调用（步态起伏） */
  protected onIdleWalk(): void { }
  /** 招式被选中进入 tel 时调用（跳跃落点预计算等） */
  protected onMoveStart(m: MoveDef, toPlayer: THREE.Vector3, dist: number): void { void m; void toPlayer; void dist; }
  /** 招式 tel→act（进入判定段）：挥砍轨迹特效等（whoosh 音已在基类播） */
  protected onMoveActive(m: MoveDef): void { void m; }
  /** 判定段 whoosh 音量（重招更闷） */
  protected activeWhooshVolume(m: MoveDef): number { return m.name === "slam" || m.name === "jump" ? 0.6 : 1; }
  /** 招式名→帧数据（连段解析用）；默认共享 config.MOVES 表 */
  protected moveByName(name: string): MoveDef { return MOVES[name]; }
  /** 削韧破绽姿态（时长/火花/切回 combat 由基类管） */
  protected updateStaggerPose(): void { }
  /** 弹反踉跄姿态（时长/火花/切回 combat 由基类管） */
  protected updateParriedPose(): void { }
  /** 变身演出姿态；默认在震波时刻切二阶段（震波回调/总时长由基类管） */
  protected updateTransform(): void {
    if (this.t >= this.transformHitAt) this.phase = 2;
  }
  /** 死亡余烬（deathT 由基类推进） */
  protected updateDeath(dt: number): void {
    if (Math.random() < dt * 20) this.vfx.embers.burst(this.chestWorld(), 3, 3, 1.2);
  }
  /** reset 时恢复外观（网格可见性/材质/初始姿态），基类随后调用 applyPose */
  protected resetVisuals(): void { }
  /** 致死拦截：返回 true 则本次不死亡（深渊监视者一阶段"复活"改用 transform 状态演出） */
  protected onLethal(): boolean { return false; }

  // ---------------- 公共 API ----------------
  pull(): void {
    if (this.state !== "statue") return;
    this.state = "rising"; this.t = 0;
    this.onAwaken();
  }

  get awake(): boolean { return this.state !== "statue"; }
  get inCombat(): boolean { return this.state === "combat"; }
  /** 血量上限（HUD 比率用——各 Boss 数值表不同） */
  get maxHp(): number { return this.cfg.hp; }
  /** 数值表引用（调校台热调用；原地改写即时生效） */
  get stats(): BossStats { return this.cfg; }

  chestWorld(out = new THREE.Vector3()): THREE.Vector3 {
    return this.chestPart().getWorldPosition(out).add(CHEST_OFF);
  }
  headWorld(out = new THREE.Vector3()): THREE.Vector3 {
    return this.headPart().getWorldPosition(out);
  }

  /** 玩家命中 Boss：返回是否死亡/是否触发破绽 */
  takeHit(dmg: number, poise: number): { died: boolean; staggered: boolean } {
    if (this.state === "statue" || this.state === "dead") return { died: false, staggered: false };
    const mult = this.state === "stagger" || this.state === "parried" ? this.cfg.staggerMul : 1;
    this.hp = Math.max(0, this.hp - dmg * mult);
    if (this.hp <= 0) {
      if (this.onLethal()) return { died: false, staggered: false };   // 子类拦截致死（监视者复活演出）
      this.die(); return { died: true, staggered: false };             // 致死优先于阶段转换
    }
    if (this.phase === 1 && this.hp <= this.cfg.hp * this.cfg.phase2At && this.state !== "transform") {
      this.state = "transform"; this.t = 0; this.sub = "idle";
      AU.transform();
      return { died: false, staggered: false };
    }
    // 削韧只在正常战斗态累积——破绽期间不再累积，杜绝无限破绽循环
    if (this.state === "combat") {
      this.poise += poise;
      if (this.poise >= this.cfg.poiseMax) {
        this.poise = 0;
        this.state = "stagger"; this.sub = "idle"; this.t = 0;
        return { died: false, staggered: true };
      }
    }
    return { died: false, staggered: false };
  }

  /** 弹反判定：Boss 处于可弹反招式的判定帧前段 */
  tryParried(): boolean {
    if (this.state !== "combat" || this.sub !== "act" || !this.move || !this.move.parryable) return false;
    if (this.t > this.move.active * 0.7 || this.hitDone) return false;
    this.state = "parried"; this.sub = "idle"; this.t = 0; this.poise = 0;
    return true;
  }

  reset(): void {
    this.state = "statue"; this.sub = "idle"; this.move = null; this.t = 0;
    this.hp = this.cfg.hp; this.phase = 1; this.poise = 0; this.yaw = this.facing0;
    this.cds = {}; this.hitDone = false; this.hitFired = 0; this.deathT = 0;
    this.resetVisuals();
    this.applyPose();
  }

  /** 场景切换/再战换人时销毁：释放几何材质并摘树；子类挂在 scene 的额外对象覆写 extraDispose */
  dispose(): void {
    this.root.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry?.dispose();
        const ms = Array.isArray(m.material) ? m.material : [m.material];
        for (const mt of ms) mt?.dispose();
      }
    });
    this.root.removeFromParent();
    this.extraDispose();
  }

  /** dispose 扩展点（如沙力万投影分身挂在 scene 直下） */
  protected extraDispose(): void { }


  private die(): void {
    this.state = "dead"; this.t = 0; this.deathT = 0;
    this.host.onBossDeath();
    AU.roar();
  }

  // ---------------- 主更新 ----------------
  update(dt: number, playerPos: THREE.Vector3, playerIframed: boolean): void {
    // 冷却
    for (const k in this.cds) this.cds[k] = Math.max(0, this.cds[k] - dt);
    // 削韧衰减
    if (this.state === "combat") this.poise = Math.max(0, this.poise - this.cfg.poiseDecay * dt);
    this.updateVisuals();

    switch (this.state) {
      case "statue":
        break;
      case "rising":
        this.updateRising(dt);   // 唤醒演出全权在子类（含 t 推进与切回 combat）
        break;
      case "combat": this.updateCombat(dt, playerPos, playerIframed); break;
      case "stagger":
        this.t += dt;
        this.updateStaggerPose();
        if (Math.random() < dt * 6) this.vfx.sparks.burst(this.chestWorld(), 2, 2.5, 0.3);
        if (this.t >= this.cfg.staggerDur) { this.state = "combat"; this.sub = "idle"; this.t = 0; }
        break;
      case "parried":
        this.t += dt;
        this.updateParriedPose();
        if (Math.random() < dt * 10) this.vfx.sparks.burst(this.chestWorld(), 3, 3, 0.35);
        if (this.t >= this.cfg.parriedDur) { this.state = "combat"; this.sub = "idle"; this.t = 0; }
        break;
      case "transform": {
        this.t += dt;
        this.updateTransform();
        if (this.t > this.transformHitAt && this.t - dt <= this.transformHitAt) {
          this.host.onBossTransform(this.root.position.clone());
          this.vfx.ring(this.root.position, 5);
          this.host.shake(0.7);
        }
        if (this.t >= this.transformDur) { this.state = "combat"; this.sub = "idle"; this.t = 0; }
        break;
      }
      case "dead":
        this.deathT += dt;
        this.updateDeath(dt);
        break;
    }
    this.applyPose();
  }

  protected updateCombat(dt: number, playerPos: THREE.Vector3, playerIframed: boolean): void {
    const toPlayer = new THREE.Vector3().subVectors(playerPos, this.root.position);
    toPlayer.y = 0;
    const dist = toPlayer.length();
    const dirYaw = Math.atan2(toPlayer.x, toPlayer.z);

    if (this.sub === "idle") {
      // 弱追踪转向
      let d = dirYaw - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += clampMag(d, this.cfg.turnRate * dt * (this.phase === 2 ? 0.75 : 1));
      // 走近
      if (dist > 3.0) {
        const speed = this.cfg.walkSpeed * (this.phase === 2 ? 0.85 : 1) * dt;
        this.root.position.addScaledVector(toPlayer.normalize(), speed);
        this.onIdleWalk();
      }
      // 选招
      const pick = this.pickMove(dist);
      if (pick) {
        this.move = pick; this.sub = "tel"; this.t = 0; this.hitDone = false; this.hitFired = 0;
        this.cds[pick.name] = pick.cd;
        this.onMoveStart(pick, toPlayer, dist);
        AU.telegraph();
      }
      return;
    }

    const m = this.move as MoveDef;
    this.t += dt;
    const total = m.startup + m.active + m.recovery;

    if (this.sub === "tel") {
      this.movePose(m, "tel", this.t, total);
      if (this.t >= m.startup) {
        this.sub = "act"; this.t = 0;
        AU.whoosh(this.activeWhooshVolume(m));
        this.onMoveActive(m);
      }
      return;
    }

    if (this.sub === "act") {
      this.movePose(m, "act", this.t, total);
      // 多段判定：第 k 段在 active*0.4 + k*hitInterval 触发（hits=1 时与单段行为一致）
      const hits = m.hits ?? 1;
      const firstAt = m.active * 0.4;
      const interval = m.hitInterval ?? 0.45;
      while (this.hitFired < hits && this.t >= Math.min(firstAt + this.hitFired * interval, m.active)) {
        this.hitFired++;
        if (dist <= m.range + 0.45 && angleWithin(this.yaw, dirYaw, m.arc / 2)) {
          if (this.hitFired === 1) this.hitDone = true;   // 首段命中后关闭弹反窗
          if (!playerIframed) {
            const dir = toPlayer.clone().normalize();
            this.host.onBossHit(m.dmg, dir, this.chestWorld(), m);
          }
        }
      }
      if (m.shock && this.t >= m.active * 0.5 && this.t - dt < m.active * 0.5) {
        // 落地冲击环与命中解耦：打中/躲开都应震地（原 !hitDone 条件导致命中时冲击环被吞）
        this.vfx.ring(this.root.position, m.shock);
        this.vfx.scorch(this.root.position.clone().addScaledVector(new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)), 2.2));
        AU.slamShock();
        this.host.shake(0.55);
      }
      if (this.t >= m.active) { this.sub = "rec"; this.t = 0; }
      return;
    }

    // rec
    this.movePose(m, "rec", this.t, total);
    if (this.t >= m.recovery) {
      // 连段：直戳后概率接二连戳
      const chain = m.chain ? this.moveByName(m.chain) : null;
      if (chain && (this.cds[chain.name] ?? 0) <= 0 && Math.random() < 0.4 && dist < chain.range) {
        this.move = chain; this.sub = "tel"; this.t = 0; this.hitDone = false; this.hitFired = 0;
        this.cds[chain.name] = chain.cd;
      } else {
        this.sub = "idle"; this.move = null;
      }
    }
  }
}

// ---------------- 常用工具（子类 pickMove/movePose 也用） ----------------
export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const smooth = (v: number) => v * v * (3 - 2 * v);
export const seg = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
export function clampMag(v: number, max: number): number { return Math.max(-max, Math.min(max, v)); }
export function angleWithin(a: number, b: number, half: number): boolean {
  let d = a - b;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return Math.abs(d) <= half;
}
/** chestWorld 复用偏移量（避免命中帧反复分配） */
const CHEST_OFF = new THREE.Vector3(0, 0.2, 0);
