---
kind: logging_system
name: Client Console Log Capture, Buffering & Debug Sink Pipeline
category: logging_system
scope:
    - '**'
source_files:
    - src/utils/consoleLogBuffer.ts
    - src/utils/consoleLogFilters.ts
    - src/services/debug/debugModule.ts
    - src/components/shared/ConsoleLogPanel.tsx
    - src/components/modal/settings/DeveloperSettingsSubview.tsx
    - src/components/DevDebugOverlay.tsx
    - src/index.tsx
    - docs/client-logging.md
    - test/unit/utils/consoleLogBuffer.test.ts
---

## What is used

Folia does not use a third-party logging framework. The renderer's logging system is built on top of `console.log` / `info` / `warn` / `error` / `debug`, with an early bootstrap step that patches every `console` method and routes each call through an in-memory bounded buffer. A separate debug module acts as a sink that ships buffered lines to the Electron main process for file persistence.

There is no server-side logger in this repository: the Docker backend (`deploy/docker/backend/server.mjs`) and the sync server (`sync-server/src/app.ts`) use plain `console.log`. The structured logging concern therefore applies only to the client/renderer side.

## Key files

- `src/utils/consoleLogBuffer.ts` — core: patches `console`, parses `[Prefix]` scopes, keeps the last 1000 entries, exposes `installConsoleLogCapture()`, `setConsoleLogSink()`, `getConsoleLogEntries()`, `subscribeToConsoleLog()`, `formatConsoleLog()`.
- `src/utils/consoleLogFilters.ts` — persisted mute list (hidden scopes + hidden levels) stored under `console_log_filters` in `localStorage`.
- `src/services/debug/debugModule.ts` — Electron bridge: registers itself as the console log sink via `setConsoleLogSink`, batches lines over IPC (`debugWriteRuntimeLines`), buffers startup lines until the first main-process state answer, supports append/overwrite modes and memory monitoring switches.
- `src/components/shared/ConsoleLogPanel.tsx` — UI panel for reading, searching, filtering, selecting, copying, clearing logs.
- `src/components/modal/settings/DeveloperSettingsSubview.tsx` — settings host exposing capture enable/disable and the debug module switches.
- `src/components/DevDebugOverlay.tsx` — Alt+Shift+D overlay that hosts the Console tab.
- `src/index.tsx` — calls `installConsoleLogCapture()` at app bootstrap so it runs before any other code logs.
- `docs/client-logging.md` — authoritative documentation of the convention and the two entry points (Settings → Developer, Alt+Shift+D).
- `test/unit/utils/consoleLogBuffer.test.ts` — unit tests covering scope parsing and buffer behavior.

## Architecture and conventions

### Patch-and-buffer pipeline

`installConsoleLogCapture()` wraps `console.log/info/warn/error/debug` once. Each call:
1. Formats arguments into a single string (Error objects are expanded to `stack ?? name: message`; circular structures become `[circular]`).
2. Parses the leading `[Scope]` tag via `/^\[([^\]\s]{1,40})\]/` and stores it as `entry.scope`.
3. Appends a `{ id, at, level, text, scope }` entry to an in-memory array capped at `LIMIT = 1000`.
4. Invokes the registered sink (the debug module) if one exists.
5. Notifies subscribers (the panel and overlay) so React can re-render.

It also attaches `window.onerror` and `unhandledrejection` listeners so uncaught exceptions appear in the same buffer even though they never go through `console`.

### Scope convention

Every log line should start with a square-bracketed subsystem name, e.g. `[Prefetch]`, `[KugouProvider]`, `[LocalLibrary]`. The parser treats everything up to the first space or `]` as the scope; lines without a leading tag land under `(untagged)` in the panel. The documented rules are:

- One word, no spaces.
- Name the subsystem, not the file.
- Be consistent across spellings.
- Only at the start of the line.

The buffer records the raw `[Prefix]` in `text` intentionally — stripping it would change the format people already copy-paste from DevTools.

### Levels

Five levels are supported by the patch: `log`, `info`, `warn`, `error`, `debug`. There is no runtime log-level configuration; filtering happens in the UI via the `hiddenLevels` filter persisted in `localStorage`.

### Sinks

`sink` is a function pointer set via `setConsoleLogSink`, deliberately left as a setter rather than an import so the buffer depends on nothing at install time. Two sinks exist:

1. **In-app panel** — reads entries directly via `getConsoleLogEntries()` / `subscribeToConsoleLog()`.
2. **Electron runtime-log sink** — `debugModule.ts` installs itself as the sink, transforms each entry into `{ at, level, tag, text }`, batches them (up to 200 lines or 1 second), and sends them over IPC to the main process which writes to disk. Startup lines are held in a bounded buffer (`STARTUP_MAX = 2000`) until the first `debugGetState` IPC answer arrives, then either flushed or discarded depending on `runtimeLogEnabled`.

### Persistence

- `console_log_capture` in `localStorage`: whether capture is on/off.
- `console_log_filters` in `localStorage`: `{ hiddenScopes: string[], hiddenLevels: ConsoleLevel[] }`.
- Filters persist across sessions and are stored as what is *hidden* (not shown), so newly added modules show up by default instead of being silently filtered out.

### Error handling

Formatting and sink invocation are wrapped in try/catch inside `push()`. The design explicitly tolerates circular structures, DOM nodes, audio nodes, and React fibers in logged arguments — anything thrown by formatting must not break the caller that was logging about the failure.

### Desktop vs browser builds

The packaged desktop build has no DevTools console unless launched under `ELECTRON_DEV`, so the in-memory buffer is essential. In the browser build, `debugModule.ts` is a no-op because there is no main process; the console still works normally and the debug switches render but report the module as unavailable.

## Conventions and constraints

- **Write via native `console.*` methods.** No logger import is needed; the bootstrap patch intercepts them all (`docs/client-logging.md`, `src/utils/consoleLogBuffer.ts`).
- **Start every meaningful line with a `[Subsystem]` tag.** This is the sole mechanism for grouping/filtering logs (`docs/client-logging.md`, `src/utils/consoleLogBuffer.ts` line 31).
- **Tag is one word, no spaces, subsystem-name not filename.** Enforced by the regex `/^\[([^\]\s]{1,40})\]/` and documented in `docs/client-logging.md`.
- **Call `installConsoleLogCapture()` exactly once, as early as possible.** It is idempotent (`installed` flag) and is invoked from `src/index.tsx`; lines logged before installation are not recorded (`src/utils/consoleLogBuffer.ts` lines 159-162, `docs/client-logging.md` line 81).
- **Capture defaults ON.** The switch exists only for users who want to stop the overhead; the comment states "the only defensible default" is on because the packaged desktop build has no console (`src/utils/consoleLogBuffer.ts` lines 66-81).
- **Bounded buffer:** exactly 1000 entries are kept; older ones are dropped (`src/utils/consoleLogBuffer.ts` line 34, 125).
- **Muted scopes/levels persist as hidden lists**, not shown lists, so new modules are visible by default (`src/utils/consoleLogFilters.ts` lines 24-31).
- **Runtime log batching:** IPC messages are batched to at most 200 lines or 1 second latency to avoid flooding the main process during bursts like prefetch (`src/services/debug/debugModule.ts` lines 107-109).
- **Startup lines are buffered until the first main-process state answer**, then either flushed or discarded based on `runtimeLogEnabled` (`src/services/debug/debugModule.ts` lines 115-145).
- **Sinks must not throw back into console.** Any sink failure is swallowed so a failing sink cannot break the original console call (`src/utils/consoleLogBuffer.ts` lines 126-130).
- **No server-side structured logging framework is present** in this repository; server endpoints use plain `console.log`.