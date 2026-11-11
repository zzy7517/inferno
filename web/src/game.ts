/** Game：世界 + onHit 总线（ADR-0004）+ Demo 流程（m1-demo.md）+ 镜头 + HUD + 调校台 */
import * as THREE from "three";
import { COLORS, P, BOSS, CAM, FEEL, MoveDef } from "./config";
import { AU, PAD } from "./audio";
import { Vfx, buildBonfire, Bonfire, FogGate } from "./vfx";
import { Boss } from "./boss";
import type { BossBase, BossHost } from "./boss-base";
import { Vordt, VORDT_STATS } from "./boss-vordt";
import { Watchers, WATCHERS_STATS } from "./boss-watchers";
import { Sulyvahn, SULYVANN_STATS } from "./boss-sulyvahn";
import { Player } from "./player";
import { Tuning } from "./tune";
import { Projectiles } from "./projectile";
import { buildHighWall, SceneAnchors } from "./scene-highwall";
import { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";

type Flow = "intro" | "statue" | "fight" | "dead" | "victory";
type SceneId = "cemetery" | "highwall";

/** Boss 注册表：场景×Boss 组合与直选入口（M2 进度线：古达→玻尔多→监视者→沙力万） */
interface BossEntry {
  name: string;
  radius: number;
  arena: SceneId;
  create: (scene: THREE.Scene, vfx: Vfx, pos: THREE.Vector3, host: BossHost) => BossBase;
}
const BOSSES: Record<string, BossEntry> = {
  gundyr:    { name: "灰烬审判者古达", radius: BOSS.radius, arena: "cemetery", create: (s, v, p, h) => new Boss(s, v, p, h) },
  vordt:     { name: VORDT_STATS.name, radius: VORDT_STATS.radius, arena: "highwall", create: (s, v, p, h) => new Vordt(s, v, p, h) },
  watchers:  { name: WATCHERS_STATS.name, radius: WATCHERS_STATS.radius, arena: "cemetery", create: (s, v, p, h) => new Watchers(s, v, p, h) },
  sulyvahn:  { name: SULYVANN_STATS.name, radius: SULYVANN_STATS.radius, arena: "cemetery", create: (s, v, p, h) => new Sulyvahn(s, v, p, h) },
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class Game {
  private renderer = new THREE.WebGLRenderer({ antialias: true });
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 120);
  private vfx!: Vfx;
  private bonfire!: Bonfire;
  private fog!: FogGate;
  private boss!: BossBase;
  private bossEntry!: BossEntry;
  private bossId = "gundyr";
  private player!: Player;
  private tune!: Tuning;
  private projectiles!: Projectiles;

  private flow: Flow = "intro";
  private camYaw = CAM.yaw;
  private camPitch = CAM.pitch;
  private manualT = 0;                        // 自由视角宽限倒计时（>0 时不自动跟背）
  private camPrevPos = new THREE.Vector3(-12.2, 0, 1.4);   // 上一帧玩家位置（判断是否移动，供跟背）
  private camDist = 5.6;
  private shakeAmp = 0;
  private hitstop = 0;
  private slowT = 0; private slowScale = 1;
  private elapsed = 0;
  private fightStart = 0;
  private deathDelay = 0;
  private victoryDelay = 0;
  private prevPx = -12.2;
  private hintT = 14;

  private stats = { hitsTaken: 0, parries: 0, ripostes: 0, deaths: 0 };

  constructor(gltf: GLTF, frames: Record<string, Record<string, unknown>>) {
    // 渲染器
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    document.body.prepend(this.renderer.domElement);

    this.scene.background = new THREE.Color(COLORS.bg);
    this.scene.fog = new THREE.FogExp2(COLORS.fog, 0.042);

    // 场景注册表：?scene=highwall 切洛斯里克的高墙（M2 篝火旅行后改为站内切换）
    this.sceneId = new URLSearchParams(location.search).get("scene") === "highwall" ? "highwall" : "cemetery";
    if (this.sceneId === "cemetery") {
      // 灰烬墓地灯光（高墙场景自带月光/环境光/雾/天幕）
      const moon = new THREE.DirectionalLight(COLORS.moon, 2.0);
      moon.position.set(6, 9, 4);
      moon.castShadow = true;
      moon.shadow.mapSize.set(2048, 2048);
      Object.assign(moon.shadow.camera, { left: -16, right: 16, top: 12, bottom: -8 });
      this.scene.add(moon);
      this.scene.add(new THREE.HemisphereLight(0x2c3548, 0x141210, 0.55));
    }

    this.setupScene();
    this.vfx = new Vfx(this.scene);
    this.projectiles = new Projectiles(this.scene);

    // 角色
    gltf.scene.traverse(o => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    const actions: Record<string, THREE.AnimationAction> = {};
    for (const clip of gltf.animations) actions[clip.name] = new THREE.AnimationMixer(gltf.scene).clipAction(clip);
    // 用单一 mixer：重建
    const mixer = new THREE.AnimationMixer(gltf.scene);
    for (const clip of gltf.animations) actions[clip.name] = mixer.clipAction(clip);

    this.player = new Player(gltf.scene, frames, {
      hitBoss: (dmg, poise, feelKey, point) => this.hitBoss(dmg, poise, feelKey, point),
      onPlayerHurt: (dmg, point, feelKey) => this.onPlayerHurt(dmg, point, feelKey),
      onParrySuccess: point => this.onParry(point),
      onDeath: () => this.onPlayerDeath(),
      bossParryableActive: () => this.boss["sub"] === "act" && this.boss.move?.parryable === true && this.boss.t < (this.boss.move?.active ?? 0) * 0.7,
      bossOpen: () => this.boss.state === "parried" || this.boss.state === "stagger",
      bossPos: () => this.boss.root.position,
      shake: a => this.shake(a),
    });
    this.player.bind(actions);
    this.player.pos.copy(this.anchors.spawn);
    this.scene.add(this.player.root);

    // Boss 选择：?boss= 直选（调试/M2 再战入口），否则按场景默认（高墙=玻尔多，墓地=古达）
    const bossParam = new URLSearchParams(location.search).get("boss");
    this.bossId = bossParam && BOSSES[bossParam] ? bossParam : (this.sceneId === "highwall" ? "vordt" : "gundyr");
    this.bossEntry = BOSSES[this.bossId];
    this.boss = this.bossEntry.create(this.scene, this.vfx, this.anchors.bossArena.clone().add(new THREE.Vector3(1.8, 0, 0)), {
      onBossHit: (dmg, dir, point, move) => this.onBossHitPlayer(dmg, dir, point, move),
      onBossReveal: () => this.revealBoss(),
      onBossTransform: point => this.transformShock(point),
      onBossDeath: () => this.onBossDeath(),
      shake: a => this.shake(a),
      fireProjectile: (pos, yaw, def) => this.projectiles.spawn(pos, yaw, def),
    });

    // 调校台（` 键开关）：帧数据热调 / 判定可视化 / 逐帧 / 存档
    this.tune = new Tuning(this.scene, this.player, this.boss);

    this.bindInput();
    this.camera.position.set(-16, 3, 4);
    this.camPrevPos.copy(this.anchors.spawn);
    this.prevPx = this.anchors.spawn.x;
    this.showMsg("无名的不死人啊，回到这片灰烬中来吧……", 4);
  }

  // ---------------- 场景 ----------------
  private sceneId: SceneId = "cemetery";
  private anchors!: SceneAnchors;
  private sceneUpdate: ((t: number, dt: number) => void) | null = null;

  private setupScene(): void {
    if (this.sceneId === "highwall") {
      const hw = buildHighWall(this.scene);
      this.anchors = hw.anchors;
      this.sceneUpdate = hw.update;
    } else {
      this.buildCemetery();
      this.anchors = {
        spawn: new THREE.Vector3(-12.2, 0, 1.4),
        bonfire: new THREE.Vector3(-12.2, 0, 0),
        fogGate: new THREE.Vector3(-5.0, 0, 0),
        bossArena: new THREE.Vector3(0.6, 0, 0),
        arenaRadius: 6.6,
        corridorMinX: -13.4,
      };
    }
    this.bonfire = buildBonfire(this.scene, this.anchors.bonfire);
    this.fog = new FogGate(this.scene, this.anchors.fogGate);
  }

  /** 灰烬墓地：走廊地面/墙 + 竞技场 + 残柱 + 远景地面 */
  private buildCemetery(): void {
    const stoneMat = new THREE.MeshStandardMaterial({ color: COLORS.stoneDark, roughness: 1, flatShading: true });
    const pathMat = new THREE.MeshStandardMaterial({ color: COLORS.groundPath, roughness: 1 });
    const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
      this.scene.add(m);
      return m;
    };
    // 走廊地面与墙
    box(9.6, 0.2, 3.6, pathMat, -9.6, -0.1, 0);
    box(9.6, 2.4, 0.5, stoneMat, -9.6, 1.2, 2.0);
    box(9.6, 2.4, 0.5, stoneMat, -9.6, 1.2, -2.0);
    // 竞技场
    const arena = new THREE.Mesh(new THREE.CircleGeometry(6.6, 48), new THREE.MeshStandardMaterial({ color: COLORS.ground, roughness: 0.95 }));
    arena.rotation.x = -Math.PI / 2;
    arena.position.set(0.6, 0.001, 0);
    arena.receiveShadow = true;
    this.scene.add(arena);
    // 竞技场残柱
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + 0.35;
      if (Math.abs(a - Math.PI) < 0.5) continue;    // 留出门口（-X 朝走廊）
      const r = 6.1;
      const h = 1.2 + ((i * 7919) % 100) / 100 * 1.8;
      box(0.7, h, 0.7, stoneMat, 0.6 + Math.cos(a) * r, h / 2, Math.sin(a) * r);
    }
    // 大地面（远景）
    const vast = new THREE.Mesh(new THREE.CircleGeometry(60, 32), new THREE.MeshStandardMaterial({ color: 0x14161b, roughness: 1 }));
    vast.rotation.x = -Math.PI / 2;
    vast.position.y = -0.05;
    this.scene.add(vast);
  }

  // ---------------- 输入 ----------------
  private bindInput(): void {
    const canvas = this.renderer.domElement;
    canvas.addEventListener("click", () => { AU.init(); });   // 点击仅初始化音频，不锁定指针（触控板友好）
    addEventListener("contextmenu", e => e.preventDefault());
    // 双模式视角：默认全自动（跟背/锁定取景）；按 V 切换自由视角（鼠标指针锁定），ESC 退出后自动回正
    document.addEventListener("pointerlockchange", () => {
      if (document.pointerLockElement !== canvas) this.manualT = CAM.manualGrace;   // 退出自由视角 → 宽限后恢复跟背
    });
    addEventListener("mousemove", e => {
      if (document.pointerLockElement !== canvas || this.player.lockOn) return;    // 锁定时镜头交给取景逻辑
      this.camYaw -= e.movementX * 0.0024;
      this.camPitch = Math.max(0.04, Math.min(0.9, this.camPitch + e.movementY * 0.002));
      this.manualT = CAM.manualGrace;
    });
    addEventListener("wheel", e => {
      if (document.pointerLockElement !== canvas) return;    // 仅自由视角下缩放，避免触控板双指误触
      this.camDist = Math.max(3.2, Math.min(8.5, this.camDist + e.deltaY * 0.004));
    });
    addEventListener("mousedown", e => this.player.onMouse(e.button, true));
    addEventListener("mouseup", e => this.player.onMouse(e.button, false));
    const inPanelInput = (e: KeyboardEvent): boolean => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
    };
    addEventListener("keydown", e => {
      if (e.code === "Space" && !inPanelInput(e)) e.preventDefault();
      if (inPanelInput(e)) return;   // 面板输入中不触发游戏按键
      this.player.onKey(e.code, true);
      if (e.code === "KeyV" && !e.repeat) {                       // 自由视角开关（鼠标用户）
        if (document.pointerLockElement === canvas) document.exitPointerLock();
        else canvas.requestPointerLock();
      }
      else if (e.code === "KeyQ") this.player.lockOn = !this.player.lockOn;
      else if (e.code === "KeyE") this.interact();
      else if (e.code === "KeyT") this.tune.toggleSlow();         // 慢动作（速度在调校台调）
      else if (e.code === "KeyM") AU.toggleMute();
      else if (e.code === "Backquote") { e.preventDefault(); this.tune.toggle(); }
      else if (e.code === "KeyP") { this.tune.paused = !this.tune.paused; }
      else if (e.code === "ArrowRight" && this.tune.paused) { this.tune.steps = Math.min(600, this.tune.steps + 1); }
      else if (e.code === "KeyR" && (this.flow === "dead" || this.flow === "victory")) this.restart();
    });
    addEventListener("keyup", e => this.player.onKey(e.code, false));
    addEventListener("resize", () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    });
  }

  // ---------------- onHit 总线（六通道同帧扇出，参数来自手感档案 FEEL） ----------------
  private hitstopFor(ms: number): void { this.hitstop = Math.max(this.hitstop, ms / 1000); }
  private shake(amp: number): void { this.shakeAmp = Math.max(this.shakeAmp, amp); }
  private slowmo(scale: number, dur: number): void { this.slowScale = scale; this.slowT = dur; }
  /** 通过名字调 AU 方法：必须以 AU.xxx() 形式调用保持 this 绑定（直接取方法引用会丢 this） */
  private sfx(name: string): void {
    const fn = (AU as unknown as Record<string, (() => void) | undefined>)[name];
    if (fn) fn.call(AU);
  }

  /** 玩家命中 Boss：时间/动画/特效/音效/镜头/手柄六通道同帧 */
  private hitBoss(dmg: number, poise: number, feelKey: string, point: THREE.Vector3): void {
    const f = FEEL[feelKey] ?? FEEL.pR1a;
    const r = this.boss.takeHit(dmg, poise);
    this.vfx.sparks.burst(point, f.sparks, f.sparkSpeed, 0.35);
    this.hitstopFor(f.hitstop);
    this.shake(f.shake);
    this.sfx(FEEL[feelKey]?.sfx ?? "hitStone");
    PAD.rumble(f.shake * 0.5, f.shake, 90 + f.hitstop * 600);
    if (feelKey === "pRip") this.slowmo(0.35, 0.5);               // 处决：顿帧+慢动作（combat-feel 最高层级）
    if (r.staggered) {
      const fs = FEEL.stagger;
      this.showMsg("破 绽", 1.2, true);
      this.vfx.sparks.burst(this.boss.chestWorld(), fs.sparks, fs.sparkSpeed, 0.5);
      this.hitstopFor(fs.hitstop);
      this.shake(fs.shake);
      AU.parry();
      PAD.rumble(0.4, 0.9, 260);
      this.slowmo(0.4, 0.4);
    }
    if (r.died) { this.slowmo(0.3, 1.1); this.shake(0.8); PAD.rumble(0.7, 1, 500); }
  }

  private onBossHitPlayer(dmg: number, dir: THREE.Vector3, point: THREE.Vector3, move: MoveDef): void {
    // 六通道反馈统一在 onPlayerHurt 内按手感档案扇出（applyHit 会回传 feelKey）
    void point;
    this.player.applyHit(dmg, dir, move);
  }

  private onPlayerHurt(dmg: number, point: THREE.Vector3, feelKey: string): void {
    this.stats.hitsTaken++;
    const f = FEEL[feelKey] ?? FEEL.bLight;
    this.flash(feelKey === "block" ? "rgba(155,59,50,0.25)" : "rgba(155,59,50,0.5)");
    this.vfx.sparks.burst(point, f.sparks, f.sparkSpeed, 0.4, 0.6);
    this.shake(f.shake);
    this.hitstopFor(f.hitstop);
    if (feelKey !== "block") this.sfx(FEEL[feelKey]?.sfx ?? "hitStone");               // 格挡音在 player.applyHit 播过
    PAD.rumble(f.shake * 0.6, f.shake * 0.9 + 0.1, 110 + f.hitstop * 700);
    this.vfx.dust.burst(point, 6, 2, 0.5);
    void dmg;
  }

  private onParry(point: THREE.Vector3): void {
    if (this.boss.tryParried()) {
      this.stats.parries++;
      const f = FEEL.parry;
      AU.parry();
      this.vfx.sparks.burst(point, f.sparks, f.sparkSpeed, 0.5);
      this.slowmo(0.35, 0.45);
      this.hitstopFor(f.hitstop);
      this.shake(f.shake);
      this.flash("rgba(230,195,122,0.35)");
      PAD.rumble(0.8, 0.6, 200);
      this.showMsg("弹 反", 1, true);
    }
  }

  private transformShock(point: THREE.Vector3): void {
    const d = this.player.pos.distanceTo(this.boss.root.position);
    if (d < 5 && !this.player.isIframed) {
      this.player.applyHit(20, this.player.pos.clone().sub(this.boss.root.position).setY(0).normalize(), null, "bHeavy");
    }
    this.vfx.embers.burst(point.clone().setY(1.5), 40, 6, 1.2);
    this.shake(0.8);
    this.showMsg("人性的沉淀", 1.6);
  }

  private revealBoss(): void {
    $("bossbar").classList.add("on");
    // 只改标题 span，勿动 #bossName.textContent——会连带销毁 #bossPhase2（曾致每帧 null.style 崩循环）
    $("bossTitle").textContent = this.bossEntry.name;
    $("winBig").textContent = `${this.bossEntry.name} 已陨落`;
    this.showMsg(this.bossEntry.name, 2.2, true);
    AU.roar();
    this.fightStart = this.elapsed;
    this.player.lockOn = true;   // 开战自动锁定（无鼠标方案）
  }

  private onBossDeath(): void {
    this.flow = "victory";
    this.victoryDelay = 2.2;
    this.player.souls += 3000;
    this.player.lockOn = false;
  }

  private onPlayerDeath(): void {
    this.flow = "dead";
    this.deathDelay = 1.6;
    this.stats.deaths++;
    this.player.lockOn = false;
  }

  private restart(): void {
    this.player.reset(this.anchors.spawn);
    this.boss.reset();
    this.projectiles.clear();
    this.prevPx = this.anchors.spawn.x;
    this.fog.solid = false;
    this.flow = "intro";
    $("bossbar").classList.remove("on");
    $("overlayDeath").classList.remove("show");
    $("overlayWin").classList.remove("show");
  }

  // ---------------- 交互 ----------------
  private interact(): void {
    if (this.flow === "fight" && this.player.tryRiposte()) { this.stats.ripostes++; return; }
    if (this.flow === "intro" && this.player.pos.distanceTo(this.bonfire.pos) < 1.6) {
      this.player.hp = P.hp; this.player.estus = P.estusMax;
      AU.bonfireRest();
      this.showMsg("在篝火旁稍作休息", 1.5);
      this.vfx.embers.burst(this.bonfire.pos.clone().setY(0.8), 20, 2, 1.5);
      return;
    }
    if (this.flow === "intro" && Math.abs(this.player.pos.x - this.anchors.fogGate.x) < 1.4 && Math.abs(this.player.pos.z) < 1.8) {
      this.fog.open(); this.fog.solid = false;
      AU.fogGate();
      this.flow = "statue";
      this.showMsg("雾门散去——", 1.5);
      return;
    }
    if (this.flow === "statue" && this.player.pos.distanceTo(this.boss.root.position) < 3.2) {
      this.boss.pull();
      this.flow = "fight";
      setTimeout(() => { this.fog.close(); this.fog.solid = true; }, 800);
    }
  }

  // ---------------- 流程与主循环 ----------------
  private clampWorld(): void {
    const p = this.player.pos;
    const gateX = this.anchors.fogGate.x;
    if (this.fog.solid) {
      if (this.prevPx > gateX) p.x = Math.max(p.x, gateX + 0.4);
      else p.x = Math.min(p.x, gateX - 0.4);
    }
    if (p.x < gateX) {
      p.x = Math.max(p.x, this.anchors.corridorMinX);
      p.z = Math.max(-1.45, Math.min(1.45, p.z));
    } else {
      const cx = p.x - this.anchors.bossArena.x, cz = p.z - this.anchors.bossArena.z;
      const maxR = this.anchors.arenaRadius - 0.9;
      const r = Math.hypot(cx, cz);
      if (r > maxR) { const k = maxR / r; p.x = this.anchors.bossArena.x + cx * k; p.z = this.anchors.bossArena.z + cz * k; }
    }
    // 玩家与 Boss 推挤
    const d = this.boss.root.position.clone().sub(p); d.y = 0;
    const minD = this.bossEntry.radius + P.playerRadius;
    if (this.boss.awake && d.length() < minD) p.sub(d.normalize().multiplyScalar(minD - d.length()));
    this.prevPx = p.x;
  }

  private prompt(): string | null {
    if (this.flow === "fight" && (this.boss.state === "parried" || this.boss.state === "stagger") && this.player.pos.distanceTo(this.boss.root.position) < 2.5) return "E 处决";
    if (this.flow === "intro" && this.player.pos.distanceTo(this.bonfire.pos) < 1.6) return "E 篝火休息（补满血与原素瓶）";
    if (this.flow === "intro" && Math.abs(this.player.pos.x - this.anchors.fogGate.x) < 1.4 && Math.abs(this.player.pos.z) < 1.8) return "E 跨入雾门";
    if (this.flow === "statue" && this.player.pos.distanceTo(this.boss.root.position) < 3.2) return "E 拔出螺旋剑";
    return null;
  }

  private updateCamera(rdt: number): void {
    const target = this.player.pos.clone().add(new THREE.Vector3(0, 1.45, 0));
    let dist = this.camDist;
    let lookAt = target;

    const locked = this.player.lockOn && this.boss.awake && this.boss.state !== "dead";
    if (locked) {
      // 锁定取景：镜头在玩家背侧、看向两人中点，距离随间距自适应
      const toBoss = this.boss.root.position.clone().sub(this.player.pos);
      const sep = toBoss.length();
      lookAt = this.player.pos.clone().lerp(this.boss.root.position, 0.32).setY(target.y);
      const wantYaw = Math.atan2(toBoss.x, toBoss.z) + Math.PI;
      let d = wantYaw - this.camYaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.camYaw += d * Math.min(1, rdt * CAM.lockLerp);
      this.camPitch += (CAM.lockPitch - this.camPitch) * Math.min(1, rdt * 4);
      dist = Math.max(this.camDist, CAM.lockDistBase + sep * CAM.lockDistPerSep);
    } else {
      // 自动跟背：自由视角宽限期外且正在移动 → 缓动到角色背后（黑神话式）
      this.manualT = Math.max(0, this.manualT - rdt);
      const moved = this.player.pos.distanceToSquared(this.camPrevPos) > 1e-6;
      this.camPrevPos.copy(this.player.pos);
      if (this.manualT <= 0 && moved) {
        const wantYaw = this.player.yaw + Math.PI;
        let d = wantYaw - this.camYaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        this.camYaw += d * Math.min(1, rdt * CAM.followLerp);
        this.camPitch += (CAM.pitch - this.camPitch) * Math.min(1, rdt * 1.5);
      }
    }
    this.camera.position.set(
      lookAt.x + Math.sin(this.camYaw) * Math.cos(this.camPitch) * dist,
      lookAt.y + Math.sin(this.camPitch) * dist,
      lookAt.z + Math.cos(this.camYaw) * Math.cos(this.camPitch) * dist,
    );
    if (this.shakeAmp > 0.001) {
      this.camera.position.add(new THREE.Vector3((Math.random() - 0.5) * this.shakeAmp * 0.3, (Math.random() - 0.5) * this.shakeAmp * 0.22, (Math.random() - 0.5) * this.shakeAmp * 0.3));
      this.shakeAmp *= Math.exp(-7 * rdt);
    }
    this.camera.lookAt(lookAt);
  }

  private updateHud(): void {
    ($("hpFl") as HTMLElement).style.width = `${Math.max(0, this.player.hp / P.hp * 100)}%`;
    ($("stFl") as HTMLElement).style.width = `${Math.max(0, this.player.stamina / P.stamina * 100)}%`;
    $("estusN").textContent = String(this.player.estus);
    $("soulN").textContent = String(this.player.souls);
    // Boss 条（白条延迟；比率按各 Boss 自己的血量上限）
    const lag = $("bossLag"), fill = $("bossFill");
    const cur = this.boss.hp / this.boss.maxHp;
    const lagV = parseFloat(lag.dataset.v ?? "1");
    const newLag = Math.max(cur, lagV - 0.004);
    lag.dataset.v = String(newLag);
    lag.style.width = `${newLag * 100}%`;
    fill.style.width = `${cur * 100}%`;
    $("bossPhase2").style.opacity = this.boss.phase === 2 ? "1" : "0";
    // 提示与阶段
    const pr = this.prompt();
    $("prompt").textContent = pr ?? "";
    $("prompt").classList.toggle("on", !!pr);
    const lock = $("lockon");
    if (this.player.lockOn && this.boss.awake && this.boss.state !== "dead") {
      const head = this.boss.headWorld();
      head.project(this.camera);
      if (head.z < 1) {
        lock.style.display = "block";
        lock.style.left = `${(head.x * 0.5 + 0.5) * innerWidth}px`;
        lock.style.top = `${(-head.y * 0.5 + 0.5) * innerHeight}px`;
      } else lock.style.display = "none";
    } else lock.style.display = "none";
  }

  private flash(color: string): void {
    const f = $("flash");
    f.style.background = color;
    f.animate([{ opacity: 0.9 }, { opacity: 0 }], { duration: 550, easing: "ease-out" });
  }

  private showMsg(text: string, dur: number, gold = false): void {
    const m = $("msg");
    m.textContent = text;
    m.style.color = gold ? "#e6c37a" : "#c9cdd4";
    m.animate([{ opacity: 0 }, { opacity: 1 }, { opacity: 1 }, { opacity: 0 }], { duration: dur * 1000 });
  }

  private fmtTime(s: number): string {
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  }

  start(): void {
    let last = performance.now();
    this.renderer.setAnimationLoop(() => {
      const now = performance.now();
      const rdt = Math.min(0.05, (now - last) / 1000);
      last = now;
      this.elapsed += rdt;
      this.tune.frameTick(rdt);

      // 时间控制：调校台暂停/逐帧 > 顿帧 > 慢动作 > 调校台慢放
      let dt = rdt;
      if (this.tune.paused) {
        if (this.tune.steps > 0) { this.tune.steps--; dt = (1 / 60) * (this.tune.slowOn ? this.tune.timeScale : 1); }
        else dt = 0;
      } else if (this.hitstop > 0) { this.hitstop -= rdt; dt = 0; }
      else if (this.slowT > 0) { this.slowT -= rdt; dt *= this.slowScale; }
      else if (this.tune.slowOn) dt *= this.tune.timeScale;

      // 战斗更新
      if (this.flow === "fight") this.boss.update(dt, this.player.pos, this.player.isIframed);
      else if (this.boss.state === "rising" || this.boss.state === "dead" || this.boss.state === "transform") this.boss.update(dt, this.player.pos, this.player.isIframed);
      this.player.update(dt, this.camYaw);
      this.clampWorld();
      this.vfx.update(dt);
      // 投射物（沙力万矢）：命中走 applyHit → onPlayerHurt 手感档案扇出，可格挡
      this.projectiles.update(dt, this.player.pos, this.player.isIframed, (def, point, dir) => {
        void point;
        this.player.applyHit(def.dmg, dir, null, def.feelKey);
      });
      this.fog.update(this.elapsed);
      this.sceneUpdate?.(this.elapsed, dt);
      this.tune.updateViz();

      // 篝火粒子
      this.bonfire.light.intensity = 9 + Math.sin(this.elapsed * 13) * 1.6 + Math.sin(this.elapsed * 31) * 0.8;
      if (Math.random() < rdt * 8) this.vfx.embers.spawn(this.bonfire.pos.x + (Math.random() - 0.5) * 0.3, 0.5, this.bonfire.pos.z + (Math.random() - 0.5) * 0.3, 0, 1 + Math.random(), 0, 1.4);

      // 流程结算
      if (this.flow === "dead" && (this.deathDelay -= rdt) <= 0) {
        $("overlayDeath").classList.add("show");
        this.deathDelay = 999;
      }
      if (this.flow === "victory" && (this.victoryDelay -= rdt) <= 0) {
        $("winStats").textContent =
          `用时 ${this.fmtTime(this.elapsed - this.fightStart)} · 受击 ${this.stats.hitsTaken} · 弹反 ${this.stats.parries} · 处决 ${this.stats.ripostes} · 身陨 ${this.stats.deaths}`;
        $("overlayWin").classList.add("show");
        AU.victoryBell();
        AU.soulGain();
        this.victoryDelay = 999;
      }

      if (this.hintT > 0 && (this.hintT -= rdt) <= 0) $("hint").classList.add("off");

      this.updateCamera(rdt);
      this.updateHud();
      this.renderer.render(this.scene, this.camera);
    });
  }
}
