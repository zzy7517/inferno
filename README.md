# 黑暗之魂3（仓库代号 Inferno）

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
├── GLOSSARY.md              # 领域术语表（不死人/篝火/魂/弹反……）
├── tools/
│   ├── blender/build_character.py   # 角色生成脚本（事实源，ADR-0003）
│   └── inspect_glb.mjs               # GLB 结构自动验证
├── web/                     # Three.js 播放器（M0：管线验证）
└── docs/
    ├── adr/                 # 架构决策记录（0001–0009）
    ├── ROADMAP.md           # 里程碑 M0–M4（M0 ✅）
    └── design/
        └── combat-feel.md   # 打击感设计规范
```

## 开发环境

- Node.js ≥ 20（本机 v24 ✓）
- Blender 最新稳定版（Apple Silicon 原生，headless 脚本 + MCP 双通道由 AI 驱动）
- 磁盘预算 ~3–5 GB（详见各 ADR 背景与 ROADMAP）

## 当前状态

**M0 管线验证完成，M1 战斗垂直切片进行中**（进度见 [ROADMAP](docs/ROADMAP.md)）。已定：DS3 同人定位（ADR-0009）、命名直接复用 DS3 官方名（作品名「黑暗之魂3」，规范词见 [GLOSSARY](GLOSSARY.md)）、美术（ADR-0006）、单机+桌面（ADR-0007）、业余排期、精力制+剑盾（ADR-0008）。
