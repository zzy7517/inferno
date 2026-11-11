/** Game：世界 + onHit 总线（ADR-0004）+ Demo 流程（m1-demo.md）+ 镜头 + HUD */
import * as THREE from "three";
import { COLORS, P, BOSS, CAM, MoveDef } from "./config";
import { AU } from "./audio";
import { Vfx, buildBonfire, Bonfire, FogGate } from "./vfx";
import { Boss } from "./boss";
import { Player } from "./player";
import { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";

type Flow = "intro" | "statue" | "fight" | "dead" | "victory";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class Game {
  private renderer = new THREE.WebGLRenderer({ antialias: true });
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 120);
  private vfx!: Vfx;
  private bonfire!: Bonfire;
  private fog!: FogGate;
  private boss!: Boss;
  private player!: Player;

  private flow: Flow = "intro";
  private camYaw = CAM.yaw;
  private camPitch = CAM.pitch;
  private manualT = 0;                        // 自由视角宽限倒计时（>0 时不自动跟背）
  private camPrevPos = new THREE.Vector3(-12.2, 0, 1.4);   // 上一帧玩家位置（判断是否移动，供跟背）
  private camDist = 5.6;
  private shakeAmp = 0;
  private hitstop = 0;
  private slowT = 0; private slowScale = 1;
  private slowDebug = false;
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

    // 灯光：冷月光 + 篝火
    const moon = new THREE.DirectionalLight(COLORS.moon, 2.0);
    moon.position.set(6, 9, 4);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    Object.assign(moon.shadow.camera, { left: -16, right: 16, top: 12, bottom: -8 });
    this.scene.add(moon);
    this.scene.add(new THREE.HemisphereLight(0x2c3548, 0x141210, 0.55));

    this.buildWorld();
    this.vfx = new Vfx(this.scene);

    // 角色
    gltf.scene.traverse(o => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    const actions: Record<string, THREE.AnimationAction> = {};
    for (const clip of gltf.animations) actions[clip.name] = new THREE.AnimationMixer(gltf.scene).clipAction(clip);
    // 用单一 mixer：重建
    const mixer = new THREE.AnimationMixer(gltf.scene);
    for (const clip of gltf.animations) actions[clip.name] = mixer.clipAction(clip);

    this.player = new Player(gltf.scene, frames, {
      hitBoss: (dmg, poise, heavy, point) => this.hitBoss(dmg, poise, heavy, point),
      onPlayerHurt: (dmg, point) => this.onPlayerHurt(dmg, point),
      onParrySuccess: point => this.onParry(point),
      onDeath: () => this.onPlayerDeath(),
      bossParryableActive: () => this.boss["sub"] === "act" && this.boss.move?.parryable === true && this.boss.t < (this.boss.move?.active ?? 0) * 0.7,
      bossOpen: () => this.boss.state === "parried" || this.boss.state === "stagger",
      bossPos: () => this.boss.root.position,
      shake: a => this.shake(a),
    });
    this.player.bind(actions);
    this.player.pos.set(-12.2, 0, 1.4);
    this.scene.add(this.player.root);

    this.boss = new Boss(this.scene, this.vfx, new THREE.Vector3(2.4, 0, 0), {
      onBossHit: (dmg, dir, point, move) => this.onBossHitPlayer(dmg, dir, point, move),
      onBossReveal: () => this.revealBoss(),
      onBossTransform: point => this.transformShock(point),
      onBossDeath: () => this.onBossDeath(),
      shake: a => this.shake(a),
    });

    this.bindInput();
    this.camera.position.set(-16, 3, 4);
    this.showMsg("无名的不死人啊，回到这片灰烬中来吧……", 4);
  }

  // ---------------- 世界 ----------------
  private buildWorld(): void {
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

    this.bonfire = buildBonfire(this.scene, new THREE.Vector3(-12.2, 0, 0));
    this.fog = new FogGate(this.scene, new THREE.Vector3(-5.0, 0, 0));
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
    addEventListener("keydown", e => {
      if (e.code === "Space") e.preventDefault();
      this.player.onKey(e.code, true);
      if (e.code === "KeyV" && !e.repeat) {                       // 自由视角开关（鼠标用户）
        if (document.pointerLockElement === canvas) document.exitPointerLock();
        else canvas.requestPointerLock();
      }
      else if (e.code === "KeyQ") this.player.lockOn = !this.player.lockOn;
      else if (e.code === "KeyE") this.interact();
      else if (e.code === "KeyT") { this.slowDebug = !this.slowDebug; }
      else if (e.code === "KeyM") AU.toggleMute();
      else if (e.code === "KeyR" && (this.flow === "dead" || this.flow === "victory")) this.restart();
    });
    addEventListener("keyup", e => this.player.onKey(e.code, false));
    addEventListener("resize", () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    });
  }

  // ---------------- onHit 总线 ----------------
  private hitstopFor(ms: number): void { this.hitstop = Math.max(this.hitstop, ms / 1000); }
  private shake(amp: number): void { this.shakeAmp = Math.max(this.shakeAmp, amp); }
  private slowmo(scale: number, dur: number): void { this.slowScale = scale; this.slowT = dur; }

  private hitBoss(dmg: number, poise: number, heavy: boolean, point: THREE.Vector3): void {
    const r = this.boss.takeHit(dmg, poise);
    this.vfx.sparks.burst(point, heavy ? 26 : 12, heavy ? 6 : 4, 0.35);
    this.hitstopFor(heavy ? 0.11 : 0.06);
    this.shake(heavy ? 0.4 : 0.15);
    heavy ? AU.hitHeavy() : AU.hitStone();
    if (r.staggered) { this.showMsg("破 绽", 1.2, true); AU.parry(); this.slowmo(0.4, 0.4); }
    if (r.died) { this.slowmo(0.3, 1.1); this.shake(0.8); }
  }

  private onBossHitPlayer(dmg: number, dir: THREE.Vector3, point: THREE.Vector3, move: MoveDef): void {
    this.player.applyHit(dmg, dir, move);
    this.vfx.sparks.burst(point, 14, 5, 0.4, 0.6);
    this.shake(0.5);
    this.hitstopFor(0.05);
    this.flash("rgba(155,59,50,0.55)");
    AU.hitStone();
  }

  private onPlayerHurt(dmg: number, point: THREE.Vector3): void {
    this.stats.hitsTaken++;
    this.flash("rgba(155,59,50,0.4)");
    this.vfx.dust.burst(point, 6, 2, 0.5);
    void dmg;
  }

  private onParry(point: THREE.Vector3): void {
    if (this.boss.tryParried()) {
      this.stats.parries++;
      AU.parry();
      this.vfx.sparks.burst(point, 30, 7, 0.5);
      this.slowmo(0.35, 0.45);
      this.hitstopFor(0.1);
      this.flash("rgba(230,195,122,0.35)");
      this.showMsg("弹 反", 1, true);
    }
  }

  private transformShock(point: THREE.Vector3): void {
    const d = this.player.pos.distanceTo(this.boss.root.position);
    if (d < 5 && !this.player.isIframed) {
      this.player.applyHit(20, this.player.pos.clone().sub(this.boss.root.position).setY(0).normalize(), null);
    }
    this.vfx.embers.burst(point.clone().setY(1.5), 40, 6, 1.2);
    this.shake(0.8);
    this.showMsg("人性的沉淀", 1.6);
  }

  private revealBoss(): void {
    $("bossbar").classList.add("on");
    // 只改标题 span，勿动 #bossName.textContent——会连带销毁 #bossPhase2（曾致每帧 null.style 崩循环）
    $("bossTitle").textContent = BOSS.name;
    this.showMsg(BOSS.name, 2.2, true);
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
    this.player.reset(new THREE.Vector3(-12.2, 0, 1.4));
    this.boss.reset();
    this.prevPx = -12.2;
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
    if (this.flow === "intro" && Math.abs(this.player.pos.x - (-5.0)) < 1.4 && Math.abs(this.player.pos.z) < 1.8) {
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
    const gateX = -5.0;
    if (this.fog.solid) {
      if (this.prevPx > gateX) p.x = Math.max(p.x, gateX + 0.4);
      else p.x = Math.min(p.x, gateX - 0.4);
    }
    if (p.x < gateX) {
      p.x = Math.max(p.x, -13.4);
      p.z = Math.max(-1.45, Math.min(1.45, p.z));
    } else {
      const cx = p.x - 0.6, cz = p.z;
      const r = Math.hypot(cx, cz);
      if (r > 5.7) { const k = 5.7 / r; p.x = 0.6 + cx * k; p.z = cz * k; }
    }
    // 玩家与 Boss 推挤
    const d = this.boss.root.position.clone().sub(p); d.y = 0;
    const minD = BOSS.radius + P.playerRadius;
    if (this.boss.awake && d.length() < minD) p.sub(d.normalize().multiplyScalar(minD - d.length()));
    this.prevPx = p.x;
  }

  private prompt(): string | null {
    if (this.flow === "fight" && (this.boss.state === "parried" || this.boss.state === "stagger") && this.player.pos.distanceTo(this.boss.root.position) < 2.5) return "E 处决";
    if (this.flow === "intro" && this.player.pos.distanceTo(this.bonfire.pos) < 1.6) return "E 篝火休息（补满血与原素瓶）";
    if (this.flow === "intro" && Math.abs(this.player.pos.x + 5.0) < 1.4 && Math.abs(this.player.pos.z) < 1.8) return "E 跨入雾门";
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
    // Boss 条（白条延迟）
    const lag = $("bossLag"), fill = $("bossFill");
    const cur = this.boss.hp / BOSS.hp;
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

      let dt = rdt;
      if (this.hitstop > 0) { this.hitstop -= rdt; dt = 0; }
      else if (this.slowT > 0) { this.slowT -= rdt; dt *= this.slowScale; }
      else if (this.slowDebug) dt *= 0.25;

      // 战斗更新
      if (this.flow === "fight") this.boss.update(dt, this.player.pos, this.player.isIframed);
      else if (this.boss.state === "rising" || this.boss.state === "dead" || this.boss.state === "transform") this.boss.update(dt, this.player.pos, this.player.isIframed);
      this.player.update(dt, this.camYaw);
      this.clampWorld();
      this.vfx.update(dt);
      this.fog.update(this.elapsed);

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
