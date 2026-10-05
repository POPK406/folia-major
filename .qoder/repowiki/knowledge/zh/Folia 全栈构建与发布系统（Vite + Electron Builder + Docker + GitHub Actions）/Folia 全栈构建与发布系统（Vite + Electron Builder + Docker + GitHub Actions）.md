---
kind: build_system
name: Folia 全栈构建与发布系统（Vite + Electron Builder + Docker + GitHub Actions）
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - vite.config.ts
    - .github/workflows/electron-release.yml
    - .github/workflows/docker-stack-publish.yml
    - .github/workflows/pr-unit-tests.yml
    - deploy/docker/compose.build.yaml
    - deploy/docker/VERSION
    - deploy/docker/images/gateway.Dockerfile
    - deploy/docker/images/backend.Dockerfile
    - deploy/docker/images/netease-api.Dockerfile
    - deploy/docker/images/kugou-api.Dockerfile
    - deploy/docker/images/qq-api.Dockerfile
    - deploy/docker/images/sync-server.Dockerfile
    - deploy/docker/scripts/validate-version.sh
    - shared/realecoReleaseMetadata.cjs
    - packaging/linux/build-windowtolayer.mjs
    - packaging/windows/build-wallpaper-helper.mjs
    - packaging/ffmpeg/fetch-ffmpeg.mjs
    - sync-server/package.json
---

## 1. 构建系统与工具链

Folia 采用 **Node.js ≥24** 作为统一运行时，围绕 Vite 8 组织前端与 Electron 桌面端的构建，通过 electron-builder 打包多平台安装包，并通过 Docker Compose 编排 Web 后端、API 网关与各音乐平台 API 服务。CI 全部基于 GitHub Actions。

- 前端/桌面端：`vite.config.ts` 定义 React + PWA 构建，输出 `index.html`、`stage-client.html`、`mod-export.html` 三个入口；通过 `define` 注入 `__COMMIT_HASH__`、`__GIT_BRANCH__`、`__APP_VERSION__`、`__APP_VERSION_LABEL__`、`__APP_RELEASE_CHANNEL__`、`__DOCKER_STACK_VERSION__` 等编译期常量。
- Electron 打包：`package.json` 的 `build` 字段配置 electron-builder，产物输出到 `release/`，包含 macOS dmg/zip、Windows NSIS、Linux tar.gz/deb/rpm，并启用 `electron-updater` 自动更新通道。
- 原生辅助二进制：Linux 侧通过 `packaging/linux/build-windowtolayer.mjs` 拉取上游源码并应用 `packaging/linux/patches/windowtolayer-popup-resilience.patch` 编译 `windowtolayer`；Windows 侧通过 `packaging/windows/build-wallpaper-helper.mjs` 编译 `folia-wallpaper-helper.exe`。两者均作为 `extraResources` 打入安装包。
- FFmpeg：通过 `npm run build:ffmpeg`（`packaging/ffmpeg/fetch-ffmpeg.mjs`）下载各平台预编译二进制，放入 `build/ffmpeg/${os}-${arch}` 后由 electron-builder 以 `extraResources` 映射为 `ffmpeg-audio`。
- AUR 包：`packaging/aur/folia-major-bin/PKGBUILD` 配合 `update.sh` 在 CI 中推送至 Arch User Repository。
- 同步服务：`sync-server/` 独立 npm 工程，支持 Cloudflare Workers (`wrangler dev/deploy`) 与 Node (`tsx src/node.ts`) 双运行模式，TypeScript 经 `tsc` 编译。
- API 子项目：`api-ts/` 通过 `npm run build:vercel-api`（`tsc -p api-ts/tsconfig.json`）编译为 Vercel Edge / Cloudflare Workers 可部署的 JS。

## 2. 关键文件

- 根构建脚本：`package.json`（scripts + electron-builder 配置）、`vite.config.ts`、`tsconfig.json`、`.nvmrc`、`.npmrc`
- Electron 打包钩子：`build/beforePack.cjs`、`build/afterPack.cjs`、`build/installer.nsh`
- 原生构建脚本：`packaging/linux/build-windowtolayer.mjs`、`packaging/windows/build-wallpaper-helper.mjs`、`packaging/ffmpeg/fetch-ffmpeg.mjs`
- Docker Compose：`deploy/docker/compose.yaml`、`deploy/docker/compose.build.yaml`、`deploy/docker/compose.sync.yaml`、`deploy/docker/VERSION`
- Dockerfile：`deploy/docker/images/{gateway,backend,netease-api,kugou-api,qq-api,sync-server}.Dockerfile`
- CI 工作流：`.github/workflows/{electron-release,docker-stack-publish,pr-unit-tests,codemap-sync,canary-pre-release,nightly-pre-release,release-candidate,sync-server-docker-publish}.yml`
- 版本校验：`shared/realecoReleaseMetadata.cjs`、`deploy/docker/scripts/validate-version.sh`

## 3. 架构与约定

### 3.1 版本管理

仓库存在两套独立的版本号来源：

- **桌面端 Realeco 发行版**：版本号来自根 `package.json#version`，格式要求稳定 `A.B.C`，由 `.github/workflows/electron-release.yml` 中的 `validateRealecoReleaseMetadata` 校验 commit message 与 `realeco-release` 文件内容，并与 GitHub Releases 上已有 tag 比较，禁止重复或回退。
- **Docker 镜像堆栈**：版本号来自 `deploy/docker/VERSION`，由 `deploy/docker/scripts/validate-version.sh` 校验语义化版本递增；push 到 main 时对比上一个版本的 `deploy/docker/VERSION`，不允许回退。

两个系统的版本号互不相关，分别驱动 Electron 安装包和 Docker 镜像标签。

### 3.2 构建流水线

- **PR 单元测试**（`.github/workflows/pr-unit-tests.yml`）：对 PR 与 main 分支并行执行 `npm run typecheck` 与 `npm run test:unit`（Vitest），并对 `sync-server` 单独做 `npm run build:node`。缓存策略直接缓存 `node_modules/`（而非 `~/.npm`），key 使用 `hashFiles('package-lock.json')`，因为依赖树约 1.4 GB（onnxruntime-node 285 MB + electron 43 dist 313 MB）。
- **Electron 发布**（`.github/workflows/electron-release.yml`）：触发条件为 push `realeco-release` 文件或手动触发。流程：验证版本 → 清理孤立 tag → 在 ubuntu/windows/macos-latest 矩阵上安装 Rust toolchain（仅 Linux/Windows 需要）→ 调用 `packaging/linux/build-windowtolayer.mjs` 与 `packaging/windows/build-wallpaper-helper.mjs` → 用 `TARGET_VERSION` 重写 `package.json#version` 与 `foliaReleaseChannel='realeco'` → `npm run build`（`ELECTRON=true`）→ `electron-builder --publish never --config.publish.channel=latest` → 上传 artifact → 创建/更新 GitHub Draft Release → 可选推送 AUR。
- **Docker 镜像发布**（`.github/workflows/docker-stack-publish.yml`）：仅在 `main` 且 `deploy/docker/VERSION` 变更时触发。`prepare` job 校验分支、版本递增、Docker Hub 凭据，并检查目标 tag 是否已存在（除非 `force_republish=true`）。`build` job 使用 `docker/setup-buildx-action@v4` 在 `ubuntu-24.04` 与 `ubuntu-24.04-arm` 上并发构建 `amd64`/`arm64` 镜像，打上 `${IMAGE}:${VERSION}-${arch}` 标签，并使用 GHA cache scope 按 image+arch 隔离。`promote` job 通过 `docker buildx imagetools create` 将每个镜像同时标记为 `${VERSION}`、`${MAJOR.MINOR}`、`${MAJOR}`、`latest`。
- **Sync Server 发布**：`.github/workflows/sync-server-docker-publish.yml` 走 `wrangler deploy`。

### 3.3 Docker 镜像结构

`deploy/docker/images/` 下每个服务一个 Dockerfile，统一基于 `node:24-alpine` 构建阶段 + 最小 runner 镜像：

- `gateway.Dockerfile`：Vite 构建产物由 Nginx 1.29-alpine 提供，通过 `entrypoint.sh` 渲染 `nginx.conf.template`，反向代理到 backend/netease/kugou/qq API。
- `backend.Dockerfile`：先 `npm ci && tsc -p api-ts/tsconfig.json` 编译 `api-ts/`，再复制 `deploy/docker/backend/server.mjs` 与 `shared/`。
- `netease-api.Dockerfile` / `kugou-api.Dockerfile` / `qq-api.Dockerfile`：各自目录下的 `package.json` 独立安装依赖并启动对应 API。
- `sync-server.Dockerfile`：复用 `sync-server/` 工程的 `wrangler.toml` 或 Node 入口。

Compose 文件 `compose.build.yaml` 将所有服务命名为 `*-local/*:check` 用于本地构建检查，`compose.yaml` 为生产编排。

### 3.4 Electron 产物命名与资源

electron-builder 配置了跨平台 artifactName：

- macOS：`${productName}-${version}-${arch}.${ext}`（dmg + zip，x64/arm64）
- Windows：`${productName}-Setup-${version}.${ext}`（NSIS）
- Linux：`${name}-${version}-linux-${arch}.${ext}`（tar.gz/deb/rpm）

`asarUnpack` 保留 `electron/analysis/htdemucs_runner.py` 与所有 `@koromix/koffi-*/*.node` 原生模块不被压缩进 asar；`extraResources` 注入 FFmpeg、图标、tray 模板、Linux desktop 文件与 windowtolayer。

## 4. 约定与约束

- **Node 版本**：根 `package.json` 与 `sync-server/package.json` 的 `engines.node` 均声明 `>=24.0.0`，CI 的 `setup-node` 固定使用 `node-version: 24`。
- **依赖安装**：CI 统一使用 `npm ci`，根依赖缓存 key 为 `node-modules-ubuntu-latest-node24-${hashFiles('package-lock.json')}`，sync-server 缓存 key 为 `sync-server-node-modules-ubuntu-latest-node24-${hashFiles('sync-server/package-lock.json')}`。
- **Realeco 版本不可重复**：`electron-release.yml` 在 validate 阶段查询 GitHub Releases，若 `v${target}` 已存在且非 draft/pre-release 则拒绝；若最新版本号大于等于当前 target 也拒绝。
- **Docker 版本必须递增**：`docker-stack-publish.yml` 在 push 场景读取上一提交 `deploy/docker/VERSION` 并调用 `validate-version.sh` 比较，不允许回退；默认模式下会 `docker manifest inspect` 检查目标 tag 是否已存在。
- **Docker 发布仅限 main**：`docker-stack-publish.yml` 显式检查 `GITHUB_REF != refs/heads/main` 即退出。
- **Commit 元数据注入**：Vite 构建时优先使用 `VERCEL_GIT_COMMIT_SHA`/`VERCEL_GIT_COMMIT_REF`，否则回退到 `git rev-parse`；当 `REQUIRE_COMMIT_NAME=true` 且无法从 `https://namoe.izuna.top/api/namoe?hash=` 解析出 commit name 时会抛错（Docker 发布流水线强制开启此环境变量）。
- **PWA precache 限制**：`vite-plugin-pwa` 设置 `maximumFileSizeToCacheInBytes: 5000000`，three.js 被拆成独立 chunk 以避免超过 workbox 单文件大小限制；`runtime-config.js` 与 `assets/folium-icons/**` 被加入 `globIgnores`。
- **开发服务器忽略路径**：Vite server watch 显式忽略 `**/release/**` 与 `**/models/**`，注释说明是因为 electron-builder 在 Windows 上重命名临时目录时会被 watcher 句柄阻塞导致 EPERM。
- **Rust 工具链缓存**：Linux 上缓存 `.windowtolayer-src` workspace，Windows 上缓存 `packaging/windows/wallpaper-helper` workspace，使用 `Swatinem/rust-cache@v2`。
- **Docker 镜像标签策略**：每个镜像同时产出 `${VERSION}-${arch}`、`${VERSION}`、`${MAJOR.MINOR}`、`${MAJOR}`、`latest` 五个标签，通过 `imagetools create` 聚合 multi-arch manifests。
- **AUR 推送条件**：仅在 `AUR_SSH_PRIVATE_KEY` 与 `AUR_REPO_SSH_URL` 两个 secret 均已配置时才执行，否则跳过。
- **electron-builder publish**：CI 中显式传入 `--publish never`，实际发布由 workflow 后续步骤通过 `gh release upload` 完成，避免 electron-builder 自行调用 GitHub API。
