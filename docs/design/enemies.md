# 小怪系统设计：活尸 / 教堂骑士侍从 / 咒腐乌鸦

**定位**：关卡流程的敌人填充 + 战斗系统的背刺/群战体验。与 Boss 拉开量级——无削韧/阶段/弹反，受击即打断；复用 `config.MoveDef` 注册表与 BossBase 的 idle→tel→act→rec 招式节拍，帧数据全部进调校台热调。

**命名空间**：招式键 `hollow* / squire* / crow*` 前缀（对标 `MOVES_VORDT`）；手感档案 `eHollow/eSquire/eCrow/eGuard`。`enemies-config.ts` 模块加载即 `Object.assign` 并入 `config.MOVES / config.FEEL` 总表——调校台与存档自动收录，不改现有文件。

**文件**：`web/src/enemy.ts`（EnemyBase 状态机 + 三种敌人 + EnemyManager）、`web/src/enemies-config.ts`（招式/手感/数值表 + 布怪预设）。game.ts 接线见文末「接线指南」。

---

## 敌人规格

| 敌人 | 场景 | hp | 掉魂 | 定位 | 教学点 |
|------|------|----|------|------|--------|
| 活尸 Hollow | 灰烬墓地 | 40 | 50 | 烂剑单挥+二连，慢速逼近，巡逻 | 基础阅读；**背刺 60（=3×20）直接秒杀** |
| 教堂骑士侍从 Squire | 高墙 | 90 | 120 | 直剑三连 + 盾挡姿态，站桩守位 | 打盾被弹开（格挡硬直）；背刺 60 重创不秒 |
| 咒腐乌鸦 Crow | 高墙 | 30 | 80 | 飞行（y≈1.2 悬停），扑击+俯冲 | 对空时机；背刺 45（=3×15）秒杀 |

## 招式表（帧数据秒；节拍 tel/act/rec 与 BossBase 同构）

### 活尸
| 招式 | 前摇 | 判定 | 后摇 | 伤害 | 距离 | 弧度 | cd | 可弹反 | 备注 |
|------|------|------|------|------|------|------|-----|--------|------|
| hollowSlash 烂剑单挥 | 0.62 | 0.14 | 0.92 | 14 | 2.4 | 1.7 | 2.2 | ✓ | 基础阅读 |
| hollowDouble 烂剑二连 | 0.50 | 0.44 | 1.05 | 10×2 | 2.4 | 1.7 | 3.6 | ✓ | hits=2 / interval 0.24，第二段反手回撩 |

### 教堂骑士侍从
| 招式 | 前摇 | 判定 | 后摇 | 伤害 | 距离 | 弧度 | cd | 可弹反 | 备注 |
|------|------|------|------|------|------|------|-----|--------|------|
| squireCombo 直剑三连 | 0.42 | 0.78 | 1.00 | 8×3 | 2.7 | 1.5 | 4.2 | ✓ | hits=3 / interval 0.22：横斩→回斩→突刺 |
| squireGuard 盾挡姿态 | 0.30 | 1.70 | 0.55 | 0 | — | — | 5.5 | ✗ | **act 窗口内正面受击被弹开**（不掉血，回调 eGuard 手感） |

### 咒腐乌鸦
| 招式 | 前摇 | 判定 | 后摇 | 伤害 | 距离 | 弧度 | cd | 可弹反 | 备注 |
|------|------|------|------|------|------|------|-----|--------|------|
| crowPounce 扑击 | 0.42 | 0.16 | 0.80 | 10 | 2.3 | 1.3 | 3.0 | ✓ | lunge 2.6；贴身（<2.8m）解围，y 压到 0.5 |
| crowDive 俯冲 | 0.50 | 0.20 | 1.05 | 14 | 2.6 | 0.9 | 5.5 | ✓ | lunge 5.5；3.2–9m 触发，先爬升后贴地掠袭（y→0.35） |

## AI 状态机

```
idle（巡逻/站桩）──玩家入 8m 视锥（±fov，贴身 2.2m 全向察觉）──▶ alert（0.45s 转身举械）
combat：sub idle（转向/逼近/选招）→ tel → act（多段判定）→ rec → idle…
combat──玩家远离 16m──▶ idle（回巡逻）
任意──受击致死──▶ dead（瘫倒 0.8s → 沉入地面 1.0s → 摘树移除，onDeath 掉魂）
非判定段 + 背后背刺──▶ backstab（1.2s 硬直，一次 3× 伤害）
```

- **受击打断**：tel/rec 段被打回 idle + 0.22s 硬直（hurtT）；act 段已出招不打断。无削韧表——小怪压制靠 R1 连击即可（DS3 杂兵手感）。
- **选招**：距离 + 冷却过滤 + 权重抽取（`weightedPick`）；招间 0.35s gap 防无缝连发。乌鸦按距离二分：贴身扑击 / 远盘旋俯冲 / 中距悬停等待。
- **前冲（lunge）**：位移放前摇后 60%（`lerpVectors` 到预计算落点，不冲过玩家），act 起点已贴近 → range 判定即真实接触（同 vordtCharge 思路）。

## 背刺规则（`tryBackstab(playerPos, playerYaw)`）

1. 距离 ≤ backstabRange(1.2) + radius；
2. 玩家在敌人**背后 ±40°** 扇区内（`angleWithin(dirYaw, yaw+π, backstabArc)`）；
3. 玩家大致面向敌人（±75°，防背对蹭刀）；
4. 敌人非 combat-act 判定段、非已死/已背刺。

满足 → 一次 `stats.backstabDmg`（= 3× 背刺基准：活尸 60 / 侍从 60 / 乌鸦 45）+ `pRip` 处决级六通道手感；未死则进 1.2s backstab 硬直。玩家侧动画/位移由 game 接线处理（建议复用 riposte 演出）。

## 手感档案（FEEL_ENEMY）

| 键 | 场景 | 顿帧 | 震屏 | 火花 | 击退 | 音效 |
|----|------|------|------|------|------|------|
| eHollow | 活尸斩中玩家 | 0.05 | 0.35 | 8 | 0.35 | hitLight |
| eSquire | 侍从剑中玩家 | 0.06 | 0.42 | 10 | 0.40 | hitLight |
| eCrow | 乌鸦爪中玩家 | 0.04 | 0.30 | 6 | 0.30 | hitLight |
| eGuard | 玩家打盾被弹开 | 0.07 | 0.35 | 14 | 0 | blockHit |

背刺复用现有 `pRip`（处决层级）。`eGuard` 触发时 game 侧应给玩家一个短格挡硬直（接线建议见下）。

## 群战与性能

- **轻量**：每敌 ≤15 网格（活尸 11 / 侍从 13 / 乌鸦 10）；几何/材质**模块级缓存共享**（`GEOS/MATS`），dispose 只摘树不释放（跨实例复用，模块生命周期兜底）。
- **敌间不碰撞**（省性能），**与玩家推挤**：EnemyManager.update 内敌人侧让位（minD = enemy.radius + P.playerRadius，同 boss clampWorld 模式）；玩家侧推挤由 game.clampWorld 对称补一段即可。
- **尸体自理**：dead 1.8s 后自动摘树并移出管理器列表，无需接线清扫。
- 敌人命中玩家统一走 `host.onHitPlayer(dmg, dir, move)` → `player.applyHit(dmg, dir, move)`（move.feel 驱动受击手感、可格挡、翻滚 iframe 生效——update 第三参 playerIframed）。

## game.ts 接线指南（主线程执行；本模块零依赖 game）

```ts
import { EnemyManager } from "./enemy";
// 构造（Game 内）：
this.enemies = new EnemyManager(this.scene, this.vfx, {
  onHit: (feelKey, point) => {            // 敌人被玩家命中：六通道扇出（同 hitBoss 反馈段）
    const f = FEEL[feelKey] ?? FEEL.pR1a;
    this.vfx.sparks.burst(point, f.sparks, f.sparkSpeed, 0.35);
    this.hitstopFor(f.hitstop); this.shake(f.shake);
    this.sfx(f.sfx); PAD.rumble(f.shake * 0.5, f.shake, 90 + f.hitstop * 600);
    if (feelKey === "eGuard") { /* 可选：玩家格挡硬直演出 */ }
  },
  onHitPlayer: (dmg, dir, move) => this.player.applyHit(dmg, dir, move),
  onDeath: souls => { this.player.souls += souls; this.showMsg(`魂 +${souls}`, 1.2, true); this.saveState(); },
  shake: a => this.shake(a),
});
// 布怪（场景搭建处，anchors 自定）：
this.enemies.spawn({ kind: "hollow", facing: Math.PI / 2 }, new THREE.Vector3(x, 0, z));
// 主循环（player.update 之后、clampWorld 之前）：
this.enemies.update(dt, this.player.pos, this.player.isIframed);
// 玩家攻击路由（player.tryHitBoss 同几何；可与 Boss 判定并存）：
this.enemies.tryHit(this.player.pos, this.player.yaw, dmg, poise, feelKey);
// E 键背刺（interact 内，优先级同 tryRiposte）：
if (this.enemies.tryBackstab(this.player.pos, this.player.yaw)) { /* 播处决演出 */ return; }
// 场景切换/篝火休息：this.enemies.clear() 后按关卡表重新 spawn
```

**公开 API 一览**（`web/src/enemy.ts`）：

| 成员 | 签名 | 说明 |
|------|------|------|
| `EnemyManager` | `constructor(scene, vfx, host: EnemyHost)` | 群战编排器 |
| | `spawn(spec: EnemyKind \| EnemySpawnSpec, pos: Vector3): EnemyBase` | 布怪（spec 可带 facing/patrol） |
| | `update(dt, playerPos: Vector3, playerIframed = false): void` | 主更新 + 玩家推挤 + 尸体清扫 |
| | `tryHit(pos, yaw, dmg, poise = 0, feelKey = "pR1a"): { hits; blocked }` | 玩家攻击扇面（距离 2.4+radius / ±63°） |
| | `tryBackstab(playerPos, playerYaw): { dmg; died } \| null` | 背刺入口（最近可背刺目标） |
| | `clear(): void` / `dispose(): void` | 清场摘树 |
| `EnemyBase` | `takeHit(dmg, poise = 0, feelKey?, fromDir?): { died; blocked }` | 受击（blocked=打盾弹开） |
| | `tryBackstab(playerPos, playerYaw): { dmg; died } \| null` | 单敌背刺判定 |
| | `update(dt, playerPos, playerIframed)` / `dispose()` / `hitPoint(out?)` | 单敌驱动/销毁/受击锚点 |
| | `state/sub/move/t/hp/yaw/root/stats/gone` | 全公开（HUD/调试/探针用） |
| `EnemyHost` | `{ onHit, onHitPlayer, onDeath, shake }` | 宿主回调（形状见上） |

## 验证记录（2026-11-12）

- `cd web && npx tsc --noEmit` → **零错**。
- Playwright 探针 `/tmp/npm-probe/enemies-probe.mjs`（import dev server 上的 `/src/enemy.ts`，mock host，1/60 步进）→ **24/24 通过**：
  - ① 三种敌人均 idle→alert→combat 转移 ✓
  - ② hollow 二连 hits=2（总伤 20，段间隔正常）✓
  - ③ squire 盾挡：act 窗口内 takeHit 不掉血（hp 90 保持）、回调 eGuard；窗口外正常掉血（hp 78）✓
  - ④ crow 悬停 y∈[1.15,1.28]；俯冲贴地 y 0.40 且命中；扑击下压 y 0.58 且命中 ✓
  - ⑤ 背刺：正面 ✗ / 背后超距 ✗ / 侧后超角 ✗ / 背后 0.8m ✓（60 伤秒杀 + onDeath(50)）✓
  - ⑥ 三敌齐亡掉魂 [50,120,80]；尸体 3.3s 内自动清列；scene.children 数量复原；dispose 无残留 ✓
  - 附：MOVES/FEEL 并表验证（调校台可见）✓
- 同框摆拍截图：`/tmp/enemies.png`（活尸举剑/侍从举盾/乌鸦悬停，月夜冷调 + 篝火暖光）。
