# GitHub Release 监控控制台 · UI 设计规范（Material Design 2）

> 本文档是 **Material Design 2（MD2）** 的完整 UI 设计规范，作为 Code Agent 改造
> `index.js` 内联 HTML 模板（`<style>` 段，约第 1174–1320 行）的**唯一输入**。
> 文档只描述「设计意图 + 可直接抄进 `<style>` 的 CSS 规则」，不修改 `index.js`，不含任何 JS 实现。

---

## 0. 阅读前必读（现状对照）

当前 `index.js` 的 `<style>` 实际是 **MD3 风格**，与本项目要求的 MD2 冲突，Code Agent 改造时必须**逐项替换**以下既有写法：

| 现有（MD3，须改） | MD2 目标 |
|---|---|
| `.btn { border-radius: 9999px }`（药丸按钮） | `border-radius: 4px` |
| `.card { border-radius: 16px }` | `border-radius: 8px` |
| `.card` 用 `box-shadow: --md-sys-elevation-1` 且叠加 `border: 1px outline` | 去掉描边，用 `elevation 2` 静止 / `4` hover |
| 变量命名 `--md-sys-color-*`（MD3 命名） | 改为 `--md-*` 命名（见 §2），整段 `:root` 替换 |
| `.btn-tonal` 走 `secondary-container` 浅色块 | 改为「次要强调按钮」（secondary 实色或浅 tint，见 §3.4） |
| `.version` 圆角 `9999px` | 建议改 `4px`（芯片用 MD2 直角/小圆角） |
| 暗色写在独立的 `@media (prefers-color-scheme: dark)` 覆盖块 | 统一进 §6 的暗色变量覆盖 |

**保持不变（绝不改动）**：所有 `onclick="..."`、元素 `id`、`class` 名（`.btn-filled` 等保留以便 drop-in）、中文文案、emoji（💾📥📤🎯🔄🔍 等）、`<script>` 业务逻辑、表格行的 JS 动态拼接结构。

---

## 1. 设计 DNA 与总体原则

- **采用 Google Material Design 2（严格 MD2，非 MD3）**。
- 视觉特征锚点（用于 §7 验收）：
  - **大圆角卡片**（8px，不是 MD3 的 16–28px 超大圆角）；
  - **分层阴影 elevation**（用经典 MD2 双投影写法，不是 MD3 的柔和单层）；
  - **悬浮操作按钮 FAB**（圆形 56dp，右下角固定，elevation 6/8）；
  - **水波纹 ripple**（纯 CSS `::after` 径向缩放，不依赖 JS）；
  - **扁平柔和、克制用色**，主色集中在 AppBar / 主要按钮 / FAB / 链接 / focus 态。
- **明确不是 MD3**：不使用 MD3 的大圆药丸按钮、动态配色（tonal 容器）、大圆角表面、动态色彩角色系统。
- **浅色模式优先**；按 §6 提供基础暗色模式（`prefers-color-scheme: dark`），保持 MD2 观感而非 MD3 暗色。
- 运行形态：Cloudflare Worker 内联 HTML，**无打包器、无框架**，所有样式为**手写 CSS**；字体通过 Google Fonts CDN 引入 **Roboto**（见 §3.1）。

---

## 2. 全局主题 Token（直接抄进 `<style>` 的 `:root`）

> 用下方整段替换现有 `:root { ... }`（含 MD3 命名变量）。所有 hex 均为具体值。

```css
:root {
  /* ============ 配色：MD2 调色板 ============ */
  /* 主色 Primary = Material Blue 700 #1976D2（选择理由见下方说明） */
  --md-primary-50:  #E3F2FD;
  --md-primary-100: #BBDEFB;
  --md-primary-200: #90CAF9;
  --md-primary-300: #64B5F6;
  --md-primary-400: #42A5F5;
  --md-primary-500: #2196F3;
  --md-primary-600: #1E88E5;
  --md-primary-700: #1976D2;   /* 主色基准（AppBar / 主要按钮 / FAB） */
  --md-primary-800: #1565C0;
  --md-primary-900: #0D47A1;
  --md-primary:        #1976D2;          /* 主色实色 */
  --md-on-primary:     #FFFFFF;          /* 主色上的文字 */
  --md-primary-variant:#1565C0;          /* pressed / hover 压暗态 */
  --md-primary-light:  #E3F2FD;          /* hover 浅底 / 信息容器 */

  /* 次要色 Secondary = Material Teal 600 #00897B（与主蓝互补，用于次要强调/导出/测试等） */
  --md-secondary:       #00897B;
  --md-on-secondary:    #FFFFFF;
  --md-secondary-variant:#00796B;

  /* 表面 / 背景 */
  --md-background:   #FAFAFA;   /* 页面底色（浅灰，比纯白更耐看） */
  --md-surface:      #FFFFFF;   /* 卡片/弹窗表面 */
  --md-surface-2:    #F5F5F5;   /* 行 hover、代码块等次级表面 */

  /* 文字 */
  --md-on-background: #212121;  /* 主文字 */
  --md-on-surface:    #212121;  /* 表面上的主文字 */
  --md-on-surface-medium: #5F6368; /* 次要/说明文字 */
  --md-on-surface-disabled: rgba(33,33,33,0.38); /* 禁用文字 */
  --md-on-surface-disabled-bg: rgba(33,33,33,0.12); /* 禁用背景 */

  /* 分割线 / 描边 */
  --md-divider:   #E0E0E0;
  --md-outline:   #BDBDBD;      /* 输入框默认描边 */
  --md-outline-focused: #1976D2;

  /* 错误色 */
  --md-error:       #D32F2F;
  --md-on-error:    #FFFFFF;
  --md-error-light: #FDECEA;     /* 错误容器/提示条 */

  /* ============ 圆角（MD2 风） ============ */
  --radius-card:    8px;   /* 卡片、Dialog */
  --radius-button:  4px;   /* 按钮 */
  --radius-input:   4px;   /* 输入框、select */
  --radius-fab:     50%;   /* FAB 圆形 */
  --radius-chip:    4px;   /* badge / chip / version 标签 */

  /* ============ 间距：8pt 基准网格 ============ */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-7: 28px;
  --space-8: 32px;
  --space-9: 36px;
  --space-10: 40px;
  --space-11: 44px;
  --space-12: 48px;

  /* ============ 排版：Roboto 字号层级（MD2） ============ */
  --font-base: "Roboto", "Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
  --font-mono: "Roboto Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  /* MD2 Type Scale：名称 / 字号 / 行高 / 字重 */
  /* Display 1: 34/40 400; Headline: 24/32 400; Title: 20/28 500;
     Subtitle: 16/24 400; Body1: 14/20 400; Body2: 14/20 500;
     Caption: 12/16 400; Button: 14/20 500; Overline: 12/32 500 大写 */

  /* ============ 阴影（MD2 elevation，经典双投影写法） ============ */
  --elev-0: none;
  --elev-1: 0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.24);
  --elev-2: 0 3px 6px rgba(0,0,0,0.16), 0 3px 6px rgba(0,0,0,0.23);
  --elev-4: 0 10px 20px rgba(0,0,0,0.19), 0 6px 6px rgba(0,0,0,0.23);
  --elev-6: 0 6px 10px rgba(0,0,0,0.16), 0 1px 18px rgba(0,0,0,0.22);  /* FAB */
  --elev-8: 0 14px 28px rgba(0,0,0,0.25), 0 10px 10px rgba(0,0,0,0.22); /* FAB hover */
  --elev-16: 0 16px 24px rgba(0,0,0,0.22), 0 6px 30px rgba(0,0,0,0.30);
  --elev-24: 0 24px 38px rgba(0,0,0,0.25), 0 9px 46px rgba(0,0,0,0.12);  /* Dialog */

  /* ============ 过渡曲线 ============ */
  --ease-standard: cubic-bezier(0.4, 0, 0.2, 1);  /* MD2 standard easing */
  --dur-fast: 150ms;
  --dur-base: 200ms;
}
```

### 主色选择理由
- 选 **Material Blue 700 `#1976D2`** 作为主色：蓝色在后台/运维/监控类产品中传递「信任、稳定、基础设施」的专业感；与 GitHub 品牌黑形成区分又不冲突；白字对比满足 WCAG AA（对比度 > 4.5:1）。
- 这是 **经典 MD2 蓝**（Material Design 规范中的 Blue 700），而非 MD3 的动态主色，契合本规范「严格 MD2」的纪律。
- **次要色选 Teal 600 `#00897B`**：与主蓝互补（蓝+青绿），用于「导出 / 立即测试」等次级强调动作，避免所有按钮都蓝得单调。错误相关统一走 `--md-error`。

---

## 3. 组件改造清单（核心交付物）

> 每条给出可直接抄的 CSS，作用于现有 class。所有规则确保 **不触碰 `<script>`**。

### 3.1 字体引入（`<head>` 内，`<style>` 之前）
在 `<style>` 前加（或复用已有 `<link>` 旁追加）：
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&family=Roboto+Mono:wght@400;500&display=swap" rel="stylesheet">
```

### 3.2 AppBar（顶部应用栏）【建议新增】
当前 `.app-header` 只是居中文字标题（`<h1>🔍 GitHub Release 监控</h1>` + 时钟），**没有 MD2 AppBar**。建议改造为 MD2 顶部应用栏：固定高度、elevation 4、primary 背景（或 surface + 底部分割线）。

**Markup 建议（Code Agent 可微调，但保留原文字与 emoji）**：
```html
<header class="md-appbar">
  <span class="md-appbar__title">🔍 GitHub Release 监控</span>
  <div class="md-appbar__actions">
    <span class="md-appbar__clock" id="clock">北京时间 --:--:--</span>
  </div>
</header>
```
> 若不想新增 class，可直接给现有 `.app-header` 套以下样式（不破坏其内部结构）。

**CSS（MD2 AppBar，surface + 底部分割线版，克制专业）**：
```css
.md-appbar {
  position: sticky; top: 0; z-index: 100;
  height: 56px;                      /* MD2 标准 AppBar 高度（桌面可 64px） */
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 var(--space-4);
  background: var(--md-surface);
  border-bottom: 1px solid var(--md-divider);
  box-shadow: var(--elev-4);
  margin: calc(-1 * var(--space-2)) calc(-1 * var(--space-4)) var(--space-6); /* 抵消 body padding 满宽 */
  color: var(--md-on-surface);
}
.md-appbar__title { font-size: 20px; font-weight: 500; line-height: 28px; }
.md-appbar__clock { font-size: 13px; color: var(--md-on-surface-medium); }

/* 若偏好「primary 实色 AppBar」版本，改用： */
/* .md-appbar { background: var(--md-primary); color: var(--md-on-primary); border-bottom: none; } */
/* .md-appbar__clock { color: rgba(255,255,255,0.8); } */
```
> 原 `.app-header h1 { color: primary }` 的居中大标题样式可删除或并入 `.md-appbar__title`。`.subtitle`（时钟）现已被移入 AppBar 右侧；若保留原 `.subtitle` 用法，请同步调整。

### 3.3 Card（MD2 卡片）
替换原有 `.card`（去掉描边，统一 elevation，8px 圆角，hover 上浮）：
```css
.card {
  background: var(--md-surface);
  border-radius: var(--radius-card);     /* 8px，原为 16px */
  padding: var(--space-6);               /* 24px */
  margin-bottom: var(--space-6);        /* 24px */
  box-shadow: var(--elev-2);            /* 静止 elevation 2，原为 elevation-1 + border */
  border: none;                         /* 移除原 outline-variant 描边 */
  transition: box-shadow var(--dur-base) var(--ease-standard),
              transform var(--dur-base) var(--ease-standard);
}
.card:hover {
  box-shadow: var(--elev-4);            /* hover elevation 4 */
  transform: translateY(-2px);          /* 轻微上移 */
}
.card h2 { font-size: 20px; font-weight: 500; line-height: 28px; margin-bottom: var(--space-4); }
.card h3 { font-size: 16px; font-weight: 500; line-height: 24px; margin-bottom: var(--space-2); }
```

### 3.4 Button（三级按钮 + error）
> **关键：去掉 `border-radius: 9999px`，改 4px；加 hover/active/focus-visible/disabled。**
> 原 `.btn-error` 保留为「危险按钮」变体。`.btn-tonal` 在 MD2 下定义为**次要强调按钮**（secondary 实色），不用 MD3 tonal 浅容器。

```css
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--space-1);
  height: 40px;                            /* MD2 标准按钮高度 36–40dp */
  min-width: 64px;
  padding: 0 var(--space-6);               /* 左右 24px */
  border-radius: var(--radius-button);     /* 4px，原为 9999px */
  border: none;
  font-family: var(--font-base);
  font-size: 14px; font-weight: 500; line-height: 20px;
  letter-spacing: 0.5px;
  text-transform: none;                    /* 中文不强制大写 */
  cursor: pointer;
  user-select: none;
  position: relative; overflow: hidden;    /* 配合 §3.13 ripple */
  transition: box-shadow var(--dur-base) var(--ease-standard),
              background-color var(--dur-fast) var(--ease-standard),
              transform var(--dur-fast) var(--ease-standard);
}

/* Filled / Contained（主要按钮：保存、添加、导入） */
.btn-filled {
  background: var(--md-primary);
  color: var(--md-on-primary);
  box-shadow: var(--elev-2);
}
.btn-filled:hover { box-shadow: var(--elev-4); }
.btn-filled:active { background: var(--md-primary-variant); transform: scale(0.97); }

/* Tonal → MD2 次要强调按钮（secondary 实色，用于导出/测试等） */
.btn-tonal {
  background: var(--md-secondary);
  color: var(--md-on-secondary);
  box-shadow: var(--elev-1);
}
.btn-tonal:hover { background: var(--md-secondary-variant); box-shadow: var(--elev-2); }
.btn-tonal:active { transform: scale(0.97); }

/* Outlined（描边按钮：触发新一轮检测） */
.btn-outlined {
  background: transparent;
  color: var(--md-primary);
  border: 1px solid var(--md-outline);
  box-shadow: none;
}
.btn-outlined:hover { background: var(--md-primary-light); border-color: var(--md-primary); }
.btn-outlined:active { background: var(--md-primary-100); transform: scale(0.97); }

/* Error（危险：删除仓库，原 .btn-error 保留） */
.btn-error {
  background: var(--md-error);
  color: var(--md-on-error);
  box-shadow: var(--elev-1);
}
.btn-error:hover { box-shadow: var(--elev-2); }
.btn-error:active { background: #B71C1C; transform: scale(0.97); }

/* 通用焦点环 / 禁用（所有 .btn 适用） */
.btn:focus-visible {
  outline: 2px solid var(--md-primary);
  outline-offset: 2px;
}
.btn:disabled,
.btn[disabled] {
  background: var(--md-on-surface-disabled-bg) !important;
  color: var(--md-on-surface-disabled) !important;
  box-shadow: none !important;
  opacity: 1;                  /* 用底色+文字色表达禁用，而非单纯 opacity */
  pointer-events: none;
  cursor: not-allowed;
}
```
> 表格内的 `.delete-repo-btn` 现用 `style="height:32px;padding:0 12px;font-size:0.7rem;"` 内联覆盖——保留即可，其 `.btn .btn-error` 样式已生效。如需统一可改为 `.btn--sm` 工具类，但不强制。

### 3.5 TextField（输入框，MD2 outlined 风格）
替换 `.input` 为 MD2 outlined 文字字段：默认 1px 描边、focus 时 primary 描边加粗、56dp 高（桌面）；内联的小 number/time 用 `--compact` 变体适配。
```css
.input {
  height: 56px;                          /* MD2 outlined 字段标准 56dp */
  padding: 0 var(--space-3);
  border: 1px solid var(--md-outline);
  border-radius: var(--radius-input);    /* 4px */
  background: var(--md-surface);
  color: var(--md-on-surface);
  font-family: var(--font-base);
  font-size: 14px; line-height: 20px;
  outline: none;
  transition: border-color var(--dur-fast) var(--ease-standard),
              box-shadow var(--dur-fast) var(--ease-standard);
}
.input::placeholder { color: var(--md-on-surface-medium); }
.input:hover { border-color: var(--md-on-surface); }
.input:focus {
  border-color: var(--md-primary);
  border-width: 2px;                     /* focus 加粗 */
  padding: 0 calc(var(--space-3) - 1px); /* 抵消 1px 边框变化，避免跳动 */
}
.input:disabled { background: var(--md-surface-2); color: var(--md-on-surface-disabled); border-color: var(--md-divider); }

/* 内联紧凑型（number / time 等小字段，避免 56px 过高） */
.input--compact { height: 40px; }

/* select 复用 .input 样式即可；下拉箭头保留原生 */
select.input { padding-right: var(--space-6); appearance: none;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><path fill='%235F6368' d='M7 10l5 5 5-5z'/></svg>");
  background-repeat: no-repeat; background-position: right 8px center; }

/* 多行代码/模板 textarea（MD2 outlined 版，原 textarea 改造） */
textarea {
  width: 100%; min-height: 180px;
  font-family: var(--font-mono); font-size: 13px; line-height: 20px;
  padding: var(--space-3);
  border: 1px solid var(--md-outline);
  border-radius: var(--radius-input);
  background: var(--md-surface);
  color: var(--md-on-surface);
  resize: vertical; outline: none;
}
textarea:focus { border-color: var(--md-primary); border-width: 2px; padding: calc(var(--space-3) - 1px); }

/* 备注内联输入框 .note-input（表格内，紧凑 outlined） */
.note-input {
  width: 100%; min-width: 120px; box-sizing: border-box;
  height: 36px; padding: 0 var(--space-2);
  border: 1px solid var(--md-outline); border-radius: var(--radius-input);
  background: var(--md-surface); color: var(--md-on-surface);
  font-size: 13px; outline: none;
  transition: border-color var(--dur-fast) var(--ease-standard);
}
.note-input:focus { border-color: var(--md-primary); border-width: 2px; padding: 0 calc(var(--space-2) - 1px); }
```

### 3.6 Table（MD2 数据表）
替换 `table / th / td / tbody tr`，行高 52dp、行间分割线、表头大写、行 hover 高亮、状态 badge 内联（badge 见 §3.11）。
```css
.table-wrapper { overflow-x: auto; margin: 0 calc(-1 * var(--space-2)); padding: 0 var(--space-2); }
table { width: 100%; border-collapse: collapse; font-size: 14px; min-width: 600px; }
th {
  height: 52px; text-align: left; padding: 0 var(--space-3);
  border-bottom: 1px solid var(--md-divider);
  font-size: 12px; font-weight: 500; line-height: 16px;
  letter-spacing: 0.5px; text-transform: uppercase;
  color: var(--md-on-surface-medium);
}
td {
  height: 52px; padding: 0 var(--space-3);
  border-bottom: 1px solid var(--md-divider);
  color: var(--md-on-surface); vertical-align: middle;
}
tbody tr { transition: background-color var(--dur-fast) var(--ease-standard); }
tbody tr:hover { background: var(--md-surface-2); }
```
> 状态列内 `<code>`（通知链接）沿用：`code { background: var(--md-surface-2); padding: 2px 6px; border-radius: 4px; font-family: var(--font-mono); font-size: 12px; }`。

### 3.7 Tabs（标签）【可选增强】
现有 markup **没有** tab，列为可选增强。若后续增加，使用 MD2 下划线指示器：
```css
.md-tabs { display: flex; border-bottom: 1px solid var(--md-divider); }
.md-tab {
  height: 48px; padding: 0 var(--space-6); border: none; background: transparent;
  font-size: 14px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px;
  color: var(--md-on-surface-medium); cursor: pointer; position: relative;
}
.md-tab--active { color: var(--md-primary); }
.md-tab--active::after {
  content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;
  background: var(--md-primary);
}
```

### 3.8 FAB（悬浮操作按钮）【建议新增】
现有模板**没有** FAB。MD2 中 FAB 适合承载「全局主操作」。本控制台最合适的主操作是 **「➕ 添加仓库」**（当前在卡片内）或 **「🎯 立即测试」**。建议把 **「➕ 添加仓库」** 升级为右下角 FAB（主色、圆形、elevation 6/8）。

**Markup 建议**（保留原 `addRepo()`，可选用 `onkeydown` 回车）：
```html
<button class="md-fab" title="添加监控仓库" onclick="document.getElementById('repoInput').focus()">➕</button>
```
**CSS**：
```css
.md-fab {
  position: fixed; right: var(--space-6); bottom: var(--space-6);
  width: 56px; height: 56px; border-radius: var(--radius-fab);   /* 圆形 */
  display: flex; align-items: center; justify-content: center;
  background: var(--md-primary); color: var(--md-on-primary);
  border: none; cursor: pointer; font-size: 24px;
  box-shadow: var(--elev-6);                                     /* elevation 6 */
  transition: box-shadow var(--dur-base) var(--ease-standard),
              transform var(--dur-fast) var(--ease-standard),
              background-color var(--dur-fast) var(--ease-standard);
  z-index: 200;
}
.md-fab:hover { box-shadow: var(--elev-8); background: var(--md-primary-600); }
.md-fab:active { transform: scale(0.96); background: var(--md-primary-variant); }
.md-fab:focus-visible { outline: 2px solid var(--md-primary); outline-offset: 3px; }
```
> 决策：建议加 FAB（承载「添加仓库」），但**保留原卡片内「➕ 添加新监控项目」卡片不删除**（FAB 仅作快捷入口，避免移除既有功能）。若 Code Agent 评估风险，可先只加样式、暂不挂 FAB。

### 3.9 Dialog / Snackbar（弹窗 / 提示条）【样式方案，JS 不改】
现有 `<script>` 仍用 `alert()` / `confirm()`（如保存失败、删除确认）。**本规范不修改 JS**，因此 `alert/confirm` 继续原生工作。下方提供可替换的 MD2 样式方案，供后续「若 Code Agent 被允许改写 JS」时平滑替换。

**MD2 Dialog（elevation 24 + scrim）**：
```css
.md-scrim {
  position: fixed; inset: 0; background: rgba(0,0,0,0.32);
  display: flex; align-items: center; justify-content: center; z-index: 1000;
}
.md-dialog {
  min-width: 280px; max-width: 560px; background: var(--md-surface);
  border-radius: var(--radius-card);   /* 8px */
  box-shadow: var(--elev-24);
  padding: var(--space-6) var(--space-6) var(--space-4);
}
.md-dialog__title { font-size: 20px; font-weight: 500; line-height: 28px; margin-bottom: var(--space-3); }
.md-dialog__body { font-size: 14px; line-height: 20px; color: var(--md-on-surface-medium); }
.md-dialog__actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-5); }
```

**MD2 Snackbar（底部提示条，可替代部分成功提示）**：
```css
.md-snackbar {
  position: fixed; left: 50%; bottom: var(--space-6); transform: translateX(-50%) translateY(20px);
  min-width: 288px; max-width: 568px;
  background: #323232; color: #FFFFFF;     /* MD2 snackbar 经典深底 */
  padding: var(--space-2) var(--space-4); border-radius: 4px;
  box-shadow: var(--elev-6); font-size: 14px; line-height: 20px;
  opacity: 0; pointer-events: none;
  transition: opacity var(--dur-base) var(--ease-standard), transform var(--dur-base) var(--ease-standard);
  z-index: 1100;
}
.md-snackbar--show { opacity: 1; transform: translateX(-50%) translateY(0); }
```
> 现有保存成功提示用 `<span id="settingsSaved">✅ 已保存</span>`（行内显示），可保留；如需统一为 snackbar，需改 JS，超出本规范范围。

### 3.10 Drawer（侧边抽屉）【可选增强】
现有单页控制台暂不需要；若后续功能增多，给出 MD2 navigation drawer 样式：
```css
.md-drawer {
  position: fixed; top: 0; left: 0; bottom: 0; width: 256px;
  background: var(--md-surface); box-shadow: var(--elev-16);
  padding: var(--space-2) 0; z-index: 300;
  transform: translateX(-100%); transition: transform var(--dur-base) var(--ease-standard);
}
.md-drawer--open { transform: translateX(0); }
.md-drawer__item {
  display: flex; align-items: center; gap: var(--space-4);
  height: 48px; padding: 0 var(--space-4); color: var(--md-on-surface);
  font-size: 14px; cursor: pointer; border: none; background: transparent; width: 100%; text-align: left;
}
.md-drawer__item--active { background: var(--md-primary-light); color: var(--md-primary); font-weight: 500; }
```

### 3.11 Badge / Chip（状态标签）
现有 `.badge` / `.badge-ok/-warn/-dead/-recov` 保留 class 名，改为 MD2 小圆角芯片（4px，非 MD3 大圆角），文字保持原中文（正常/异常/失效/观察中）：
```css
.badge {
  display: inline-block; padding: 3px 10px;
  border-radius: var(--radius-chip);        /* 4px */
  font-size: 11px; font-weight: 500; line-height: 16px;
  letter-spacing: 0.4px; text-transform: none;
}
.badge-ok    { background: #E6F4EA; color: #1E7A34; }
.badge-warn  { background: #FEF7E0; color: #B26A00; }
.badge-dead  { background: #FCE8E6; color: #C5221F; }
.badge-recov { background: #FFFDE7; color: #8A6D00; }
```
> 暗色下覆盖（见 §6）。`.version` 标签（顶部版本号）同样用 `.badge` 风格即可，或保留独立小圆角。

### 3.12 Loading / Skeleton（加载）
现有 `loadingText`（⏳ 提示）与按钮 `disabled` 态已覆盖基本反馈。补充 MD2 按钮 loading 态与脉冲动画：
```css
/* 按钮 loading：禁用 + 旋转环（纯 CSS，不改 JS，由 .is-loading 类触发，若 JS 愿意加类） */
.btn.is-loading { color: transparent !important; pointer-events: none; position: relative; }
.btn.is-loading::before {
  content: ""; position: absolute; width: 18px; height: 18px;
  border: 2px solid currentColor; border-top-color: transparent;
  border-radius: 50%; animation: md-spin 0.7s linear infinite;
}
@keyframes md-spin { to { transform: rotate(360deg); } }

/* 骨架屏占位（可选，用于表格/卡片加载） */
.md-skeleton {
  background: linear-gradient(90deg, #EEEEEE 25%, #E0E0E0 37%, #EEEEEE 63%);
  background-size: 400% 100%;
  animation: md-shimmer 1.4s ease infinite; border-radius: 4px;
}
@keyframes md-shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
@media (prefers-color-scheme: dark) {
  .md-skeleton { background: linear-gradient(90deg, #2A2A2A 25%, #3A3A3A 37%, #2A2A2A 63%); background-size: 400% 100%; }
}
```

### 3.13 Ripple（水波纹，纯 CSS）
**不依赖 JS**，用 `::after` + `:active` 径向渐变缩放实现，挂载在所有 `.btn` / `.md-fab` / `.md-tab` 上（已在 §3.4 给 `.btn` 加了 `position:relative; overflow:hidden`）。
```css
.btn::after, .md-fab::after, .md-tab::after, .md-drawer__item::after {
  content: ""; position: absolute;
  left: var(--ripple-x, 50%); top: var(--ripple-y, 50%);
  width: 8px; height: 8px; border-radius: 50%;
  background: currentColor; opacity: 0;
  transform: translate(-50%, -50%) scale(1);
  pointer-events: none;
}
.btn:active::after, .md-fab:active::after, .md-tab:active::after, .md-drawer__item:active::after {
  animation: md-ripple 480ms var(--ease-standard);
}
@keyframes md-ripple {
  0%   { opacity: 0.32; transform: translate(-50%, -50%) scale(1); }
  100% { opacity: 0;    transform: translate(-50%, -50%) scale(28); }
}
```
> 说明：纯 CSS 版水波纹从元素中心扩散（不设 `--ripple-x/y` 时回退到 50%）。要精确跟随点击坐标需 JS 设置变量，但那会触碰 `<script>`——本规范选**纯 CSS 中心扩散**方案，零 JS 改动，符合纪律。颜色用 `currentColor`（主色按钮=白、outlined=蓝），观感统一。

---

## 4. 交互细节规范

统一过渡：`transition: <prop> var(--dur-base) var(--ease-standard)`，时长 150–200ms。

| 状态 | 表现 | 适用 |
|---|---|---|
| **hover** | 阴影升一级（filled 2→4、tonal/outlined 加底色）、卡片上浮 2px | 全部可交互 |
| **active** | `transform: scale(0.97)`（按钮）/ `scale(0.96)`（FAB）+ 背景压暗（filled→`--md-primary-variant`） | `.btn` / `.md-fab` |
| **focus-visible** | `outline: 2px solid var(--md-primary); outline-offset: 2px;`（清晰焦点环，键盘可达性） | 所有按钮/输入 |
| **disabled** | 用 `底色=on-surface 12% + 文字=on-surface 38%` 表达（不靠 `opacity` 半透明，避免叠色发灰）；`pointer-events:none; cursor:not-allowed` | 按钮/输入 |
| **loading** | 见 §3.12：按钮透明文字 + 旋转环；或禁用态 + ⏳ 行内提示 | 保存/测试按钮 |
| **ripple** | 见 §3.13：`scale(1)→scale(28)` 480ms 标准曲线 | 按钮/FAB/tab |

**无障碍**：focus-visible 仅键盘聚焦时出现（不干扰鼠标点击）；所有触控区 ≥ 44px（按钮 40px 高 + 8px 内边距已接近，FAB 56px、卡片内链接≥44px）；颜色对比满足 AA。

---

## 5. 布局与响应式规范

```css
/* 全局基准（替换原 body 样式，保留 max-width 与居中） */
*, *::before, *::after { box-sizing: border-box; }
html { font-size: 16px; }
body {
  font-family: var(--font-base);
  background: var(--md-background);
  color: var(--md-on-background);
  line-height: 1.5;
  margin: 0 auto;
  max-width: 1020px;            /* 内容最大宽度 */
  padding: var(--space-4);      /* 页面边距 16px */
}

/* 栅格：卡片默认纵向堆叠；桌面端可用多卡并排（可选） */
.md-grid { display: grid; gap: var(--space-6); grid-template-columns: 1fr; }
@media (min-width: 960px) {
  .md-grid { grid-template-columns: repeat(2, 1fr); }  /* 桌面双列 */
}
```

**断点（与现有 `max-width:768px` 对齐并扩展）**：
- **移动端 `< 600px`**：单列堆叠；`.form-group` 纵向、`.btn` 满宽；表格横向滚动（`overflow-x:auto` 已在 `.table-wrapper`）。
- **平板 `600–959px`**：保持单列，但增大内边距。
- **桌面 `≥ 960px`**：多卡栅格（如上 `.md-grid`），AppBar 高度 64px 可选，FAB 固定右下角。

```css
@media (max-width: 768px) {
  body { padding: var(--space-2); }
  .card { padding: var(--space-4); margin-bottom: var(--space-4); }
  .form-group { flex-direction: column; align-items: stretch; }
  .btn { width: 100%; }
}
@media (max-width: 599px) {
  .md-appbar { height: 56px; }
  .md-fab { right: var(--space-4); bottom: var(--space-4); }
}
```

**触控区域**：所有按钮高度 40px（≥36dp）+ 内边距，FAB 56px，表格行高 52px，均 ≥ 44px 等效触控目标。

---

## 6. 暗色模式（`prefers-color-scheme: dark`）

**整段替换**原独立暗色 `@media` 覆盖块。保持 MD2 暗色观感（背景 `#121212`、表面 `#1E1E1E`、错误用偏亮红），并同步覆盖 badge 颜色。

```css
@media (prefers-color-scheme: dark) {
  :root {
    --md-background:    #121212;
    --md-surface:       #1E1E1E;
    --md-surface-2:     #2A2A2A;

    --md-on-background: #E6E1E5;
    --md-on-surface:    #E6E1E5;
    --md-on-surface-medium: #B0B0B0;
    --md-on-surface-disabled: rgba(255,255,255,0.38);
    --md-on-surface-disabled-bg: rgba(255,255,255,0.12);

    --md-divider:   #3C3C3C;
    --md-outline:   #5A5A5A;
    --md-primary-light: #1A3A5C;     /* hover 浅底改用深蓝调 */

    /* 主色暗色下略提亮以保持可读（MD2 暗色常见做法） */
    --md-primary:        #42A5F5;
    --md-on-primary:     #012A36;
    --md-primary-variant:#1E88E5;
    --md-primary-700:    #1976D2;

    --md-secondary:      #4DB6AC;
    --md-on-secondary:   #012A23;

    --md-error:          #CF6679;
    --md-on-error:       #381E1E;
    --md-error-light:    #5C1A17;
  }
  /* badge 暗色覆盖 */
  .badge-ok    { background: #1A3C28; color: #81C995; }
  .badge-warn  { background: #3C3014; color: #FDD663; }
  .badge-dead  { background: #3C1E1C; color: #F28B82; }
  .badge-recov { background: #3C3414; color: #FDD663; }
  /* 输入/textarea 暗色边框微调 */
  .input, textarea, .note-input { background: #2A2A2A; }
  .md-appbar { background: #1E1E1E; }
}
```

---

## 7. 验收对照（Code Agent 自检清单）

### 7.1 「界面是 MD2 而非 MD3」判断标准
- [ ] 卡片圆角为 **8px**（无 16–28px 超大圆角）。
- [ ] 卡片用 **elevation 2 静止 / 4 hover** 分层阴影（经典双投影写法），而非 MD3 单层柔和阴影；未叠加 `border` 描边。
- [ ] 按钮圆角为 **4px**（无 `border-radius: 9999px` 药丸按钮）。
- [ ] 存在 **FAB**（右下角 56px 圆形，elevation 6/8）——若实现 §3.8。
- [ ] 按钮/可交互元素有 **纯 CSS 水波纹 ripple**（`:active` 径向缩放）。
- [ ] 整体**扁平柔和**、主色克制（仅 AppBar/主按钮/FAB/focus/链接用蓝）。
- [ ] **无** MD3 tonal 容器配色、无 MD3 动态色彩角色系统。
- [ ] 配色取自 MD2 调色板（`--md-primary` 蓝 + `--md-secondary` 青绿），具体 hex 与 §2 一致。

### 7.2 「原有功能/文案/emoji 完全保留」约束
- [ ] 所有 `onclick="saveSettings()/addRepo()/..."` 等事件 **未改动**。
- [ ] 所有元素 `id`（如 `repoTableBody`、`testBtn`、`clock`、`settingsSaved`）**未改动**。
- [ ] 现有 `class` 名（`.btn-filled/.btn-tonal/.btn-outlined/.btn-error/.card/.input/.badge*` 等）**保留**，仅替换其 CSS 规则。
- [ ] 中文文案（「检测节奏设置」「通知内容配置」「📦 批量导入 / 导出项目」等）**一字未改**。
- [ ] emoji（💾📥📤🎯🔄🔍⛔✅⏳❌🔕🟢💤 等）**全部保留**。
- [ ] `<script>` 业务逻辑 **零改动**（`alert/confirm` 仍按原样工作）。
- [ ] 表格动态拼接结构（badge 类、`note-input`、`delete-repo-btn`）**样式兼容**，渲染不破版。

---

## 8. 给 Code Agent 的执行顺序建议

按以下顺序落地，避免样式冲突与回滚：

1. **`:root` 变量**：整段替换现有 `:root`（含 MD3 命名变量与暗色块），换成本文档 §2 + §6 的 `--md-*` 集合。
2. **全局 reset / base**：替换 `body`、补 `*` box-sizing、`html` 字号、`code` 基础样式（见 §5）。
3. **字体引入**：在 `<head>` 加 Roboto / Roboto Mono 的 Google Fonts `<link>`（§3.1）。
4. **各组件 CSS**（按依赖顺序）：
   - AppBar（§3.2，建议新增，保留原文字/emoji）
   - Card（§3.3）
   - Button 三级 + error + focus/disabled/ripple 挂载（§3.4、§3.13）
   - TextField / textarea / select / note-input（§3.5）
   - Table（§3.6）
   - Badge / Chip（§3.11）、Info-panel、Auth-error、Result-block（沿用 MD2 圆角/底色）
   - FAB（§3.8，建议新增）
   - 可选：Tabs / Drawer / Dialog / Snackbar / Skeleton 样式（§3.7/3.10/3.9/3.12）
5. **响应式**（§5 的 media query）：先 `max-width:768px` 兼容现有，再补 `<600px` 与 `≥960px`。
6. **暗色模式**（§6）：整段替换原 `prefers-color-scheme: dark` 覆盖。
7. **自检**：逐条过 §7 清单，确认「MD2 特征达标」且「原功能/文案/emoji 无损」。

> 优先级提示：第 1–4 步是「从 MD3 改回 MD2」的核心（圆角、阴影、按钮、输入框）；FAB/Dialog/Drawer 为增强项，可后置或按需取舍，但不应引入 MD3 视觉。

---

*本规范由 UI-Design Agent 产出，仅描述设计，不含任何 `index.js` 改动与 JS 实现。*
