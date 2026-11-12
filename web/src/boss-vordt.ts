/** Boss #2「冷冽谷的玻尔多」（docs/design/m3-bosses.md 招式表帧数据）：兽形盔甲骑士 + 大锤
 * 通用机制（状态机/削韧破绽/弹反/阶段转换/死亡/命中判定/走近追踪）全在 BossBase（boss-base.ts），
 * 本文件只保留玻尔多专属：MOVES_VORDT/FEEL_VORDT（模块加载即并入 config 总表——调校台/存档自动收录，不改现有文件）、
 * 四足兽外观与 Pose 系统、选招权重、冲刺位移（位移放前摇，act 段即接触判定，与古达跳劈同构）、冰息多段、冰霜地面表现。
 * 冰蓝（0x9fd8e8）是本 Boss 主题色例外（m3-bosses.md 破例条款）；全局冷灰 + 火光纪律不变。
 */
import * as THREE from "three";
import { MOVES, FEEL, MoveDef, FeelDef } from "./config";
import { Vfx, Particles } from "./vfx";
import { AU } from "./audio";
import { BossBase, clamp01, smooth, seg, pickWeighted } from "./boss-base";
import type { AttackVolume, BossHost, BossStats } from "./boss-base";
import { numbered, part, partMat, spawnBoss } from "./boss-rig";

export type { BossState, BossHost } from "./boss-base";

// ---------------- 主题色（冰蓝 = 本 Boss 唯一例外强调色） ----------------
const ICE = 0x9fd8e8;        // 冰晶 / 冰面 / 冷雾
const ICE_GLOW = 0x5fb9d6;   // 冰晶自发光
const ICE_SLASH = 0xbfe2ee;  // 锤风轨迹（冷白）

/** 一阶段移速基准：基类 phase2 走速乘 0.85，这里预除回去，使二阶段实际 +25%（m3-bosses.md）。不再加快。 */
const WALK_P1 = 3.0;
const WALK_P2 = WALK_P1 * 1.25 / 0.85;
/** 远距离冲刺出手带：再近改近战，再远冲程够不着（lunge 7 + 落差约 2.8）。超出就走近，不空挥。 */
const CHARGE_NEAR = 6.5;
const CHARGE_FAR = 9.8;

/** 蓄力 ease-in（game-feel：ease-in 只用于前摇）。k²。 */
const easeIn = (v: number) => { const k = clamp01(v); return k * k; };
/**
 * 前摇对半：前半段的前一半 ease-in 到满蓄并保持到半程，后半段才从 0 发力到 1。
 * 不改 startup 秒数——重冲 0.70s 仍整段可反应。
 */
function anticipate(t: number, startup: number): number {
  const arrive = startup * 0.25;
  if (arrive <= 1e-4) return 1;
  return t >= arrive ? 1 : easeIn(t / arrive);
}
function releaseSmooth(t: number, startup: number): number {
  return smooth(seg(t, startup * 0.5, startup));
}
function releaseEase(t: number, startup: number): number {
  return easeIn(seg(t, startup * 0.5, startup));
}

export const VORDT_STATS: BossStats & { name: string; radius: number } = {
  name: "冷冽谷的玻尔多",
  radius: 1.1,
  hp: 700,
  poiseMax: 120, poiseDecay: 10, staggerDur: 2.2, staggerMul: 1.5,
  parriedDur: 1.8,
  phase2At: 0.6,
  walkSpeed: WALK_P1, turnRate: 2.6,      // 比古达快但转向钝——兽形惯性
};

/** 招式表（帧数据照 m3-bosses.md「Boss #2」；键名 vordt 前缀避免撞古达） */
export const MOVES_VORDT: Record<string, MoveDef> = {
  vordtSweep:  { name: "vordtSweep",  label: "锤横扫",   startup: 0.65, active: 0.18, recovery: 0.90, dmg: 26, range: 3.8, arc: 2.8, parryable: true,  cd: 3.0, feel: "vHeavy" },
  vordtSlam:   { name: "vordtSlam",   label: "下砸",     startup: 0.80, active: 0.14, recovery: 1.10, dmg: 32, range: 3.2, arc: 1.0, shock: 4.5, parryable: true, cd: 4.2, feel: "vHeavy" },
  vordtStomp:  { name: "vordtStomp",  label: "冰霜践踏", startup: 0.55, active: 0.22, recovery: 0.95, dmg: 24, range: 3.4, arc: 6.28, frost: { mul: 0.6, dur: 1.5 }, parryable: false, cd: 5.5, feel: "vLight" },
  vordtCharge: { name: "vordtCharge", label: "直线冲刺", startup: 0.70, active: 0.16, recovery: 1.30, dmg: 36, range: 9.0, arc: 0.6, lunge: 7.0, parryable: true, cd: 7.0, feel: "vCharge" },
  vordtBreath: { name: "vordtBreath", label: "冰息",     startup: 0.35, active: 0.90, recovery: 1.20, dmg: 8, hits: 4, hitInterval: 0.25, range: 7, arc: 0.8, frost: { mul: 0.55, dur: 2 }, parryable: false, cd: 6.5, phase2Only: true, feel: "vFrost" },
};

/** 手感档案（combat-feel.md 层级基准；vFrost 为冰息单段——4 跳连击不做屏震轰炸） */
export const FEEL_VORDT: Record<string, FeelDef & { label: string }> = {
  vLight:  { label: "玻尔多·轻", hitstop: 0.05, shake: 0.40, sparks: 10, sparkSpeed: 4, knockback: 0.4, sfx: "hitStone" },
  vHeavy:  { label: "玻尔多·重", hitstop: 0.09, shake: 0.55, sparks: 16, sparkSpeed: 5, knockback: 0.6, sfx: "hitHeavy" },
  vFrost:  { label: "冰息·段",   hitstop: 0.03, shake: 0.25, sparks: 6,  sparkSpeed: 3, knockback: 0.2, sfx: "hitStone" },
  vCharge: { label: "玻尔多·冲", hitstop: 0.10, shake: 0.60, sparks: 18, sparkSpeed: 5, knockback: 0.7, sfx: "hitHeavy" },
};

// 模块加载即并入总表（值是同一批对象引用，调校台热调双向生效）
Object.assign(MOVES, MOVES_VORDT);
Object.assign(FEEL, FEEL_VORDT);

// ---------------- Pose 系统（仿 boss.ts：STANCE/STATUE + lerpPose） ----------------
interface Pose {
  y: number; lean: number; twist: number; reach: number;
  armLift: number; armSwing: number; halPitch: number;
  headPitch: number; crouch: number; armL: number;
}
/** 兽形战斗站姿：躯干大前倾、锤头低垂贴地、四肢着地。halPitch 负到锤底落在地面上，厚锤头才看得见。 */
const STANCE: Pose = { y: 0, lean: 0.5, twist: 0, reach: 0, armLift: 0.35, armSwing: 0, halPitch: -0.74, headPitch: 0.15, crouch: 0, armL: 0 };
/** 趴伏石化：跪姿 y-0.5 / 前倾 0.9（唤醒演出起点） */
const STATUE: Pose = { ...STANCE, y: -0.5, lean: 0.9, crouch: 0.5, armLift: 0.7, halPitch: 1.3, headPitch: 0.35, armL: 0.3 };

export class Vordt extends BossBase {
  private body = new THREE.Group();
  private torso = new THREE.Group();
  private legR = new THREE.Group();
  private legL = new THREE.Group();
  private headG = new THREE.Group();
  private armR = new THREE.Group();
  private armL = new THREE.Group();
  private hammerG = new THREE.Group();
  private hamHilt = new THREE.Object3D();
  private hamTip = new THREE.Object3D();
  private head!: THREE.Object3D;
  private eyeMat!: THREE.MeshStandardMaterial;
  private eyeLight!: THREE.PointLight;
  private hammerIce: THREE.Mesh[] = [];      // 二阶段锤头结冰
  private pose: Pose = { ...STATUE };
  private chargeFrom = new THREE.Vector3();
  private chargeTo = new THREE.Vector3();
  private chargeGap = 1.2;                  // 冲刺落点到出手时玩家的距离（冰心/接触射程都对着它）
  private fxStep = 0;                        // 招式落点表现步进（onMoveStart 归零）
  private transformFxDone = false;
  private phase2Speed = false;               // 共享 walkSpeed 是否被写成二阶段值
  private walkSaved = WALK_P1;               // 加成前的一阶段移速（含调校台改值）
  private lastMove = "";                     // 上一招，用来压低连续践踏
  private mist!: Particles;                  // 冷雾粒子池（冰息锥 / 冲刺爪痕 / 二阶段周身冷雾）
  private lastVisT = 0;

  constructor(scene: THREE.Scene, vfx: Vfx, pos: THREE.Vector3, host: BossHost, facing = -Math.PI / 2) {
    super(scene, vfx, pos, host, VORDT_STATS, facing);
    // 死亡重开不走 reset。上一实例若没归还，表上会停着二阶段常量，一阶段开局就被加速。
    if (Math.abs(this.cfg.walkSpeed - WALK_P2) < 1e-4) this.cfg.walkSpeed = WALK_P1;
    this.mist = new Particles(scene, 140, { size: 0.17, color: ICE, additive: true, gravity: -0.25 });
    this.lastVisT = performance.now();
    this.transformHitAt = 0.5;               // 0.5s 冰爆波（m3-bosses.md 二阶段变身）
    this.assemble();
  }

  // ---------------- 外观：关节位置仍是原来的四足骨架，网格换成 Blender 导出的兽形 ----------------
  protected override buildBody(): void {
    // 形体来自 tools/blender/build_bosses.py。四足关节的转角仍由 applyPose 写。
    const rig = spawnBoss("vordt", "v_body");
    this.body = part(rig, "v_body") as THREE.Group;
    this.torso = part(rig, "v_torso") as THREE.Group;
    this.legR = part(rig, "v_legR") as THREE.Group;
    this.legL = part(rig, "v_legL") as THREE.Group;
    this.headG = part(rig, "v_headG") as THREE.Group;
    this.head = this.headG;
    this.armR = part(rig, "v_armR") as THREE.Group;
    this.armL = part(rig, "v_armL") as THREE.Group;
    this.hammerG = part(rig, "v_hammer") as THREE.Group;
    const sc = (n: number) => n * (3.8 / 2.579);
    this.hamHilt.position.set(0, sc(0.1), sc(0.15));
    this.hamTip.position.set(0, sc(0.364), sc(1.537));
    this.hammerG.add(this.hamHilt, this.hamTip);
    this.eyeMat = partMat(rig, "v_eye");
    this.eyeLight = new THREE.PointLight(ICE, 0, 4.5, 2);
    this.eyeLight.position.set(0, sc(0.04), sc(0.42));
    this.headG.add(this.eyeLight);
    this.hammerIce = numbered(rig, "v_ice");
    for (const c of this.hammerIce) c.visible = false;
    this.root.add(this.body);
  }

  protected override chestPart(): THREE.Object3D { return this.torso; }
  protected override headPart(): THREE.Object3D { return this.head; }

  /** 横扫和下砸贴着锤头。践踏是脚下的圆，冰息从嘴里往前，冲刺是胸口前方那一条。 */
  protected override attackVolume(m: MoveDef): AttackVolume | null {
    if (m.name === "vordtSweep" || m.name === "vordtSlam") {
      return { kind: "blade", hilt: this.hamHilt, tip: this.hamTip, pad: 0.55 };
    }
    if (m.name === "vordtStomp") {
      return { kind: "disk", x: this.root.position.x, z: this.root.position.z, r: m.range };
    }
    if (m.name === "vordtBreath") {
      const mouth = new THREE.Vector3();
      this.head.getWorldPosition(mouth);
      return { kind: "cone", x: mouth.x, z: mouth.z, yaw: this.yaw, range: m.range, arc: m.arc };
    }
    if (m.name === "vordtCharge") {
      const chest = this.chestWorld();
      return { kind: "cone", x: chest.x, z: chest.z, yaw: this.yaw, range: m.range, arc: m.arc };
    }
    return null;
  }

  // ---------------- 姿态应用 ----------------
  protected override applyPose(): void {
    const p = this.pose;
    this.root.rotation.y = this.yaw;
    this.body.position.set(0, p.y, p.reach);
    this.torso.rotation.set(p.lean, p.twist, 0);
    this.headG.rotation.x = p.headPitch;
    this.armR.rotation.set(-p.armLift, 0, -p.armSwing);
    this.armL.rotation.set(-p.armL, 0.12, 0);
    this.hammerG.rotation.x = 0.3 + p.halPitch;             // halPitch>0 = 锤头下压
    this.legR.rotation.x = this.legL.rotation.x = -0.12 - p.crouch * 0.5;
  }

  private lerpPose(a: Pose, b: Pose, k: number): void {
    const p = this.pose;
    p.y = a.y + (b.y - a.y) * k; p.lean = a.lean + (b.lean - a.lean) * k;
    p.twist = a.twist + (b.twist - a.twist) * k; p.reach = a.reach + (b.reach - a.reach) * k;
    p.armLift = a.armLift + (b.armLift - a.armLift) * k; p.armSwing = a.armSwing + (b.armSwing - a.armSwing) * k;
    p.halPitch = a.halPitch + (b.halPitch - a.halPitch) * k;
    p.headPitch = a.headPitch + (b.headPitch - a.headPitch) * k;
    p.crouch = a.crouch + (b.crouch - a.crouch) * k; p.armL = a.armL + (b.armL - a.armL) * k;
  }

  protected override movePose(m: MoveDef, sub: string, t: number, total: number): void {
    const wind: Pose = { ...STANCE }, strike: Pose = { ...STANCE };
    switch (m.name) {
      case "vordtSweep":
        wind.twist = 0.72; wind.armSwing = -1.55; wind.armLift = 0.3; wind.lean = 0.36;
        strike.twist = -1.02; strike.armSwing = 1.7; strike.armLift = 0.28; strike.lean = 0.5; strike.reach = 0.35;
        break;
      case "vordtSlam":   // 前半把锤举过背，后半砸到地面上（锤头停在地面，不钻进去）
        wind.armLift = -2.4; wind.halPitch = -2.35; wind.lean = -0.28; wind.y = 0.56; wind.crouch = -0.4; wind.headPitch = -0.48;
        strike.armLift = 1.6; strike.halPitch = -0.62; strike.lean = 1.28; strike.y = -0.28; strike.crouch = 0.62; strike.reach = 0.68; strike.headPitch = 0.5;
        break;
      case "vordtStomp":   // 前半抬身，后半砸落——贴身看得见再撤
        wind.y = 0.58; wind.crouch = -0.42; wind.lean = 0.12; wind.armL = -0.95; wind.armLift = -0.2; wind.headPitch = -0.2;
        strike.y = -0.52; strike.crouch = 0.6; strike.lean = 1.1; strike.armL = 0.4; strike.armLift = 0.45; strike.headPitch = 0.25;
        break;
      case "vordtCharge":  // 前半伏低刨地，后半才冲；act 段保持接触姿态
        wind.crouch = 0.78; wind.lean = 1.08; wind.headPitch = 0.65; wind.y = -0.5; wind.armLift = 0.9; wind.halPitch = 1.1; wind.twist = 0.05;
        strike.crouch = 0.26; strike.lean = 0.7; strike.reach = 0.9; strike.y = -0.18; strike.armLift = 0.35; strike.headPitch = 0.22; strike.halPitch = 0.5;
        break;
      case "vordtBreath":  // 抬头喷洒（headPitch 负 = 仰头）。整段前摇都保持后仰，喷雾在判定段
        wind.headPitch = -0.9; wind.lean = 0.08; wind.y = 0.26; wind.armL = -0.9; wind.armLift = -0.6; wind.crouch = -0.22;
        strike.headPitch = -0.72; strike.lean = 0.42; strike.y = 0.1; strike.armL = -0.55; strike.crouch = -0.08;
        break;
    }
    // 冲刺：位移只在前摇后半（古达跳劈同构——act 起点已在接触距离上）。前半只伏低，不贴脸。
    if (m.name === "vordtCharge" && sub === "tel") {
      const windK = anticipate(t, m.startup);
      const rush = releaseSmooth(t, m.startup);
      this.lerpPose(STANCE, wind, windK);
      if (rush > 0) {
        this.lerpPose(wind, strike, rush);
        this.root.position.lerpVectors(this.chargeFrom, this.chargeTo, rush);
        if (Math.random() < 0.65) this.mist.burst(this.root.position.clone().setY(0.22), 2, 2.4, 0.65, 0.45);
      } else if (Math.random() < 0.45) {
        this.vfx.dust.burst(this.root.position.clone().setY(0.12), 2, 1.3, 0.4);
      }
      if (this.fxStep === 0 && rush >= 1) {
        this.fxStep = 1;
        // 冰心在接触点（身前 chargeGap），半径收进弧 0.6 的锥里。横跑出去的位置不铺冰。
        if (this.phase === 2) {
          const half = m.arc / 2;
          const r = Math.min(0.85, Math.max(0.35, this.chargeGap * Math.sin(half) * 0.9));
          this.laneIce(r, this.chargeGap);
        }
        this.vfx.dust.burst(this.root.position.clone().setY(0.15), 8, 2.5, 0.7);
      }
      return;
    }
    // 下砸 / 践踏：前半蓄力姿态，后半加速砸下。判定段保持落地姿态，避免从 wind 再起摆弹回去。
    if ((m.name === "vordtSlam" || m.name === "vordtStomp") && sub === "tel") {
      const windK = anticipate(t, m.startup);
      const drop = releaseEase(t, m.startup);
      this.lerpPose(STANCE, wind, windK);
      if (drop > 0) this.lerpPose(wind, strike, drop);
      return;
    }
    // 冰息：整段前摇都是后仰吸气，0.35s 都看得见，再喷。
    if (m.name === "vordtBreath" && sub === "tel") {
      this.lerpPose(STANCE, wind, anticipate(t, m.startup));
      return;
    }
    if (sub === "tel") this.lerpPose(STANCE, wind, smooth(seg(t, m.startup * 0.55, m.startup)));
    else if (sub === "act") {
      const planted = m.name === "vordtCharge" || m.name === "vordtSlam" || m.name === "vordtStomp";
      this.lerpPose(wind, strike, planted ? 1 : seg(t, 0, m.active));
      this.impactFx(m, t);
    }
    else this.lerpPose(strike, STANCE, smooth(seg(t, m.recovery * 0.35, m.recovery)));
    void total;
  }

  /** 沿当前面向铺冰。半径须落在该招的判定锥里，避免冰在安全区、伤害在另一处。 */
  private laneIce(radius: number, forward: number): void {
    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.vfx.scorch(this.root.position.clone().addScaledVector(fwd, forward).setY(0.05), radius, ICE);
  }

  /** 招式落点表现（与命中判定解耦：打中/躲开都应震地结冰） */
  private impactFx(m: MoveDef, t: number): void {
    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    // 冰霜践踏：自放冷色冲击包（不走 MoveDef.shock——基类该路径固定暖色环/暖斑，会污染冰主题）
    if (m.name === "vordtStomp" && this.fxStep === 0 && t >= m.active * 0.5) {
      this.fxStep = 1;
      this.vfx.ring(this.root.position, 3.4, ICE);
      // 全向践踏的判定在脚底。冰心偏到身前 1.2m 时，身后吃伤害、前方安全区铺冰。
      this.vfx.scorch(this.root.position.clone().setY(0.05), 3.2, ICE);
      this.mist.burst(this.root.position.clone().setY(0.4), 18, 3.5, 1.2, 0.7);
      AU.slamShock();
      this.host.shake(0.55);
      return;
    }
    if (m.name === "vordtSlam" && this.fxStep === 0 && t >= m.active * 0.5) {
      this.fxStep = 1;
      // 弧 1.0（半角 0.5）。圆心在 2m、半径 0.9 时，圆上最大张角 asin(0.9/2)≈0.47 < 0.5，冰在锤锥里。
      const at = this.root.position.clone().addScaledVector(fwd, 2.0).setY(0.1);
      this.vfx.dust.burst(at, 10, 3, 0.7);
      this.mist.burst(at, 8, 2.5, 1.0, 0.6);
      if (this.phase === 2) this.vfx.scorch(at, 0.9, ICE);
      return;
    }
    if (m.name === "vordtBreath") {
      // 距离 7、半角 0.4。三片冰的圆心和半径都收在锥内，最远缘 < 7，躲出锥的人不踩冰。
      const marks: readonly [number, number][] = [[2.3, 0.85], [4.1, 1.5], [5.5, 1.4]];
      while (this.fxStep < marks.length && t >= 0.12 + this.fxStep * 0.28) {
        const [d, r] = marks[this.fxStep];
        this.vfx.scorch(this.root.position.clone().addScaledVector(fwd, d).setY(0.05), r, ICE);
        this.fxStep++;
      }
      if (Math.random() < 0.85) {                                   // 扇形冷雾
        const d = 1.2 + Math.random() * 5.4;
        const side = new THREE.Vector3(fwd.z, 0, -fwd.x);
        const p = this.root.position.clone().addScaledVector(fwd, d)
          .addScaledVector(side, (Math.random() - 0.5) * (d / 7) * 1.6).setY(0.5 + Math.random() * 0.7);
        this.mist.burst(p, 2, 1.2, 1.1, 0.4);
      }
    }
  }

  // ---------------- 玻尔多专属覆盖点 ----------------
  /** 趴伏石化 → 抬身 2.2s + 抖尘/冷雾 */
  protected override updateRising(dt: number): void {
    this.t += dt;
    this.lerpPose(STATUE, STANCE, smooth(clamp01(this.t / 2.2)));
    if (Math.random() < dt * 8) this.vfx.dust.burst(this.root.position, 3, 2, 0.7);
    if (Math.random() < dt * 6) this.mist.burst(this.root.position.clone().setY(0.8), 2, 1.2, 1.2, 0.5);
    if (this.t > 0.5 && this.t - dt <= 0.5) this.host.onBossReveal();
    if (this.t >= 2.2) { this.state = "combat"; this.sub = "idle"; this.t = 0; }
  }

  /** 唤醒：起身音 + 冰尘炸开 */
  protected override onAwaken(): void {
    AU.rise();
    this.mist.burst(this.root.position.clone().setY(0.8), 16, 2.5, 1.4, 0.6);
  }

  /** 眼睛呼吸 + 冷雾池推进 + 二阶段周身冷雾 */
  protected override updateVisuals(): void {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastVisT) / 1000);
    this.lastVisT = now;
    this.mist.update(dt);
    this.eyeMat.emissiveIntensity = (this.phase === 2 ? 1.8 : 0.8) + Math.sin(now * 0.003) * 0.25;
    this.eyeLight.intensity = this.phase === 2 ? 1.8 + Math.sin(now * 0.005) * 0.4 : 0;
    if (this.phase === 2 && this.state !== "statue" && Math.random() < dt * 10) {
      this.mist.burst(this.chestWorld(), 1, 0.5, 1.6, 0.3);
    }
    // 破绽/弹反/被打断的招式只改了部分姿态。待机若不拉回 STANCE，蹲伏和举锤会一直留着（走近时 onIdleWalk 只改 y/lean）。
    if (this.state === "combat" && this.sub === "idle") this.lerpPose(this.pose, STANCE, 1 - Math.exp(-12 * dt));
  }

  /** 兽类小碎步（步频高于古达） */
  protected override onIdleWalk(): void {
    const w = performance.now() * 0.011;
    this.pose.y = Math.abs(Math.sin(w)) * 0.05 - 0.02;
    this.pose.lean = 0.5 + Math.sin(w * 2) * 0.025;
  }

  /** 冲刺/冰息在出手瞬间锁面向：位移、判定锥、冰痕同一条线，前摇期间不再追踪。 */
  private lockYaw(toPlayer: THREE.Vector3): boolean {
    const dir = toPlayer.clone();
    dir.y = 0;
    if (dir.lengthSq() < 1e-8) return false;
    dir.normalize();
    this.yaw = Math.atan2(dir.x, dir.z);
    return true;
  }

  /** 冲刺起终点预计算（前冲不越过玩家；前半段还不动，这里只记下落点） */
  protected override onMoveStart(m: MoveDef, toPlayer: THREE.Vector3, dist: number): void {
    this.fxStep = 0;
    this.lastMove = m.name;
    if (m.name === "vordtBreath") { this.lockYaw(toPlayer); return; }
    if (m.name !== "vordtCharge") return;
    this.chargeFrom.copy(this.root.position);
    this.chargeTo.copy(this.root.position);
    if (!this.lockYaw(toPlayer)) return;
    const dir = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const travel = Math.min(m.lunge ?? 7, Math.max(0, dist - 1.2));
    this.chargeGap = Math.max(0, dist - travel);
    this.chargeTo.addScaledVector(dir, travel);
  }

  /** 判定段开始：锤横扫冷色轨迹 */
  protected override onMoveActive(m: MoveDef): void {
    if (m.name === "vordtSweep") {
      // 环带外缘贴锤头最远扫到的位置（约 0.82×射程），高度落在锤头而不是胸口。时机仍是这一下。
      const at = this.chestWorld();
      at.y = this.hamTip.getWorldPosition(new THREE.Vector3()).y;
      this.vfx.slash(at, this.yaw, m.range * 0.82, true, ICE_SLASH);
    }
  }

  /** 重招风声更闷 */
  protected override activeWhooshVolume(m: MoveDef): number {
    return m.name === "vordtSlam" || m.name === "vordtStomp" || m.name === "vordtCharge" ? 0.6 : 1;
  }

  /** 破绽：兽躯瘫伏 */
  protected override updateStaggerPose(): void {
    this.lerpPose(STANCE, { ...STANCE, lean: 0.95, crouch: 0.45, y: -0.4, armLift: 0.25, halPitch: 1.2 }, Math.min(1, this.t * 5));
  }

  /** 弹反踉跄：更深的瘫伏 + 锤脱手侧垂 */
  protected override updateParriedPose(): void {
    this.lerpPose(STANCE, { ...STANCE, lean: 1.1, crouch: 0.55, y: -0.55, armLift: 0.15, armSwing: 0.45, halPitch: 1.35 }, Math.min(1, this.t * 8));
  }

  /** 变身：蜷缩蓄力 → 0.5s 冰爆波（基类同时回调 onBossTransform 交 game 侧结算伤害）→ 冰眼点燃 */
  protected override updateTransform(): void {
    const crouchPose = { ...STANCE, crouch: 0.55, y: -0.55, lean: 1.1 };
    if (this.t < 0.5) {
      this.lerpPose(STANCE, crouchPose, smooth(this.t / 0.5));
      return;
    }
    if (!this.transformFxDone) {
      this.transformFxDone = true;
      this.phase = 2;
      this.applyPhase2Speed();                                 // 净 +25%，不在这之上再加
      this.vfx.ring(this.root.position, 4, ICE);
      this.mist.burst(this.chestWorld(), 26, 4.5, 1.4, 0.8);
      for (const c of this.hammerIce) c.visible = true;      // 锤头结冰
    }
    this.lerpPose(crouchPose, { ...STANCE, lean: 0.35, y: 0.15 }, smooth(seg(this.t, 0.5, 1.5)));
  }

  /** 死亡：侧向垮塌 + 余烬 + 最后一缕冷雾 */
  protected override updateDeath(dt: number): void {
    this.lerpPose(this.pose, { ...STANCE, lean: 1.15, twist: 0.4, y: -0.7, crouch: 0.6, armLift: 0.2, halPitch: 1.4 }, dt * 3);
    if (Math.random() < dt * 20) this.vfx.embers.burst(this.chestWorld(), 3, 3, 1.2);
    if (Math.random() < dt * 8) this.mist.burst(this.chestWorld(), 1, 0.8, 1.6, 0.4);
  }

  /** 二阶段写的是共享 VORDT_STATS.walkSpeed。归还看「写过没有」，不看此刻 phase 是不是 2
   *  （reset 会先把 phase 清成 1；死亡重开只 dispose、不走 reset）。 */
  private applyPhase2Speed(): void {
    if (this.phase2Speed) return;
    this.walkSaved = this.cfg.walkSpeed;
    if (Math.abs(this.walkSaved - WALK_P2) < 1e-4) this.walkSaved = WALK_P1;
    this.phase2Speed = true;
    this.cfg.walkSpeed = this.walkSaved * 1.25 / 0.85;
  }
  private restoreWalk(): void {
    if (this.phase2Speed) {
      this.phase2Speed = false;
      this.cfg.walkSpeed = this.walkSaved;
      return;
    }
    if (Math.abs(this.cfg.walkSpeed - WALK_P2) < 1e-4) this.cfg.walkSpeed = WALK_P1;
  }

  protected override releaseSharedState(): void {
    this.restoreWalk();
  }

  /** 冷雾挂在 scene 上，不在 root 里。死亡重开只 dispose root 的话，粒子池会一层层留下。 */
  protected override extraDispose(): void {
    this.mist.mesh.geometry.dispose();
    (this.mist.mesh.material as THREE.Material).dispose();
    this.mist.mesh.removeFromParent();
  }

  /** 复位外观：锤冰收回、眼灯熄灭、移速还原、回趴伏石像 */
  protected override resetVisuals(): void {
    this.transformFxDone = false;
    this.fxStep = 0;
    this.lastMove = "";
    this.eyeLight.intensity = 0;
    this.restoreWalk();
    for (const c of this.hammerIce) c.visible = false;
    this.lerpPose(STANCE, STATUE, 1);
  }

  // ---------------- 选招（玻尔多权重） ----------------
  protected override pickMove(dist: number): MoveDef | null {
    const M = MOVES_VORDT;
    const ready = (m: MoveDef) => (this.cds[m.name] ?? 0) <= 0 && (!m.phase2Only || this.phase === 2);
    // 远距离：冲刺必出（惩罚窗口教学，对标古达跳劈）。二阶段 cd 减半 = 冲刺可二连。
    // 上限约 9.8：lunge 7 + 接触落差 ≈ 2.8。再远判定用 range 9 会在身体没到时打中人。
    if (dist > CHARGE_NEAR) {
      const charge = M.vordtCharge;
      const lunge = charge.lunge ?? 7;
      const travel = Math.min(lunge, Math.max(0, dist - 1.2));
      const gap = dist - travel;
      const far = Math.min(CHARGE_FAR, lunge + 2.8);
      const chargeReady = (this.cds[charge.name] ?? 0) <= (this.phase === 2 ? charge.cd * 0.5 : 0);
      // 落差已经大于本招射程：走近，不挥。出手用本次接触距离，不改共享表上的 range 9。
      if (dist <= far && gap <= charge.range && chargeReady) {
        return { ...charge, range: Math.min(charge.range, gap + 0.6) };
      }
      return null;
    }
    let stompW = dist < 2.2 ? 4 : 0;
    const slamW = dist < 2.2 ? 3 : 2;
    const sweepW = 3;
    const breathW = this.phase === 2 && dist >= 2.5 && dist <= 6 ? 2.5 : 0;
    // 上一招已是践踏、别的招又好：压低权重，避免贴身连踩。别的招都在冷却时仍允许践踏。
    if (this.lastMove === M.vordtStomp.name && stompW > 0) {
      const alt = [
        [M.vordtSlam, slamW],
        [M.vordtSweep, sweepW],
        [M.vordtBreath, breathW],
      ] as [MoveDef, number][];
      if (alt.some(([m, w]) => w > 0 && ready(m) && dist < m.range * 0.95)) stompW = 1;
    }
    const pool: [MoveDef, number][] = [
      [M.vordtStomp, stompW],
      [M.vordtSlam, slamW],
      [M.vordtSweep, sweepW],
      [M.vordtBreath, breathW],
    ];
    const cands = pool.filter(([m, w]) => w > 0 && ready(m) && dist < m.range * 0.95);
    if (!cands.length) return null;
    return pickWeighted(cands) ?? cands[0][0];
  }
}
