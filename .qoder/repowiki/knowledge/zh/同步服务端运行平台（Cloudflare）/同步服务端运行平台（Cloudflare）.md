---
kind: external_dependency
name: 同步服务端运行平台（Cloudflare）
slug: cloudflare-workers-d1
category: external_dependency
category_hints:
    - vendor_identity
scope:
    - '**'
---

官方可选同步服务端 `sync-server` 推荐以 Cloudflare Workers + D1 免运维部署，也提供 Docker 与 SQLite 自托管变体。前端通过设置中的服务端地址与 `SYNC_TOKEN` 启用跨设备外观/AI 主题库同步。