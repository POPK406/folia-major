---
kind: external_dependency
name: 酷狗音乐音源 SDK
slug: kugou-music-api
category: external_dependency
category_hints:
    - vendor_identity
scope:
    - '**'
---

酷狗音源通过 npm 包 `kugoumusicapi`（直链 `github.com/MakcRe/KuGouMusicApi v1.6.0`）引入。Web 版需用户自行部署 KuGouMusicApi 实例并通过 `VITE_KUGOU_API_BASE` 指向；Electron 版在主进程中直接调用内置 Node 模块，不启动独立 HTTP 服务。自动匹配时位于网易云、QQ 之后的第三回退位。