---
kind: external_dependency
name: AI 主题生成 — Google Gemini
slug: google-gemini
category: external_dependency
category_hints:
    - vendor_identity
scope:
    - '**'
---

AI 能力首选 Google Gemini（JSON 输出更稳定），通过 `@google/genai` SDK 调用，凭 `GEMINI_API_KEY` 启用。用于根据歌曲情绪与歌词内容生成沉浸式背景与视觉参数。