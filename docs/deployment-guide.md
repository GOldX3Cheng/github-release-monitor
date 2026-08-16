# 部署指南（图形化，无需本地环境）

本指南教你仅通过 Cloudflare 网页控制台完成部署，全程约 10 分钟。想用命令行见文末「方法三」。

## 三种方式一览

| 方式 | 适合场景 | 环境变量 / 密钥放哪 | 数据库绑定怎么设 |
| --- | --- | --- | --- |
| 方法一 直接粘贴代码 | 不想碰 Git，最快上手 | Cloudflare 后台（Worker → 设置 → 变量和机密） | 后台「绑定」里手动加，名称 `DB` |
| 方法二 关联 GitHub 自动部署 | 推送代码即自动重新部署 | Cloudflare 后台（部署配置页的「环境变量」区） | 部署配置页选 D1 并绑定，名称 `DB` |
| 方法三 本地命令行 | 习惯 CLI / 需要本地调试 | `wrangler secret put` 或 `.dev.vars` | 写在 `wrangler.toml` 的 `[[d1_databases]]` |

## 先说清楚：配置到底放哪里

这是最容易混淆的地方，请先读这一段。

- **环境变量和密钥（WEBHOOK_URL / API_KEY / WEBHOOK_AUTH_TOKEN / GITHUB_TOKEN）一律配在 Cloudflare 后台。** 它们运行时由 Worker 的 `env` 对象读取（代码里是 `env.WEBHOOK_URL` 等）。GitHub 的「Settings → Secrets」与此流程无关，写了也不会被读取。只有当你改用「GitHub Actions 自己跑 `wrangler deploy`」时才需要 GitHub 机密，本仓库的三种方式都不走那条路径。
- **数据库绑定名固定为 `DB`。** 代码通过 `env.DB` 访问数据库。你在 Cloudflare 绑定界面填的「变量名称 / 绑定名称」就是 `DB`，不是 `database_id`。
- **`database_id` 你不用管（除非用方法三）。** 它是 `wrangler.toml` 里的一个字段（一串 UUID）。通过 Git 关联部署时，Cloudflare 会托管并自动覆盖这个 ID，你只需在配置页从下拉列表「选数据库」，不用手填 UUID。

> 一句话：配置跟着运行时走，全部在 Cloudflare 一侧；`DB` 是绑定名不是字段名，选库即可不选 UUID。

---

## 方法一：直接粘贴代码（最简单，推荐）

### 1. 登录 Cloudflare 仪表板

打开 https://dash.cloudflare.com/ 并登录。

### 2. 创建 Worker 服务

1. 左侧菜单点击 **Workers 和 Pages**；
2. 点击 **创建应用程序** → 选择 **创建 Worker**；
3. 为 Worker 指定一个全局唯一的名称，例如 `github-release-monitor`；
4. 点击 **部署**，等待创建完成。

### 3. 粘贴代码

1. 在刚创建的 Worker 页面点击 **编辑代码**，进入在线代码编辑器；
2. 删除编辑器里所有默认代码；
3. 打开本项目仓库的 `index.js`，将全部内容复制并粘贴到编辑器；
4. 点击右上角 **保存并部署**。

### 4. 创建并绑定 D1 数据库（必须）

本项目用 Cloudflare D1（SQLite）保存监控状态，必须创建并绑定，否则接口返回 `503`。

1. 左侧菜单进入 **Workers 和 Pages** → **D1**；
2. 点击 **创建数据库**，名称填 `github-release-monitor`；
3. 创建完成后，进入 Worker 页面，打开 **设置** → **绑定**；
4. 点击 **添加** → 选择 **D1 数据库**；
5. **变量名称**填 `DB`，**数据库**从下拉列表选择刚创建的 `github-release-monitor`；
6. 点击 **保存**。

> 数据表会在 Worker 首次运行时自动创建，无需手动建表或执行迁移。这里选的是「数据库名」，不是 UUID；UUID 由 Cloudflare 在后台自动关联。

### 5. 配置环境变量（重要）

返回 Worker 页面，进入 **设置** → **变量和机密**。

点击 **添加**，依次添加以下配置。**所有涉及密钥的变量请务必勾选「加密」（机密）**。

| 变量名 | 是否必填 | 说明 | 示例 |
| --- | --- | --- | --- |
| `WEBHOOK_URL` | 必填 | 通知推送目标地址（POST JSON），见通知渠道配置 | `https://your-wxpush.workers.dev/wxsend` |
| `API_KEY` | 必填 | 管理面板与 API 的访问密钥，设一串足够复杂的随机字符串 | `aB3kF9...`（随机生成） |
| `WEBHOOK_AUTH_TOKEN` | 选填 | 推送时携带的 `Authorization` 请求头值（部分渠道需要，如 wxpush） | 渠道提供的 token |
| `GITHUB_TOKEN` | 选填（推荐） | GitHub Personal Access Token，提高 API 限额（60→5000 次/小时），支持监控私有仓库 | `github_pat_...` |

添加完成后点击 **保存**。

> 注意：`DB` 不在这里配，它在第 4 步的「绑定」里。

### 6. 配置定时触发器（Cron）

1. 进入 Worker 的 **设置** → **触发器**；
2. 找到 **Cron 触发器**，点击 **添加 Cron 触发器**；
3. 输入 `*/5 * * * *`（每 5 分钟唤醒一次），点击 **添加**；
4. 保存后确认触发器状态为「已启用」。

> Worker 内部会自动控制检查节奏（默认每 5 分钟检查一个仓库、8 小时完成一轮），Cron 频率只需保证「至少每 5 分钟一次」，无需精确匹配仓库数量。

### 7. 验证部署

1. 回到 Worker 的 **概览** 页面，点击访问地址（形如 `https://github-release-monitor.<你的子域>.workers.dev`）；
2. 应看到 **「GitHub Release 监控控制台」** 管理面板；
3. 在面板 **「监控仓库」** 输入框添加仓库，例如 `openai/openai-cookbook`，点击添加；
4. 在面板点击 **「测试」**，确认收到通知（首次测试会强制推送一次）；
5. 若测试失败，检查 `WEBHOOK_URL` / `WEBHOOK_AUTH_TOKEN` 与通知渠道配置是否一致。

部署完成。之后 Worker 会按周期自动监控并推送通知。

---

## 方法二：关联 GitHub 仓库自动部署（持续集成）

如果你希望推送代码后自动部署，可以把本仓库直接连接到 Cloudflare。

1. **Fork 或克隆项目**：将本仓库 Fork 到你的 GitHub 账号（或克隆后推送到你自己的仓库）；
2. 登录 Cloudflare，进入 **Workers 和 Pages** → **创建应用程序** → **Workers** 选项卡；
3. 选择 **连接到 Git 仓库**，按提示授权 GitHub 并选择你的仓库；
4. **生产分支**选择 `main`；Cloudflare 会自动读取 `wrangler.toml`（无需手动填写构建命令）；
5. 在配置页 **创建或选择 D1 数据库** 并绑定：绑定名称填 `DB`，数据库从下拉列表选你刚创建的 `github-release-monitor`（不需要手填 UUID）；
6. 在同一配置页的 **环境变量** 区域添加上面方法一第 5 步的变量（`WEBHOOK_URL` / `API_KEY` 必填，另两个选填），涉密项同样勾选「加密」；
7. 点击 **保存并部署**。

此后每次向 `main` 推送代码，Cloudflare 都会自动重新部署。

> 关键提醒：这里的「环境变量」是 **Cloudflare 部署配置页里的输入框**，不是 GitHub 仓库的 Secrets。两者互不相通，别在 GitHub 那边配。
> 另外，`wrangler.toml` 里的 `database_id` 字段在 Git 部署时会被 Cloudflare 托管覆盖，你不用改它、也不用抄 UUID 到任何地方。如果部署后接口报 `503`（数据库未绑定），直接进 Worker 的 **设置 → 绑定**，手动选 D1 数据库、绑定名填 `DB` 即可。

---

## 方法三：本地命令行部署（可选）

适合习惯命令行的用户。

```bash
# 1. 克隆项目
git clone https://github.com/<你的账号>/github-release-monitor.git
cd github-release-monitor

# 2. 安装依赖
npm install

# 3. 登录 Cloudflare（浏览器授权）
npx wrangler login

# 4. 创建 D1 数据库，把输出的 database_id 填入 wrangler.toml
npx wrangler d1 create github-release-monitor

# 5. 配置机密（按提示输入，不要提交到仓库）
npx wrangler secret put WEBHOOK_URL
npx wrangler secret put API_KEY
npx wrangler secret put WEBHOOK_AUTH_TOKEN   # 可选
npx wrangler secret put GITHUB_TOKEN         # 可选

# 6. 部署
npm run deploy

# 本地调试
npm run dev
```

> 方法三里 `database_id` 才需要你手动填进 `wrangler.toml`；方法一、方法二都不需要。

---

## 常见误区

**Q：环境变量应该写在 GitHub 的 Secrets 里吗？**
A：不应该。方法二走的是 Cloudflare 自己的 Git 流水线，运行期只读 Cloudflare 后台的「变量和机密」。GitHub Secrets 只有当你用 GitHub Actions 部署时才生效，本仓库三种方式都不依赖它。

**Q：数据库变量名写 DB 还是 database_id？内容填库名还是 UUID？**
A：变量名写 `DB`（这是代码 `env.DB` 引用的绑定名）。`database_id` 是 `wrangler.toml` 的字段，不是绑定名。Git 部署时在配置页从下拉列表「选数据库」即可，不用手填 UUID；UUID 由 Cloudflare 后台自动关联。

**Q：面板打开后接口报 503？**
A：几乎都是 D1 未绑定。检查 Worker **设置 → 绑定** 中是否有变量名为 `DB` 的 D1 绑定。Git 部署偶尔绑定未生效，手动在「绑定」里选一次数据库即可。

**Q：添加仓库后一直没有通知？**
A：依次检查：① `WEBHOOK_URL` 是否正确；② 渠道是否要求 `Authorization`（wxpush 需要）；③ 通知模板字段是否与渠道要求一致；④ 点击面板「测试」确认链路。

**Q：`API_KEY` 忘了设置，面板操作提示 Unauthorized？**
A：进入 **设置 → 变量和机密** 添加 `API_KEY` 即可。面板所有接口通过请求头 `X-API-Key` 校验。

**Q：想让 Worker 检查得更频繁？**
A：面板「参数设置」中可调整「仓库检查间隔」（5 到 60 分钟）与「完整周期时长」（1 到 48 小时）。

---

## 下一步

- 通知渠道设置教程 —— 微信（wxpush）、Telegram、Discord、企业微信、钉钉等渠道的完整对接方法
- README —— 项目总览与环境变量总表
