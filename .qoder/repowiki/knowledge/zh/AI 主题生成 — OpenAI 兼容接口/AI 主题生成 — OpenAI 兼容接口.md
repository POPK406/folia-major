---
kind: external_dependency
name: AI 主题生成 — OpenAI 兼容接口
slug: openai-compatible-api
category: external_dependency
category_hints:
    - vendor_identity
scope:
    - '**'
---

除 Gemini 外还支持任意 OpenAI 兼容接口（如 DeepSeek、ChatGPT），通过 `OPENAI_API_URL` + `OPENAI_API_MODEL` + `OPENAI_API_TEMPERATURE` 配置。通用请求封装在 `shared/openAICompatibleRequest.mjs`。