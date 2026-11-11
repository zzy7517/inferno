/** 玩家「不死人」：GLB 动画 + 战斗状态机（DS3 式精力制，ADR-0008） */
import * as THREE from "three";
import { P, FEEL, MoveDef } from "./config";
import { AU } from "./audio";

export type PState = "idle" | "attack" | "heavyCharge" | "heavy" | "roll" | "block" | "parry" | "estus" | "hurt" | "guardbreak" | "riposte" | "dead";

export interface PlayerHost {
  hitBoss: (dmg: number, poise: number, feelKey: string, point: THREE.Vector3) => void;
  /** 攻击判定帧的敌人扇面（每挥一次；M3 小怪系统，几何在 EnemyManager 内） */
  hitEnemies?: (dmg: number, poise: number, feelKey: string) => void;
  onPlayerHurt: (dmg: number, point: THREE.Vector3, feelKey: string) => void;
  onParrySuccess: (point: THREE.Vector3) => void;
  onDeath: () => void;
  bossParryableActive: () => boolean;
  bossOpen: () => boolean;              // parried / stagger
  bossPos: () => THREE.Vector3;
  shake: (amp: number) => void;
}

interface ClipMeta { startup: number; active: number; recovery: number; cancelFrom: number; total: number; iframes: [number, number]; window: [number, number]; healAt: number }

export class Player {
  readonly root = new THREE.Group();
  mixer!: THREE.AnimationMixer;
  actions: Record<string, THREE.AnimationAction> = {};
  meta: ClipMeta = { startup: 0.2, active: 0.1, recovery: 0.6, cancelFrom: 0.55, total: 0.9, iframes: [0.04, 0.3], window: [0.08, 0.2], healAt: 0.55 };

  state: PState = "idle";
  t = 0;
  combo = 0;
  pos = new THREE.Vector3();
  yaw = 0;
  hp = P.hp;
  stamina = P.stamina;
  estus = P.estusMax;
  souls = 0;
  lockOn = false;
  blocking = false;

  private charge = 0;
  private dodgeDir = new THREE.Vector3(0, 0, 1);
  private buffered: { kind: "r1" | "roll" | "parry" | "estus"; at: number } | null = null;
  private spendAt = -9;
  private healApplied = false;
  private riposteApplied = false;
  private keys = new Set<string>();
  private mouseDownAt = -9;
  private lmbDown = false;
  private rmbDown = false;
  private elapsed = 0;
  private yVel = 0;          // 击飞垂直速度
  private airborne = false;  // 空中（上挑）：锁输入，落地回 hurt
  private slowT = 0;         // 冰霜减速剩余时间
  private slowMul = 1;       // 冰霜减速倍率

  constructor(private model: THREE.Group, frames: Record<string, Record<string, unknown>>, private host: PlayerHost) {
    this.root.add(model);
    model.rotation.y = Math.PI;   // M0 调好的朝向
    this.mixer = new THREE.AnimationMixer(model);
    const atk = frames.attack as Record<string, number>;
    const estus = frames.estus as Record<string, number>;
    const rollIframes = (frames.roll as Record<string, unknown>).iframes as [number, number];
    const parryWindow = (frames.parry as Record<string, unknown>).window as [number, number];
    this.meta = {
      startup: atk.startup, active: atk.active, recovery: atk.recovery, cancelFrom: atk.cancelFrom, total: atk.total,
      iframes: rollIframes,
      window: parryWindow,
      healAt: estus.healAt,
    };
  }

  bind(actions: Record<string, THREE.AnimationAction>, mixer?: THREE.AnimationMixer): void {
    // actions 必须与其所属 mixer 同源（动画步进权在本类 update 内）；
    // 若外部用独立 mixer 生成 actions（game.ts GLTF 装载路径），此处接管该实例，否则动画冻在帧 0
    if (mixer) this.mixer = mixer;
    this.actions = actions;
    this.play("idle", 0, true);
  }

  // ---------------- 输入 ----------------
  onKey(code: string, down: boolean): void {
    if (down) this.keys.add(code); else this.keys.delete(code);
    if (!down || this.state === "dead") return;
    if (code === "Space") this.buffer("roll");
    else if (code === "KeyF") this.buffer("parry");
    else if (code === "KeyR") this.buffer("estus");
  }
  onMouse(button: number, down: boolean): void {
    if (this.state === "dead") return;
    if (button === 0) {
      this.lmbDown = down;
      if (down) this.mouseDownAt = this.elapsed;
      else if (this.state === "heavyCharge") this.releaseHeavy();
      else if (this.elapsed - this.mouseDownAt < 0.25) this.buffer("r1");
    } else if (button === 2) {
      this.rmbDown = down;
      if (!down) this.exitBlock();
    }
  }
  private buffer(kind: "r1" | "roll" | "parry" | "estus"): void {
    this.buffered = { kind, at: this.elapsed };
  }

  // ---------------- 状态切换 ----------------
  private play(name: string, fade = 0.12, loop = false): void {
    const to = this.actions[name];
    if (!to) return;
    const from = this.currentAction;
    to.reset();
    to.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    to.clampWhenFinished = true;
    to.enabled = true;
    to.fadeIn(fade).play();
    if (from && from !== to) from.fadeOut(fade);
    this.activeName = name;
  }
  private activeName = "idle";
  private get currentAction(): THREE.AnimationAction | undefined { return this.actions[this.activeName]; }

  private enter(s: PState): void {
    this.state = s; this.t = 0;
    switch (s) {
      case "attack": {
        this.hitApplied = false;
        const spd = [1, 1.12, 0.85][this.combo] ?? 1;
        this.play("attack", 0.08);
        this.actions.attack.timeScale = spd;
        AU.whoosh(1 / spd);
        break;
      }
      case "heavyCharge": this.charge = 0; this.play("attack", 0.15); this.actions.attack.timeScale = 0.35; break;
      case "heavy": this.play("attack", 0.05); this.actions.attack.timeScale = 0.6; AU.swingHeavy(); break;
      case "roll": this.play("roll", 0.06); this.spend(P.rollCost); AU.whoosh(0.8); break;
      case "block": this.play("block_idle", 0.12, true); break;
      case "parry": this.play("parry", 0.04); this.spend(P.parryCost); AU.whoosh(1.4); break;
      case "estus": this.play("estus", 0.1); this.healApplied = false; this.estus--; break;
      case "hurt": this.play("hurt", 0.05); AU.hurt(); break;
      case "guardbreak": this.play("hurt", 0.05); AU.guardBreak(); break;
      case "riposte": this.play("attack", 0.05); this.actions.attack.timeScale = 0.55; this.riposteApplied = false; break;
      case "dead": this.play("death", 0.1); AU.deathSting(); break;
      case "idle": this.play("idle", 0.15, true); break;
    }
  }

  private exitBlock(): void {
    if (this.state === "block") this.enter("idle");
  }

  private spend(v: number): void {
    this.stamina = Math.max(0, this.stamina - v);
    this.spendAt = this.elapsed;
  }
  private canSpend(v: number): boolean { return this.stamina >= v; }

  get isIframed(): boolean {
    return this.state === "roll" && this.t >= this.meta.iframes[0] && this.t <= this.meta.iframes[1];
  }

  // ---------------- 外部事件 ----------------
  /** 外部事件。feelKey：命中的手感档案（FEEL key），knockback 由档案给出 */
  applyHit(dmg: number, dir: THREE.Vector3, move: MoveDef | null, feelOverride?: string): void {
    const feelKey = feelOverride ?? move?.feel ?? "bLight";
    if (this.state === "dead" || this.isIframed) return;
    const point = this.pos.clone().add(new THREE.Vector3(0, 1.2, 0));
    if (this.state === "block" && !move?.grab) {
      const drain = dmg * P.blockDrainMul;
      if (this.stamina >= drain) {
        this.stamina -= drain; this.spendAt = this.elapsed;
        this.hp -= dmg * P.blockChip;
        AU.blockHit();
        this.host.onPlayerHurt(dmg * P.blockChip, point, "block");
      } else {
        this.stamina = 0;
        this.enter("guardbreak");   // 破防
        this.hp -= dmg;
        this.host.onPlayerHurt(dmg, point, feelKey);
      }
    } else {
      this.hp -= dmg;
      this.host.onPlayerHurt(dmg, point, feelKey);
      if (move?.frost) this.applySlow(move.frost.mul, move.frost.dur);
      if (this.state !== "riposte") this.enter("hurt");
      this.pos.addScaledVector(dir, FEEL[feelKey]?.knockback ?? 0.5);   // 击退
      if (move?.knockUp) {                                               // 击飞（监视者上挑）
        this.pos.y = 0.01;
        this.airborne = true;
        this.yVel = move.knockUp;
      }
    }
    if (this.hp <= 0) { this.hp = 0; this.enter("dead"); this.host.onDeath(); }
  }

  heal(): void {
    this.hp = Math.min(P.hp, this.hp + P.hp * P.estusHeal);
    AU.estus();
  }

  /** 冰霜减速（玻尔多）：取更狠的倍率、更长的时长 */
  applySlow(mul: number, dur: number): void {
    this.slowMul = Math.min(this.slowMul, mul);
    this.slowT = Math.max(this.slowT, dur);
  }

  reset(pos: THREE.Vector3): void {
    this.pos.copy(pos); this.hp = P.hp; this.stamina = P.stamina;
    this.estus = P.estusMax; this.state = "idle"; this.t = 0;
    this.buffered = null; this.combo = 0; this.yaw = Math.PI / 2;
    this.airborne = false; this.yVel = 0;
    this.play("idle", 0.1, true);
  }

  // ---------------- 主更新 ----------------
  update(dt: number, camYaw: number): void {
    this.elapsed += dt;
    if (this.state === "dead") { this.mixer.update(dt); return; }
    // 击飞空中：抛物线 + 落地硬直，锁一切输入
    if (this.airborne) {
      this.pos.y += this.yVel * dt;
      this.yVel -= 18 * dt;
      if (this.pos.y <= 0) {
        this.pos.y = 0; this.airborne = false; this.yVel = 0;
        this.enter("hurt");   // 落地硬直复用 hurt 0.4s
      }
      this.root.position.copy(this.pos);
      this.mixer.update(dt);
      return;
    }
    if (this.buffered && this.elapsed - this.buffered.at > P.bufferWindow) this.buffered = null;

    // 精力回复
    const regenRate = this.state === "block" ? P.regenBlock : P.staminaRegen;
    if (this.elapsed - this.spendAt > P.regenDelay) this.stamina = Math.min(P.stamina, this.stamina + regenRate * dt);
    if (this.slowT > 0) { this.slowT -= dt; if (this.slowT <= 0) { this.slowT = 0; this.slowMul = 1; } }
    const slowK = this.slowT > 0 ? this.slowMul : 1;

    const inputDir = this.inputDir(camYaw);
    const moving = inputDir.lengthSq() > 0.01;
    const bossPos = this.host.bossPos();

    // 锁定朝向
    const wantLock = this.lockOn;
    if (wantLock && this.state !== "roll") {
      const d = Math.atan2(bossPos.x - this.pos.x, bossPos.z - this.pos.z);
      this.yaw = angDamp(this.yaw, d, 14, dt);
    }

    // 各状态
    switch (this.state) {
      case "idle": {
        // 按住左键 → R2 蓄力
        if (this.lmbDown && this.elapsed - this.mouseDownAt > 0.22 && this.canSpend(P.r2Cost)) {
          this.enter("heavyCharge"); break;
        }
        if (this.rmbDown) { this.enter("block"); break; }
        const b = this.buffered;
        if (b) {
          this.buffered = null;
          if (b.kind === "r1" && this.canSpend(P.r1Cost)) { this.spend(P.r1Cost); this.combo = 0; this.faceBoss(bossPos, dt, true); this.enter("attack"); break; }
          if (b.kind === "roll" && this.canSpend(P.rollCost)) { this.setDodgeDir(inputDir, camYaw); this.enter("roll"); break; }
          if (b.kind === "parry" && this.canSpend(P.parryCost)) { this.enter("parry"); break; }
          if (b.kind === "estus" && this.estus > 0 && this.hp < P.hp) { this.enter("estus"); break; }
        }
        // 移动
        if (moving) {
          const sprint = this.keys.has("ShiftLeft") && this.canSpend(1);
          const speed = (sprint ? P.sprint : P.walk) * slowK;
          if (sprint) this.spend(11 * dt);
          this.pos.addScaledVector(inputDir, speed * dt);
          if (!wantLock) this.yaw = angDamp(this.yaw, Math.atan2(inputDir.x, inputDir.z), 12, dt);
          if (this.activeName !== "walk") this.play("walk", 0.18, true);
          this.actions.walk.timeScale = sprint ? 1.7 : 1;
        } else {
          if (this.activeName !== "idle") this.play("idle", 0.2, true);
        }
        break;
      }
      case "block": {
        if (!this.rmbDown) { this.enter("idle"); break; }
        if (moving) this.pos.addScaledVector(inputDir, P.walk * 0.42 * slowK * dt);
        break;
      }
      case "attack": {
        const m = this.meta;
        const tt = this.currentAction?.time ?? this.t;
        // 判定中段命中
        if (!this.hitApplied && tt >= m.startup + m.active * 0.4) {
          this.hitApplied = true;
          this.tryHitBoss(P.r1Dmg[this.combo] ?? 12, P.r1Poise[this.combo] ?? 12, ["pR1a", "pR1b", "pR1c"][this.combo] ?? "pR1a");
        }
        // 后摇 55% 后可翻滚取消 / 接下一刀
        const cancelAt = m.startup + m.active + m.recovery * m.cancelFrom;
        if (tt >= cancelAt && this.buffered) {
          const b = this.buffered; this.buffered = null;
          if (b.kind === "roll" && this.canSpend(P.rollCost)) { this.setDodgeDir(inputDir, camYaw); this.enter("roll"); break; }
          if (b.kind === "r1" && this.canSpend(P.r1Cost) && this.combo < 2) {
            this.spend(P.r1Cost); this.combo++; this.faceBoss(bossPos, dt, true); this.enter("attack"); break;
          }
        }
        if (tt >= m.total / (this.actions.attack.timeScale || 1)) {
          this.combo = 0; this.enter("idle");
        }
        this.t += dt;
        break;
      }
      case "heavyCharge": {
        this.charge = Math.min(1.3, this.charge + dt);
        if (this.charge >= 1.3) this.releaseHeavy();
        break;
      }
      case "heavy": {
        const tt = this.currentAction?.time ?? 0;
        if (!this.hitApplied && tt >= (this.meta.startup + this.meta.active * 0.4) / 0.6) {
          this.hitApplied = true;
          const mult = 1 + this.charge * 0.6;
          this.tryHitBoss(P.r2DmgBase * mult, P.r2Poise, "pR2");
        }
        if (tt >= this.meta.total / 0.6) this.enter("idle");
        this.t += dt;
        break;
      }
      case "roll": {
        const T = 0.7;
        const speed = 9.5 * Math.pow(1 - this.t / T, 0.6) + 1.5;
        this.pos.addScaledVector(this.dodgeDir, speed * dt);
        this.yaw = Math.atan2(this.dodgeDir.x, this.dodgeDir.z);
        if (this.t >= T) this.enter("idle");
        this.t += dt;
        break;
      }
      case "parry": {
        const [a, b] = this.meta.window;
        if (this.t >= a && this.t <= b && this.host.bossParryableActive()) {
          const boss = this.host.bossPos().clone().setY(1.8);
          // 实际弹反判定在 game 侧调 boss.tryParried()
          this.host.onParrySuccess(boss);
        }
        if (this.t >= 0.47) this.enter(this.rmbDown ? "block" : "idle");
        this.t += dt;
        break;
      }
      case "estus": {
        if (!this.healApplied && this.t >= this.meta.healAt) { this.healApplied = true; this.heal(); }
        if (this.t >= 1.1) this.enter("idle");
        this.t += dt;
        break;
      }
      case "hurt": if (this.t >= 0.4) this.enter("idle"); this.t += dt; break;
      case "guardbreak": if (this.t >= 1.2) this.enter("idle"); this.t += dt; break;
      case "riposte": {
        if (!this.riposteApplied && this.t >= 0.4) {
          this.riposteApplied = true;
          this.tryHitBoss(P.riposteDmg, 0, "pRip");   // 六通道反馈（顿帧/震屏/音画）走 FEEL.pRip
        }
        if (this.t >= 1.0) this.enter("idle");
        this.t += dt; break;
      }
    }

    this.root.position.copy(this.pos);
    this.root.rotation.y = this.yaw;
    this.mixer.update(dt);
  }

  private hitApplied = false;
  enterAttackFromHold(): void { this.spend(P.r2Cost); this.faceBoss(this.host.bossPos(), 0.016, true); this.enter("heavy"); this.hitApplied = false; }
  private releaseHeavy(): void { this.enterAttackFromHold(); }

  tryRiposte(): boolean {
    if ((this.state === "idle" || this.state === "block") && this.host.bossOpen()) {
      const d = this.host.bossPos().sub(this.pos); d.y = 0;
      if (d.length() < 2.5) {
        this.yaw = Math.atan2(d.x, d.z);
        this.enter("riposte");
        return true;
      }
    }
    return false;
  }

  private tryHitBoss(dmg: number, poise: number, feelKey: string): void {
    this.host.hitEnemies?.(dmg, poise, feelKey);   // 小怪扇面与 Boss 判定同拍（每挥一次）
    const bossPos = this.host.bossPos();
    const to = bossPos.clone().sub(this.pos); to.y = 0;
    const dYaw = Math.atan2(to.x, to.z);
    let diff = dYaw - this.yaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    if (to.length() < 2.8 + 0.2 && Math.abs(diff) < 1.1) {
      this.host.hitBoss(dmg, poise, feelKey, bossPos.clone().setY(1.5));
    }
  }

  private faceBoss(bossPos: THREE.Vector3, dt: number, snap = false): void {
    const d = Math.atan2(bossPos.x - this.pos.x, bossPos.z - this.pos.z);
    this.yaw = snap ? d : angDamp(this.yaw, d, 20, dt);
  }

  private setDodgeDir(inputDir: THREE.Vector3, camYaw: number): void {
    if (inputDir.lengthSq() > 0.01) this.dodgeDir.copy(inputDir).normalize();
    else this.dodgeDir.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));   // 无输入向后滚
    void camYaw;
  }

  private inputDir(camYaw: number): THREE.Vector3 {
    let x = 0, z = 0;
    if (this.keys.has("KeyW")) z += 1;
    if (this.keys.has("KeyS")) z -= 1;
    if (this.keys.has("KeyA")) x -= 1;
    if (this.keys.has("KeyD")) x += 1;
    if (!x && !z) return new THREE.Vector3();
    const f = new THREE.Vector3(-Math.sin(camYaw), 0, -Math.cos(camYaw));
    const r = new THREE.Vector3(Math.cos(camYaw), 0, -Math.sin(camYaw));
    return f.multiplyScalar(z).add(r.multiplyScalar(x)).normalize();
  }
}

function angDamp(a: number, b: number, lambda: number, dt: number): number {
  let d = b - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return a + d * (1 - Math.exp(-lambda * dt));
}
