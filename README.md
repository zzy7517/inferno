# Inferno（工作名）

3D 网页动作游戏，**Dark Souls 3 同人致敬**：网页版黑魂，非商用、免费网页发行。三人合一（程序+策划+美术）+ AI 辅助开发。

技术路线参考：[wukong.cnmwx.com](https://wukong.cnmwx.com/)（纯网页、程序化资产、AI 开发的魂类同人，证明该技术路线可行；仅参考技术，不参考 IP）。

## 技术栈（已定稿，见 ADR）

| 层 | 选型 | 决策记录 |
|----|------|----------|
| 平台 | 浏览器网页，链接即玩 | [ADR-0001](docs/adr/0001-web-platform.md) |
| 运行时 | TypeScript + Three.js + Vite，不用游戏引擎 | [ADR-0002](docs/adr/0002-threejs-no-engine.md) |
| 动画管线 | Blender + bpy 生成脚本 + Mixamo 基底 → GLB + JSON 帧数据 | [ADR-0003](docs/adr/0003-blender-bpy-animation-pipeline.md) |
| 战斗架构 | 时序归代码、动画归表现、onHit 总线 | [ADR-0004](docs/adr/0004-combat-timing-in-code.md) |
| 游戏定位 | DS3 同人致敬，非商用（取代 ADR-0005）| [ADR-0009](docs/adr/0009-ds3-fan-tribute.md) |
| 美术风格 | 暗黑奇幻·冷灰基调 + 火光唯一强调色，风格化渲染 | [ADR-0006](docs/adr/0006-art-style-dark-fantasy.md) |
| 第一版范围 | 纯单机 + 桌面键鼠/手柄优先 | [ADR-0007](docs/adr/0007-v1-scope-singleplayer-desktop.md) |
| 战斗模型 | DS3 式精力制，M1 武器剑盾，弹反→处决 | [ADR-0008](docs/adr/0008-combat-stamina-sword-shield.md) |

## 仓库结构

```
├── GLOSSARY.md              # 领域术语表（前摇/判定帧/削韧/手感档案……）
├── docs/
│   ├── adr/                 # 架构决策记录
│   ├── ROADMAP.md           # 里程碑 M0–M4
│   └── design/
│       └── combat-feel.md   # 打击感设计规范（六通道/数值表/验收标准）
└── (代码于 M0 启动时加入)
```

## 开发环境

- Node.js ≥ 20（本机 v24 ✓）
- Blender 最新稳定版（Apple Silicon 原生，headless 脚本 + MCP 双通道由 AI 驱动）
- 磁盘预算 ~3–5 GB（详见各 ADR 背景与 ROADMAP）

## 当前状态

**设计阶段完成，待启动 M0**。已定：DS3 同人定位与命名（ADR-0009）、美术（ADR-0006）、单机+桌面（ADR-0007）、业余排期、精力制+剑盾（ADR-0008）。
唯一非阻塞待定项：中文正式名。
