/** Game：世界 + onHit 总线（ADR-0004）+ Demo 流程（m1-demo.md）+ 镜头 + HUD + 调校台 */
import * as THREE from "three";
import { P, BOSS, CAM, FEEL, MoveDef } from "./config";
import { AU, PAD } from "./audio";
import { Vfx, buildBonfire, buildSoulSign, Bonfire, FogGate, SoulSign } from "./vfx";
import { Boss } from "./boss";
import type { BossBase, BossHost } from "./boss-base";
import { Vordt, VORDT_STATS } from "./boss-vordt";
import { Watchers, WATCHERS_STATS } from "./boss-watchers";
import { Sulyvahn, SULYVANN_STATS } from "./boss-sulyvahn";
import { Morgott, MORGOTT_STATS } from "./boss-morgott";
import { Radahn, RADAHN_STATS } from "./boss-radahn";
import { Player } from "./player";
import { Tuning } from "./tune";
import { Projectiles } from "./projectile";
import { buildHighWall, SceneAnchors } from "./scene-highwall";
import { buildCemetery } from "./scene-cemetery";
import { buildStormveil } from "./scene-stormveil";
import { Margit, MARGIT_STATS } from "./boss-margit";
import { Godrick, GODRICK_STATS } from "./boss-godrick";
import { EnemyManager, EnemyBase, type BossRoomSeal } from "./enemy";
import { ENEMY_PRESETS } from "./enemies-config";
import { BOSS_ORDER, SCENE_NAME, ZONE_OF, loadProgress, saveProgress, clearProgress, onDefeat, bossForScene, shortcutUnlockedOn } from "./progress";
import type { SceneId, BossId, Progress } from "./progress";
import { Shortcut, SHORTCUT_RADIUS } from "./mechanic";
import type { ShortcutDef, ShortcutHost } from "./mechanic";
import { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";

type Flow = "intro" | "statue" | "fight" | "dead" | "victory";

/** Boss 注册表：场景×Boss 组合与直选入口
 * 进度线 v1.1（m4）：古达→玻尔多→玛尔基特(城垣E)→葛瑞克(城垣E4)→监视者(墓地C)→沙力万(高墙D)
 * margit/godrick 暂为金色幽灵占位（boss-stub.ts），正式实现落地后替换 create 即可 */
interface BossEntry {
  name: string;
  radius: number;
  arena: SceneId;
  souls: number;                 // 击败魂奖励
  create: (scene: THREE.Scene, vfx: Vfx, pos: THREE.Vector3, host: BossHost) => BossBase;
}
const BOSSES: Record<string, BossEntry> = {
  gundyr:    { name: "灰烬审判者古达", radius: BOSS.radius, arena: "cemetery", souls: 3000, create: (s, v, p, h) => new Boss(s, v, p, h) },
  vordt:     { name: VORDT_STATS.name, radius: VORDT_STATS.radius, arena: "highwall", souls: 4000, create: (s, v, p, h) => new Vordt(s, v, p, h) },
  margit:    { name: MARGIT_STATS.name, radius: MARGIT_STATS.radius, arena: "stormveil", souls: 12000, create: (s, v, p, h) => new Margit(s, v, p, h) },
  godrick:   { name: GODRICK_STATS.name, radius: GODRICK_STATS.radius, arena: "stormveil", souls: 20000, create: (s, v, p, h) => new Godrick(s, v, p, h) },
  watchers:  { name: WATCHERS_STATS.name, radius: WATCHERS_STATS.radius, arena: "cemetery", souls: 6000, create: (s, v, p, h) => new Watchers(s, v, p, h) },
  morgott:   { name: MORGOTT_STATS.name, radius: MORGOTT_STATS.radius, arena: "stormveil", souls: 15000, create: (s, v, p, h) => new Morgott(s, v, p, h) },
  radahn:    { name: RADAHN_STATS.name, radius: RADAHN_STATS.radius, arena: "cemetery", souls: 18000, create: (s, v, p, h) => new Radahn(s, v, p, h) },
  sulyvahn:  { name: SULYVANN_STATS.name, radius: SULYVANN_STATS.radius, arena: "highwall", souls: 9000, create: (s, v, p, h) => new Sulyvahn(s, v, p, h) },
};
/** Boss→场景映射（进度线推导用） */
const ARENAS: Record<string, SceneId> = Object.fromEntries(Object.entries(BOSSES).map(([k, v]) => [k, v.arena]));

/** T6 捷径布点表：id 对齐 progress.SHORTCUT_IDS，开启条件见 progress.shortcutUnlockedOn。
 *  坐标均已对齐 SceneAnchors v2 zones 可走域（探针 t6-probe 校验）：
 *  pos=交互圆心（电梯本体），dest=黑场落位点 */
const SHORTCUT_DEFS: (ShortcutDef & { scene: SceneId })[] = [
  // A3 古达房西南角（房心 -1.5 r12→可走 r11.1，距房心 8.8m，避开雾门线 x=-10）→ A1 篝火旁（走廊 -142..-101，half 2.75）
  { id: "cemetery:a3-a1", scene: "cemetery", kind: "elevator", label: "墓园电梯",
    pos: new THREE.Vector3(-7.5, 0, -6.5), dest: new THREE.Vector3(-139.2, 0, 1.2), destName: "灰烬墓地 · 出生台地" },
  // D2 沙力万房东北（房心 99.1 r19，相对旧点东移 18m）→ B 走廊东端
  { id: "highwall:d-b", scene: "highwall", kind: "elevator", label: "月坛电梯",
    pos: new THREE.Vector3(98.7, 0, 6.6), dest: new THREE.Vector3(-6, 0, 0), destName: "高墙 · 城墙步道" },
  // E4 残柱厅中段（12.4..24 half 4，拱门 x=14.5 之东）→ E1 篝火旁（走廊 -38..-20.5 half 11）
  { id: "stormveil:e4-e1", scene: "stormveil", kind: "elevator", label: "教堂电梯",
    pos: new THREE.Vector3(16, 0, -2.5), dest: new THREE.Vector3(-35.4, 0, 1.6), destName: "城垣 · 外梯" },
];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class Game {
  private renderer = new THREE.WebGLRenderer({ antialias: true });
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 480);
  private vfx!: Vfx;
  private bonfire!: Bonfire;
  private fog!: FogGate;
  private shortcuts: Shortcut[] = [];          // T6 捷径（setupScene 按场景表重建）
  private boss!: BossBase;
  private bossEntry!: BossEntry;
  private bossId = "gundyr";
  private lockKind: "boss" | "enemy" = "boss";
  private lockEnemy: EnemyBase | null = null;
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
  private shakeT = 0;                     // 震屏相位（正弦叠加，避免逐帧随机噪声）
  private readonly camRay = new THREE.Raycaster();
  private readonly camDir = new THREE.Vector3();
  private hitstop = 0;
  private slowT = 0; private slowScale = 1;
  private elapsed = 0;
  private fightStart = 0;
  private deathDelay = 0;
  private victoryDelay = 0;
  private prevPx = -12.2;
  /** 当前 Boss 脚下的 arena 圆（几何半径 r）。第一次判定后锁住，Boss 走位不换房。 */
  private bossRoom: { x: number; z: number; r: number } | null = null;
  /** 玩家走进可走圆后封门。击败、回篝火、换场景时清空。 */
  private bossSeal: { x: number; z: number; walk: number } | null = null;
  /** 本场还可以封。解开后关掉，避免人还站在圆里时下一帧又封上；换 Boss 再打开。 */
  private bossSealArmed = true;
  private hintT = 14;

  private stats = { hitsTaken: 0, parries: 0, ripostes: 0, deaths: 0 };

  // M2 魂循环状态
  private progress!: Progress;                 // localStorage 存档（构造时 ?fresh=1 可清档）
  private bloodstain: SoulSign | null = null;  // 场上血渍（掉魂点）
  private sceneDispose: (() => void) | null = null;
  private bossOverride: string | null = null;  // 再战直选（一次性，spawnBoss 消费）
  private enemies!: EnemyManager;              // M3 小怪系统（构造后即置）
  private tryN = 0;                            // 当前 Boss 累计挑战次数
  private menuOpen = false;
  private menuIdx = 0;
  private menuItems: { label: string; off?: boolean; act: () => void }[] = [];

  constructor(gltf: GLTF, frames: Record<string, Record<string, unknown>>) {
    // 存档：?fresh=1 清档重开（调试/重玩）
    const params = new URLSearchParams(location.search);
    if (params.get("fresh")) clearProgress();
    this.progress = loadProgress();

    // 渲染器
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    document.body.prepend(this.renderer.domElement);

    // 场景注册表：首入场景优先级 ?scene= 调试参数 > 上次休息篝火(跨会话重生点，DS3 规则) > 墓地
    const reqScene = params.get("scene") as SceneId | null;
    const savedBonfire = this.progress.lastBonfire as SceneId;
    this.sceneId = reqScene ?? (this.progress.unlockedScenes.includes(savedBonfire) ? savedBonfire : "cemetery");

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
      hitBoss: (dmg, poise, feelKey, point, opts) => { void opts; this.hitBoss(dmg, poise, feelKey, point); },
      hitEnemies: (dmg, poise, feelKey, def) => { this.enemies.tryHit(this.player.pos, this.player.yaw, dmg, poise, feelKey, def); },
      onPlayerHurt: (dmg, point, feelKey) => this.onPlayerHurt(dmg, point, feelKey),
      onParrySuccess: point => this.onParry(point),
      onDeath: () => this.onPlayerDeath(),
      bossParryableActive: () => this.boss.canBeParried(),
      bossOpen: () => this.boss.state === "parried" || this.boss.state === "stagger",
      bossPos: () => this.boss.root.position,
      aimPos: () => this.aimPos(),
      shake: a => this.shake(a),
    });
    this.player.bind(actions);
    this.player.pos.copy(this.anchors.spawn);
    this.player.souls = this.progress.souls;     // 魂量随存档恢复
    this.scene.add(this.player.root);

    // 小怪系统（M3）：布怪在 spawnEnemies（按场景预设表，篝火休息/旅行重刷）
    this.enemies = new EnemyManager(this.scene, this.vfx, {
      onHit: (feelKey, point) => {                // 敌人被玩家命中：六通道扇出（同 hitBoss 反馈段）
        const f = FEEL[feelKey] ?? FEEL.pR1a;
        this.vfx.sparks.burst(point, f.sparks, f.sparkSpeed, 0.35);
        this.hitstopFor(f.hitstop); this.shake(f.shake);
        this.sfx(f.sfx); PAD.rumble(f.shake * 0.5, f.shake, 90 + f.hitstop * 600);
      },
      onHitPlayer: (dmg, dir, move) => this.player.applyHit(dmg, dir, move),
      onDeath: souls => { this.player.souls += souls; this.showMsg(`魂 +${souls}`, 1.2, true); this.saveState(); },
      shake: a => this.shake(a),
    });
    // Boss 选择：?boss= 直选（调试/再战入口，一次性），否则按进度线推导本场雾门 Boss
    // 直选同时开放直至该 Boss 的驻区——否则 clampWorld 会按未解锁区把玩家推出竞技场（Boss 够不着）
    const bossParam = params.get("boss");
    if (bossParam && BOSSES[bossParam]) {
      this.bossOverride = bossParam;
      for (let i = 0; i <= BOSS_ORDER.indexOf(bossParam as BossId); i++) {
        const z = ZONE_OF[BOSS_ORDER[i]];
        if (z && !this.progress.zoneUnlocks.includes(z)) this.progress.zoneUnlocks.push(z);
      }
    }
    this.spawnEnemies();
    this.spawnBoss();

    // 调校台（` 键开关）：帧数据热调 / 判定可视化 / 逐帧 / 存档
    this.tune = new Tuning(this.scene, this.player, this.boss);

    // 存档血渍恢复（只建本场景的；他乡的在旅行时建）
    if (this.progress.bloodstain && this.progress.bloodstain.scene === this.sceneId) {
      this.bloodstain = buildSoulSign(this.scene, new THREE.Vector3(this.progress.bloodstain.x, 0, this.progress.bloodstain.z));
    }

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
    this.sceneDispose?.();
    this.sceneDispose = null;
    this.sceneUpdate = null;
    if (this.sceneId === "highwall") {
      const hw = buildHighWall(this.scene);
      this.anchors = hw.anchors;
      this.sceneUpdate = hw.update;
      this.sceneDispose = hw.dispose;
    } else if (this.sceneId === "stormveil") {
      const sv = buildStormveil(this.scene);
      this.anchors = sv.anchors;
      this.sceneUpdate = sv.update ?? null;   // 风雾漂移动态（T1 灰盒）
      this.sceneDispose = sv.dispose;
    } else {
      const cm = buildCemetery(this.scene);
      this.anchors = cm.anchors;
      this.sceneUpdate = cm.update;   // 飘灰/火焰/流云动态
      this.sceneDispose = cm.dispose;
    }
    this.bonfire = buildBonfire(this.scene, this.anchors.bonfire);
    this.fog = new FogGate(this.scene, this.anchors.fogGate);
    // T6 捷径：按场景表建实例（旅行重建/首次构造同一路径），开放态读 progress.shortcuts
    for (const s of this.shortcuts) s.dispose();
    const host: ShortcutHost = { onShortcutRide: def => this.onShortcutRide(def) };
    this.shortcuts = SHORTCUT_DEFS
      .filter(d => d.scene === this.sceneId)
      .map(d => new Shortcut(this.scene, d, this.progress.shortcuts.includes(d.id), host));
  }

  // ---------------- Boss 生命周期（M2：进度线选人 / 旅行销毁重建） ----------------
  /** 按场景预设布怪（旅行/篝火休息/构造时重刷；T8 将迁入关卡表） */
  /** 按场景预设表布怪（T8：位置入 ENEMY_PRESETS 数据表；zone 字段按进度闸门过滤，未解锁深区别刷） */
  private spawnEnemies(): void {
    this.enemies.clear();
    if (this.lockKind === "enemy") this.clearLock();
    const specs = ENEMY_PRESETS[this.sceneId];
    if (!specs?.length) return;
    for (const p of specs) {
      if (p.zone && !this.progress.zoneUnlocks.includes(p.zone)) continue;
      this.enemies.spawn(p, new THREE.Vector3(p.at?.[0] ?? 0, 0, p.at?.[1] ?? 0));
    }
  }

  private spawnBoss(): void {
    const pick = this.bossOverride && BOSSES[this.bossOverride] ? this.bossOverride : bossForScene(this.progress, this.sceneId, ARENAS);
    this.bossOverride = null;
    this.bossId = pick;
    this.bossEntry = BOSSES[pick];
    // 落位：优先取该 Boss 驻区(m4 zones v2)的 arena 圆心（城垣葛瑞克→E5 接肢教堂/高墙沙力万→D 月坛房），
    // 场景未提供 zones 时回退 legacy bossArena；同区多 arena 时取圆心最贴近 legacy bossArena 者
    // （墓地 cemetery:A 含两座 arena——袋形墓苑 I 在前，find() 首中会错置古达）；+1.8m 东偏保持既有雾门-石像间距惯例
    const candidates = (this.anchors.zones ?? []).filter(z => z.kind === "arena" && z.id === ZONE_OF[pick as BossId]);
    const zone = candidates.length
      ? candidates.reduce((best, z) => (z.center!.distanceTo(this.anchors.bossArena) < best.center!.distanceTo(this.anchors.bossArena) ? z : best))
      : undefined;
    const bossPos = (zone?.center ?? this.anchors.bossArena).clone().add(new THREE.Vector3(1.8, 0, 0));
    this.boss = this.bossEntry.create(this.scene, this.vfx, bossPos, {
      onBossHit: (dmg, dir, point, move) => this.onBossHitPlayer(dmg, dir, point, move),
      onBossReveal: () => this.revealBoss(),
      onBossTransform: point => this.transformShock(point),
      onBossDeath: () => this.onBossDeath(),
      shake: a => this.shake(a),
      fireProjectile: (pos, yaw, def) => this.projectiles.spawn(pos, yaw, def),
    });
    this.bossRoom = null;
    this.bossSealArmed = true;
    this.syncBossRoom();
  }

  /** 通用对象销毁：释放几何/材质并摘树（篝火/雾门等无自管 dispose 的对象） */
  private disposeObj(o: THREE.Object3D): void {
    o.traverse(c => {
      const m = c as THREE.Mesh;
      if (m.isMesh) {
        m.geometry?.dispose();
        const ms = Array.isArray(m.material) ? m.material : [m.material];
        for (const mt of ms) mt?.dispose();
      }
    });
    o.removeFromParent();
  }

  /** 篝火旅行（M4 T9 演出：黑场渐隐 0.3s → 换场景 → 渐显 + 区域题字卡；restart 也走此路） */
  private travelTo(target: SceneId): void {
    this.releaseBossSeal();
    this.closeMenu();
    $("fade").classList.add("on");
    setTimeout(() => {
      this.rebuildScene(target);
      $("fade").classList.remove("on");
      this.showZoneCard(SCENE_NAME[target]);
    }, 340);
  }

  /** 区域题字卡（DS3 风格：大字距 + 缓入缓出） */
  private showZoneCard(text: string): void {
    const el = $("zoneCard");
    el.textContent = text;
    el.classList.add("on");
    setTimeout(() => el.classList.remove("on"), 2100);
  }

  private rebuildScene(target: SceneId): void {
    this.releaseBossSeal();
    this.bossRoom = null;
    this.boss.dispose();
    this.disposeObj(this.bonfire.group);
    this.disposeObj(this.fog.group);
    this.bloodstain?.dispose();
    this.bloodstain = null;
    this.projectiles.clear();
    this.sceneId = target;
    this.setupScene();
    this.spawnEnemies();
    this.spawnBoss();
    this.tune.retarget(this.boss);
    this.player.reset(this.anchors.spawn);
    this.prevPx = this.anchors.spawn.x;
    this.flow = "intro";
    this.tryN = 0;
    $("bossbar").classList.remove("on");
    $("overlayDeath").classList.remove("show");
    $("overlayWin").classList.remove("show");
    if (this.progress.bloodstain && this.progress.bloodstain.scene === target) {
      this.bloodstain = buildSoulSign(this.scene, new THREE.Vector3(this.progress.bloodstain.x, 0, this.progress.bloodstain.z));
    }
  }

  private saveState(): void {
    this.progress.souls = this.player.souls;
    this.progress.stats.parries = this.stats.parries;
    this.progress.stats.ripostes = this.stats.ripostes;
    saveProgress(this.progress);
  }

  // ---------------- 输入 ----------------
  private bindInput(): void {
    const canvas = this.renderer.domElement;
    canvas.addEventListener("click", () => { AU.init(); });   // 点击仅初始化音频，不锁定指针（触控板友好）
    canvas.addEventListener("dragstart", e => e.preventDefault()); // 点按被当成拖拽时，浏览器会停住页面绘制
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
    // passive:false 才能 preventDefault。不拦的话，触控板横滑会走浏览器返回手势：
    // 页面被拍成快照，WebGL 不再刷新，看起来就是屏幕卡死。
    addEventListener("wheel", e => {
      e.preventDefault();
      if (e.ctrlKey || document.pointerLockElement !== canvas) return; // 捏合只禁缩放；双指不推动镜头
      this.camDist = Math.max(3.2, Math.min(8.5, this.camDist + e.deltaY * 0.004));
    }, { passive: false });
    addEventListener("mousedown", e => { if (!this.menuOpen) this.player.onMouse(e.button, true); });
    addEventListener("mouseup", e => { if (!this.menuOpen) this.player.onMouse(e.button, false); });
    const inPanelInput = (e: KeyboardEvent): boolean => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
    };
    addEventListener("keydown", e => {
      if (e.code === "Space" && !inPanelInput(e)) e.preventDefault();
      if (inPanelInput(e)) return;   // 面板输入中不触发游戏按键
      // 篝火菜单：吞掉游戏按键，只响应菜单操作
      if (this.menuOpen) {
        if (e.code === "ArrowUp" || e.code === "KeyW") this.menuMove(-1);
        else if (e.code === "ArrowDown" || e.code === "KeyS") this.menuMove(1);
        else if (e.code === "KeyE" || e.code === "Enter") this.menuConfirm();
        else if (e.code === "Escape" || e.code === "Backspace") this.closeMenu();
        return;
      }
      this.player.onKey(e.code, true);
      if (e.code === "KeyV" && !e.repeat) {                       // 自由视角开关（鼠标用户）
        if (document.pointerLockElement === canvas) document.exitPointerLock();
        else canvas.requestPointerLock();
      }
      else if (e.code === "KeyQ" && !e.repeat) this.cycleLock();
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
    if (this.bossId === "gundyr") this.showMsg("人性的沉淀", 1.6);
  }

  private revealBoss(): void {
    $("bossbar").classList.add("on");
    // 只改标题 span，勿动 #bossName.textContent——会连带销毁 #bossPhase2（曾致每帧 null.style 崩循环）
    $("bossTitle").textContent = this.bossEntry.name;
    $("winBig").textContent = `${this.bossEntry.name} 已陨落`;
    $("bossTry").textContent = `第 ${this.tryN} 次挑战`;
    this.showMsg(this.bossEntry.name, 2.2, true);
    AU.roar();
    this.fightStart = this.elapsed;
    this.lockKind = "boss";
    this.lockEnemy = null;
    this.player.lockOn = true;   // 开战自动锁定 Boss（无鼠标方案）
  }

  private onBossDeath(): void {
    this.releaseBossSeal();
    this.flow = "victory";
    this.victoryDelay = 2.2;
    const award = this.bossEntry.souls;
    this.player.souls += award;
    // T6：先取本次击败新增的捷径（onDefeat→deriveZones 会幂等并入 progress.shortcuts）
    const freshShortcuts = shortcutUnlockedOn(this.bossId as BossId)
      .filter(sid => !this.progress.shortcuts.includes(sid));
    onDefeat(this.progress, this.bossId as BossId, ARENAS);   // 记 defeated + 解锁下一位场景/点篝火/开捷径
    for (const sid of freshShortcuts) {
      // 本场景实例即时开门 + 提示；他乡捷径（如监视者胜开高墙电梯）旅行后 rebuildScene 读 progress 自然开门
      const sc = this.shortcuts.find(s => s.def.id === sid);
      if (sc) { sc.setOpen(true); this.showMsg(`捷径开启 · ${sc.def.label}`, 2.2, true); }
      else this.showMsg("远方传来机关开启的轰鸣……", 2.2, true);
    }
    const allClear = this.progress.defeated.length >= BOSS_ORDER.length;
    $("winSub").textContent = allClear
      ? `薪火的巡礼告一段落 —— ${BOSS_ORDER.length} 位 Boss 尽数陨落`
      : `魂 +${award}`;
    this.player.lockOn = false;
    this.lockEnemy = null;
    this.saveState();
  }

  private onPlayerDeath(): void {
    this.flow = "dead";
    this.deathDelay = 1.6;
    this.stats.deaths++;
    this.progress.stats.deaths++;
    // 掉魂铁律：全部魂掉在死点，旧血渍随之消散
    if (this.player.souls > 0) {
      this.dropBloodstain(this.player.pos.clone(), this.player.souls);
      this.player.souls = 0;
    }
    this.player.lockOn = false;
    this.lockEnemy = null;
    this.saveState();
  }

  private dropBloodstain(pos: THREE.Vector3, souls: number): void {
    this.bloodstain?.dispose();
    this.bloodstain = buildSoulSign(this.scene, pos);
    this.progress.bloodstain = { scene: this.sceneId, x: pos.x, z: pos.z, souls };
  }

  /** R 回到篝火：走旅行管线（同场景也整场重建——雾门 Boss 随进度换人） */
  private restart(): void {
    this.travelTo(this.progress.lastBonfire);
  }

  // ---------------- 交互 ----------------
  private interact(): void {
    if (this.menuOpen) { this.menuConfirm(); return; }
    if (this.enemies.tryBackstab(this.player.pos, this.player.yaw)) { this.stats.ripostes++; return; }   // 敌人背刺（pRip 处决级手感在 manager 内扇出）
    if (this.flow === "fight" && this.player.tryRiposte()) { this.stats.ripostes++; return; }
    // 血渍拾回（任何非菜单时刻，含战斗中——DS3 规则）
    if (this.bloodstain && this.progress.bloodstain && this.player.pos.distanceTo(this.bloodstain.group.position) < 1.5) {
      const souls = this.progress.bloodstain.souls;
      this.player.souls += souls;
      this.progress.bloodstain = null;
      this.bloodstain.dispose();
      this.bloodstain = null;
      this.progress.stats.soulRegains++;
      AU.soulGain();
      this.showMsg(`拾回 ${souls} 魂`, 1.6, true);
      this.saveState();
      return;
    }
    // T6 捷径：近旁 E 搭乘（locked 也命中——提示与乘坐判定居 onShortcutRide）
    for (const sc of this.shortcuts) if (sc.interact(this.player.pos)) return;
    if (this.flow === "intro" && this.player.pos.distanceTo(this.bonfire.pos) < 1.6) {
      if (!this.progress.litBonfires.includes(this.sceneId)) { this.showMsg("篝火尚未点燃", 1.4); return; }
      this.openBonfireMenu();
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
      this.tryN = (this.progress.attempts[this.bossId] ?? 0) + 1;
      this.progress.attempts[this.bossId] = this.tryN;
      this.saveState();
      this.boss.pull();
      this.flow = "fight";
      setTimeout(() => { this.fog.close(); this.fog.solid = true; }, 800);
    }
  }

  // ---------------- 捷径（T6：电梯/单向门） ----------------
  /** Shortcut.interact 命中回调：locked 提示「尚未开启」；open 黑场渐隐（复用 #fade）→ 落位 + 题字卡 */
  private onShortcutRide(def: ShortcutDef): void {
    const sc = this.shortcuts.find(s => s.def.id === def.id);
    if (!sc?.isOpen) { this.showMsg("捷径尚未开启", 1.4); return; }
    if (this.flow !== "intro" && this.flow !== "statue") return;   // 战斗/结算中不乘梯（防 Boss 追出房区）
    if (this.bossSeal) return;                                     // 封门后捷径落点在圆外，骑乘会被钳回来
    AU.fogGate();
    $("fade").classList.add("on");
    setTimeout(() => {
      this.player.pos.copy(def.dest);
      this.prevPx = def.dest.x;          // 同步雾门单向墙判据，防 clampWorld 按“上一帧在东”把玩家拽回
      $("fade").classList.remove("on");
      this.showZoneCard(def.destName);
    }, 340);
  }

  // ---------------- 篝火菜单（M2：休息/传送/再战） ----------------
  private openBonfireMenu(): void {
    const items: { label: string; off?: boolean; act: () => void }[] = [];
    items.push({ label: "休息", act: () => { this.closeMenu(); this.restAtBonfire(); } });
    for (const sc of ["cemetery", "highwall", "stormveil"] as SceneId[]) {
      const unlocked = this.progress.unlockedScenes.includes(sc);
      items.push({
        label: `传送 · ${SCENE_NAME[sc]}`,
        off: !unlocked || sc === this.sceneId,
        act: () => { if (unlocked) this.travelTo(sc); },
      });
    }
    // 全通后：再战任意 Boss（同时是调校入口）
    if (this.progress.defeated.length >= BOSS_ORDER.length) {
      for (const id of BOSS_ORDER) {
        items.push({ label: `再战 · ${BOSSES[id].name}`, act: () => { this.bossOverride = id; this.travelTo(BOSSES[id].arena); } });
      }
    }
    items.push({ label: "离开", act: () => this.closeMenu() });
    this.menuItems = items;
    this.menuIdx = 0;
    this.menuOpen = true;
    this.renderMenu();
    $("bonfireMenu").classList.add("show");
  }

  private renderMenu(): void {
    const box = $("menuItems");
    box.replaceChildren();
    this.menuItems.forEach((it, i) => {
      const d = document.createElement("div");
      d.className = `mi${i === this.menuIdx ? " sel" : ""}${it.off ? " off" : ""}`;
      d.textContent = it.label;
      box.appendChild(d);
    });
  }

  private menuMove(dir: number): void {
    const n = this.menuItems.length;
    if (!n) return;
    for (let k = 1; k <= n; k++) {                       // 跳过灰显项
      const i = (this.menuIdx + dir * k + n * 2) % n;
      if (!this.menuItems[i].off) { this.menuIdx = i; break; }
    }
    this.renderMenu();
  }

  private menuConfirm(): void {
    const it = this.menuItems[this.menuIdx];
    if (!it) return;
    if (it.off) { this.showMsg("尚不可用", 1); return; }
    it.act();
  }

  private closeMenu(): void {
    if (!this.menuOpen) return;
    this.menuOpen = false;
    $("bonfireMenu").classList.remove("show");
  }

  private restAtBonfire(): void {
    this.player.hp = P.hp;
    this.player.estus = P.estusMax;
    this.progress.lastBonfire = this.sceneId;           // 重生点设为此篝火
    this.boss.reset();                                   // 敌人重置
    this.spawnEnemies();                                 // 小怪重刷（DS3 篝火规则）
    this.projectiles.clear();
    AU.bonfireRest();
    this.showMsg("在篝火旁稍作休息", 1.6);
    this.vfx.embers.burst(this.bonfire.pos.clone().setY(0.8), 24, 2, 1.6);
    this.saveState();
  }

  // ---------------- 流程与主循环 ----------------
  private clampWorld(): void {
    const p = this.player.pos;
    const gateX = this.anchors.fogGate.x;
    if (this.fog.solid) {
      if (this.prevPx > gateX) p.x = Math.max(p.x, gateX + 0.4);
      else p.x = Math.min(p.x, gateX - 0.4);
    }
    if (this.anchors.zones?.length) {
      // v2 逐区钳制：西→东找当前区；未解锁区在衔接处成单向墙
      const zs = this.anchors.zones;
      let zi = 0;
      for (let i = 0; i < zs.length; i++) if (p.x >= zs[i].minX) zi = i;
      const zone = zs[zi];
      const unlocked = this.progress.zoneUnlocks.includes(zone.id);
      if (!unlocked && zi > 0) p.x = Math.min(p.x, zs[zi - 1].maxX - 0.4);   // 推回上一区东界
      if (zone.kind === "corridor") {
        const half = zone.half ?? 1.45;
        p.z = Math.max(-half, Math.min(half, p.z));
        p.x = Math.max(zone.minX, Math.min(zone.maxX, p.x));
      } else if (zone.center && zone.r) {
        const cx = p.x - zone.center.x, cz = p.z - zone.center.z;
        const maxR = zone.r - 0.9;
        const r = Math.hypot(cx, cz);
        if (r > maxR) { const k = maxR / r; p.x = zone.center.x + cx * k; p.z = zone.center.z + cz * k; }
      }
    } else if (p.x < gateX) {
      p.x = Math.max(p.x, this.anchors.corridorMinX);
      p.z = Math.max(-1.45, Math.min(1.45, p.z));
    } else {
      const cx = p.x - this.anchors.bossArena.x, cz = p.z - this.anchors.bossArena.z;
      const maxR = this.anchors.arenaRadius - 0.9;
      const r = Math.hypot(cx, cz);
      if (r > maxR) { const k = maxR / r; p.x = this.anchors.bossArena.x + cx * k; p.z = this.anchors.bossArena.z + cz * k; }
    }
    // 分区钳制可能把人按回走廊；已经进过可走圆的，这里再封一次门
    this.trySealBossRoom();
    // 玩家与 Boss 推挤
    const d = this.boss.root.position.clone().sub(p); d.y = 0;
    const minD = this.bossEntry.radius + P.playerRadius;
    if (this.boss.awake && d.length() < minD) p.sub(d.normalize().multiplyScalar(minD - d.length()));
    this.clampInsideBossSeal();
    this.prevPx = p.x;
  }

  /** boss.root 落在哪个 arena 圆内（距 center < r），那就是 Boss 房。没有 zones 时用 legacy 圆。 */
  private syncBossRoom(): void {
    if (this.bossRoom || !this.boss?.root || !this.anchors) return;
    const pos = this.boss.root.position;
    const zones = this.anchors.zones;
    if (zones?.length) {
      let best: { x: number; z: number; r: number; d2: number } | null = null;
      for (const z of zones) {
        if (z.kind !== "arena" || !z.center || z.r == null) continue;
        const dx = pos.x - z.center.x, dz = pos.z - z.center.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < z.r * z.r && (!best || d2 < best.d2)) best = { x: z.center.x, z: z.center.z, r: z.r, d2 };
      }
      if (best) this.bossRoom = { x: best.x, z: best.z, r: best.r };
      return;
    }
    const dx = pos.x - this.anchors.bossArena.x, dz = pos.z - this.anchors.bossArena.z;
    const r = this.anchors.arenaRadius;
    if (dx * dx + dz * dz < r * r) this.bossRoom = { x: this.anchors.bossArena.x, z: this.anchors.bossArena.z, r };
  }

  /** 身体进入可走圆（距圆心 ≤ r-0.9）才封。没进圆之前不封。 */
  private trySealBossRoom(): void {
    if (!this.bossSealArmed || this.bossSeal || !this.bossRoom) return;
    const walk = this.bossRoom.r - 0.9;
    if (walk <= 0) return;
    const dx = this.player.pos.x - this.bossRoom.x, dz = this.player.pos.z - this.bossRoom.z;
    if (dx * dx + dz * dz <= walk * walk) this.bossSeal = { x: this.bossRoom.x, z: this.bossRoom.z, walk };
  }

  private releaseBossSeal(): void {
    this.bossSeal = null;
    this.bossSealArmed = false;
  }

  /** 小怪用的可走圆。人在圆内，或封门本帧还没把跨出去的身体钳回来，都算在房里。 */
  private bossGate(): BossRoomSeal | null {
    const room = this.bossRoom;
    if (!room) return null;
    const r = room.r - 0.9;
    if (r <= 0) return null;
    const dx = this.player.pos.x - room.x, dz = this.player.pos.z - room.z;
    const inside = dx * dx + dz * dz <= r * r;
    return { x: room.x, z: room.z, r, playerInside: this.bossSeal !== null || inside };
  }

  /** 封门后每帧钳在可走圆内，x 落进走廊区也不能退出去。 */
  private clampInsideBossSeal(): void {
    const s = this.bossSeal;
    if (!s) return;
    const p = this.player.pos;
    const dx = p.x - s.x, dz = p.z - s.z;
    const dist = Math.hypot(dx, dz);
    if (dist > s.walk) {
      const k = s.walk / dist;
      p.x = s.x + dx * k;
      p.z = s.z + dz * k;
    }
  }

  private prompt(): string | null {
    if (this.menuOpen) return null;
    if (this.flow === "fight" && (this.boss.state === "parried" || this.boss.state === "stagger") && this.player.pos.distanceTo(this.boss.root.position) < 2.5) return "E 处决";
    if (this.bloodstain && this.progress.bloodstain && this.player.pos.distanceTo(this.bloodstain.group.position) < 1.5) return `E 拾回 ${this.progress.bloodstain.souls} 魂`;
    // T6 捷径提示：靠近显示搭乘/未开启（与篝火提示同式）
    const sc = this.shortcuts.find(s => this.player.pos.distanceTo(s.def.pos) < SHORTCUT_RADIUS);
    if (sc && (this.flow === "intro" || this.flow === "statue")) {
      if (!sc.isOpen) return "捷径尚未开启";
      if (!this.bossSeal) return "E 搭乘捷径";
    }
    if (this.flow === "intro" && this.player.pos.distanceTo(this.bonfire.pos) < 1.6) return this.progress.litBonfires.includes(this.sceneId) ? "E 篝火（休息 · 传送）" : "篝火尚未点燃";
    if (this.flow === "intro" && Math.abs(this.player.pos.x - this.anchors.fogGate.x) < 1.4 && Math.abs(this.player.pos.z) < 1.8) return "E 跨入雾门";
    if (this.flow === "statue" && this.player.pos.distanceTo(this.boss.root.position) < 3.2) return "E 拔出螺旋剑";
    return null;
  }

  private clearLock(): void {
    this.lockKind = "boss";
    this.lockEnemy = null;
    if (this.player) this.player.lockOn = false;
  }

  /** 当前锁定点。Boss 战自动锁 Boss；小怪超出 22m、死亡，或封门后站在圆外则失效。 */
  private lockPoint(): THREE.Vector3 | null {
    if (!this.player?.lockOn) return null;
    if (this.lockKind === "enemy") {
      const e = this.lockEnemy;
      if (!e?.alive) return null;
      if (e.root.position.distanceTo(this.player.pos) > 22) return null;
      if (this.enemyOutsideSeal(e.root.position)) return null;
      return e.root.position;
    }
    if (!this.boss?.awake || this.boss.state === "dead") return null;
    return this.boss.root.position;
  }

  /** 出手朝向：锁定目标优先；否则面前 3.6m 内的小怪；再否则竞技场内的 Boss。远处石像不吸附。 */
  private aimPos(): THREE.Vector3 | null {
    const locked = this.lockPoint();
    if (locked) return locked;
    const melee = this.enemies?.nearestAhead(this.player.pos, this.player.yaw, 3.6, 1.15);
    if (melee) return melee.root.position;
    if (this.boss?.awake && this.boss.state !== "dead" && this.boss.root.position.distanceTo(this.player.pos) < 28) {
      return this.boss.root.position;
    }
    return null;
  }

  private cycleLock(): void {
    const cands = this.lockCandidates();
    const cur = this.lockPoint();
    if (!cur) {
      if (!cands.length) return;
      this.applyLock(cands[0]);
      return;
    }
    if (cands.length <= 1) { this.clearLock(); return; }
    const id = this.lockKind === "boss" ? "boss" : `e${this.lockEnemy?.root.id}`;
    const i = cands.findIndex(c => c.id === id);
    this.applyLock(cands[(i < 0 ? 0 : i + 1) % cands.length]);
  }

  private applyLock(c: { id: string; kind: "boss" } | { id: string; kind: "enemy"; enemy: EnemyBase }): void {
    if (c.kind === "boss") {
      this.lockKind = "boss";
      this.lockEnemy = null;
    } else {
      this.lockKind = "enemy";
      this.lockEnemy = c.enemy;
    }
    this.player.lockOn = true;
  }

  private lockCandidates(): ({ id: string; kind: "boss" } | { id: string; kind: "enemy"; enemy: EnemyBase })[] {
    const out: { id: string; kind: "boss" | "enemy"; enemy?: EnemyBase; ang: number; d: number }[] = [];
    const push = (id: string, kind: "boss" | "enemy", pos: THREE.Vector3, enemy?: EnemyBase) => {
      const dx = pos.x - this.player.pos.x;
      const dz = pos.z - this.player.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 16 || d < 0.35) return;
      let ang = Math.atan2(dx, dz) - this.player.yaw;
      ang = Math.atan2(Math.sin(ang), Math.cos(ang));
      out.push({ id, kind, enemy, ang, d });
    };
    if (this.boss.awake && this.boss.state !== "dead") push("boss", "boss", this.boss.root.position);
    for (const e of this.enemies.enemies) {
      if (!e.alive || this.enemyOutsideSeal(e.root.position)) continue;
      push(`e${e.root.id}`, "enemy", e.root.position, e);
    }
    const front = out.filter(o => Math.abs(o.ang) < 1.9);
    const pool = (front.length ? front : out).sort((a, b) => Math.abs(a.ang) - Math.abs(b.ang) || a.d - b.d);
    return pool.map(o => o.kind === "enemy"
      ? { id: o.id, kind: "enemy" as const, enemy: o.enemy as EnemyBase }
      : { id: o.id, kind: "boss" as const });
  }

  /** 封门已生效，且点在可走圆外。没封门时恒为 false。边界与仇恨一致：距圆心 ≥ walk。 */
  private enemyOutsideSeal(pos: THREE.Vector3): boolean {
    const s = this.bossSeal;
    if (!s) return false;
    const dx = pos.x - s.x, dz = pos.z - s.z;
    return dx * dx + dz * dz >= s.walk * s.walk;
  }

  private updateCamera(rdt: number): void {
    if (this.player.lockOn && !this.lockPoint()) this.clearLock();
    const target = this.player.pos.clone().add(new THREE.Vector3(0, 1.45, 0));
    let dist = this.camDist;
    let lookAt = target;

    const focus = this.lockPoint();
    const locked = !!focus;
    if (locked && focus) {
      // 锁定取景：镜头在玩家背侧、看向两人中点，距离随间距自适应
      const toBoss = focus.clone().sub(this.player.pos);
      const sep = toBoss.length();
      lookAt = this.player.pos.clone().lerp(focus, 0.32).setY(target.y);
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
    this.occludeCamera(lookAt);
    if (this.shakeAmp > 0.001) {
      // 手感档案的振幅直接驱动互质正弦；顿帧期间仍走真实时间，衰减完回到原位
      this.shakeT += rdt * 28;
      const s = this.shakeAmp;
      this.camera.position.x += Math.sin(this.shakeT * 1.7) * s * 0.18;
      this.camera.position.y += Math.sin(this.shakeT * 2.3) * s * 0.12;
      this.camera.position.z += Math.sin(this.shakeT * 1.1) * s * 0.18;
      this.shakeAmp *= Math.exp(-8 * rdt);
    } else {
      this.shakeT = 0;
    }
    this.camera.lookAt(lookAt);
  }

  /** 镜头钻进墙里时拉回到墙前。只打场景根上的实心网格，跳过天穹、雾和地面贴片。 */
  private occludeCamera(lookAt: THREE.Vector3): void {
    const root = this.scene.getObjectByName(this.sceneId);
    if (!root) return;
    this.camDir.copy(this.camera.position).sub(lookAt);
    const len = this.camDir.length();
    if (len < 0.45) return;
    this.camDir.multiplyScalar(1 / len);
    this.camRay.set(lookAt, this.camDir);
    this.camRay.near = 0.12;
    this.camRay.far = len;
    const hits = this.camRay.intersectObject(root, true);
    for (const hit of hits) {
      const mesh = hit.object as THREE.Mesh;
      if (!mesh.isMesh) continue;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (mats.some(m => !m || m.transparent || m.side === THREE.BackSide || m.opacity < 0.99)) continue;
      let inset = hit.distance - 0.22;
      if (inset < 0.3) inset = Math.max(0.12, hit.distance * 0.65);
      inset = Math.min(inset, Math.max(0.12, hit.distance - 0.08));
      if (inset < len - 0.03) this.camera.position.copy(lookAt).addScaledVector(this.camDir, inset);
      return;
    }
  }

  private updateHud(): void {
    ($("hpFl") as HTMLElement).style.width = `${Math.max(0, this.player.hp / P.hp * 100)}%`;
    ($("stFl") as HTMLElement).style.width = `${Math.max(0, this.player.stamina / P.stamina * 100)}%`;
    document.querySelector(".bar.st")?.classList.toggle("empty", this.player.stamina < P.rollCost);
    $("vig").classList.toggle("danger", this.player.hp / P.hp < 0.3);
    $("estusN").textContent = String(this.player.estus);
    $("estusN").classList.toggle("empty", this.player.estus <= 0);
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
    const head = this.lockKind === "enemy" && this.lockEnemy?.alive
      ? this.lockEnemy.hitPoint()
      : (this.player.lockOn && this.boss.awake && this.boss.state !== "dead" ? this.boss.headWorld() : null);
    if (this.player.lockOn && head) {
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
    // three.js 在回调返回之后才 requestAnimationFrame。回调里一旦抛错，下一帧不会再约，画面就停在最后一帧。
    this.renderer.setAnimationLoop(() => {
      try {
        const now = performance.now();
        const rdt = Math.min(0.05, (now - last) / 1000);
        last = now;
        this.elapsed += rdt;
        this.tune.frameTick(rdt);

        // 时间控制：调校台暂停/逐帧 > 篝火菜单冻结 > 顿帧 > 慢动作 > 调校台慢放
        let dt = rdt;
        if (this.tune.paused) {
          if (this.tune.steps > 0) { this.tune.steps--; dt = (1 / 60) * (this.tune.slowOn ? this.tune.timeScale : 1); }
          else dt = 0;
        } else if (this.menuOpen) dt = 0;
        else if (this.hitstop > 0) { this.hitstop -= rdt; dt = 0; }
        else if (this.slowT > 0) { this.slowT -= rdt; dt *= this.slowScale; }
        else if (this.tune.slowOn) dt *= this.tune.timeScale;

        // 战斗更新
        if (this.flow === "fight") this.boss.update(dt, this.player.pos, this.player.isIframed);
        else if (this.boss.state === "rising" || this.boss.state === "dead" || this.boss.state === "transform") this.boss.update(dt, this.player.pos, this.player.isIframed);
        this.player.update(dt, this.camYaw);
        this.syncBossRoom();
        this.trySealBossRoom();
        this.enemies.update(dt, this.player.pos, this.player.isIframed, this.bossGate());
        this.clampWorld();
        this.vfx.update(dt);
        // 投射物（沙力万矢）：命中走 applyHit → onPlayerHurt 手感档案扇出，可格挡
        this.projectiles.update(dt, this.player.pos, this.player.isIframed, (def, point, dir) => {
          void point;
          this.player.applyHit(def.dmg, dir, null, def.feelKey);
        });
        this.fog.update(this.elapsed);
        for (const sc of this.shortcuts) sc.update(dt);   // T6 捷径动画（封印呼吸/门扇旋开）
        this.bloodstain?.update(this.elapsed);
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
          const allClear = this.progress.defeated.length >= BOSS_ORDER.length;
          $("winStats").textContent =
            `用时 ${this.fmtTime(this.elapsed - this.fightStart)} · 受击 ${this.stats.hitsTaken} · 弹反 ${this.stats.parries} · 处决 ${this.stats.ripostes}`
            + (allClear ? ` · 身陨合计 ${this.progress.stats.deaths} · 拾回魂 ${this.progress.stats.soulRegains} 次` : "");
          $("overlayWin").classList.add("show");
          AU.victoryBell();
          AU.soulGain();
          this.victoryDelay = 999;
        }

        if (this.hintT > 0 && (this.hintT -= rdt) <= 0) $("hint").classList.add("off");

        this.updateCamera(rdt);
        this.updateHud();
        this.renderer.render(this.scene, this.camera);
      } catch (err) {
        console.error(err);
      }
    });
  }
}
