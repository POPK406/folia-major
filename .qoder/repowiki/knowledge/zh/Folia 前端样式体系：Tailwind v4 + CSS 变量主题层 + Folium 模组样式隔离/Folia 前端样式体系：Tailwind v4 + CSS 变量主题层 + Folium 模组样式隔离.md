---
kind: frontend_style
name: Folia 前端样式体系：Tailwind v4 + CSS 变量主题层 + Folium 模组样式隔离
category: frontend_style
scope:
    - '**'
source_files:
    - tailwind.config.js
    - postcss.config.js
    - src/index.css
    - src/services/baseThemes.ts
    - src/utils/themeColorMath.ts
    - src/components/app/presentation/buildAppStyle.ts
    - src/mods/folium/registries/styles.ts
    - docs/folium/api.md
    - mods/README.md
---

## 1. 使用的系统与工具

- **CSS 框架**：Tailwind CSS v4（通过 `@import "tailwindcss"` 引入，而非旧版 `@tailwind base/components/utilities`）。
- **PostCSS 管线**：`postcss.config.js` 使用 `@tailwindcss/postcss` 与 `autoprefixer`。
- **构建入口**：Vite（`vite.config.ts`），Tailwind content 扫描范围在 `tailwind.config.js` 中显式声明。
- **字体资源**：通过 `src/index.css` 中的 `@font-face` 从 jsdmirror CDN 加载 `Folia Noto Serif SC`（400/500），默认字体栈为 `'Inter', sans-serif`。
- **主题系统**：基于 CSS 自定义属性（`--bg-color`、`--text-primary`、`--border-color`、`--transition-glow-color` 等）+ Tailwind 原子类，无 SCSS/Less 预处理链。

## 2. 关键文件

- `tailwind.config.js` — Tailwind 配置，仅扩展 `content` 路径，未自定义 theme/插件。
- `postcss.config.js` — PostCSS 插件注册。
- `src/index.css` — 全局样式入口，声明 Tailwind、`@layer folium-mods`、字体、滚动条、动画、click-through 等。
- `src/services/baseThemes.ts` — 内置双主题常量 `DEFAULT_THEME`（午夜墨染，zinc-950 背景）与 `DAYLIGHT_THEME`（日光素白，stone-100 背景）。
- `src/utils/themeColorMath.ts` — Hex/HSL/RGB 互转、WCAG 对比度计算、色相距离、自动调亮度的对比度求解器。
- `src/hooks/useThemeController.ts` / `src/stores/useThemeSettingsStore.ts` / `src/stores/useThemeQuickEditorStore.ts` — 运行时主题状态与控制器。
- `src/components/app/presentation/buildAppStyle.ts` — 将主题对象映射到 DOM 上的 CSS 变量（如 `--bg-color`）。
- `src/mods/folium/registries/styles.ts` — Folium 模组样式的注入器，包裹在 `@layer folium-mods` 中。
- `docs/folium/api.md`、`mods/README.md` — 文档化模组样式约定。

## 3. 架构与约定

### 3.1 Tailwind v4 + 原子类为主
`tailwind.config.js` 的 `theme.extend` 为空，项目几乎不扩展 Tailwind 预设；样式以组件内联 className 的原子类组合为主。`index.html` 与 `src/**/*.{js,ts,jsx,tsx}` 被纳入扫描，`api/` 与 `local/snt-dev/` 也被包含。

### 3.2 主题通过 CSS 变量驱动
主题数据模型（`Theme` / `DualTheme`）由 `baseThemes.ts` 提供默认值，运行时由 `buildAppStyle.ts` 写入 `style="--bg-color: ...; --text-primary: ..."` 等变量，组件用 `var(--bg-color)`、`color-mix(in srgb, var(--bg-color) 20%, transparent)` 等表达式消费。颜色数学运算集中在 `themeColorMath.ts`，支持 WCAG 对比度校验与自动调亮。

### 3.3 Folium 模组样式隔离层
`src/index.css` 显式声明 `@layer folium-mods;`，并在注释中说明该层位于 Tailwind 各层之后，使模组注入的 CSS 能覆盖宿主样式而无需 `!important`。`src/mods/folium/registries/styles.ts` 把每个模组的 CSS 包裹成 `<style>@layer folium-mods { ... }</style>` 动态注入，随模组卸载移除。`docs/folium/api.md` 与 `mods/README.md` 将此约定文档化。

### 3.4 全局样式组织
`src/index.css` 集中管理：
- 字体加载（Noto Serif SC）
- 全局 body 背景/文字色
- 鼠标指针隐藏（`.cursor-auto-hidden`，利用 Tailwind v4 规则在 `@layer utilities` 中，故无层规则优先级更高）
- 滚动条主题（`--scrollbar-track/thumb/hover` 变量 + `-webkit-scrollbar` 伪元素）
- 主题自适应面板类（`.theme-polaroid-card`、`.theme-glass-panel`，使用 `color-mix` + `!important` 强制覆盖）
- click-through 模式（`html[data-click-through='active']`）
- 多组 `@keyframes`（remote-progress-transition-glow、grid-panel-toggle-hint、ponder-next-cue-*、ponder-skeleton-*）
- 可访问性降级：所有动画均受 `:root[data-reduce-motion~='uiMicroMotion']` 控制，禁用或简化动画。

### 3.5 响应式策略
没有独立的媒体查询断点库；响应式主要通过 Tailwind 原子类（如 `md:`、`sm:` 前缀）实现。`src/index.css` 中仅在滚动条相关处使用 `@media (max-width: 768px)` 做移动端滚动条隐藏。

## 4. 约定与约束

- **模组 CSS 必须放入 `@layer folium-mods`**：由 `docs/folium/api.md` 与 `mods/README.md` 明确约定，并由 `registries/styles.ts` 在注入时自动包裹；测试 `test/unit/mod-system/foliumUiRegistries.test.ts` 断言注入内容包含 `@layer folium-mods`。
- **全局 cursor 隐藏规则不得移入 `@layer`**：`src/index.css` 注释明确要求 `.cursor-auto-hidden` 保持在任何 `@layer` 之外，因为 Tailwind v4 的工具类全在 `@layer utilities` 中，无层规则整体优先于有层规则，这是唯一能压住 18 处 `disabled:cursor-not-allowed` 的方式。
- **主题色只接受 hex**：`themeColorMath.ts` 的 `parseThemeColor` 与 `mixHexColors` 等函数对输入进行 hex 解析，类型定义与注释表明 Theme 颜色字段只接受 hex 字符串。
- **动画需尊重 `data-reduce-motion`**：所有 `@keyframes` 都配套了 `:root[data-reduce-motion~='uiMicroMotion']` 的禁用分支，由 `useMotionSettingsStore.ts` 同步到 `<html data-reduce-motion>`。
- **主题变量命名空间**：应用级变量统一以 `--bg-color`、`--text-primary`、`--border-color`、`--transition-glow-color` 等前缀暴露，组件侧通过 `var()` 与 `color-mix(in srgb, ...)` 消费，避免硬编码颜色。
- **滚动条样式走 CSS 变量**：`::-webkit-scrollbar-thumb` 的颜色通过 `--scrollbar-thumb` 等变量注入，便于主题切换。
- **Tailwind 未扩展主题**：`tailwind.config.js` 的 `theme.extend` 为空，项目不使用 Tailwind 的 spacing/color/fontSize 等设计令牌，而是直接写原子类或 CSS 变量。