/** 调校工作台（ROADMAP M1 末项）：帧数据热调 / 判定可视化 / 慢动作·逐帧 / 参数存档
 *  热调原理：MOVES/P/BOSS/FEEL 均为运行时对象，战斗系统每帧读取 → 面板原地改写即生效（ADR-0004「时序归代码」的红利）
 */
import * as THREE from "three";
import { P, BOSS, MOVES, FEEL, MoveDef, FeelDef, SfxName } from "./config";
import { Player } from "./player";
import type { BossBase } from "./boss-base";

const STORE_KEY = "inferno.tune.v1";

interface Snapshot { P: unknown; BOSS: unknown; MOVES: unknown; FEEL: unknown }
const DEFAULTS = JSON.parse(JSON.stringify({ P, BOSS, MOVES, FEEL })) as Snapshot;

// ---------------- 判定可视化 ----------------

function sectorGeo(arc: number): THREE.BufferGeometry {
  // 扇面中心对准局部 +Z（角色面向），mesh.rotation.y = yaw 即可
  const g = new THREE.RingGeometry(0.5, 1, Math.max(6, Math.ceil(arc * 14)), 1, -arc / 2 - Math.PI / 2, arc);
  g.rotateX(-Math.PI / 2);
  return g;
}
function ringGeo(): THREE.BufferGeometry {
  const g = new THREE.RingGeometry(0.94, 1, 40);
  g.rotateX(-Math.PI / 2);
  return g;
}
function flatMat(color: number, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
}

class Sector {
  readonly mesh: THREE.Mesh;
  private arc = -1;
  constructor(scene: THREE.Scene, private mat: THREE.MeshBasicMaterial) {
    this.mesh = new THREE.Mesh(sectorGeo(1), mat);
    this.mesh.visible = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
  }
  show(pos: THREE.Vector3, yaw: number, range: number, arc: number): void {
    if (Math.abs(arc - this.arc) > 0.02) {   // 弧度变了才重建几何
      this.arc = arc;
      this.mesh.geometry.dispose();
      this.mesh.geometry = sectorGeo(arc);
    }
    this.mesh.position.set(pos.x, 0.05, pos.z);
    this.mesh.rotation.y = yaw;
    this.mesh.scale.setScalar(range);
    this.mesh.visible = true;
  }
  hide(): void { this.mesh.visible = false; }
}

export class DebugViz {
  on = true;
  showBoss = true; showPlayer = true; showIframes = true; showParry = true;
  private bossTel: Sector; private bossAct: Sector; private player: Sector;
  private blade: THREE.Line;
  private shock: THREE.Mesh;
  private iframe: THREE.Mesh;
  private parry: THREE.Mesh;

  constructor(scene: THREE.Scene) {
    this.bossTel = new Sector(scene, flatMat(0xe6c37a, 0.16));
    this.bossAct = new Sector(scene, flatMat(0xff5040, 0.22));
    this.player = new Sector(scene, flatMat(0x66d9e8, 0.18));
    const bladeGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.blade = new THREE.Line(bladeGeo, new THREE.LineBasicMaterial({ color: 0x66d9e8 }));
    this.blade.visible = false;
    this.blade.renderOrder = 6;
    scene.add(this.blade);
    this.shock = new THREE.Mesh(ringGeo(), flatMat(0xff5040, 0.3));
    this.iframe = new THREE.Mesh(ringGeo(), flatMat(0x7a8f4a, 0.55));
    this.parry = new THREE.Mesh(ringGeo(), flatMat(0xe6c37a, 0.5));
    for (const m of [this.shock, this.iframe, this.parry]) { m.visible = false; m.renderOrder = 5; scene.add(m); }
  }

  update(player: Player, boss: BossBase): void {
    // Boss 招式扇面：黄=前摇 telegraph，红=判定帧
    const m = boss.move;
    let shown = false;
    if (this.on && this.showBoss && boss.state === "combat" && m && (boss.sub === "tel" || boss.sub === "act")) {
      const s = boss.sub === "tel" ? this.bossTel : this.bossAct;
      (boss.sub === "tel" ? this.bossAct : this.bossTel).hide();
      s.show(boss.root.position, boss.root.rotation.y, m.range + 0.45, m.arc);
      shown = true;
    }
    if (!shown) { this.bossTel.hide(); this.bossAct.hide(); }

    // 下劈/跳劈冲击环
    if (this.on && this.showBoss && m?.shock && boss.state === "combat" && boss.sub === "act") {
      this.shock.position.set(boss.root.position.x, 0.05, boss.root.position.z);
      this.shock.scale.setScalar(m.shock);
      this.shock.visible = true;
    } else this.shock.visible = false;

    // 玩家这一帧的刃。判定贴着模型走，不再画脚底扇形。
    const line = player.strikeLine;
    if (this.on && this.showPlayer && line) {
      const pos = this.blade.geometry.getAttribute("position") as THREE.BufferAttribute;
      pos.setXYZ(0, line.ax, 0.08, line.az);
      pos.setXYZ(1, line.bx, 0.08, line.bz);
      pos.needsUpdate = true;
      this.blade.geometry.computeBoundingSphere();
      this.blade.visible = true;
      this.player.hide();
    } else { this.blade.visible = false; this.player.hide(); }

    // 翻滚无敌帧
    if (this.on && this.showIframes && player.state === "roll") {
      (this.iframe.material as THREE.MeshBasicMaterial).color.set(player.isIframed ? 0x9bdc58 : 0x4a5058);
      this.iframe.position.set(player.pos.x, 0.06, player.pos.z);
      this.iframe.scale.setScalar(0.62);
      this.iframe.visible = true;
    } else this.iframe.visible = false;

    // 弹反窗口
    if (this.on && this.showParry && player.state === "parry") {
      const [a, b] = player.meta.window;
      const open = player.t >= a && player.t <= b;
      (this.parry.material as THREE.MeshBasicMaterial).color.set(open ? 0xe6c37a : 0x6b6144);
      this.parry.position.set(player.pos.x, 0.06, player.pos.z);
      this.parry.scale.setScalar(0.5);
      this.parry.visible = true;
    } else this.parry.visible = false;
  }
}

// ---------------- 调校面板 ----------------

const $el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

export class Tuning {
  readonly viz: DebugViz;
  visible = false;
  paused = false;
  slowOn = false;
  timeScale = 0.25;
  steps = 0;
  frame = 0;
  frameMs = 16.7;

  private root = $el("div");
  private selMove = "thrust";
  private selFeel = "pR1a";
  private frameLabel = $el("span");
  private loadLabel = $el("span");
  private slowBox!: HTMLInputElement;
  private hudTimer = 0;

  constructor(scene: THREE.Scene, private player: Player, private boss: BossBase) {
    this.viz = new DebugViz(scene);
    this.root.id = "tune";
    document.body.appendChild(this.root);
    this.restore();
    this.render();
  }

  toggle(): void { this.visible = !this.visible; this.root.classList.toggle("on", this.visible); }

  /** 场景旅行/再战换 Boss 后重绑目标（血量上限/招式表/数值热调跟新实例走） */
  retarget(boss: BossBase): void { this.boss = boss; }
  toggleSlow(): void {
    this.slowOn = !this.slowOn;
    this.slowBox.checked = this.slowOn;
  }

  frameTick(rdt: number): void {
    this.frame++;
    this.frameMs += (rdt * 1000 - this.frameMs) * 0.1;   // EMA
    this.hudTimer += rdt;
    if (this.hudTimer > 0.25) {
      this.hudTimer = 0;
      this.frameLabel.textContent = `#${this.frame} · ${this.frameMs.toFixed(1)}ms · ${(1000 / this.frameMs).toFixed(0)}fps${this.paused ? " · ⏸" : ""}${this.steps > 0 ? ` · 步进×${this.steps}` : ""}`;
    }
  }

  updateViz(): void { this.viz.update(this.player, this.boss); }

  private get bossStats(): { hp: number; poiseMax: number; poiseDecay: number; staggerDur: number; staggerMul: number; parriedDur: number; phase2At: number; walkSpeed: number; turnRate: number } {
    return this.boss.stats;
  }

  // ---- DOM 构建 ----
  private render(): void {
    this.root.replaceChildren();
    const h = $el("h3");
    h.textContent = "调校台";
    this.root.append(h, this.row("快捷键", "` 收起 · P 暂停 · → 逐帧 · T 慢动作"));
    this.root.append(this.frameLabel, $el("hr"));

    this.renderPlayback();
    this.renderVizSection();
    this.renderFeelSection();
    this.renderMoveSection();
    this.renderPlayerSection();
    this.renderBossSection();
    this.renderStoreSection();
  }

  private section(title: string): HTMLDetailsElement {
    const d = $el("details");
    d.open = true;
    const s = $el("summary");
    s.textContent = title;
    d.append(s);
    this.root.append(d);
    return d;
  }

  private row(label: string, value: string): HTMLDivElement {
    const r = $el("div", "trow");
    const l = $el("label"); l.textContent = label;
    const v = $el("span"); v.textContent = value;
    r.append(l, v);
    return r;
  }

  /** 滑杆行：get/set 直连目标对象，拖动即热调 */
  private slider(parent: HTMLElement, label: string, get: () => number, set: (v: number) => void, min: number, max: number, step: number): void {
    const r = $el("div", "trow");
    const l = $el("label"); l.textContent = label;
    const right = $el("span", "tval");
    const range = $el("input") as HTMLInputElement;
    range.type = "range"; range.min = String(min); range.max = String(max); range.step = String(step);
    range.value = String(get());
    const num = $el("input", "tnum") as HTMLInputElement;
    num.type = "number"; num.min = String(min); num.max = String(max); num.step = String(step);
    num.value = get().toFixed(step < 0.1 ? 3 : 1);
    const sync = (v: number) => {
      const c = Math.max(min, Math.min(max, v));
      set(c);
      range.value = String(c);
      num.value = c.toFixed(step < 0.1 ? 3 : 1);
    };
    range.addEventListener("input", () => sync(parseFloat(range.value)));
    num.addEventListener("change", () => sync(parseFloat(num.value || "0")));
    right.append(num);
    r.append(l, range, right);
    parent.append(r);
  }

  private check(parent: HTMLElement, label: string, get: () => boolean, set: (v: boolean) => void): void {
    const r = $el("div", "trow");
    const l = $el("label"); l.textContent = label;
    const c = $el("input") as HTMLInputElement;
    c.type = "checkbox"; c.checked = get();
    c.addEventListener("change", () => set(c.checked));
    r.append(c, l);
    parent.append(r);
  }

  private select<T extends string>(parent: HTMLElement, label: string, opts: [T, string][], get: () => T, set: (v: T) => void): void {
    const r = $el("div", "trow");
    const l = $el("label"); l.textContent = label;
    const s = $el("select") as HTMLSelectElement;
    for (const [v, name] of opts) s.add(new Option(name, v, false, v === get()));
    s.addEventListener("change", () => { set(s.value as T); this.render(); });
    r.append(l, s);
    parent.append(r);
  }

  private btn(parent: HTMLElement, label: string, onClick: () => void): void {
    const b = $el("button", "tbtn");
    b.textContent = label;
    b.addEventListener("click", onClick);
    parent.append(b);
  }

  // ---- 各区块 ----
  private renderPlayback(): void {
    const d = this.section("播放");
    const pr = $el("div", "trow");
    const l = $el("label"); l.textContent = "慢动作";
    this.slowBox = $el("input") as HTMLInputElement;
    this.slowBox.type = "checkbox"; this.slowBox.checked = this.slowOn;
    this.slowBox.addEventListener("change", () => { this.slowOn = this.slowBox.checked; });
    pr.append(this.slowBox, l);
    d.append(pr);
    this.slider(d, "速度", () => this.timeScale, v => { this.timeScale = v; }, 0.05, 1, 0.05);
    const steps = $el("div", "trow");
    const l2 = $el("label"); l2.textContent = "逐帧";
    const minus = $el("button", "tbtn"); minus.textContent = "−10";
    const plus = $el("button", "tbtn"); plus.textContent = "+10";
    minus.addEventListener("click", () => { this.steps = Math.max(0, this.steps - 10); });
    plus.addEventListener("click", () => { this.steps = Math.min(600, this.steps + 10); });
    steps.append(l2, minus, plus);
    d.append(steps);
    this.check(d, "暂停（P）", () => this.paused, v => { this.paused = v; });
  }

  private renderVizSection(): void {
    const d = this.section("判定可视化");
    const v = this.viz;
    this.check(d, "总开关", () => v.on, x => { v.on = x; });
    this.check(d, "Boss 招式扇面", () => v.showBoss, x => { v.showBoss = x; });
    this.check(d, "玩家攻击扇面", () => v.showPlayer, x => { v.showPlayer = x; });
    this.check(d, "翻滚无敌帧", () => v.showIframes, x => { v.showIframes = x; });
    this.check(d, "弹反窗口", () => v.showParry, x => { v.showParry = x; });
  }

  private renderFeelSection(): void {
    const d = this.section("手感档案");
    const opts = Object.entries(FEEL).map(([k, f]) => [k, f.label] as [string, string]);
    this.select(d, "档案", opts, () => this.selFeel, v => { this.selFeel = v; });
    const f = FEEL[this.selFeel] as FeelDef & { label: string };
    if (!f) return;
    this.slider(d, "顿帧 s", () => f.hitstop, x => { f.hitstop = x; }, 0, 0.4, 0.005);
    this.slider(d, "震屏", () => f.shake, x => { f.shake = x; }, 0, 1, 0.05);
    this.slider(d, "火花数", () => f.sparks, x => { f.sparks = Math.round(x); }, 0, 60, 1);
    this.slider(d, "火花速度", () => f.sparkSpeed, x => { f.sparkSpeed = x; }, 0, 12, 0.5);
    this.slider(d, "击退", () => f.knockback, x => { f.knockback = x; }, 0, 1.5, 0.05);
    const sfxNames: SfxName[] = ["hitStone", "hitLight", "hitHeavy", "blockHit", "parry", "riposte"];
    this.select(d, "音效组", sfxNames.map(s => [s, s] as [SfxName, string]), () => f.sfx, x => { f.sfx = x; });
  }

  private renderMoveSection(): void {
    const d = this.section("Boss 招式帧数据");
    const opts = Object.values(MOVES).map(m => [m.name, m.label] as [string, string]);
    this.select(d, "招式", opts, () => this.selMove, v => { this.selMove = v; });
    const m = MOVES[this.selMove] as MoveDef;
    if (!m) return;
    this.slider(d, "前摇 s", () => m.startup, x => { m.startup = x; }, 0.05, 2, 0.01);
    this.slider(d, "判定 s", () => m.active, x => { m.active = x; }, 0.05, 0.6, 0.01);
    this.slider(d, "后摇 s", () => m.recovery, x => { m.recovery = x; }, 0.05, 2.5, 0.01);
    this.slider(d, "伤害", () => m.dmg, x => { m.dmg = Math.round(x); }, 1, 80, 1);
    this.slider(d, "距离 m", () => m.range, x => { m.range = x; }, 0.5, 10, 0.1);
    this.slider(d, "弧度", () => m.arc, x => { m.arc = x; }, 0.2, 3.2, 0.05);
    this.slider(d, "冷却 s", () => m.cd, x => { m.cd = x; }, 0, 15, 0.1);
    if (m.lunge !== undefined) this.slider(d, "前冲 m", () => m.lunge ?? 0, x => { m.lunge = x; }, 0, 8, 0.1);
    if (m.shock !== undefined) this.slider(d, "冲击环 m", () => m.shock ?? 0, x => { m.shock = x; }, 0, 8, 0.1);
    this.check(d, "可弹反", () => m.parryable, x => { m.parryable = x; });
  }

  private renderPlayerSection(): void {
    const d = this.section("玩家数值");
    this.slider(d, "走/跑 速度", () => P.walk, x => { P.walk = x; }, 1, 8, 0.1);
    this.slider(d, "疾跑速度", () => P.sprint, x => { P.sprint = x; }, 2, 12, 0.1);
    this.slider(d, "翻滚耗精", () => P.rollCost, x => { P.rollCost = x; }, 0, 50, 1);
    this.slider(d, "轻击耗精", () => P.r1Cost, x => { P.r1Cost = x; }, 0, 40, 1);
    this.slider(d, "重击耗精", () => P.r2Cost, x => { P.r2Cost = x; }, 0, 50, 1);
    this.slider(d, "精力回复/s", () => P.staminaRegen, x => { P.staminaRegen = x; }, 0, 80, 1);
    this.slider(d, "回复延迟 s", () => P.regenDelay, x => { P.regenDelay = x; }, 0, 2, 0.05);
    for (let i = 0; i < 3; i++) {
      this.slider(d, `轻击${i + 1}伤害`, () => P.r1Dmg[i], x => { P.r1Dmg[i] = Math.round(x); }, 1, 40, 1);
    }
    this.slider(d, "重击基础伤", () => P.r2DmgBase, x => { P.r2DmgBase = Math.round(x); }, 1, 60, 1);
    this.slider(d, "处决伤害", () => P.riposteDmg, x => { P.riposteDmg = Math.round(x); }, 1, 200, 1);
    this.slider(d, "攻击倍率", () => P.dmgMul, x => { P.dmgMul = x; }, 0.1, 20, 0.1);
    this.check(d, "两下死（调试）", () => P.godDmg, x => { P.godDmg = x; });
    this.slider(d, "原素瓶回复", () => P.estusHeal, x => { P.estusHeal = x; }, 0.1, 1, 0.05);
    this.slider(d, "预输入窗 s", () => P.bufferWindow, x => { P.bufferWindow = x; }, 0.05, 0.5, 0.01);

    const d2 = this.section("玩家帧数据（动画内窗口）");
    const meta = this.player.meta;
    this.slider(d2, "无敌帧 起", () => meta.iframes[0], x => { meta.iframes[0] = x; }, 0, 0.7, 0.01);
    this.slider(d2, "无敌帧 止", () => meta.iframes[1], x => { meta.iframes[1] = x; }, 0, 0.7, 0.01);
    this.slider(d2, "弹反窗 起", () => meta.window[0], x => { meta.window[0] = x; }, 0, 0.5, 0.01);
    this.slider(d2, "弹反窗 止", () => meta.window[1], x => { meta.window[1] = x; }, 0, 0.5, 0.01);
    this.slider(d2, "后摇取消点", () => meta.cancelFrom, x => { meta.cancelFrom = x; }, 0, 0.9, 0.05);
  }

  private renderBossSection(): void {
    const d = this.section("Boss 数值（当前 Boss）");
    const B = this.bossStats;   // 活实例的数值表：原地改写即时生效（会话级，不进存档）
    this.slider(d, "血量上限", () => B.hp, x => { B.hp = Math.round(x); }, 100, 2000, 10);
    this.slider(d, "削韧上限", () => B.poiseMax, x => { B.poiseMax = x; }, 20, 300, 5);
    this.slider(d, "削韧衰减/s", () => B.poiseDecay, x => { B.poiseDecay = x; }, 0, 40, 1);
    this.slider(d, "破绽时长 s", () => B.staggerDur, x => { B.staggerDur = x; }, 0.5, 6, 0.1);
    this.slider(d, "弹反跪地 s", () => B.parriedDur, x => { B.parriedDur = x; }, 0.5, 6, 0.1);
    this.slider(d, "二阶段阈值", () => B.phase2At, x => { B.phase2At = x; }, 0.01, 0.9, 0.01);
    this.slider(d, "移速", () => B.walkSpeed, x => { B.walkSpeed = x; }, 0.5, 8, 0.1);
    this.slider(d, "转向速率", () => B.turnRate, x => { B.turnRate = x; }, 0.5, 10, 0.1);
  }

  private renderStoreSection(): void {
    const d = this.section("参数存档");
    const btns = $el("div", "trow");
    this.btn(btns, "存档", () => { this.save(); this.loadLabel.textContent = "已保存 " + new Date().toLocaleTimeString(); });
    this.btn(btns, "读取", () => { this.restore(true) && this.render(); });
    this.btn(btns, "导出 JSON", () => this.exportJson());
    this.btn(btns, "恢复默认", () => { this.apply(DEFAULTS); this.render(); this.loadLabel.textContent = "已恢复默认"; });
    d.append(btns);
    const file = $el("input") as HTMLInputElement;
    file.type = "file"; file.accept = ".json"; file.style.display = "none";
    file.addEventListener("change", () => {
      const f = file.files?.[0];
      if (!f) return;
      void f.text().then(txt => {
        try {
          this.apply(JSON.parse(txt) as Snapshot);
          this.render();
          this.loadLabel.textContent = "已导入 " + f.name;
        } catch { this.loadLabel.textContent = "导入失败：JSON 解析错误"; }
      });
    });
    d.append(file);
    this.btn(d, "导入 JSON…", () => file.click());
    d.append(this.loadLabel);
  }

  // ---- 存档 ----
  private snapshot(): Snapshot {
    return JSON.parse(JSON.stringify({ P, BOSS, MOVES, FEEL })) as Snapshot;
  }

  /** 原地套用：保持对象引用不变（Boss/玩家持有的 move 引用继续生效） */
  private apply(s: Partial<Snapshot>): void {
    if (s.P) Object.assign(P, s.P);
    if (s.BOSS) Object.assign(BOSS, s.BOSS);
    if (s.MOVES) for (const [k, v] of Object.entries(s.MOVES)) { if (MOVES[k]) Object.assign(MOVES[k], v); }
    if (s.FEEL) for (const [k, v] of Object.entries(s.FEEL)) { if (FEEL[k]) Object.assign(FEEL[k], v); }
  }

  private save(): void {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.snapshot())); } catch { /* 隐私模式等 */ }
  }

  private restore(verbose = false): boolean {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) { if (verbose) this.loadLabel.textContent = "无存档"; return false; }
      this.apply(JSON.parse(raw) as Snapshot);
      if (verbose) this.loadLabel.textContent = "已读取存档";
      else this.loadLabel.textContent = "启动时已载入存档";
      return true;
    } catch { return false; }
  }

  private exportJson(): void {
    const blob = new Blob([JSON.stringify(this.snapshot(), null, 2)], { type: "application/json" });
    const a = $el("a") as HTMLAnchorElement;
    a.href = URL.createObjectURL(blob);
    a.download = `inferno-tune-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
}
