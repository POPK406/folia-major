---
kind: configuration_system
name: Folia 多运行时配置系统：Vite 构建变量 + Docker 运行时注入 + Electron 进程环境变量
category: configuration_system
scope:
    - '**'
source_files:
    - vite.config.ts
    - src/services/runtimeConfig.ts
    - src/vite-env.d.ts
    - public/runtime-config.js
    - .env.example
    - deploy/docker/.env.example
    - deploy/docker/compose.yaml
    - vercel.json
    - wrangler.jsonc
    - electron/main.cjs
---

## 1. 总体方案

Folia 采用**三层叠加**的配置加载策略，按运行环境区分来源与优先级：

| 层 | 来源 | 作用域 | 读取方式 |
|---|---|---|---|
| 构建期常量 | `vite.config.ts` 中的 `define` | 编译产物（前端 / worker） | 全局常量 `__COMMIT_HASH__`、`__GIT_BRANCH__`、`__APP_VERSION__`、`__APP_VERSION_LABEL__`、`__APP_RELEASE_CHANNEL__`、`__DOCKER_STACK_VERSION__` |
| Vite 构建变量 | `.env*` 中 `VITE_*` 前缀的变量 | Web 构建产物 | `import.meta.env.VITE_*`（如 `VITE_AI_PROVIDER`、`VITE_NETEASE_API_BASE`、`VITE_KUGOU_API_BASE`、`VITE_QQ_API_BASE`） |
| 运行时注入 | `public/runtime-config.js` 暴露 `window.__FOLIA_RUNTIME_CONFIG__` | 浏览器运行时（Docker 部署时由网关动态替换） | `src/services/runtimeConfig.ts` 优先读 `window.__FOLIA_RUNTIME_CONFIG__.aiProvider`，回退到 `import.meta.env.VITE_AI_PROVIDER` |
| Electron 进程环境变量 | `process.env.FOLIA_*` | Electron 主进程及子进程 | `electron/main.cjs` 等直接读取 |
| Docker Compose 环境变量 | `deploy/docker/.env.example` + `compose.yaml` | 各容器服务 | compose 文件内 `${VAR:-default}` 展开 |

## 2. 关键文件

- `vite.config.ts` — 定义 `define` 注入的全局常量、`base`（Electron 下为 `./`）、PWA Workbox globIgnores（排除 `runtime-config.js`）、开发期歌词代理中间件。
- `src/vite-env.d.ts` — 声明 `Window.__FOLIA_RUNTIME_CONFIG__` 类型（`aiProvider?: 'gemini' | 'openai'`）以及所有 Electron IPC 接口类型。
- `src/services/runtimeConfig.ts` — 唯一集中式运行时 AI Provider 解析器，实现“运行时注入 > 构建变量”的降级逻辑。
- `public/runtime-config.js` — 空壳，初始化 `window.__FOLIA_RUNTIME_CONFIG__ = window.__FOLIA_RUNTIME_CONFIG__ || {}`，供 Docker 网关在请求时注入实际值。
- `.env.example` — 客户端侧 `VITE_*` 变量模板（Netease/Kugou/QQ API Base、AI Provider、Gemini/OpenAI Key/URL/Model/Temperature）。
- `deploy/docker/.env.example` + `deploy/docker/compose.yaml` — 服务端侧 `FOLIA_*`、`GEMINI_API_KEY`、`OPENAI_*`、`SYNC_TOKEN`、`DASHBOARD_TOKEN` 等变量模板与默认值。
- `vercel.json` — Vercel 平台路由重写 `/api/qq/:path*` → `/api/qq?path=/:path*`。
- `wrangler.jsonc` — Cloudflare Workers 入口、`assets.run_worker_first: ["/api/*"]`、`define` 注入 `NODE_ENV`/`JEST_WORKER_ID`/`LOG_LEVEL`。
- `electron/main.c` — 大量 `process.env.FOLIA_*` 开关（`FOLIA_LINUX_GRAPHICS_MODE`、`FOLIA_WINDOWTOLAYER_PATH`、`FOLIA_WALLPAPER_HELPER_PATH`、`FOLIA_ANALYSIS_FORCE_CPU`、`FOLIA_FFMPEG_PATH`、`FOLIA_TRANSCODE_FFMPEG_PATH`、`FOLIA_MAC_WALLPAPER_SELFTEST`、`FOLIA_PASSWORD_STORE`、`FOLIA_WRAPPED_BY_WINDOWTOLAYER`、`FOLIA_RELAUNCH`）。

## 3. 架构约定

### 3.1 变量命名空间

- **Web 构建变量**：统一以 `VITE_` 前缀，由 Vite 在构建期注入。消费方通过 `import.meta.env.VITE_*` 访问（见 `src/services/netease.ts`、`src/services/onlineMusic/kugouTransport.ts`、`src/services/onlineMusic/qqTransport.ts`）。
- **运行时注入**：仅 `window.__FOLIA_RUNTIME_CONFIG__` 一个全局对象，当前只承载 `aiProvider`；新增字段需同步更新 `src/vite-env.d.ts` 的类型声明。
- **Electron 进程变量**：统一以 `FOLIA_` 前缀，全部从 `process.env` 读取，不经过任何封装库。
- **Docker 服务变量**：以 `FOLIA_` 或业务语义命名（`QQ_AUTH_SESSION_PATH`、`QQ_SESSION_SECRET`、`SYNC_TOKEN`、`DASHBOARD_TOKEN`），在 `compose.yaml` 中以 `${VAR:-default}` 形式提供默认值。

### 3.2 优先级规则

`src/services/runtimeConfig.ts` 显式定义了 AI Provider 的优先级：

```
window.__FOLIA_RUNTIME_CONFIG__.aiProvider  >  import.meta.env.VITE_AI_PROVIDER
```

即：**运行时注入覆盖构建期变量**。该模式用于让同一份 Web 构建产物在不同部署环境中切换 Gemini/OpenAI，而不需要重新构建。

### 3.3 缺失处理

- `netease.ts`：当 `VITE_NETEASE_API_BASE` 不可用时抛出 `Error("Failed to access environment variables for API base. Please configure VITE_NETEASE_API_BASE.")`。
- `kugouTransport.ts` / `qqTransport.ts`：未配置对应 `VITE_*_API_BASE` 时抛出 `OnlineProviderError('unavailable', 'VITE_*_API_BASE is not configured', provider)`，使在线音乐提供者优雅降级为 unavailable。
- `runtime-config.js`：始终保证 `window.__FOLIA_RUNTIME_CONFIG__` 存在，避免运行时注入为空时的引用错误。

### 3.4 构建期常量

`vite.config.ts` 通过 `define` 注入以下全局常量，类型在 `src/vite-env.d.ts` 中声明：

- `__COMMIT_HASH__`：优先取 `VERCEL_GIT_COMMIT_SHA`，否则 `git rev-parse --short HEAD`，并尝试调用外部 API 解析 commit name。
- `__GIT_BRANCH__`：优先 `VERCEL_GIT_COMMIT_REF`，否则 `git rev-parse --abbrev-ref HEAD`。
- `__APP_VERSION__`：从根 `package.json` 读取。
- `__APP_VERSION_LABEL__`：来自 `APP_VERSION_LABEL` 环境变量，默认 `'Realeco'`。
- `__APP_RELEASE_CHANNEL__`：来自 `APP_RELEASE_CHANNEL`，默认 `'realeco'`。
- `__DOCKER_STACK_VERSION__`：来自 `DOCKER_STACK_VERSION`，默认空串。

当 `REQUIRE_COMMIT_NAME=true` 且无法解析 commit name 时，构建会抛错中止。

### 3.5 PWA 与运行时配置隔离

`vite.config.ts` 中 Workbox 配置显式将 `runtime-config.js` 加入 `globIgnores`，因为 Docker 部署时该文件由网关动态生成，不应被预缓存；同时 `/api/*` 路径加入 `navigateFallbackDenylist`，确保 API 导航不被 SPA shell 拦截。

## 4. 约定与约束

- **所有 Web 可注入配置必须使用 `VITE_` 前缀**：这是 Vite 的硬性约束，非 `VITE_` 前缀的环境变量不会进入 `import.meta.env`（`.env.example` 中所有客户端变量均遵循此约定）。
- **运行时注入字段必须在 `src/vite-env.d.ts` 中声明类型**：`Window.__FOLIA_RUNTIME_CONFIG__` 的类型是强类型的，新增字段需同步扩展类型，否则 TypeScript 会报错。
- **Electron 进程级开关统一使用 `FOLIA_` 前缀**：在 `electron/main.cjs`、`electron/analysis/worker.cjs`、`electron/modSystem/ffmpeg.cjs` 等多处一致地通过 `process.env.FOLIA_*` 读取，无独立配置文件。
- **Docker 部署的每个服务都声明 `healthcheck` 并使用 `read_only: true`**：`compose.yaml` 中所有 service 均启用只读根文件系统 + tmpfs 临时目录 + `security_opt: no-new-privileges:true`，属于强制的安全基线。
- **Compose 中的敏感变量使用 `${VAR:?message}` 语法强制必填**：例如 `SYNC_TOKEN` 要求至少 8 字符，缺少时 compose 启动即失败。
- **在线音乐 API Base URL 缺失时服务降级而非崩溃**：`kugouTransport.ts` 和 `qqTransport.ts` 抛出 `OnlineProviderError('unavailable', ...)`，由上层判断是否可用，而不是直接中断应用启动。
- **AI Provider 选择走单一入口**：`getWebAiProvider()` 是唯一对外暴露的函数，所有消费者应通过它获取 Provider，禁止直接读取 `import.meta.env.VITE_AI_PROVIDER`（已有 `test/unit/services/runtimeConfig.test.ts` 验证运行时注入优先于构建变量的行为）。
- **Vercel 与 Cloudflare Workers 共享同一份代码但通过不同配置入口**：Vercel 通过 `vercel.json` 做路由重写；Cloudflare 通过 `wrangler.jsonc` 的 `assets.run_worker_first` 让 `/api/*` 先走 worker 再回退静态资源。两者都不修改源码，仅通过部署平台配置差异生效。
- **Electron 子进程继承父进程 env 并追加标记位**：壁纸模式子进程通过 `{ ...process.env, FOLIA_WRAPPED_BY_WINDOWTOLAYER: '1', FOLIA_RELAUNCH: '1' }` 传递状态，防止重复包装。

## 5. 不适用场景说明

本仓库不存在传统意义上的集中式配置文件（如 `config.yaml`、`application.properties`、`.json` 配置中心）。所有配置均以环境变量 + 构建期常量的形式存在，因此本卡片聚焦于这一跨运行时的环境变量/构建变量体系。