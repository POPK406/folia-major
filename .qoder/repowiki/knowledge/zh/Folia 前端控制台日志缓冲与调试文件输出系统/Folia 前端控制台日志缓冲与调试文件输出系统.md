---
kind: logging_system
name: Folia 前端控制台日志缓冲与调试文件输出系统
category: logging_system
scope:
    - '**'
source_files:
    - src/utils/consoleLogBuffer.ts
    - src/utils/consoleLogFilters.ts
    - src/services/debug/debugModule.ts
    - electron/preload.cjs
---

## 概述

Folia 的前端（Electron 渲染进程 + Web 构建）没有引入第三方日志框架，而是基于原生 `console.log/warn/error/info/debug` 自建了一套轻量级日志管线：在启动时 patch `console`，将每行日志结构化后写入内存环形缓冲，再通过可选的 sink 路由到 UI 面板或 Electron 主进程的文件落盘。

## 核心文件与职责

- `src/utils/consoleLogBuffer.ts` — 日志采集、格式化、内存缓冲、sink 分发、全局开关；导出 `installConsoleLogCapture`、`setConsoleLogSink`、`getConsoleLogEntries`、`subscribeToConsoleLog`、`clearConsoleLog`、`formatConsoleLog`、`isConsoleCaptureEnabled` / `setConsoleCaptureEnabled`。
- `src/utils/consoleLogFilters.ts` — 持久化“隐藏作用域”和“隐藏级别”过滤器，key 为 `console_log_filters`，遵循项目 localStorage 约定（snake_case key、直接读写、不抛异常）。
- `src/services/debug/debugModule.ts` — 渲染端调试模块：通过 `window.electron.debugGetState/debugSetState/debugWriteRuntimeLines` IPC 与 Electron 主进程通信，把 console 行批量写入主进程管理的运行时日志文件。
- `electron/preload.cjs` — 暴露 `debugGetState`、`debugSetState`、`debugWriteRuntimeLines` 给渲染进程。
- `electron/main.cjs`（及对应 IPC handler）— 接收 `debug-runtime-lines`、`debug-get-state`、`debug-set-state`，负责实际的文件写入与状态管理。

## 架构与约定

### 1. 采集层：patch console + window error
`installConsoleLogCapture()` 一次性替换 `console.log/info/warn/error/debug`，并额外监听 `window.error` 与 `unhandledrejection`，保证未捕获异常也能进入缓冲。默认开启（打包桌面端无 DevTools，必须始终记录），可通过 `localStorage.console_log_capture` 关闭。

### 2. 结构化字段
每条日志被规范化为 `ConsoleLogEntry`：
- `id`: 自增序号
- `at`: `Date.now()` 时间戳
- `level`: `'log' | 'info' | 'warn' | 'error' | 'debug'`
- `text`: 所有参数经 `format()` 序列化后的字符串（循环引用标记为 `[circular]`，Error 对象展开 stack/message）
- `scope`: 从文本开头的 `[Prefix]` 正则提取（如 `[App]`、`[Prefetch]`、`[Lyric API]`），作为子系统标签

### 3. 存储与缓冲
- 内存环形缓冲，上限 `LIMIT = 1000` 条，超出自动截断。
- 每次 push 产生新数组引用，配合 `useSyncExternalStore` 做 React 订阅更新。
- 支持 `setConsoleLogSink` 注册外部 sink（由 `debugModule` 注入），sink 失败不会反噬调用方。

### 4. 过滤与 UI
- `consoleLogFilters.ts` 维护 `hiddenScopes` 与 `hiddenLevels`，默认全部显示；新增子系统不会因“白名单缺失”而被静默隐藏。
- 过滤器持久化到 `localStorage.console_log_filters`，损坏/被阻止时回退为空集。

### 5. 主进程文件落盘（Electron 专属）
`debugModule.ts` 通过 IPC 将 console 行批量发送到主进程：
- 批大小 `BATCH_MAX = 200`，超时 `BATCH_MS = 1000`，避免每行一个 IPC 消息。
- 启动阶段存在 `startupBuffer`（上限 2000 行），在主进程返回开关状态前暂存，再根据最终状态决定丢弃或发送。
- 主进程侧提供 `runtimeFile`、`memoryFile`、`logsRoot` 等路径，支持 append/overwrite 模式。

### 6. 调用点约定
业务代码直接使用原生 `console.*`，并通过 `[ModuleName]` 前缀标注来源，例如：
- `console.error('[buildSettingsDialogModel] Failed to toggle stage mode:', error)`
- `console.warn('[Lattice lyrics] Falling back to the song title', error)`
- `console.log('[Lyric API] Listening on http://127.0.0.1:${port}/v1/lyric.')`
- electron 侧：`console.log('[ai] POST ${apiUrl} model=${model} ...')`、`console.warn('[analysis] worker exited on its own (${code})')`

该 `[Prefix]` 约定是纯代码约定，由 `readScope` 正则解析，不是类型约束。

## 约束与规则

1. **日志采集必须在应用早期安装**：`installConsoleLogCapture()` 注释明确说明“anything logged before this is not recorded”，因此应在 bootstrap 链最前端调用。
2. **sink 不可抛异常**：`push()` 中对 sink 调用包裹 try/catch，确保 sink 故障不影响原始 console 调用。
3. **localStorage 访问一律 try/catch**：`consoleLogBuffer.ts` 与 `consoleLogFilters.ts` 对 `localStorage.getItem/setItem` 均做异常捕获，blocked/full storage 场景下降级为 session-only 行为。
4. **过滤器采用“隐藏列表”语义**：`consoleLogFilters.ts` 显式注释“Deliberately stores what is HIDDEN rather than what is shown”，新增子系统默认可见。
5. **Electron 渲染端日志管道通过 `window.electron` 可选链访问**：浏览器构建中所有 debug 方法为 no-op，`DebugModuleSnapshot.available = false`，UI 仍可渲染但报告 unavailable。
6. **错误与未处理拒绝统一归入 error 级别**：`window.addEventListener('error' | 'unhandledrejection')` 均以 `level: 'error'` 写入缓冲。
7. **日志格式保持人类可读**：`formatConsoleLog()` 输出形如 `HH:mm:ss [level] text`，且刻意保留 `[Prefix]` 前缀不被剥离，以维持用户已习惯的复制粘贴格式。
8. **Electron 主进程日志使用原生 console**：`electron/**/*.cjs` 中直接调用 `console.log/warn`，并以 `[ai]`、`[analysis]`、`[models]`、`[Lyric API]` 等前缀标识子系统，未使用与渲染端相同的缓冲/sink 机制。

## 不适用部分

仓库后端（`sync-server/`、`api/`、`worker/`）未发现统一的日志框架或结构化日志库，其日志方式不在本卡片范围内。