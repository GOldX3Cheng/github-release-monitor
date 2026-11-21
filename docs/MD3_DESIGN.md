# GitHub Release 监控控制台 · UI 设计规范（Material Design 3 · 扁平）

> 本文档描述 `index.js` 内联 HTML 模板中**已落地**的 UI 规范。
> 采用 **Material Design 3（M3）**，并且是**扁平**取向：层级一律用 tonal 表面色表达，不用阴影、不用渐变。
> 改造范围仅限 `<style>` 段；`id`、`class` 名、事件绑定、`<script>` 业务逻辑、中文文案一律不动。

---

## 1. 设计原则

1. **层级靠表面色，不靠阴影**：`surface-container-lowest → low → container → high → highest` 五档 tonal 表面。
2. **不用渐变、不用大投影**：仅 FAB 与 Snackbar 保留极轻的一层 elevation。
3. **状态层表达交互**：hover / focus / pressed 用 8%–10% 的 `on-*` 叠加，而不是变色或描边加粗。
4. **圆角按 M3 刻度**：4 / 8 / 12 / 16 / 28 / full，不随意取值。
5. **扁平不等于简陋**：按钮、卡片、字段、徽章各自有明确形状语义（见 §4）。
6. **明暗双主题**：跟随 `prefers-color-scheme`，两套 tonal 色板一一对应。

---

## 2. 设计令牌（Color roles）

### 2.1 浅色

| 角色 | 值 | 用途 |
| --- | --- | --- |
| `primary` / `on-primary` | `#0B57D0` / `#FFFFFF` | 主按钮、链接、聚焦态 |
| `primary-container` / `on-primary-container` | `#D8E2FF` / `#001A41` | 横幅、FAB、图标底 |
| `secondary-container` / `on-secondary-container` | `#DAE2F9` / `#131C2B` | tonal 按钮 |
| `tertiary-container` / `on-tertiary-container` | `#F7D9FA` / `#28132D` | 「观察中」徽章 |
| `error-container` / `on-error-container` | `#FFDAD6` / `#410002` | 「失效」徽章、危险按钮 |
| `success-container` / `on-success-container` | `#B7F0C7` / `#002112` | 「正常」徽章 |
| `warning-container` / `on-warning-container` | `#FFDCB9` / `#2E1500` | 「异常」徽章 |
| `surface` / `on-surface` | `#FAFAFC` / `#1A1B21` | 页面底、正文 |
| `surface-container-*` | `#FFFFFF / #F4F4F8 / #EEEFF3 / #E8E9EF / #E2E3EA` | 卡片、抽屉、行、分隔 |
| `outline` / `outline-variant` | `#757681` / `#C5C6D0` | 输入框边框 / 卡片描边 |
| `inverse-surface` / `inverse-on-surface` | `#2F3036` / `#F1F0F7` | Snackbar |

### 2.2 深色

| 角色 | 值 |
| --- | --- |
| `primary` / `on-primary` | `#A9C8FF` / `#002A63` |
| `primary-container` / `on-primary-container` | `#00448B` / `#D8E2FF` |
| `secondary-container` / `on-secondary-container` | `#3F4859` / `#DAE2F9` |
| `tertiary-container` / `on-tertiary-container` | `#563F5B` / `#F7D9FA` |
| `error-container` / `on-error-container` | `#93000A` / `#FFDAD6` |
| `success-container` / `on-success-container` | `#005231` / `#B7F0C7` |
| `warning-container` / `on-warning-container` | `#733800` / `#FFDCB9` |
| `surface` / `on-surface` | `#12131A` / `#E3E2E9` |
| `surface-container-*` | `#0D0E14 / #191A22 / #1D1E26 / #282933 / #33343E` |
| `outline` / `outline-variant` | `#8F909A` / `#45464F` |
| `inverse-surface` / `inverse-on-surface` | `#E3E2E9` / `#2F3036` |

### 2.3 形状刻度

```
--r-xs:4px   --r-sm:8px   --r-md:12px   --r-lg:16px   --r-xl:28px   --r-full:999px
```

### 2.4 动效

| 令牌 | 值 |
| --- | --- |
| `--ease` | `cubic-bezier(.2,0,0,1)`（M3 standard / emphasized） |
| `--ease-out` | `cubic-bezier(.05,.7,.1,1)`（emphasized decelerate） |
| `--dur-short` / `--dur-med` / `--dur-long` | `150ms` / `220ms` / `320ms` |

并提供 `prefers-reduced-motion` 兜底（全部降到 1ms）。

---

## 3. 排版（M3 Type scale）

| 用途 | 字号 / 行高 | 字重 | 字距 |
| --- | --- | --- | --- |
| 应用栏标题 | 22 / 28 | 400 | 0 |
| 卡片标题 | 16 / 24 | 500 | 0 |
| 统计数字 | 30 / 38 | 400 | 0 |
| 正文 body-medium | 14 / 20 | 400 | 0.1px |
| 按钮 label-large | 14 / 20 | 500 | 0.1px |
| 标签 label-medium | 12 / 16 | 500 | 0.5px |
| 徽章 label-small | 11 / 16 | 500 | 0.5px |

字体栈以 Roboto 开头，回退到系统字体；**不引外部字体**（避免被 CSP 拦截）。

---

## 4. 组件规范

### 4.1 顶部应用栏（Small Top App Bar）

- 高 64px，`position:sticky`，背景 `surface-container` 86% + `backdrop-filter:blur(16px)`
- 底部 1px `outline-variant` 分隔线，无阴影
- 标题 title-large 22/400；右侧为标准图标按钮（40×40，全圆角，8% 状态层）
- 铃铛右上角 Badge：直径 16px，`error` 底、`on-error` 字，外圈 2px 底色描边

### 4.2 卡片（Outlined Card）

- `background: surface-container-lowest`，`border: 1px solid outline-variant`，`border-radius: 12px`，`box-shadow: none`
- 内边距 20px；卡片标题 title-medium 16/500

### 4.3 统计卡（Filled Card）

- 同卡片描边样式，数字 30/38 权重 400
- 颜色语义：项目数 = `primary`、正常 = `success`、失效异常 = `error`、未读 = `warning`

### 4.4 按钮（Common Button）

统一 40px 高、全圆角胶囊、`label-large` 14/500，四类：

| 类型 | 底 | 字 | 场景 |
| --- | --- | --- | --- |
| filled | `primary` | `on-primary` | 主操作（添加、保存） |
| tonal | `secondary-container` | `on-secondary-container` | 次操作（导入） |
| outlined | 透明 + `outline` 边 | `primary` | 中性操作（导出、全部删除） |
| text | 透明 | `primary` | 横幅内链接 |

hover 叠加 8% `on-*`，`disabled` 透明度 .38。

### 4.5 文本字段（Outlined Text Field）

- 高 48px，`border-radius: 4px`，`1px solid outline`，背景透明
- hover 边框转 `on-surface`；focus 边框 `primary` + `inset 0 0 0 1px`（避免 1px→2px 抖动）
- textarea 圆角放宽到 8px，等宽字体

### 4.6 状态徽章（Chip）

- 高 24px，`border-radius: 8px`，`label-small` 11/500，无边框
- 用各语义的 container 色：正常 `success-container`、异常 `warning-container`、失效 `error-container`、观察中 `tertiary-container`、无发布 `surface-container-highest`
- 悬停 `title` 显示判定依据（`lastError` / `reason` / `judgeReason`）

### 4.7 列表（List）

- 容器 `surface-container-lowest` + 12px 圆角 + 描边；行间用 1px `outline-variant` 分隔，**不给每行单独加边框**
- 行内边距 `10px 16px 10px 12px`，hover 8% 状态层

### 4.8 抽屉（Modal Navigation Drawer）

- 宽 `min(400px, 100vw)`，靠边一侧 16px 圆角，背景 `surface-container-low`
- 遮罩 scrim `rgba(0,0,0,.32)`（深色主题 .55）
- 头部 64px，标题 title-large 22/400

### 4.9 手风琴分组

- 组容器 `surface-container` + 12px 圆角；头部 56px，左侧 30px 圆角图标块（`primary-container` 底）
- 展开用 `grid-template-rows: 0fr → 1fr` 做高度动画；箭头 SVG 旋转 180°

### 4.10 FAB

- 56×56，`border-radius: 16px`（M3 FAB 是方角不是圆形），`primary-container` 底 + `on-primary-container` 图标
- 保留极轻 elevation（`--shadow-2`），hover 抬升到 `--shadow-3`

### 4.11 Snackbar

- `inverse-surface` 底、`inverse-on-surface` 字，圆角 8px，居中底部 24px

---

### 4.12 配额卡片（Filled Card 网格）

面板底部的 Cloudflare 配额区块用一组紧凑的 filled card：

- 网格 `repeat(auto-fill, minmax(216px, 1fr))`，间距 `--sp-3`；≤640px 时收窄到 160px
- 卡片背景 `surface-container-low`、圆角 `--r-sm`、**无描边**（与上面的 outlined card 区分层级）
- 内部四行：服务名（label-medium，`on-surface-variant`）+ 百分比（右对齐、等宽数字）→ 指标名（body-medium）→ 用量 / 上限（body-small，`on-surface-variant`）→ 4px 进度条
- 进度条轨道 `surface-container-highest`，填充色按等级取 `--success` / `--warning` / `--error`
- 超过 8 项时容器加 `.collapsed`，用 `:nth-child(n+9) { display:none }` 隐藏，下方 `ghost-btn` 切换「展开全部 N 项 / 收起」
- 区块底部用一行 hint 汇总超阈值项，没有风险时说明阈值口径（80% 预警 / 100% 超额）

## 5. 响应式

| 断点 | 变化 |
| --- | --- |
| ≤ 820px | 统计卡 2 列；仓库行改为 `badge / name / del` + `note` 两行网格 |
| ≤ 640px | 应用栏 60px；表单纵向堆叠；按钮撑满宽度；FAB 与 Snackbar 内收 |

滚动条统一细化（`scrollbar-width:thin` + WebKit 8px 圆角 thumb）。

---

## 6. 改造时的硬性约束

1. **保留旧变量别名**：`<script>` 里仍用 `var(--err)`、`var(--ok)`、`var(--pri)`、`var(--text-2)`、`var(--text-3)` 动态取色，`:root` 末尾那组别名（`--pri` / `--err` / `--ok` / `--warn` / `--text*` / `--line*` / `--surface*` / `--recov*`）**不能删**。
2. **不改 DOM id 与 class**：JS 用 `getElementById` 取 55 个节点，且用字符串拼接生成 `.repo-row`、`.badge b-*`、`.notif`、`.banner`、`.quota-item` 等结构。
3. **不改 `<script>`**：所有交互、鉴权、轮询逻辑与样式解耦。
4. **不引外部资源**：字体、图标全部内联或系统字体，避免被 CSP 拦截。

---

## 7. 自检清单

- [ ] 卡片只有 1px 描边，看不到投影
- [ ] 按钮是胶囊形，不是 4px 直角
- [ ] hover 是淡淡的灰/主色叠加，不是边框变粗
- [ ] 深色主题下所有文字对比度足够（尤其 `on-surface-variant` 与 `surface-container-*`）
- [ ] 窄屏下仓库行不出现横向滚动条
- [ ] 关闭通知后再刷新，通知不再出现（服务端已删除）
