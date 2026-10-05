---
kind: dependency_management
name: Folia 全栈依赖管理：npm + lockfile + 多子包隔离
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - package-lock.json
    - .npmrc
    - .nvmrc
    - sync-server/package.json
    - sync-server/package-lock.json
    - deploy/docker/backend/package.json
    - deploy/docker/kugou-api/package.json
    - deploy/docker/netease-api/package.json
    - deploy/docker/qq-api/package.json
---

## 1. 使用的系统与工具

- **包管理器**：npm（根目录与每个独立服务各自维护 `package.json` + `package-lock.json`）。
- **Node 版本锁定**：根 `.nvmrc` 声明 `24`，根 `package.json` 的 `engines.node = ">=24.0.0"`，`sync-server/package.json`、`deploy/docker/backend/package.json` 同样声明 `>=24.0.0`，保证所有 Node 子工程使用同一主版本。
- **构建/打包**：Electron 端通过 `electron-builder` 发布到 GitHub Releases；Web API 通过 Vercel Edge / Cloudflare Workers 部署（见 `vercel.json`、`wrangler.jsonc`）。
- **Docker 镜像**：`deploy/docker/images/*.Dockerfile` 为 backend、gateway、kugou-api、netease-api、qq-api、sync-server 分别定义镜像，镜像内各自 `npm ci` 安装对应 `package.json`。

## 2. 关键文件

- 根依赖清单：`package.json`、`package-lock.json`、`.npmrc`、`.nvmrc`
- 同步服务：`sync-server/package.json`、`sync-server/package-lock.json`、`sync-server/wrangler.toml`
- Docker 子服务：
  - `deploy/docker/backend/package.json`
  - `deploy/docker/kugou-api/package.json`
  - `deploy/docker/netease-api/package.json`
  - `deploy/docker/qq-api/package.json`
- Electron 打包配置：根 `package.json` 中 `build.*` 字段（appId、publish、asarUnpack、extraResources、mac/win/linux target）

## 3. 架构与约定

### 3.1 多包隔离
仓库不是单一 npm workspace，而是多个独立的 npm 包：
- 根包 `folia-major`：Electron 桌面端 + React 前端 + Vite 构建入口。
- `sync-server`：Hono 同步服务，同时支持 Cloudflare Workers (`wrangler dev`) 和 Node.js (`tsx src/node.ts`)。
- `deploy/docker/{backend,kugou-api,netease-api,qq-api}`：每个目录一个最小化 `package.json`，只声明该容器需要的运行时依赖，由各自的 `package-lock.json` 锁定。

### 3.2 版本策略
- 生产依赖使用语义化版本范围（如 `^4.40.1`、`^8.21.3`），开发依赖也使用 `^` 或精确版本（如 `typescript: "~7.0.2"`）。
- 根 `package.json` 通过 `overrides` 强制提升部分传递依赖的版本：
  - `@babel/plugin-transform-runtime` → `7.29.7`
  - `qs` → `6.16.0`
  - `three-stdlib.fflate` → `$fflate`（复用根依赖中的 fflate 版本）
  - `@discordjs/rest.undici` → `^6.27.0`
- 对第三方 Git tarball 直接声明 URL：`kugoumusicapi` 指向 `https://github.com/MakcRe/KuGouMusicApi/archive/refs/tags/v1.6.0.tar.gz`，在 Docker 的 `kugou-api/package.json` 中也以相同 URL 重复声明，确保镜像可离线构建。

### 3.3 私有注册表与远程 tarball
- `.npmrc` 显式设置 `registry=https://registry.npmjs.org/` 并关闭 `replace-registry-host`，表明项目不依赖企业私有 npm registry。
- 通过 `allow-remote=root` 允许根 `package.json` 中声明的远程 tarball（即 `kugoumusicapi` 的 GitHub URL）被安装。

### 3.4 原生模块与平台相关依赖
- `onnxruntime-node` 是 Electron 分析子进程的 ONNX Runtime，但 `.npmrc` 中 `onnxruntime-node-install=skip` 跳过其 postinstall（因为项目只申请 WebGPU，失败回退 CPU，不会加载 CUDA/TensorRT 提供器），避免 CI 卡在 NuGet 下载上。
- `electron-builder` 的 `asarUnpack` 明确排除 `node_modules/@koromix/koffi-*/**/*.node`，因为 Koffi 绑定的原生二进制不能打入 asar。
- `extraResources` 将预编译的 `windowtolayer`、`folia-wallpaper-helper.exe`、FFmpeg 等二进制资源随安装包分发。

### 3.5 依赖来源分布
| 位置 | 用途 | 主要依赖 |
|---|---|---|
| 根 `package.json` | Electron 桌面端 + 前端运行时 | electron、react、three、pixi.js、zustand、axios、koffi、onnxruntime-node、ws、electron-store、electron-updater |
| `sync-server/package.json` | 主题/设置同步后端 | hono、better-sqlite3、@hono/node-server |
| `deploy/docker/backend/package.json` | Vercel/Cloudflare 主题生成 API | @google/genai、express |
| `deploy/docker/qq-api/package.json` | QQ 音乐代理 | @yakult-green-tea/qq-music-api |
| `deploy/docker/netease-api/package.json` | 网易云代理 | @neteasecloudmusicapienhanced/api |
| `deploy/docker/kugou-api/package.json` | 酷狗代理 | kugoumusicapi (GitHub tarball) |

## 4. 约定与约束

- **Node 版本**：所有含 `engines.node` 的包均要求 `>=24.0.0`，配合 `.nvmrc` 的 `24`，构成仓库级 Node 版本约束。
- **lockfile 优先**：各子目录均有对应的 `package-lock.json`，Docker 镜像构建脚本应使用 `npm ci`（由 lockfile 驱动确定性安装）。
- **不允许隐式远程源**：除根 `.npmrc` 中 `allow-remote=root` 允许的根级 tarball 外，其他子包的依赖必须来自 npm registry；新增远程 tarball 需显式添加到根 `package.json` 才能被安装。
- **原生二进制不打包进 asar**：`electron-builder.asarUnpack` 规则强制 `@koromix/koffi-*` 的原生模块保持 unpack，这是运行期可加载的前提。
- **平台无关的 onnxruntime-node 安装被禁用**：`.npmrc` 的 `onnxruntime-node-install=skip` 是 CI 可运行的前提，任何绕过该配置的尝试都会导致非 linux/x64 环境挂起。
- **Docker 子服务依赖与根包解耦**：每个 `deploy/docker/*/package.json` 仅声明该容器所需的运行时依赖，避免把 Electron/前端依赖带入镜像。