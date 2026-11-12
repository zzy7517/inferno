/** 玩家「不死人」：GLB 动画 + 战斗状态机（DS3 式精力制，ADR-0008）
 *  DS3 直剑完全表：R1 三连 / R2 蓄力分级 / 翻滚 / 后撤步 / 格挡 / 弹反 / 处决 / 原素瓶
 *  + 跑攻 / 翻滚攻 / 后撤攻 / 踢击(破盾) / 战技架势(两段派生)。时序权威在帧数据 json（ADR-0004）。 */
import * as THREE from "three";
import { P, FEEL, PMOVES, PMoveDef, MoveDef } from "./config";
import { AU } from "./audio";

export type PState = "idle" | "attack" | "heavyCharge" | "heavy" | "roll" | "backstep" | "moveAtk" | "stance" | "block" | "parry" | "estus" | "hurt" | "guardbreak" | "riposte" | "dead";

/** 命中附加标志（enemy 系统读取）：isKick=踢击打崩格挡姿态；launcher=上挑击飞小怪（Boss 免疫） */
export interface HitOpts { isKick?: boolean; launcher?: boolean }

export interface PlayerHost {
  hitBoss: (dmg: number, poise: number, feelKey: string, point: THREE.Vector3, opts?: HitOpts) => void;
  /** 攻击判定帧的敌人扇面（每挥一次；M3 小怪系统，几何在 EnemyManager 内；def 携带 isKick/launcher 供 T8 布点消费） */
  hitEnemies?: (dmg: number, poise: number, feelKey: string, def?: PMoveDef) => void;
  onPlayerHurt: (dmg: number, point: THREE.Vector3, feelKey: string) => void;
  onParrySuccess: (point: THREE.Vector3) => void;
  onDeath: () => void;
  bossParryableActive: () => boolean;
  bossOpen: () => boolean;              // parried / stagger
  bossPos: () => THREE.Vector3;
  /** 出手与锁定要朝向的点。没有近处目标时返回 null，避免全图扭向远处 Boss。 */
  aimPos?: () => THREE.Vector3 | null;
  shake: (amp: number) => void;
}

interface ClipMeta { startup: number; active: number; recovery: number; cancelFrom: number; total: number; iframes: [number, number]; window: [number, number]; healAt: number }

export class Player {
  readonly root = new THREE.Group();
  mixer!: THREE.AnimationMixer;
  actions: Record<string, THREE.AnimationAction> = {};
  meta: ClipMeta = { startup: 0.2, active: 0.1, recovery: 0.6, cancelFrom: 0.55, total: 0.9, iframes: [0.04, 0.3], window: [0.04, 0.32], healAt: 0.55 };

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
  private buffered: { kind: "r1" | "roll" | "parry" | "estus"; at: number; tapDur: number } | null = null;
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
  // DS3 新招状态
  private fHeld = false;     // F 按住（长按=战技架势，轻点=弹反）
  private fDownAt = -9;
  private curMove: PMoveDef | null = null;          // moveAtk 当前招式（PMOVES）
  private curMoveKey = "";                          // 对应 PMOVES key（精力：kick 走 P.kickCost）
  private moveMeta: ClipMeta = { startup: 0.2, active: 0.1, recovery: 0.4, cancelFrom: 0.55, total: 0.7, iframes: [0, 0], window: [0, 0], healAt: 0 };
  private lungeDir = new THREE.Vector3(0, 0, 1);    // moveAtk 前冲方向
  private backstepIframes: [number, number] = [0.08, 0.16];
  private heavySpeed = 0.6;   // R2 播放速率（满蓄更沉）

  constructor(private model: THREE.Group, private frames: Record<string, Record<string, unknown>>, private host: PlayerHost) {
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
    const bs = frames.backstep as { iframes?: [number, number] } | undefined;
    if (bs?.iframes) this.backstepIframes = bs.iframes;
  }

  bind(actions: Record<string, THREE.AnimationAction>): void {
    // 重绑到本实例 mixer：外部传入的 action 表可能建在别的 mixer 上（该 mixer 不被 update），
    // 不重绑则 mixer.update 永不推进这些 action——动画冻结在单帧姿势
    for (const [name, act] of Object.entries(actions)) {
      this.actions[name] = this.mixer.clipAction(act.getClip());
    }
    this.play("idle", 0, true);
  }

  // ---------------- 输入 ----------------
  onKey(code: string, down: boolean): void {
    if (down) this.keys.add(code); else this.keys.delete(code);
    // F 双职能：轻点=弹反（松开即缓冲），长按 ≥P.stanceHoldTime=战技架势（update 里结算）
    if (code === "KeyF") {
      if (down) { this.fDownAt = this.elapsed; this.fHeld = true; }
      else {
        if (this.fHeld && this.elapsed - this.fDownAt < P.stanceHoldTime && this.state !== "dead") this.buffer("parry");
        this.fHeld = false;
      }
    }
    if (!down || this.state === "dead") return;
    if (code === "Space") this.buffer("roll");
    else if (code === "KeyR") this.buffer("estus");
  }
  onMouse(button: number, down: boolean): void {
    if (this.state === "dead") return;
    // 战技架势派生（按下即发）：左键=盾冲突刺（高削韧）/ 右键=上挑（击飞小怪）
    if (down && this.state === "stance" && this.canSpend(P.r1Cost)) {
      if (button === 0) { this.faceBoss(this.aimAt(), 0.016, true); this.startMove("stancePoke"); return; }
      if (button === 2) { this.rmbDown = true; this.faceBoss(this.aimAt(), 0.016, true); this.startMove("stanceUp"); return; }
    }
    if (button === 0) {
      this.lmbDown = down;
      if (down) this.mouseDownAt = this.elapsed;
      else if (this.state === "heavyCharge") this.releaseHeavy();
      else if (this.state === "stance") { /* 架势中的点击已在按下时消费为派生 */ }
      else if (this.elapsed - this.mouseDownAt < 0.25) this.buffer("r1", this.elapsed - this.mouseDownAt);
    } else if (button === 2) {
      this.rmbDown = down;
      if (!down) this.exitBlock();
    }
  }
  private buffer(kind: "r1" | "roll" | "parry" | "estus", tapDur = 0.25): void {
    this.buffered = { kind, at: this.elapsed, tapDur };
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
      case "backstep": this.play("backstep", 0.06); this.spend(P.backstepCost); AU.whoosh(0.9); break;
      case "moveAtk": this.hitApplied = false; this.play(this.curMove?.clip ?? "attack", 0.08); AU.whoosh(this.curMoveKey === "kick" ? 1.5 : 1.1); break;
      case "stance": this.play("stance", 0.1); this.spend(P.stanceCost); AU.whoosh(0.6); break;
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
    if (this.state === "roll") return this.t >= this.meta.iframes[0] && this.t <= this.meta.iframes[1];
    if (this.state === "backstep") return this.t >= this.backstepIframes[0] && this.t <= this.backstepIframes[1];
    return false;
  }

  /** moveAtk 通用出招：读 PMOVES 数值 + 帧数据 json 时序，前冲方向 = 当前朝向或指定方向 */
  private startMove(key: string, dir?: THREE.Vector3): void {
    const def = PMOVES[key];
    if (!def) { this.enter("idle"); return; }
    this.curMove = def;
    this.curMoveKey = key;
    this.spend(key === "kick" ? P.kickCost : P.r1Cost);
    if (dir && dir.lengthSq() > 0.01) {
      this.yaw = Math.atan2(dir.x, dir.z);
      this.lungeDir.copy(dir).normalize();
    } else {
      this.lungeDir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    }
    const c = this.frames[def.clip] as Record<string, number> | undefined;
    this.moveMeta = {
      startup: c?.startup ?? 0.2, active: c?.active ?? 0.1, recovery: c?.recovery ?? 0.4,
      cancelFrom: c?.cancelFrom ?? 0.55, total: c?.total ?? 0.7,
      iframes: [0, 0], window: [0, 0], healAt: 0,
    };
    this.enter("moveAtk");
  }

  /** 帧数据 json 数值读取（缺 clip/缺键时给默认） */
  private clipNum(clip: string, key: string, def: number): number {
    const c = this.frames[clip] as Record<string, number> | undefined;
    return typeof c?.[key] === "number" ? c[key] : def;
  }

  // ---------------- 外部事件 ----------------
  /** 外部事件。feelKey：命中的手感档案（FEEL key），knockback 由档案给出 */
  applyHit(dmg: number, dir: THREE.Vector3, move: MoveDef | null, feelOverride?: string): void {
    const feelKey = feelOverride ?? move?.feel ?? "bLight";
    if (this.state === "dead" || this.isIframed) return;
    const point = this.pos.clone().add(new THREE.Vector3(0, 1.2, 0));
    // 弹反窗内挨上可弹反的一击：这一下改判弹反，不掉血、不进受击
    if (move?.parryable && this.inParryWindow()) {
      this.host.onParrySuccess(point);
      return;
    }
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
    this.fHeld = false; this.curMove = null; this.curMoveKey = ""; this.charge = 0;
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
    const aim = this.aimAt();

    // 锁定朝向：朝当前目标（Boss 或小怪），没有目标就不拧身
    const wantLock = this.lockOn;
    if (wantLock && aim && this.state !== "roll") {
      const d = Math.atan2(aim.x - this.pos.x, aim.z - this.pos.z);
      this.yaw = angDamp(this.yaw, d, 14, dt);
    }

    // 各状态
    switch (this.state) {
      case "idle": {
        // 按住左键 → R2 蓄力
        if (this.lmbDown && this.elapsed - this.mouseDownAt > 0.22 && this.canSpend(P.r2Cost)) {
          this.enter("heavyCharge"); break;
        }
        // 长按 F ≥0.35s → 战技架势（轻点在 onKey 松开时缓冲为弹反）
        if (this.fHeld && this.elapsed - this.fDownAt >= P.stanceHoldTime && this.canSpend(P.stanceCost)) {
          this.faceBoss(aim, dt, true); this.enter("stance"); break;
        }
        if (this.rmbDown) { this.enter("block"); break; }
        const b = this.buffered;
        if (b) {
          // 精力不够就留着缓冲，等回复到能出招；喝不了的原素瓶直接丢掉
          if (b.kind === "r1") {
            const sprinting = moving && (this.keys.has("ShiftLeft") || this.keys.has("ShiftRight"));
            if (sprinting && this.canSpend(P.r1Cost)) { this.buffered = null; this.startMove("runAttack", inputDir); break; }
            if (this.keys.has("KeyW") && b.tapDur < 0.15 && this.canSpend(P.kickCost)) {
              this.buffered = null; this.faceBoss(aim, dt, true); this.startMove("kick"); break;
            }
            if (this.canSpend(P.r1Cost)) { this.buffered = null; this.spend(P.r1Cost); this.combo = 0; this.faceBoss(aim, dt, true); this.enter("attack"); break; }
          } else if (b.kind === "roll") {
            if (!moving && this.canSpend(P.backstepCost)) {
              this.buffered = null;
              this.dodgeDir.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
              this.enter("backstep"); break;
            }
            if (moving && this.canSpend(P.rollCost)) { this.buffered = null; this.setDodgeDir(inputDir, camYaw); this.enter("roll"); break; }
          } else if (b.kind === "parry" && this.canSpend(P.parryCost)) { this.buffered = null; this.enter("parry"); break; }
          else if (b.kind === "estus" && this.estus > 0 && this.hp < P.hp) { this.buffered = null; this.enter("estus"); break; }
          else if (b.kind === "estus") this.buffered = null;
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
        // 举盾可直接翻滚取消；精力不够则留下预输入（破防仍只走 applyHit）
        if (this.buffered?.kind === "roll" && this.canSpend(P.rollCost)) {
          this.buffered = null;
          this.setDodgeDir(inputDir, camYaw);
          this.enter("roll");
          break;
        }
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
          const b = this.buffered;
          if (b.kind === "roll" && this.canSpend(P.rollCost)) {
            this.buffered = null; this.setDodgeDir(inputDir, camYaw); this.enter("roll"); break;
          }
          if (b.kind === "r1" && this.combo < 2 && this.canSpend(P.r1Cost)) {
            this.buffered = null; this.spend(P.r1Cost); this.combo++; this.faceBoss(aim, dt, true); this.enter("attack"); break;
          }
          if (b.kind !== "r1" && b.kind !== "roll") this.buffered = null;
          else if (b.kind === "r1" && this.combo >= 2) this.buffered = null;
        }
        // -1e-3：clip 时长为浮点（0.89999997…），clampWhenFinished 后与 total 差亿分之一会导致永不收招（真机 rAF 必现）
        if (tt >= m.total / (this.actions.attack.timeScale || 1) - 1e-3) {
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
        if (!this.hitApplied && tt >= (this.meta.startup + this.meta.active * 0.4) / this.heavySpeed) {
          this.hitApplied = true;
          // R2 分级：蓄力 ≥P.r2FullCharge 满蓄（+35% 伤害 / 破韧翻倍），否则普通 R2
          const full = this.charge >= P.r2FullCharge;
          this.tryHitBoss(
            P.r2DmgBase * (full ? P.r2FullDmgMul : 1),
            P.r2Poise * (full ? P.r2FullPoiseMul : 1),
            "pR2",
          );
        }
        // 后摇 cancelFrom 之后可翻滚取消；精力不够则留下预输入
        const m = this.meta;
        const cancelAt = m.startup + m.active + m.recovery * m.cancelFrom;
        if (tt >= cancelAt && this.buffered?.kind === "roll" && this.canSpend(P.rollCost)) {
          this.buffered = null;
          this.setDodgeDir(inputDir, camYaw);
          this.enter("roll");
          break;
        }
        if (tt >= this.meta.total / this.heavySpeed - 1e-3) this.enter("idle");
        this.t += dt;
        break;
      }
      case "roll": {
        const T = 0.7;
        // Math.max(0,…)：退出检查在 t += dt 之前，收尾帧 t 会越过 T，负底数的非整数幂是 NaN，
        // 一次就毒化 pos → 相机 NaN → 画面永久黑屏（M1 起每次翻滚必中）
        const speed = 9.5 * Math.pow(Math.max(0, 1 - this.t / T), 0.6) + 1.5;
        this.pos.addScaledVector(this.dodgeDir, speed * dt);
        this.yaw = Math.atan2(this.dodgeDir.x, this.dodgeDir.z);
        // 翻滚攻：翻滚 60% 后缓冲的 R1 在此精确衔接（起身横扫）
        if (this.buffered?.kind === "r1" && this.t >= T * 0.6 && this.canSpend(P.r1Cost)) {
          this.buffered = null;
          this.faceBoss(aim, dt, true);
          this.startMove("rollAttack");
          break;
        }
        if (this.t >= T) this.enter("idle");
        this.t += dt;
        break;
      }
      case "backstep": {
        const T = this.clipNum("backstep", "total", 0.45);
        // 线性衰减剖面：∫v dt = P.backstepDist（1.6m 后跃，面朝不变）；Math.max 同 roll——防收尾帧过冲倒退
        const v0 = 2 * P.backstepDist / T;
        this.pos.addScaledVector(this.dodgeDir, v0 * Math.max(0, 1 - this.t / T) * dt);
        // 后撤中 R1 → 后撤直刺（chainFrom 帧数据可调）
        const chainAt = this.clipNum("backstep", "chainFrom", 0.18);
        if (this.buffered?.kind === "r1" && this.t >= chainAt && this.canSpend(P.r1Cost)) {
          this.buffered = null;
          this.faceBoss(aim, dt, true);
          this.startMove("backstepAttack");
          break;
        }
        if (this.t >= T) this.enter("idle");
        this.t += dt;
        break;
      }
      case "moveAtk": {
        const def = this.curMove;
        if (!def) { this.enter("idle"); break; }
        const m = this.moveMeta;
        const tt = this.currentAction?.time ?? this.t;
        // 前冲：前摇+判定内前载衰减剖面，总位移 = def.lunge
        if (def.lunge > 0 && tt < m.startup + m.active) {
          const span = m.startup + m.active;
          this.pos.addScaledVector(this.lungeDir, (2 * def.lunge / span) * (1 - tt / span) * dt);
        }
        if (!this.hitApplied && tt >= m.startup + m.active * 0.4) {
          this.hitApplied = true;
          this.tryHitBoss(def.dmg, def.poise, def.feel, def);
        }
        // 后摇取消：翻滚（预输入缓冲一致）
        const cancelAt = m.startup + m.active + m.recovery * m.cancelFrom;
        if (tt >= cancelAt && this.buffered?.kind === "roll" && this.canSpend(P.rollCost)) {
          this.buffered = null;
          this.setDodgeDir(inputDir, camYaw);
          this.enter("roll");
          break;
        }
        if (tt >= m.total - 1e-3) this.enter("idle");
        this.t += dt;
        break;
      }
      case "stance": {
        // 战技架势 0.6s：左/右键派生在 onMouse 按下即发；可翻滚取消；被击中即破（applyHit → hurt）
        if (this.buffered?.kind === "roll" && this.canSpend(P.rollCost)) {
          this.buffered = null;
          this.setDodgeDir(inputDir, camYaw);
          this.enter("roll");
          break;
        }
        if (this.t >= this.clipNum("stance", "total", 0.6)) this.enter("idle");
        this.t += dt;
        break;
      }
      case "parry": {
        if (this.inParryWindow() && this.host.bossParryableActive()) {
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

  /** 弹反有效帧。帧数据在 character_frames.json 的 parry.window。 */
  inParryWindow(): boolean {
    const [a, b] = this.meta.window;
    return this.state === "parry" && this.t >= a && this.t <= b;
  }

  private hitApplied = false;
  enterAttackFromHold(): void {
    this.spend(P.r2Cost); this.faceBoss(this.aimAt(), 0.016, true);
    this.enter("heavy"); this.hitApplied = false;
    // 满蓄更沉：播放稍慢，数值分级见 heavy 分支（+35% / 破韧 x2）
    this.heavySpeed = this.charge >= P.r2FullCharge ? 0.5 : 0.62;
    this.actions.attack.timeScale = this.heavySpeed;
  }
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

  private tryHitBoss(dmg: number, poise: number, feelKey: string, def?: PMoveDef): void {
    this.host.hitEnemies?.(dmg, poise, feelKey, def);   // 小怪扇面与 Boss 判定同拍（每挥一次）
    const bossPos = this.host.bossPos();
    const to = bossPos.clone().sub(this.pos); to.y = 0;
    const dYaw = Math.atan2(to.x, to.z);
    let diff = dYaw - this.yaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    const range = def?.range !== undefined ? def.range + 0.2 : 2.8 + 0.2;
    if (to.length() < range && Math.abs(diff) < 1.1) {
      const opts: HitOpts | undefined = def ? { isKick: def.isKick, launcher: def.launcher } : undefined;
      this.host.hitBoss(dmg, poise, feelKey, bossPos.clone().setY(1.5), opts);
    }
  }

  /** 锁定目标优先，否则由宿主给出的近战软吸附点。宿主未提供时退回 Boss。 */
  private aimAt(): THREE.Vector3 | null {
    if (this.host.aimPos) return this.host.aimPos();
    return this.host.bossPos();
  }

  private faceBoss(at: THREE.Vector3 | null, dt: number, snap = false): void {
    if (!at) return;
    const d = Math.atan2(at.x - this.pos.x, at.z - this.pos.z);
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
