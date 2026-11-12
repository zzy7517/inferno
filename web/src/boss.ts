/** Boss「灰烬审判者古达」（DS3 官方名直接复用）：程序化石像傀儡 + FSM（docs/design/m1-demo.md 招式表）
 * 骨架全部代码驱动（时序归代码 ADR-0004），帧数据来自 config.MOVES
 * 通用机制（状态机/削韧破绽/弹反/阶段转换/死亡/命中判定/走近追踪）在 BossBase（boss-base.ts），
 * 本文件只保留古达专属：外观、Pose 姿态系统、选招权重、变身爆发、拔剑唤醒
 */
import * as THREE from "three";
import { BOSS, MOVES, MoveDef, COLORS } from "./config";
import { Vfx } from "./vfx";
import { AU } from "./audio";
import { BossBase, clamp01, smooth, seg, pickWeighted } from "./boss-base";
import type { BossHost } from "./boss-base";

export type { BossState, BossHost } from "./boss-base";

interface Pose {
  y: number; lean: number; twist: number;
  armLift: number; armSwing: number; halPitch: number;
  reach: number; crouch: number;
  serpOut: number; serpYaw: number;
  armL: number;
}
const STANCE: Pose = { y: 0, lean: 0.06, twist: 0, armLift: 0.25, armSwing: 0, halPitch: 0.3, reach: 0, crouch: 0, serpOut: 0, serpYaw: 0, armL: 0 };
const STATUE: Pose = { ...STANCE, y: -0.62, lean: 0.55, armLift: -0.05, halPitch: -1.25, crouch: 0.4 };

export class Boss extends BossBase {
  private body = new THREE.Group();
  private torso = new THREE.Group();
  private armR = new THREE.Group();
  private armL = new THREE.Group();
  private head!: THREE.Mesh;
  private serpent: THREE.Mesh[] = [];
  private serpGlow!: THREE.PointLight;
  private swordInChest!: THREE.Mesh;
  private swordLight!: THREE.PointLight;
  private emberMat!: THREE.MeshStandardMaterial;

  private pose: Pose = { ...STATUE };
  private jumpFrom = new THREE.Vector3();
  private jumpTo = new THREE.Vector3();
  private stepFrom = new THREE.Vector3();
  private stepTo = new THREE.Vector3();
  private stepping = false;
  /** 上一招名：有替代时降权，避免同一招连出两次 */
  private lastMove = "";
  /** 远/近距离带滞后，避免在 6m、1.7m 边界来回换招 */
  private preferFar = false;
  private preferClose = false;

  constructor(scene: THREE.Scene, vfx: Vfx, pos: THREE.Vector3, host: BossHost) {
    super(scene, vfx, pos, host, BOSS, -Math.PI / 2);   // 面向 -X（雾门方向）
    this.assemble();
  }

  // ---------------- 外观 ----------------
  protected override buildBody(): void {
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
      this.torso.add(box(0.09, 0.05, 0.03, this.emberMat, sx, 1.66, 0.31));
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
    this.root.add(this.body);
    this.body.add(this.torso);
  }

  protected override chestPart(): THREE.Object3D { return this.torso; }
  protected override headPart(): THREE.Object3D { return this.head; }

  // ---------------- 姿态应用 ----------------
  protected override applyPose(): void {
    const p = this.pose;
    this.root.rotation.y = this.yaw;
    this.body.position.set(0, p.y - p.crouch * 0.22, p.reach);
    this.torso.rotation.set(p.lean, p.twist, 0);
    this.armR.rotation.set(-p.armLift, 0, -p.armSwing);
    this.armL.rotation.set(-p.armL, 0.2, 0);
    // 人性的沉淀：serpYaw 0 = 背后待机，PI = 正前突刺，两侧为横扫
    const show = this.phase === 2 || this.state === "transform";
    const serp = (this.phase === 2 && this.state !== "transform") ? Math.max(p.serpOut, 0.72) : p.serpOut;
    const n = this.serpent.length;
    const outLen = serp * 3.4;
    this.serpGlow.intensity = show ? Math.min(6.5, 1.6 + serp * 2.4) : 0;
    const aim = Math.PI + p.serpYaw;
    const forward = Math.max(0, -Math.cos(p.serpYaw));
    for (let i = 0; i < n; i++) {
      const s = this.serpent[i];
      s.visible = show;
      const k = i / (n - 1);
      const wobble = Math.sin(performance.now() * 0.004 + i * 0.9) * 0.14 * Math.min(1, serp);
      const reach = 0.28 + k * outLen;
      const along = Math.cos(aim) * reach;
      const lateral = Math.sin(aim) * reach + wobble;
      const arch = (1 - forward * 0.7) * 0.48;
      s.position.set(lateral, 1.22 + Math.sin(k * Math.PI) * arch, along);
      s.rotation.set(0, aim, 0);
      const depth = (0.34 - i * 0.025) * 1.5;
      const step = outLen / Math.max(1, n - 1);
      s.scale.set(1, 1, Math.min(2.2, Math.max(1, (step * 0.92) / Math.max(0.16, depth))));
    }
  }

  private lerpPose(a: Pose, b: Pose, k: number): void {
    const p = this.pose;
    p.y = a.y + (b.y - a.y) * k; p.lean = a.lean + (b.lean - a.lean) * k;
    p.twist = a.twist + (b.twist - a.twist) * k;
    p.armLift = a.armLift + (b.armLift - a.armLift) * k; p.armSwing = a.armSwing + (b.armSwing - a.armSwing) * k;
    p.halPitch = a.halPitch + (b.halPitch - a.halPitch) * k; p.reach = a.reach + (b.reach - a.reach) * k;
    p.crouch = a.crouch + (b.crouch - a.crouch) * k;
    p.serpOut = a.serpOut + (b.serpOut - a.serpOut) * k;
    p.serpYaw = lerpAngle(a.serpYaw, b.serpYaw, k);
    p.armL = a.armL + (b.armL - a.armL) * k;
  }

  /** 跳劈滞空高度：前摇结束时仍在空中，下砸落在判定段 */
  private jumpArc(leap: number): number {
    return Math.sin(clamp01(leap) * Math.PI * 0.8) * 1.35;
  }

  private heavyMove(name: string): boolean {
    return name === "sweep" || name === "slam" || name === "jump" || name === "grab" || name === "serpSweep" || name === "serpThrust";
  }

  /** 招式姿态：随阶段进度插值到目标姿态。重招先把武器举到位并停住，再快斩。 */
  protected override movePose(m: MoveDef, sub: string, t: number, total: number): void {
    // 跳劈：先下蹲举戟，再跃向锁定落点；高度在 lerp 之后写，避免被姿态插值清掉
    if (m.name === "jump" && sub === "tel") {
      const k = clamp01(t / Math.max(0.0001, m.startup));
      const windK = smooth(seg(k, 0, 0.42));
      const leap = smooth(seg(k, 0.36, 1));
      this.lerpPose(STANCE, { ...STANCE, armLift: -2.75, lean: -0.6, crouch: 0.38, armSwing: -0.12 }, windK);
      this.root.position.lerpVectors(this.jumpFrom, this.jumpTo, leap);
      this.pose.crouch *= (1 - leap);
      this.pose.y = (1 - leap) * -0.05 + this.jumpArc(leap);
      this.pose.armLift = -2.75;
      this.pose.lean = -0.6 + 0.12 * leap;
      return;
    }
    if (m.name === "jump" && sub === "act") {
      const snap = 1 - Math.pow(1 - seg(t, 0, m.active), 3);
      this.lerpPose(
        { ...STANCE, armLift: -2.75, lean: -0.48, y: this.jumpArc(1) },
        { ...STANCE, armLift: 1.35, lean: 0.78, crouch: 0.48, y: -0.32, reach: 0.15 },
        snap,
      );
      return;
    }
    const wind: Pose = { ...STANCE }, strike: Pose = { ...STANCE };
    switch (m.name) {
      case "thrust":
        wind.twist = -0.55; wind.armLift = -1.5; wind.lean = -0.34; wind.reach = -0.18; wind.armSwing = -0.2;
        strike.twist = 0.12; strike.armLift = 1.05; strike.reach = 0.95; strike.lean = 0.42;
        break;
      case "thrust2":
        wind.twist = -0.32; wind.armLift = -0.95; wind.lean = -0.16; wind.reach = -0.05;
        strike.twist = 0.08; strike.armLift = 1.1; strike.reach = 0.8; strike.lean = 0.36;
        break;
      case "sweep":
        // 侧举 + 拧身，和头顶下劈分开
        wind.twist = 1.05; wind.armSwing = -1.45; wind.armLift = -1.35; wind.lean = -0.24;
        strike.twist = -1.15; strike.armSwing = 1.55; strike.armLift = 0.2; strike.lean = 0.26; strike.reach = 0.4;
        break;
      case "slam":
        wind.armLift = -2.85; wind.lean = -0.7; wind.armSwing = 0.06; wind.crouch = 0.12;
        strike.armLift = 1.35; strike.lean = 0.78; strike.crouch = 0.5; strike.y = -0.34; strike.reach = 0.2;
        break;
      case "jump":
        wind.armLift = -2.75; wind.lean = -0.48; wind.y = this.jumpArc(1);
        strike.armLift = 1.35; strike.lean = 0.78; strike.crouch = 0.48; strike.y = -0.32; strike.reach = 0.15;
        break;
      case "shoulder":
        wind.twist = 0.85; wind.lean = -0.42; wind.armL = -1.15; wind.reach = -0.12; wind.armLift = -0.45;
        strike.twist = -0.55; strike.lean = 0.78; strike.reach = 0.85; strike.armL = 0.35; strike.y = 0.06;
        break;
      case "grab":
        wind.lean = -0.48; wind.armL = -2.35; wind.twist = -0.4; wind.reach = -0.12; wind.crouch = 0.08;
        strike.lean = 0.66; strike.armL = 1.15; strike.reach = 1.05; strike.twist = 0.25;
        break;
      case "serpSweep":
        wind.serpOut = 1.35; wind.serpYaw = Math.PI - 1.25; wind.twist = 0.55; wind.lean = -0.3; wind.armLift = -1.15;
        strike.serpOut = 1.75; strike.serpYaw = Math.PI + 1.25; strike.twist = -0.65; strike.lean = 0.32; strike.armLift = 0.25;
        break;
      case "serpThrust":
        wind.serpOut = 1.05; wind.serpYaw = Math.PI - 0.85; wind.lean = -0.4; wind.armLift = -1.55; wind.twist = 0.3;
        strike.serpOut = 1.95; strike.serpYaw = Math.PI; strike.lean = 0.48; strike.reach = 0.35; strike.armLift = 0.45;
        break;
    }
    const heavy = this.heavyMove(m.name);
    if (sub === "tel") {
      const begin = heavy ? 0.02 : 0.08;
      const hold = heavy ? 0.52 : 0.72;
      this.lerpPose(STANCE, wind, smooth(seg(t, m.startup * begin, m.startup * hold)));
      if (this.stepping) {
        const k = smooth(seg(t, m.startup * 0.58, m.startup));
        this.root.position.lerpVectors(this.stepFrom, this.stepTo, k);
      }
    } else if (sub === "act") {
      const k = seg(t, 0, m.active);
      this.lerpPose(wind, strike, 1 - Math.pow(1 - k, 3));
    } else {
      const backAt = heavy ? 0.58 : 0.32;
      this.lerpPose(strike, STANCE, smooth(seg(t, m.recovery * backAt, m.recovery)));
    }
    void total;
  }

  // ---------------- 古达专属覆盖点 ----------------
  /** 拔剑唤醒：起身姿态 + 尘土 + 血条亮相时机 + 切回 combat */
  protected override updateRising(dt: number): void {
    this.t += dt;
    const k = smooth(clamp01(this.t / 2.2));
    this.lerpPose(STATUE, STANCE, k);
    if (Math.random() < dt * 8) this.vfx.dust.burst(this.root.position, 3, 2, 0.7);
    if (this.t > 0.4 && this.t - dt <= 0.4) this.host.onBossReveal();
    if (this.t >= 2.2) { this.state = "combat"; this.sub = "idle"; this.t = 0; }
  }

  /** 拔出螺旋剑：胸口剑与光熄灭 + 起身音 */
  protected override onAwaken(): void {
    this.swordInChest.visible = false;
    this.swordLight.intensity = 0;
    AU.rise();
  }

  /** 眼睛呼吸 */
  protected override updateVisuals(): void {
    this.emberMat.emissiveIntensity = (this.phase === 2 ? 1.8 : 0.9) + Math.sin(performance.now() * 0.003) * 0.2;
  }

  /** 走近步态起伏 */
  protected override onIdleWalk(): void {
    this.pose.y = Math.abs(Math.sin(performance.now() * 0.004)) * 0.06 - 0.02;
  }

  /** 跳劈落点 / 近身迈步预计算。位移沿出手瞬间方向，前摇中不再追踪。 */
  protected override onMoveStart(m: MoveDef, toPlayer: THREE.Vector3, dist: number): void {
    this.lastMove = m.name;
    this.stepping = false;
    const dir = toPlayer.clone();
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) return;
    dir.normalize();
    if (m.name === "jump") {
      this.jumpFrom.copy(this.root.position);
      this.jumpTo.copy(this.root.position).addScaledVector(dir, Math.min(m.lunge ?? 0, Math.max(0, dist - 1.2)));
      return;
    }
    // 直戳、肩撞、沉淀突刺：先亮前摇，最后一段才迈步，避免滑步追人
    if (m.lunge && (m.name === "shoulder" || m.name === "thrust" || m.name === "thrust2" || m.name === "serpThrust")) {
      const keep = m.name === "serpThrust" ? 2.4 : 0.9;
      const step = Math.min(m.lunge, Math.max(0, dist - keep));
      if (step > 0.05) {
        this.stepping = true;
        this.stepFrom.copy(this.root.position);
        this.stepTo.copy(this.root.position).addScaledVector(dir, step);
      }
    }
  }

  /** 判定段开始：挥砍轨迹（蛇招橙焰）；下砸扬尘标出落点 */
  protected override onMoveActive(m: MoveDef): void {
    const chest = this.chestWorld();
    this.vfx.slash(chest, this.yaw, m.range * 0.85, m.arc > 2 || m.name === "serpSweep", m.name.startsWith("serp") ? 0xff7a30 : 0xffd9a0);
    if (m.name === "jump" || m.name === "slam") this.vfx.dust.burst(this.root.position, 8, 3.2, 0.85);
  }

  /** 重招风声更闷，和轻戳分开 */
  protected override activeWhooshVolume(m: MoveDef): number {
    return this.heavyMove(m.name) ? 0.62 : 1;
  }

  /** 抓技不进连段。二连戳仍走基类 40%（直戳的教学），但不会接回同一招。 */
  protected override pickChain(m: MoveDef, dist: number, toPlayer: THREE.Vector3): MoveDef | null {
    if (m.grab) return null;
    const next = super.pickChain(m, dist, toPlayer);
    if (!next || next.grab || next.name === m.name) return null;
    return next;
  }

  /** 破绽姿态：后仰蜷缩 */
  protected override updateStaggerPose(): void {
    this.lerpPose(STANCE, { ...STANCE, lean: 0.55, crouch: 0.35, y: -0.35 }, Math.min(1, this.t * 5));
  }

  /** 弹反踉跄姿态：更深的后仰 */
  protected override updateParriedPose(): void {
    this.lerpPose(STANCE, { ...STANCE, lean: 0.7, crouch: 0.45, y: -0.45, armLift: -0.4 }, Math.min(1, this.t * 8));
  }

  /** 变身爆发演出：蓄力蜷缩 → 0.8s 切二阶段、人性沉淀伸出 */
  protected override updateTransform(): void {
    if (this.t < 0.8) this.lerpPose(STANCE, { ...STANCE, crouch: 0.5, y: -0.5, lean: 0.4 }, smooth(this.t / 0.8));
    else {
      this.phase = 2;
      this.lerpPose({ ...STANCE, crouch: 0.5, y: -0.5, lean: 0.4 }, { ...STANCE, serpOut: 1, lean: -0.15 }, smooth(seg(this.t, 0.8, 1.6)));
    }
  }

  /** 死亡：前倾垮塌 + 余烬 */
  protected override updateDeath(dt: number): void {
    this.lerpPose(this.pose, { ...STANCE, lean: 1.35, y: -0.75, crouch: 0.4 }, dt * 4);
    if (Math.random() < dt * 20) this.vfx.embers.burst(this.chestWorld(), 3, 3, 1.2);
  }

  /** 复位外观：胸口剑/光复位、人性沉淀收回、回石像姿态 */
  protected override resetVisuals(): void {
    this.lastMove = "";
    this.preferFar = false;
    this.preferClose = false;
    this.stepping = false;
    this.swordInChest.visible = true; this.swordLight.intensity = 3;
    this.serpGlow.intensity = 0;
    this.emberMat.emissiveIntensity = 0.9;
    for (const s of this.serpent) { s.visible = false; s.scale.set(1, 1, 1); }
    this.lerpPose(STANCE, STATUE, 1);
  }

  // ---------------- 选招（古达权重） ----------------
  protected override pickMove(dist: number): MoveDef | null {
    const ready = (m: MoveDef) => (this.cds[m.name] ?? 0) <= 0 && (!m.phase2Only || this.phase === 2);
    // 进出阈值分开：贴到 6m 外才进远距，退回 5.2m 内才离开，避免边界帧来回换招
    if (dist > 6) this.preferFar = true;
    else if (dist < 5.2) this.preferFar = false;
    if (dist < 1.7) this.preferClose = true;
    else if (dist > 2.45) this.preferClose = false;

    if (this.preferFar && dist >= 5.2) {
      const jump = MOVES.jump;
      // 落点 = dist - min(lunge, dist-1.2)。再远跳劈够不着，空跳没有惩罚窗，先走近
      const jumpMax = (jump.lunge ?? 0) + jump.range + 0.45;
      const serp = MOVES.serpThrust;
      // 突刺视觉约 6.6m + 前冲，不在射程外甩一记仍能打中的短招
      const serpMax = Math.min(serp.range * 0.95, 6.6 + (serp.lunge ?? 0));
      const jumpOk = dist <= jumpMax && ready(jump);
      const serpOk = this.phase === 2 && dist <= serpMax && ready(serp);
      if (jumpOk && !(this.lastMove === "jump" && serpOk)) return jump;
      if (serpOk && this.lastMove !== "serpThrust") return serp;
      if (jumpOk) return jump;
      return null;
    }

    if (this.preferClose) {
      const grab = MOVES.grab;
      const shoulder = MOVES.shoulder;
      // 抓技低概率，且不接在肩撞后面变成连段
      if (dist < 1.65 && ready(grab) && this.lastMove !== "grab" && this.lastMove !== "shoulder" && Math.random() < 0.18) {
        return grab;
      }
      if (ready(shoulder) && Math.random() < (this.lastMove === "shoulder" ? 0.2 : 0.55)) return shoulder;
    }

    const p2 = this.phase === 2;
    const pool: [MoveDef, number][] = [
      [MOVES.thrust, p2 ? 1.5 : 3],
      [MOVES.sweep, p2 ? 1.6 : 3],
      [MOVES.slam, p2 ? 1.5 : 2.4],
      [MOVES.shoulder, dist < 2.5 ? 2 : 0],
      [MOVES.serpSweep, p2 ? 3.6 : 0],
      [MOVES.serpThrust, p2 && dist > 3.1 && dist < MOVES.serpThrust.range * 0.95 ? 2.4 : 0],
    ];
    const cands = pool.filter(([m, w]) => w > 0 && ready(m) && dist < m.range * 0.95);
    return this.choose(cands);
  }

  /** 有别的招可用时，把刚用过的招权重大幅压低 */
  private choose(cands: [MoveDef, number][]): MoveDef | null {
    if (!cands.length) return null;
    const hasAlt = cands.some(([m]) => m.name !== this.lastMove);
    const weighted: [MoveDef, number][] = cands.map(([m, w]) => {
      const ww = hasAlt && m.name === this.lastMove ? w * 0.18 : w;
      return [m, ww];
    });
    return pickWeighted(weighted) ?? weighted[0][0];
  }
}

function lerpAngle(a: number, b: number, k: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * k;
}
