# Inferno（工作名）

3D 网页魂类动作游戏，类《黑神话：悟空》同人方向。三人合一（程序+策划+美术）+ AI 辅助开发。

参考项目：[wukong.cnmwx.com](https://wukong.cnmwx.com/)（纯网页、程序化资产、AI 开发的黑猴同人，证明该路线可行）。

## 技术栈（已定稿，见 ADR）

| 层 | 选型 | 决策记录 |
|----|------|----------|
| 平台 | 浏览器网页，链接即玩 | [ADR-0001](docs/adr/0001-web-platform.md) |
| 运行时 | TypeScript + Three.js + Vite，不用游戏引擎 | [ADR-0002](docs/adr/0002-threejs-no-engine.md) |
| 动画管线 | Blender + bpy 生成脚本 + Mixamo 基底 → GLB + JSON 帧数据 | [ADR-0003](docs/adr/0003-blender-bpy-animation-pipeline.md) |
| 战斗架构 | 时序归代码、动画归表现、onHit 总线 | [ADR-0004](docs/adr/0004-combat-timing-in-code.md) |

## 仓库结构

```
├── GLOSSARY.md              # 领域术语表（棍势、识破、削韧……）
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

**设计阶段**。已定：平台、运行时、动画管线、战斗架构。
待定（见讨论）：美术风格、时间预算、联机范围、输入目标 —— 定稿后补 ADR。
