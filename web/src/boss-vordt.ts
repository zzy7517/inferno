/** Boss #2「冷冽谷的玻尔多」（docs/design/m3-bosses.md 招式表帧数据）：兽形盔甲骑士 + 大锤
 * 通用机制（状态机/削韧破绽/弹反/阶段转换/死亡/命中判定/走近追踪）全在 BossBase（boss-base.ts），
 * 本文件只保留玻尔多专属：MOVES_VORDT/FEEL_VORDT（模块加载即并入 config 总表——调校台/存档自动收录，不改现有文件）、
 * 四足兽外观与 Pose 系统、选招权重、冲刺位移（位移放前摇，act 段即接触判定，与古达跳劈同构）、冰息多段、冰霜地面表现。
 * 冰蓝（0x9fd8e8）是本 Boss 主题色例外（m3-bosses.md 破例条款）；全局冷灰 + 火光纪律不变。
 */
import * as THREE from "three";
import { MOVES, FEEL, MoveDef, FeelDef, COLORS } from "./config";
import { Vfx, Particles } from "./vfx";
import { AU } from "./audio";
import { BossBase, clamp01, smooth, seg } from "./boss-base";
import type { BossHost, BossStats } from "./boss-base";

export type { BossState, BossHost } from "./boss-base";

// ---------------- 主题色（冰蓝 = 本 Boss 唯一例外强调色） ----------------
const ICE = 0x9fd8e8;        // 冰晶 / 冰面 / 冷雾
const ICE_GLOW = 0x5fb9d6;   // 冰晶自发光
const ICE_SLASH = 0xbfe2ee;  // 锤风轨迹（冷白）

/** 一阶段移速基准：基类 phase2 走速乘 0.85，这里预除回去，使二阶段实际 +25%（m3-bosses.md） */
const WALK_P1 = 3.0;

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
/** 兽形战斗站姿：躯干大前倾、锤头低垂、四肢着地 */
const STANCE: Pose = { y: 0, lean: 0.5, twist: 0, reach: 0, armLift: 0.35, armSwing: 0, halPitch: 0.5, headPitch: 0.15, crouch: 0, armL: 0 };
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
  private head!: THREE.Mesh;
  private eyeMat!: THREE.MeshStandardMaterial;
  private eyeLight!: THREE.PointLight;
  private hammerIce: THREE.Mesh[] = [];      // 二阶段锤头结冰
  private pose: Pose = { ...STATUE };
  private chargeFrom = new THREE.Vector3();
  private chargeTo = new THREE.Vector3();
  private fxStep = 0;                        // 招式落点表现步进（onMoveStart 归零）
  private transformFxDone = false;
  private mist!: Particles;                  // 冷雾粒子池（冰息锥 / 冲刺爪痕 / 二阶段周身冷雾）
  private lastVisT = 0;

  constructor(scene: THREE.Scene, vfx: Vfx, pos: THREE.Vector3, host: BossHost, facing = -Math.PI / 2) {
    super(scene, vfx, pos, host, VORDT_STATS, facing);
    this.mist = new Particles(scene, 140, { size: 0.17, color: ICE, additive: true, gravity: -0.25 });
    this.lastVisT = performance.now();
    this.transformHitAt = 0.5;               // 0.5s 冰爆波（m3-bosses.md 二阶段变身）
    this.assemble();
  }

  // ---------------- 外观（程序化 flatShading，~42 mesh，横向 1.8 / 站高 ~2.2） ----------------
  protected override buildBody(): void {
    const plate = new THREE.MeshStandardMaterial({ color: COLORS.stone, roughness: 0.95, flatShading: true });
    const dark = new THREE.MeshStandardMaterial({ color: COLORS.stoneDark, roughness: 1, flatShading: true });
    const steel = new THREE.MeshStandardMaterial({ color: 0x4c5560, roughness: 0.6, metalness: 0.35, flatShading: true });
    const trim = new THREE.MeshStandardMaterial({ color: 0x5a636e, roughness: 0.5, metalness: 0.4, flatShading: true });
    const ice = new THREE.MeshStandardMaterial({ color: ICE, emissive: ICE_GLOW, emissiveIntensity: 0.55, roughness: 0.25, metalness: 0.1, flatShading: true, transparent: true, opacity: 0.85 });
    this.eyeMat = new THREE.MeshStandardMaterial({ color: 0x0c1014, emissive: ICE, emissiveIntensity: 0.8, roughness: 0.4 });

    const box = (w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z); m.castShadow = true;
      return m;
    };
    const tetra = (r: number, mat: THREE.Material, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(new THREE.TetrahedronGeometry(r), mat);
      m.position.set(x, y, z);
      m.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      m.castShadow = true;
      return m;
    };

    // 后肢（兽形后腿，crouch 折叠）
    for (const [g, sx] of [[this.legR, 1], [this.legL, -1]] as [THREE.Group, number][]) {
      g.position.set(sx * 0.52, 1.02, -0.55);
      g.add(box(0.38, 0.85, 0.55, dark, 0, -0.3, 0.12));
      g.add(box(0.3, 0.75, 0.34, dark, 0, -0.85, -0.18));
      g.add(box(0.34, 0.2, 0.6, plate, 0, -1.22, 0.05));
      this.body.add(g);
    }
    // 短尾
    const tail = box(0.18, 0.18, 0.6, dark, 0, 0.78, -0.95);
    tail.rotation.x = 0.35;
    this.body.add(tail);

    // 躯干（前倾由 lean 驱动；宽矮体形：胸宽 1.2 + 肩甲到 ±0.9）
    this.torso.position.set(0, 1.2, -0.1);
    this.torso.add(box(1.1, 0.62, 0.75, dark, 0, -0.05, -0.42));            // 骨盆
    this.torso.add(box(1.2, 0.8, 1.2, plate, 0, 0.18, 0.42));               // 胸甲
    this.torso.add(box(1.05, 0.28, 1.05, steel, 0, 0.62, 0.35));            // 脊背护甲层
    // 肩甲层叠（每侧两层外扩）
    for (const s of [-1, 1]) {
      const p1 = box(0.55, 0.24, 0.78, steel, s * 0.82, 0.55, 0.42);
      p1.rotation.z = -s * 0.15;
      const p2 = box(0.46, 0.2, 0.64, trim, s * 0.86, 0.34, 0.48);
      p2.rotation.z = -s * 0.3;
      this.torso.add(p1, p2);
    }
    // 头（低伏前伸 + 冰蓝眼 + 弯角）
    this.headG.position.set(0, 0.5, 1.02);
    this.head = box(0.56, 0.52, 0.62, plate, 0, 0, 0);
    this.headG.add(this.head, box(0.32, 0.28, 0.4, dark, 0, -0.12, 0.42));
    for (const s of [-1, 1]) {
      const eye = box(0.11, 0.07, 0.05, this.eyeMat, s * 0.14, 0.06, 0.32);
      const horn = box(0.1, 0.34, 0.12, trim, s * 0.26, 0.32, -0.08);
      horn.rotation.z = -s * 0.55;
      this.headG.add(eye, horn);
    }
    this.eyeLight = new THREE.PointLight(ICE, 0, 4.5, 2);
    this.eyeLight.position.set(0, 0.1, 0.5);
    this.headG.add(this.eyeLight);
    this.torso.add(this.headG);
    // 背脊 / 肩甲冰晶尖刺（常驻装饰）
    for (let i = 0; i < 4; i++) {
      this.torso.add(tetra(0.2 - i * 0.02, ice, (i % 2 ? 0.16 : -0.16), 0.8, 0.72 - i * 0.3));
    }
    for (const s of [-1, 1]) {
      this.torso.add(tetra(0.11, ice, s * 0.78, 0.76, 0.3));
      this.torso.add(tetra(0.09, ice, s * 0.7, 0.78, 0.62));
    }

    // 右前肢（持锤）+ 大锤（长柄方头）
    this.armR.position.set(0.8, 0.42, 0.5);
    this.armR.add(box(0.36, 0.8, 0.4, plate, 0, -0.35, 0.05));
    const foreR = box(0.3, 0.75, 0.34, dark, 0, -0.95, 0.15);
    foreR.rotation.x = 0.3;
    this.armR.add(foreR, box(0.4, 0.36, 0.42, steel, 0, -1.35, 0.32));
    this.hammerG.position.set(0, -1.42, 0.38);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 2.3, 6), new THREE.MeshStandardMaterial({ color: 0x2e2a24, roughness: 0.9, flatShading: true }));
    shaft.position.set(0, 0.15, 0.85); shaft.rotation.x = Math.PI / 2 - 0.32; shaft.castShadow = true;
    this.hammerG.add(shaft);
    this.hammerG.add(box(0.4, 0.4, 0.42, trim, 0, 0.62, 1.75));             // 方形锤头
    this.hammerG.add(box(0.12, 0.5, 0.5, steel, 0.26, 0.62, 1.75), box(0.12, 0.5, 0.5, steel, -0.26, 0.62, 1.75));
    for (const [ix, iy, iz, r] of [[0.3, 0.85, 1.7, 0.16], [0, 0.95, 1.85, 0.2], [-0.3, 0.8, 1.65, 0.14]] as const) {
      const c = tetra(r, ice, ix, iy, iz);
      c.visible = false;
      this.hammerIce.push(c);
      this.hammerG.add(c);
    }
    this.armR.add(this.hammerG);
    this.torso.add(this.armR);

    // 左前肢（兽爪，冰息时撑地后仰）
    this.armL.position.set(-0.8, 0.42, 0.5);
    this.armL.add(box(0.36, 0.8, 0.4, plate, 0, -0.35, 0.05));
    const foreL = box(0.3, 0.75, 0.34, dark, 0, -0.95, 0.12);
    foreL.rotation.x = 0.25;
    this.armL.add(foreL, box(0.42, 0.3, 0.5, dark, 0, -1.35, 0.25));
    this.torso.add(this.armL);

    this.body.add(this.torso);
    this.root.add(this.body);
  }

  protected override chestPart(): THREE.Object3D { return this.torso; }
  protected override headPart(): THREE.Object3D { return this.head; }

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
        wind.twist = 0.6; wind.armSwing = -1.35; wind.armLift = 0.15; wind.lean = 0.55;
        strike.twist = -0.85; strike.armSwing = 1.5; strike.armLift = 0.25; strike.lean = 0.7; strike.reach = 0.35;
        break;
      case "vordtSlam":
        wind.armLift = -1.9; wind.halPitch = -0.7; wind.lean = 0.25; wind.y = 0.15; wind.crouch = -0.15;
        strike.armLift = 1.0; strike.halPitch = 1.2; strike.lean = 0.95; strike.y = -0.35; strike.crouch = 0.35; strike.reach = 0.55;
        break;
      case "vordtStomp":   // 前肢抬起后整身砸落
        wind.y = 0.4; wind.crouch = -0.25; wind.lean = 0.3; wind.armL = -0.6; wind.armLift = 0.1;
        strike.y = -0.5; strike.crouch = 0.55; strike.lean = 1.05; strike.armL = 0.35; strike.armLift = 0.4;
        break;
      case "vordtCharge":  // 前 40% 刨地蓄力 → 冲撞；act 段保持接触姿态
        wind.crouch = 0.4; wind.lean = 0.75; wind.headPitch = 0.4; wind.y = -0.3; wind.armLift = 0.55; wind.halPitch = 0.8; wind.twist = 0.1;
        strike.crouch = 0.3; strike.lean = 0.6; strike.reach = 0.7; strike.y = -0.2; strike.armLift = 0.45; strike.headPitch = 0.3;
        break;
      case "vordtBreath":  // 抬头喷洒（headPitch 负 = 仰头）
        wind.headPitch = -0.6; wind.lean = 0.3; wind.y = 0.1; wind.armL = -0.4; wind.armLift = -0.3;
        strike.headPitch = -0.45; strike.lean = 0.5; strike.y = 0.05; strike.armL = -0.35;
        break;
    }
    // 冲刺专属前摇：位移放前摇段（古达跳劈同构——act 起点已在玩家身前，range 判定即真实接触）
    if (m.name === "vordtCharge" && sub === "tel") {
      const k = seg(t, m.startup * 0.4, m.startup);
      this.root.position.lerpVectors(this.chargeFrom, this.chargeTo, smooth(k));
      if (k > 0 && Math.random() < 0.6) this.mist.burst(this.root.position.clone().setY(0.25), 2, 2.2, 0.7, 0.5);
      if (this.fxStep === 0 && k >= 1) {
        this.fxStep = 1;
        if (this.phase === 2) this.vfx.scorch(this.chargeTo.clone().setY(0.05), 2.4, ICE);   // 冰痕残留
        this.vfx.dust.burst(this.chargeTo.clone().setY(0.15), 8, 2.5, 0.7);
      }
      this.lerpPose(STANCE, wind, smooth(Math.min(1, t / (m.startup * 0.4))));
      if (k > 0) this.lerpPose(wind, strike, smooth(k));
      return;
    }
    if (sub === "tel") this.lerpPose(STANCE, wind, smooth(seg(t, m.startup * 0.55, m.startup)));
    else if (sub === "act") {
      // 冲刺 act = 接触瞬间：保持冲撞姿态（避免从 wind 重新起摆的回弹）
      this.lerpPose(wind, strike, m.name === "vordtCharge" ? 1 : seg(t, 0, m.active));
      this.impactFx(m, t);
    }
    else this.lerpPose(strike, STANCE, smooth(seg(t, m.recovery * 0.35, m.recovery)));
    void total;
  }

  /** 招式落点表现（与命中判定解耦：打中/躲开都应震地结冰） */
  private impactFx(m: MoveDef, t: number): void {
    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    // 冰霜践踏：自放冷色冲击包（不走 MoveDef.shock——基类该路径固定暖色环/暖斑，会污染冰主题）
    if (m.name === "vordtStomp" && this.fxStep === 0 && t >= m.active * 0.5) {
      this.fxStep = 1;
      this.vfx.ring(this.root.position, 3.4, ICE);
      this.vfx.scorch(this.root.position.clone().addScaledVector(fwd, 1.2).setY(0.05), 2.9, ICE);
      this.mist.burst(this.root.position.clone().setY(0.4), 18, 3.5, 1.2, 0.7);
      AU.slamShock();
      this.host.shake(0.55);
      return;
    }
    if (m.name === "vordtSlam" && this.fxStep === 0 && t >= m.active * 0.5) {
      this.fxStep = 1;
      const at = this.root.position.clone().addScaledVector(fwd, 2.3).setY(0.1);
      this.vfx.dust.burst(at, 10, 3, 0.7);
      this.mist.burst(at, 8, 2.5, 1.0, 0.6);
      if (this.phase === 2) this.vfx.scorch(at, 2.2, ICE);   // 二阶段招式落点冰痕
      return;
    }
    if (m.name === "vordtBreath") {
      while (this.fxStep < 3 && t >= 0.12 + this.fxStep * 0.28) {   // 锥形推进的冰面
        const k = this.fxStep / 2;
        this.vfx.scorch(this.root.position.clone().addScaledVector(fwd, 2.2 + k * 3.6).setY(0.05), 1.5 + k * 0.9, ICE);
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
  }

  /** 兽类小碎步（步频高于古达） */
  protected override onIdleWalk(): void {
    const w = performance.now() * 0.011;
    this.pose.y = Math.abs(Math.sin(w)) * 0.05 - 0.02;
    this.pose.lean = 0.5 + Math.sin(w * 2) * 0.025;
  }

  /** 冲刺起终点预计算（前冲 6–8m，不越过玩家） */
  protected override onMoveStart(m: MoveDef, toPlayer: THREE.Vector3, dist: number): void {
    this.fxStep = 0;
    if (m.name !== "vordtCharge") return;
    this.chargeFrom.copy(this.root.position);
    this.chargeTo.copy(this.root.position).addScaledVector(toPlayer.clone().normalize(), Math.min(m.lunge ?? 7, dist - 1.2));
  }

  /** 判定段开始：锤横扫冷色轨迹 */
  protected override onMoveActive(m: MoveDef): void {
    if (m.name === "vordtSweep") this.vfx.slash(this.chestWorld(), this.yaw, m.range * 0.85, true, ICE_SLASH);
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
      this.cfg.walkSpeed = WALK_P1 * 1.25 / 0.85;            // 抵消基类 phase2 ×0.85，净 +25%（m3-bosses.md）
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

  /** 复位外观：锤冰收回、眼灯熄灭、移速还原、回趴伏石像 */
  protected override resetVisuals(): void {
    this.transformFxDone = false;
    this.fxStep = 0;
    this.eyeLight.intensity = 0;
    this.cfg.walkSpeed = WALK_P1;
    for (const c of this.hammerIce) c.visible = false;
    this.lerpPose(STANCE, STATUE, 1);
  }

  // ---------------- 选招（玻尔多权重） ----------------
  protected override pickMove(dist: number): MoveDef | null {
    const M = MOVES_VORDT;
    const ready = (m: MoveDef) => (this.cds[m.name] ?? 0) <= 0 && (!m.phase2Only || this.phase === 2);
    // 远距离：冲刺必出（惩罚窗口教学，对标古达跳劈）。二阶段 cd 减半 = 冲刺可二连。
    // 上限 9.8：lunge 7 + 接触余量 ≈ 2.8，再远的话判定段落点够不着玩家（range 9 会空挥成幽灵命中）
    if (dist > 6.5) {
      const chargeReady = (this.cds[M.vordtCharge.name] ?? 0) <= (this.phase === 2 ? M.vordtCharge.cd * 0.5 : 0);
      if (dist <= 9.8 && chargeReady) return M.vordtCharge;
      return null;   // 冲刺冷却中/超出冲程：兽行逼近
    }
    const pool: [MoveDef, number][] = [
      [M.vordtStomp, dist < 2.2 ? 4 : 0],                                                   // 贴身解解围 40%
      [M.vordtSlam, dist < 2.2 ? 3 : 2],
      [M.vordtSweep, 3],
      [M.vordtBreath, this.phase === 2 && dist >= 2.5 && dist <= 6 ? 2.5 : 0],              // 二阶段冰息走廊
    ];
    const cands = pool.filter(([m, w]) => w > 0 && ready(m) && dist < m.range * 0.95);
    if (!cands.length) return null;
    const sum = cands.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * sum;
    for (const [m, w] of cands) { r -= w; if (r <= 0) return m; }
    return cands[0][0];
  }
}
