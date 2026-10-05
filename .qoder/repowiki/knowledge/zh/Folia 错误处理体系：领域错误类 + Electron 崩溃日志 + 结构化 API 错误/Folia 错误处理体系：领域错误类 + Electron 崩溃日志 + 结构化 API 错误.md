---
kind: error_handling
name: Folia 错误处理体系：领域错误类 + Electron 崩溃日志 + 结构化 API 错误
category: error_handling
scope:
    - '**'
source_files:
    - electron/debug/crashLog.cjs
    - electron/stageApi.cjs
    - electron/main.cjs
    - electron/aiTextClient.cjs
    - src/services/sync/syncClient.ts
    - shared/lyricSegmentationService.mjs
    - src/types/onlineMusic.ts
    - src/services/temperaImageArchive.ts
    - src/utils/lyrics/lyricSegmentationRecord.ts
    - src/components/folia-grid/onlineCollectionSync.ts
---

## 1. 总体方案

仓库没有引入第三方错误库（如 Sentry、Pino、tslib），而是采用「轻量自定义 Error 子类 + Electron 原生崩溃捕获 + 结构化 HTTP 错误码」的组合。

- **Electron 主进程**：`electron/debug/crashLog.cjs` 统一注册 `uncaughtException` / `unhandledRejection` / `render-process-gone` / `child-process-gone`，把堆栈写入 `logs/` 目录下的 `crash-<timestamp>.log`，最多保留 20 份，并在非退出路径上弹出对话框提示用户打开文件夹。
- **前端服务层**：每个网络/业务边界定义一个 `extends Error` 的子类，携带语义化字段（HTTP status、code、statusCode）。
- **Stage API（Node HTTP）**：使用统一的 `StageApiError`，所有路由通过 `createStageValidationError` 构造，由调用方根据 `statusCode` / `code` 映射到 JSON 响应。
- **共享 Edge 服务**：`shared/lyricSegmentationService.mjs` 抛出 `SegmentationRequestError`，附带 HTTP status，供 Vercel Edge 与 Cloudflare Worker 两个适配器复用。

## 2. 关键文件与错误类型

| 文件 | 错误类型 / 机制 | 用途 |
|---|---|---|
| `electron/debug/crashLog.cjs` | `createCrashLog` / `installCrashHandlers` | 全局崩溃兜底，写 `crash-*.log`，支持 `announceToUser` / `blocking` 选项 |
| `electron/stageApi.cjs` | `class StageApiError extends Error` | 本地 Stage API 的 HTTP 错误，含 `statusCode`、`code`、`details` |
| `src/services/sync/syncClient.ts` | `class SyncClientError extends Error` | 同步客户端 HTTP 失败，带 `status: number` |
| `shared/lyricSegmentationService.mjs` | `class SegmentationRequestError extends Error` | 歌词分段 LLM 请求失败，带 `status`（400/500/502/504） |
| `src/types/onlineMusic.ts` | `class OnlineProviderError extends Error` | 在线音乐提供者错误 |
| `src/services/temperaImageArchive.ts` | `class TemperaArchiveTooLargeError extends Error` | 图片归档体积超限 |
| `src/utils/lyrics/lyricSegmentationRecord.ts` | `class SegmentationImportError extends Error` | 分段记录导入失败 |
| `src/components/folia-grid/onlineCollectionSync.ts` | `class SyncCancelled extends Error` | 取消同步的哨兵错误 |
| `electron/aiTextClient.cjs` | `describeFetchFailure` / `formatOpenAICompatibleError` | 封装 fetch 超时、Abort、OpenAI 兼容 provider 的错误文本 |
| `electron/main.cjs` | `app.on('certificate-error', ...)` | 仅放行酷狗 CDN 的 CN 不匹配证书，其余一律拒绝 |

## 3. 架构与约定

### 3.1 自定义 Error 子类的命名与字段约定

仓库内可见的自定义错误类遵循一致的形态：

```js
class XxxError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = 'XxxError';   // 显式覆盖 name
    this.status = ...;        // HTTP 状态码（可选）
    this.statusCode = ...;    // HTTP 状态码（StageApiError）
    this.code = ...;          // 业务错误码（StageApiError）
    this.details = ...;       // 附加结构体（StageApiError）
  }
}
```

- `name` 在构造函数中显式赋值为类名，避免 `new Error().name === 'Error'` 的默认行为。
- 网络相关错误普遍暴露 `status` 或 `statusCode`，便于上层按 HTTP 语义区分（如 `SyncClientError`、`SegmentationRequestError`、`StageApiError`）。
- `StageApiError` 额外提供 `code`（如 `STAGE_BODY_TOO_LARGE`、`STAGE_FILE_TOO_LARGE`、`STAGE_PLAY_CANCELED`）和 `details` 对象，作为面向外部工具的机器可读错误码。

### 3.2 Stage API 的错误传播链

`stageApi.cjs` 内部通过工厂函数集中构造错误：

```js
const createStageValidationError = (message, code, details) => (
  new StageApiError(message, { statusCode: 400, code, details })
);
```

- 输入校验失败 → 400 + `STAGE_*_VALIDATION` 类 code。
- 请求体过大 → 413 + `STAGE_BODY_TOO_LARGE` / `STAGE_FILE_TOO_LARGE`。
- 服务端不可用（WebSocket 升级失败、会话清理等）→ 503 + `STAGE_API_ERROR` / `STAGE_PLAY_CANCELED`。
- WebSocket 连接关闭时，遍历 `stagePlayerWebSockets` 逐个 `socket.close(code, reason)`，并 catch 单个 socket 的异常，不影响其他连接。

### 3.3 共享 Edge 服务的错误模型

`shared/lyricSegmentationService.mjs` 将 LLM 调用失败统一包装为 `SegmentationRequestError`，并赋予明确的 HTTP status：

- 缺少 lines → 400
- 行数 > 400 → 400
- 未配置 OPENAI_API_KEY / GEMINI_API_KEY → 500
- 超时（`TimeoutError` / `AbortError`）→ 504
- 模型拒绝 / 空响应 / 解析失败 → 502

该模块同时维护 `readErrorDetail(response)`，从 OpenAI/Gemini 的非标准响应体中提取 `error.message` / `message` / raw text，使错误信息对部署者可观测。

### 3.4 Electron 崩溃日志策略

`electron/debug/crashLog.cjs` 的核心设计要点：

- 启动时探测可写目录：优先 `exe 同级/logs`，回退到 `<userData>/logs`；macOS 永远走 userData，避免破坏签名 bundle。
- 文件名格式 `crash-<ISO timestamp ending Z>[-<n>].log`，按时间 + 后缀排序，只保留最新 KEEP_FILES（20）份。
- `report(kind, detail, { announceToUser, blocking })`：
  - `announceToUser: false`：记录文件但不弹窗（用于 `unhandledRejection`、`child-process-gone`、可恢复的渲染进程崩溃）。
  - `blocking: true`：同步弹窗，仅在即将 exit 的路径上使用（`uncaughtException`）。
- `installCrashHandlers` 注入四个监听器：`uncaughtException`（exit(1)）、`unhandledRejection`（静默记录）、`render-process-gone`（可恢复则不弹窗）、`child-process-gone`（静默记录）。

### 3.5 前端通用错误模式

除上述专用错误类外，`src/services/*.ts` 大量直接使用 `throw new Error(...)` 表达业务不变量被违反（如 `localLibraryEntityMutations.ts` 中的 `Cannot merge different entity kinds`、`Cannot move members between missing entities`），以及 `TypeError` 做参数守卫（如 `audioCache.ts` 的 `Audio cache only accepts Blob values`）。这些错误通常由 React 组件层的 try/catch 捕获后转为 i18n 文案显示。

## 4. 观察到的约定与约束

- **自定义错误类必须继承 `Error` 并显式设置 `this.name`**：所有可见的自定义错误类都遵循这一模式（`StageApiError`、`SyncClientError`、`SegmentationRequestError`、`OnlineProviderError`、`TemperaArchiveTooLargeError`、`SegmentationImportError`、`SyncCancelled`）。
- **网络层错误携带 HTTP status**：`SyncClientError` 的 `status`、`SegmentationRequestError` 的 `status`、`StageApiError` 的 `statusCode` 均由构造参数传入，不是运行时推导。
- **Stage API 的错误码是枚举式的字符串**：`STAGE_BODY_TOO_LARGE`、`STAGE_FILE_TOO_LARGE`、`STAGE_PLAY_CANCELED`、`STAGE_API_ERROR` 等，由 `createStageValidationError` 与直接 `new StageApiError(...)` 两处共同维护。
- **Electron 崩溃报告不可中断播放流程**：`unhandledRejection` 与 `render-process-gone`（recoverable=true）均设置 `announceToUser: false`，只有 `uncaughtException` 才阻塞弹窗并 `app.exit(1)`。
- **证书校验只在酷狗 CDN 放宽**：`main.cjs` 的 `certificate-error` 处理器仅放行 `fs.youthandroid2.kugou.com` 且错误为 `net::ERR_CERT_COMMON_NAME_INVALID` 的请求，其余一律 `callback(false)`。
- **无全局错误上报 SDK**：仓库未发现 Sentry、Bugsnag、Rollbar 等集成；错误诊断依赖 `console.warn/error`、Electron 崩溃日志文件以及 Playwright/Vitest 测试断言。
- **哨兵错误用于控制流**：`SyncCancelled` 是一个空的 `Error` 子类，仅用于区分“用户主动取消”与“真实失败”，调用方通过 `instanceof SyncCancelled` 判断而非错误消息。
- **LLM 请求错误通过 `isAbort(error)` 判定**：基于 `error.name === 'TimeoutError' || error.name === 'AbortError'`，与 Node 的 `AbortSignal.timeout` 返回一致。