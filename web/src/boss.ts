/** Boss「灰烬审判者古达」（DS3 官方名直接复用）：程序化石像傀儡 + FSM（docs/design/m1-demo.md 招式表）
 * 骨架全部代码驱动（时序归代码 ADR-0004），帧数据来自 config.MOVES
 */
import * as THREE from "three";
import { BOSS, MOVES, MoveDef, COLORS } from "./config";
import { Vfx } from "./vfx";
import { AU } from "./audio";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (v: number) => v * v * (3 - 2 * v);
const seg = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));

interface Pose {
  y: number; lean: number; twist: number;
  armLift: number; armSwing: number; halPitch: number;
  reach: number; crouch: number;
  serpOut: number; serpYaw: number;
  armL: number;
}
const STANCE: Pose = { y: 0, lean: 0.06, twist: 0, armLift: 0.25, armSwing: 0, halPitch: 0.3, reach: 0, crouch: 0, serpOut: 0, serpYaw: 0, armL: 0 };
const STATUE: Pose = { ...STANCE, y: -0.62, lean: 0.55, armLift: -0.05, halPitch: -1.25, crouch: 0.4 };

export type BossState = "statue" | "rising" | "combat" | "stagger" | "parried" | "transform" | "dead";

export interface BossHost {
  onBossHit: (dmg: number, dir: THREE.Vector3, point: THREE.Vector3, move: MoveDef) => void;
  onBossReveal: () => void;          // 血条亮相（取戟）
  onBossTransform: (point: THREE.Vector3) => void;  // 变身震波伤害判定由 game 处理
  onBossDeath: () => void;
  shake: (amp: number) => void;
}

export class Boss {
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private torso = new THREE.Group();
  private armR = new THREE.Group();
  private armL = new THREE.Group();
  private head!: THREE.Mesh;
  private eyes: THREE.Mesh[] = [];
  private halberd = new THREE.Group();
  private serpent: THREE.Mesh[] = [];
  private serpGlow!: THREE.PointLight;
  private swordInChest!: THREE.Mesh;
  private swordLight!: THREE.PointLight;
  private emberMat!: THREE.MeshStandardMaterial;

  state: BossState = "statue";
  sub = "idle";                       // combat 内: idle/tel/act/rec
  move: MoveDef | null = null;
  t = 0;
  hp = BOSS.hp;
  phase = 1;
  poise = 0;
  yaw = -Math.PI / 2;                 // 面向 -X（雾门方向）
  private pose: Pose = { ...STATUE };
  private cds: Record<string, number> = {};
  private jumpFrom = new THREE.Vector3();
  private jumpTo = new THREE.Vector3();
  private hitDone = false;
  private deathT = 0;

  constructor(scene: THREE.Scene, private vfx: Vfx, pos: THREE.Vector3, private host: BossHost) {
    this.root.position.copy(pos);
    this.build();
    this.root.add(this.body);
    this.body.add(this.torso);
    scene.add(this.root);
    this.applyPose();
  }

  // ---------------- 外观 ----------------
  private build(): void {
    const stone = new THREE.MeshStandardMaterial({ color: COLORS.stone, roughness: 0.95, flatShading: true });
    const dark = new THREE.MeshStandardMaterial({ color: COLORS.stoneDark, roughness: 1, flatShading: true });
    this.emberMat = new THREE.MeshStandardMaterial({ color: 0x3a2c22, roughness: 0.7, emissive: COLORS.ember, emissiveIntensity: 0.9 });

    const box = (w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z); m.castShadow = true;
      return m;
    };
    // 腿
    this.body.add(box(0.34, 1.15, 0.4, dark, 0.42, 0.58, 0), box(0.34, 1.15, 0.4, dark, -0.42, 0.58, 0));
    this.body.add(box(0.4, 0.22, 0.62, dark, 0.42, 0.11, 0.1), box(0.4, 0.22, 0.62, dark, -0.42, 0.11, 0.1));
    // 躯干
    this.torso.position.y = 1.35;
    this.torso.add(box(1.35, 1.15, 0.7, stone, 0, 0.45, 0));
    this.torso.add(box(1.6, 0.3, 0.78, stone, 0, 1.05, 0));         // 肩甲层
    this.head = box(0.46, 0.5, 0.5, stone, 0, 1.62, 0.05);
    this.torso.add(this.head);
    for (const sx of [-0.11, 0.11]) {
      const eye = box(0.09, 0.05, 0.03, this.emberMat, sx, 1.66, 0.31);
      this.eyes.push(eye); this.torso.add(eye);
    }
    // 胸口螺旋剑（拔出前可见）
    this.swordInChest = box(0.07, 0.85, 0.05, this.emberMat, 0.25, 0.55, 0.38);
    this.swordInChest.rotation.z = 0.35;
    this.torso.add(this.swordInChest);
    this.swordLight = new THREE.PointLight(COLORS.ember, 3, 3.5, 2);
    this.swordLight.position.set(0.25, 0.55, 0.6);
    this.torso.add(this.swordLight);
    // 右臂 + 戟
    this.armR.position.set(0.85, 0.95, 0);
    this.armR.add(box(0.3, 0.95, 0.3, stone, 0, -0.45, 0));
    this.armR.add(box(0.36, 0.3, 0.36, stone, 0, -0.95, 0));
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.0, 6), new THREE.MeshStandardMaterial({ color: 0x2e2a24, roughness: 0.9 }));
    shaft.position.set(0, -0.8, 0.3); shaft.rotation.x = Math.PI / 2 - 0.5; shaft.castShadow = true;
    this.armR.add(shaft);
    const axeHead = box(0.06, 0.55, 0.4, new THREE.MeshStandardMaterial({ color: 0x6e747c, roughness: 0.5, metalness: 0.4, flatShading: true }), 0, -0.35, 1.55);
    axeHead.rotation.x = -0.5;
    this.armR.add(axeHead);
    this.torso.add(this.armR);
    // 左臂（爪）
    this.armL.position.set(-0.85, 0.95, 0);
    this.armL.add(box(0.3, 0.95, 0.3, stone, 0, -0.45, 0));
    this.armL.add(box(0.34, 0.34, 0.34, stone, 0, -0.98, 0));
    this.torso.add(this.armL);
    // 人性的沉淀（二阶段蛇形爆发体，从背部生长）
    for (let i = 0; i < 8; i++) {
      const s = 0.34 - i * 0.025;
      const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, s * 1.5), i === 7 ? this.emberMat : stone);
      m.visible = false; m.castShadow = true;
      this.serpent.push(m);
      this.torso.add(m);
    }
    this.serpGlow = new THREE.PointLight(COLORS.ember, 0, 6, 2);
    this.torso.add(this.serpGlow);
  }

  // ---------------- 姿态应用 ----------------
  private applyPose(): void {
    const p = this.pose;
    this.root.rotation.y = this.yaw;
    this.body.position.set(0, p.y, p.reach);
    this.torso.rotation.set(p.lean, p.twist, 0);
    this.armR.rotation.set(-p.armLift, 0, -p.armSwing);
    this.armL.rotation.set(-p.armL, 0.2, 0);
    // 人性的沉淀：从背后向 serpYaw 方向伸出
    const n = this.serpent.length;
    const outLen = p.serpOut * 3.4;
    this.serpGlow.intensity = p.serpOut * 6;
    for (let i = 0; i < n; i++) {
      const s = this.serpent[i];
      s.visible = this.phase === 2 || this.state === "transform";
      const k = i / (n - 1);
      const wobble = Math.sin(performance.now() * 0.004 + i * 0.9) * 0.22 * p.serpOut;
      const along = -0.5 - k * outLen;                       // 局部 -Z 为背
      const lateral = Math.sin(p.serpYaw * (1 - k * 0.4)) * k * outLen * 0.55 + wobble;
      s.position.set(lateral, 1.7 + Math.cos(p.serpYaw) * k * outLen * 0.35 + wobble, along);
      s.rotation.y = -p.serpYaw * (1 - k);
    }
  }

  private lerpPose(a: Pose, b: Pose, k: number): void {
    const p = this.pose;
    p.y = a.y + (b.y - a.y) * k; p.lean = a.lean + (b.lean - a.lean) * k;
    p.twist = a.twist + (b.twist - a.twist) * k;
    p.armLift = a.armLift + (b.armLift - a.armLift) * k; p.armSwing = a.armSwing + (b.armSwing - a.armSwing) * k;
    p.halPitch = a.halPitch + (b.halPitch - a.halPitch) * k; p.reach = a.reach + (b.reach - a.reach) * k;
    p.crouch = a.crouch + (b.crouch - a.crouch) * k;
    p.serpOut = a.serpOut + (b.serpOut - a.serpOut) * k; p.serpYaw = a.serpYaw + (b.serpYaw - a.serpYaw) * k;
    p.armL = a.armL + (b.armL - a.armL) * k;
  }

  /** 招式姿态：随阶段进度插值到目标姿态 */
  private movePose(m: MoveDef, sub: string, t: number, total: number): void {
    const wind: Pose = { ...STANCE }, strike: Pose = { ...STANCE };
    switch (m.name) {
      case "thrust": case "thrust2":
        wind.twist = 0.45; wind.armLift = -0.35; wind.reach = 0.2;
        strike.twist = -0.25; strike.armLift = 1.05; strike.reach = 1.0; strike.lean = 0.3;
        break;
      case "sweep":
        wind.twist = 0.6; wind.armSwing = -1.25; wind.armLift = 0.55;
        strike.twist = -0.75; strike.armSwing = 1.45; strike.armLift = 0.45; strike.lean = 0.18;
        break;
      case "slam":
        wind.armLift = -2.1; wind.lean = -0.18;
        strike.armLift = 1.0; strike.lean = 0.42; strike.crouch = 0.25; strike.y = -0.25;
        break;
      case "jump":
        wind.armLift = -1.6; wind.lean = -0.1;
        strike.armLift = 0.95; strike.lean = 0.45; strike.crouch = 0.3; strike.y = -0.2;
        break;
      case "shoulder":
        wind.twist = 0.35; wind.lean = -0.12;
        strike.twist = -0.25; strike.lean = 0.55; strike.reach = 1.6; strike.armL = -0.9;
        break;
      case "grab":
        wind.lean = -0.25; wind.armL = -1.6; wind.twist = 0.2;
        strike.lean = 0.5; strike.armL = -2.4; strike.reach = 1.3;
        break;
      case "serpSweep":
        wind.serpOut = 1; wind.serpYaw = -1.3; wind.twist = 0.3;
        strike.serpOut = 1; strike.serpYaw = 1.3; strike.twist = -0.35; strike.lean = 0.2;
        break;
      case "serpThrust":
        wind.serpOut = 0.7; wind.serpYaw = 0; wind.lean = -0.1;
        strike.serpOut = 1; strike.serpYaw = 0; strike.lean = 0.35; strike.reach = 0.6;
        break;
    }
    if (sub === "tel") this.lerpPose(STANCE, wind, smooth(seg(t, m.startup * 0.55, m.startup)));
    else if (sub === "act") this.lerpPose(wind, strike, seg(t, 0, m.active));
    else this.lerpPose(strike, STANCE, smooth(seg(t, m.recovery * 0.35, m.recovery)));
    void total;
  }

  // ---------------- 公共 API ----------------
  pull(): void {
    if (this.state !== "statue") return;
    this.state = "rising"; this.t = 0;
    this.swordInChest.visible = false;
    this.swordLight.intensity = 0;
    AU.rise();
  }

  get awake(): boolean { return this.state !== "statue"; }
  get inCombat(): boolean { return this.state === "combat"; }

  chestWorld(out = new THREE.Vector3()): THREE.Vector3 {
    return this.torso.getWorldPosition(out).add(new THREE.Vector3(0, 0.2, 0));
  }
  headWorld(out = new THREE.Vector3()): THREE.Vector3 {
    return this.head.getWorldPosition(out);
  }

  /** 玩家命中 Boss：返回是否死亡/是否触发破绽 */
  takeHit(dmg: number, poise: number): { died: boolean; staggered: boolean } {
    if (this.state === "statue" || this.state === "dead") return { died: false, staggered: false };
    const mult = this.state === "stagger" || this.state === "parried" ? BOSS.staggerMul : 1;
    this.hp = Math.max(0, this.hp - dmg * mult);
    if (this.phase === 1 && this.hp <= BOSS.hp * BOSS.phase2At && this.state !== "transform") {
      this.state = "transform"; this.t = 0; this.sub = "idle";
      AU.transform();
      return { died: false, staggered: false };
    }
    if (this.hp <= 0) { this.die(); return { died: true, staggered: false }; }
    if (this.state === "combat" || this.state === "stagger") {
      this.poise += poise;
      if (this.poise >= BOSS.poiseMax) {
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
    this.hp = BOSS.hp; this.phase = 1; this.poise = 0; this.yaw = -Math.PI / 2;
    this.cds = {}; this.hitDone = false; this.deathT = 0;
    this.swordInChest.visible = true; this.swordLight.intensity = 3;
    this.serpGlow.intensity = 0;
    this.emberMat.emissiveIntensity = 0.9;
    for (const s of this.serpent) s.visible = false;
    this.lerpPose(STANCE, STATUE, 1);
    this.applyPose();
  }

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
    if (this.state === "combat") this.poise = Math.max(0, this.poise - BOSS.poiseDecay * dt);
    // 眼睛呼吸
    this.emberMat.emissiveIntensity = (this.phase === 2 ? 1.8 : 0.9) + Math.sin(performance.now() * 0.003) * 0.2;

    switch (this.state) {
      case "statue":
        break;
      case "rising": {
        this.t += dt;
        const k = smooth(clamp01(this.t / 2.2));
        this.lerpPose(STATUE, STANCE, k);
        if (Math.random() < dt * 8) this.vfx.dust.burst(this.root.position, 3, 2, 0.7);
        if (this.t > 0.4 && this.t - dt <= 0.4) this.host.onBossReveal();
        if (this.t >= 2.2) { this.state = "combat"; this.sub = "idle"; this.t = 0; }
        break;
      }
      case "combat": this.updateCombat(dt, playerPos, playerIframed); break;
      case "stagger":
        this.t += dt;
        this.lerpPose(STANCE, { ...STANCE, lean: 0.55, crouch: 0.35, y: -0.35 }, Math.min(1, this.t * 5));
        if (Math.random() < dt * 6) this.vfx.sparks.burst(this.chestWorld(), 2, 2.5, 0.3);
        if (this.t >= BOSS.staggerDur) { this.state = "combat"; this.sub = "idle"; this.t = 0; }
        break;
      case "parried":
        this.t += dt;
        this.lerpPose(STANCE, { ...STANCE, lean: 0.7, crouch: 0.45, y: -0.45, armLift: -0.4 }, Math.min(1, this.t * 8));
        if (Math.random() < dt * 10) this.vfx.sparks.burst(this.chestWorld(), 3, 3, 0.35);
        if (this.t >= BOSS.parriedDur) { this.state = "combat"; this.sub = "idle"; this.t = 0; }
        break;
      case "transform": {
        this.t += dt;
        if (this.t < 0.8) this.lerpPose(STANCE, { ...STANCE, crouch: 0.5, y: -0.5, lean: 0.4 }, smooth(this.t / 0.8));
        else {
          this.phase = 2;
          this.lerpPose({ ...STANCE, crouch: 0.5, y: -0.5, lean: 0.4 }, { ...STANCE, serpOut: 1, lean: -0.15 }, smooth(seg(this.t, 0.8, 1.6)));
        }
        if (this.t > 0.85 && this.t - dt <= 0.85) {
          this.host.onBossTransform(this.root.position.clone());
          this.vfx.ring(this.root.position, 5);
          this.host.shake(0.7);
        }
        if (this.t >= 1.8) { this.state = "combat"; this.sub = "idle"; this.t = 0; }
        break;
      }
      case "dead": {
        this.deathT += dt;
        const k = smooth(clamp01(this.deathT / 1.4));
        this.lerpPose(this.pose, { ...STANCE, lean: 1.35, y: -0.75, crouch: 0.4 }, dt * 4);
        if (Math.random() < dt * 20) this.vfx.embers.burst(this.chestWorld(), 3, 3, 1.2);
        void k;
        break;
      }
    }
    this.applyPose();
  }

  private updateCombat(dt: number, playerPos: THREE.Vector3, playerIframed: boolean): void {
    const toPlayer = new THREE.Vector3().subVectors(playerPos, this.root.position);
    toPlayer.y = 0;
    const dist = toPlayer.length();
    const dirYaw = Math.atan2(toPlayer.x, toPlayer.z);

    if (this.sub === "idle") {
      // 弱追踪转向
      let d = dirYaw - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += clampMag(d, BOSS.turnRate * dt * (this.phase === 2 ? 0.75 : 1));
      // 走近
      if (dist > 3.0) {
        const speed = BOSS.walkSpeed * (this.phase === 2 ? 0.85 : 1) * dt;
        this.root.position.addScaledVector(toPlayer.normalize(), speed);
        this.pose.y = Math.abs(Math.sin(performance.now() * 0.004)) * 0.06 - 0.02;
      }
      // 选招
      const pick = this.pickMove(dist);
      if (pick) {
        this.move = pick; this.sub = "tel"; this.t = 0; this.hitDone = false;
        this.cds[pick.name] = pick.cd;
        if (pick.name === "jump") {
          this.jumpFrom.copy(this.root.position);
          const dir = toPlayer.clone().normalize();
          this.jumpTo.copy(this.root.position).addScaledVector(dir, Math.min(pick.lunge ?? 0, dist - 1.2));
        }
        AU.telegraph();
      }
      return;
    }

    const m = this.move as MoveDef;
    this.t += dt;
    const total = m.startup + m.active + m.recovery;

    if (this.sub === "tel") {
      if (m.name === "jump") {
        const k = smooth(clamp01(this.t / m.startup));
        this.root.position.lerpVectors(this.jumpFrom, this.jumpTo, k);
        this.pose.y = Math.sin(k * Math.PI) * 1.1;   // 跃起
        this.lerpPose(STANCE, { ...STANCE, armLift: -1.6, lean: -0.1 }, smooth(k));
      } else {
        this.movePose(m, "tel", this.t, total);
      }
      if (this.t >= m.startup) {
        this.sub = "act"; this.t = 0;
        AU.whoosh(m.name === "slam" || m.name === "jump" ? 0.6 : 1);
        const chest = this.chestWorld();
        this.vfx.slash(chest, this.yaw, m.range * 0.85, m.arc > 2 || m.name === "serpSweep", m.name.startsWith("serp") ? 0xff7a30 : 0xffd9a0);
      }
      return;
    }

    if (this.sub === "act") {
      this.movePose(m, "act", this.t, total);
      if (m.name === "jump") this.pose.y = 0;
      if (!this.hitDone && this.t >= m.active * 0.4) {
        // 命中判定：距离 + 夹角
        const hitPoint = this.chestWorld();
        if (dist <= m.range + 0.45 && angleWithin(this.yaw, dirYaw, m.arc / 2)) {
          this.hitDone = true;
          if (!playerIframed) {
            const dir = toPlayer.clone().normalize();
            this.host.onBossHit(m.dmg, dir, hitPoint, m);
          }
        }
      }
      if (m.shock && this.t >= m.active * 0.5 && !this.hitDone && this.t - dt < m.active * 0.5) {
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
      const chain = m.chain ? MOVES[m.chain] : null;
      if (chain && (this.cds[chain.name] ?? 0) <= 0 && Math.random() < 0.4 && dist < chain.range) {
        this.move = chain; this.sub = "tel"; this.t = 0; this.hitDone = false;
        this.cds[chain.name] = chain.cd;
      } else {
        this.sub = "idle"; this.move = null;
      }
    }
  }

  private pickMove(dist: number): MoveDef | null {
    const ready = (m: MoveDef) => (this.cds[m.name] ?? 0) <= 0 && (!m.phase2Only || this.phase === 2);
    // 远距离：跳劈 / 蛇突刺
    if (dist > 6) {
      if (ready(MOVES.jump)) return MOVES.jump;
      if (ready(MOVES.serpThrust)) return MOVES.serpThrust;
      return null;
    }
    // 贴身：抓技(低概率)/肩撞
    if (dist < 1.9) {
      if (ready(MOVES.grab) && Math.random() < 0.25) return MOVES.grab;
      if (ready(MOVES.shoulder) && Math.random() < 0.5) return MOVES.shoulder;
    }
    const pool: [MoveDef, number][] = [
      [MOVES.thrust, 3], [MOVES.sweep, 3], [MOVES.slam, 2],
      [MOVES.shoulder, dist < 2.4 ? 2 : 0],
      [MOVES.serpSweep, this.phase === 2 ? 2.5 : 0],
      [MOVES.serpThrust, this.phase === 2 && dist > 3.5 ? 2 : 0],
    ];
    const cands = pool.filter(([m, w]) => w > 0 && ready(m) && dist < m.range * 0.95);
    if (!cands.length) return null;
    const sum = cands.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * sum;
    for (const [m, w] of cands) { r -= w; if (r <= 0) return m; }
    return cands[0][0];
  }
}

function clampMag(v: number, max: number): number { return Math.max(-max, Math.min(max, v)); }
function angleWithin(a: number, b: number, half: number): boolean {
  let d = a - b;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return Math.abs(d) <= half;
}
