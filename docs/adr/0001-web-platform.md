---
status: accepted
---

# 目标平台：浏览器网页游戏

游戏以网页为唯一首发平台，打开链接即玩、零安装。参考项目 wukong.cnmwx.com 已证明纯网页可承载魂类动作游戏的完整体验，且链接即玩的传播性对独立开发者价值极高；开发机为 16GB Apple Silicon MacBook、磁盘仅剩 ~17GB，也排除了重型原生引擎工作流（UE5 仅引擎加项目即需 100GB+）。

**Consequences**: 画面与性能上限低于原生平台，靠风格化美术兜底；无应用商店分发，部署为静态托管（成本近零）；输入延迟需专门治理（见 docs/design/combat-feel.md）。
