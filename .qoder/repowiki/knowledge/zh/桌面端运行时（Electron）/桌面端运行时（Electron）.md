---
kind: external_dependency
name: 桌面端运行时（Electron）
slug: electron
category: external_dependency
category_hints:
    - vendor_identity
scope:
    - '**'
---

Folia 的桌面端基于 Electron 构建，主进程入口为 `electron/main.cjs`，渲染进程通过 `contextIsolation: true` + `nodeIntegration: false` 的安全模型经 preload 暴露能力。桌面端打包使用 electron-builder（NSIS / dmg / tar.gz / deb / rpm），更新通道由 electron-updater 驱动，发布到 GitHub Releases。Node 版本要求 ≥24。