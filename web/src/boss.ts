/** Boss「灰烬审判者古达」（DS3 官方名直接复用）：程序化石像傀儡 + FSM（docs/design/m1-demo.md 招式表）
 * 骨架全部代码驱动（时序归代码 ADR-0004），帧数据来自 config.MOVES
 * 通用机制（状态机/削韧破绽/弹反/阶段转换/死亡/命中判定/走近追踪）在 BossBase（boss-base.ts），
 * 本文件只保留古达专属：外观、Pose 姿态系统、选招权重、变身爆发、拔剑唤醒
 */
import * as THREE from "three";
import { BOSS, MOVES, MoveDef, COLORS } from "./config";
import { Vfx } from "./vfx";
import { AU } from "./audio";
import { BossBase, clamp01, smooth, seg } from "./boss-base";
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
  protected override movePose(m: MoveDef, sub: string, t: number, total: number): void {
    // 跳劈专属前摇：位移弧线 + 跃起，取代通用姿态分支
    if (m.name === "jump" && sub === "tel") {
      const k = smooth(clamp01(t / m.startup));
      this.root.position.lerpVectors(this.jumpFrom, this.jumpTo, k);
      this.pose.y = Math.sin(k * Math.PI) * 1.1;   // 跃起
      this.lerpPose(STANCE, { ...STANCE, armLift: -1.6, lean: -0.1 }, smooth(k));
      return;
    }
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
    if (m.name === "jump" && sub === "act") this.pose.y = 0;   // 落地压回
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

  /** 跳劈起跳点/落点预计算 */
  protected override onMoveStart(m: MoveDef, toPlayer: THREE.Vector3, dist: number): void {
    if (m.name !== "jump") return;
    this.jumpFrom.copy(this.root.position);
    const dir = toPlayer.clone().normalize();
    this.jumpTo.copy(this.root.position).addScaledVector(dir, Math.min(m.lunge ?? 0, dist - 1.2));
  }

  /** 判定段开始：挥砍轨迹（蛇招橙焰） */
  protected override onMoveActive(m: MoveDef): void {
    const chest = this.chestWorld();
    this.vfx.slash(chest, this.yaw, m.range * 0.85, m.arc > 2 || m.name === "serpSweep", m.name.startsWith("serp") ? 0xff7a30 : 0xffd9a0);
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
    this.swordInChest.visible = true; this.swordLight.intensity = 3;
    this.serpGlow.intensity = 0;
    this.emberMat.emissiveIntensity = 0.9;
    for (const s of this.serpent) s.visible = false;
    this.lerpPose(STANCE, STATUE, 1);
  }

  // ---------------- 选招（古达权重） ----------------
  protected override pickMove(dist: number): MoveDef | null {
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
