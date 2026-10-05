---
kind: configuration_system
name: Multi-layer Configuration System (Vite Build-time, Runtime JS Object, Docker Compose Env Vars)
category: configuration_system
scope:
    - '**'
source_files:
    - vite.config.ts
    - .env.example
    - src/services/runtimeConfig.ts
    - public/runtime-config.js
    - src/vite-env.d.ts
    - deploy/docker/compose.yaml
    - deploy/docker/.env.example
    - sync-server/src/node.ts
---

## Overview

Folia uses a three-layer configuration model that separates **build-time** constants, **runtime-overridable** values, and **deployment environment variables** across the Electron renderer, the Dockerized web stack, and the standalone sync server.

## Layer 1 — Vite build-time configuration (`vite.config.ts`)

`vite.config.ts` is the central build-time configuration entry point. It:

- Reads `process.env.VERCEL_GIT_COMMIT_SHA`, `VERCEL_GIT_COMMIT_REF`, `APP_VERSION_LABEL`, `APP_RELEASE_CHANNEL`, `DOCKER_STACK_VERSION`, and `ELECTRON` to shape the build output.
- Injects compile-time globals via the `define` block: `__COMMIT_HASH__`, `__GIT_BRANCH__`, `__APP_VERSION__`, `__APP_VERSION_LABEL__`, `__APP_RELEASE_CHANNEL__`, `__DOCKER_STACK_VERSION__`.
- Sets `base` to `'./'` when `ELECTRON=true` (Electron packaging) and `'/'` otherwise (web deployment).
- Configures PWA behavior through `vite-plugin-pwa`: `registerType: 'autoUpdate'`, Workbox `maximumFileSizeToCacheInBytes: 5000000`, and `globIgnores` that explicitly excludes `**/runtime-config.js` so the runtime config file is never precached by the service worker.
- Defines a dev-only lyric proxy middleware (`devLyricProxyPlugin`) with an allowlist of hostnames (`qq.com`, `*.qq.com`, `y.gtimg.cn`, `kugou.com`, `*.kugou.com`, `kgimg.com`, `amll-ttml-db.stevexmh.net`).

Build-time env vars consumed by the frontend are prefixed with `VITE_` per Vite convention (e.g. `VITE_NETEASE_API_BASE`, `VITE_KUGOU_API_BASE`, `VITE_QQ_API_BASE`, `VITE_AI_PROVIDER`), documented in `.env.example` at the repo root.

## Layer 2 — Runtime-overridable configuration via `window.__FOLIA_RUNTIME_CONFIG__`

The app supports overriding certain values at runtime without rebuilding, specifically for AI provider selection:

- `public/runtime-config.js` initializes `window.__FOLIA_RUNTIME_CONFIG__ = window.__FOLIA_RUNTIME_CONFIG__ || {}` as a no-op default.
- The Docker gateway injects a populated object into this key before the SPA loads.
- `src/services/runtimeConfig.ts` reads it first: `getWebAiProvider()` checks `window.__FOLIA_RUNTIME_CONFIG__.aiProvider`; if absent it falls back to `import.meta.env.VITE_AI_PROVIDER`. It normalizes the value to `'gemini' | 'openai'` (the type alias `WebAiProvider`).
- TypeScript types for the runtime object live in `src/vite-env.d.ts` under `Window`.
- Unit tests in `test/unit/services/runtimeConfig.test.ts` assert both branches (Docker runtime override vs. Vite build-time fallback).

This is the only place where a runtime JS object overrides build-time config; other settings flow directly from environment variables or user preferences stored in the app database.

## Layer 3 — Deployment environment variables

### Docker Compose stack (`deploy/docker/compose.yaml`)

Each service declares its own environment variables:

| Service | Key variables |
|---|---|
| `gateway` | `FOLIA_IMAGE_NAMESPACE`, `FOLIA_HTTP_BIND`, `FOLIA_HTTP_PORT`, `FOLIA_AI_PROVIDER` |
| `backend` | `PORT=3000`, `AI_PROVIDER`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `OPENAI_API_URL`, `OPENAI_API_MODEL`, `OPENAI_API_TEMPERATURE` |
| `netease-api` / `kugou-api` | `HOST`, `PORT`, `FOLIA_FORWARD_CLIENT_IP`, `ENABLE_GENERAL_UNBLOCK` |
| `qq-api` | `PORT`, `QQ_AUTH_STATE_PATH`, `QQ_AUTH_SESSION_PATH`, `QQ_SESSION_SECRET` |
| `sync-server` | `PORT`, `DB_PATH`, `SYNC_TOKEN`, `DASHBOARD_TOKEN`, `FOLIA_SYNC_BIND`, `FOLIA_SYNC_PORT`, `FOLIA_SYNC_DATA_DIR` |

Defaults are declared inline using `${VAR:-default}` syntax (e.g. `FOLIA_HTTP_PORT:-18080`, `FOLIA_AI_PROVIDER:-google`, `OPENAI_API_MODEL:-gpt-5.6-luna`).

User-facing defaults are centralized in `deploy/docker/.env.example`, which documents all deploy-time variables including `FOLIA_IMAGE_NAMESPACE`, `FOLIA_HTTP_BIND`, `FOLIA_HTTP_PORT`, `FOLIA_AI_PROVIDER`, `FOLIA_FORWARD_CLIENT_IP`, `ENABLE_GENERAL_UNBLOCK`, `QQ_AUTH_SESSION_PATH`, `QQ_SESSION_SECRET`, `GEMINI_API_KEY`, `OPENAI_API_*`, `FOLIA_SYNC_*`, `SYNC_TOKEN`, `DASHBOARD_TOKEN`.

### Sync Server Node process (`sync-server/src/node.ts`)

The standalone sync server has its own minimal `.env` loader: it attempts to read `../.env` relative to the module directory, parses each line with a regex `/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/`, strips surrounding quotes, and assigns keys to `process.env`. This is intentionally lightweight — no `dotenv` dependency.

It enforces two hard rules at startup:

1. `SYNC_TOKEN` must be present — otherwise logs `[ERROR] SYNC_TOKEN environment variable is missing.` and calls `process.exit(1)`.
2. `SYNC_TOKEN.length < 8` — otherwise logs `[ERROR] SYNC_TOKEN is too weak. Must be at least 8 characters long.` and calls `process.exit(1)`.

These are enforced by explicit `if` guards followed by `process.exit(1)`.

## Conventions and constraints observed

- Frontend build-time variables use the `VITE_` prefix (Vite convention); they are consumed via `import.meta.env.*`.
- Runtime-overridable values go through `window.__FOLIA_RUNTIME_CONFIG__` rather than a separate JSON file fetched at startup; the current surface is limited to `aiProvider`.
- The PWA Workbox config explicitly ignores `runtime-config.js` (`globIgnores: ['**/runtime-config.js', '**/assets/folium-icons/**']`) so Docker can serve a dynamic version without cache invalidation issues.
- Docker Compose services are `read_only: true` with `tmpfs` mounts for `/tmp` and `/var/cache/nginx`, and use `security_opt: no-new-privileges:true` — secrets come exclusively through `environment:` blocks, not mounted files.
- Secrets (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `QQ_SESSION_SECRET`, `SYNC_TOKEN`, `DASHBOARD_TOKEN`) are always passed as environment variables; no secret files are referenced in compose.
- The sync server's `.env` loader is best-effort wrapped in `try/catch` and silently ignored on failure; required validation happens after loading via explicit `process.exit(1)` checks.
- `.env.example` files exist at both the repo root (for local development) and under `deploy/docker/` (for deployment), but neither is committed with real values — they are templates.