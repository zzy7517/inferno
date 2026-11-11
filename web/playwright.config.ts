import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * T5 尺度探针配置（docs/design/m4-level-flow.md 五、实现切票）
 * webServer 起 vite 5210 独立端口，避免与开发服务器（5173）冲突；
 * reuseExistingServer:false 保证 CI/本地一致——每次从本 worktree 干净起服。
 * 多 agent 并行时 5210 可能被兄弟 worktree 占用（对方 vite 应答→本方采样到别家代码）：
 * PW_PORT=52xx npx playwright test 可换端口。
 * outputDir 指向系统临时目录：测试产物（trace/视频）不落仓库（.gitignore 不在本票改动范围）。
 */
const PORT = Number(process.env.PW_PORT ?? 5210);

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1, // 基线 JSON 由 afterAll 汇总落盘，单 worker 免竞态
  retries: 0,
  reporter: "list",
  outputDir: join(tmpdir(), "inferno-playwright-results"),
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    // SwiftShader 软件 WebGL：CI/无 GPU 环境渲染 three.js 场景采样 DC/三角形
    launchOptions: {
      args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
    },
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
