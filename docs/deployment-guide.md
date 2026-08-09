# 🚀 部署指南（图形化，无需本地环境）

本指南教你**完全不使用命令行**，仅通过 Cloudflare 网页控制台完成部署。全程大约 10 分钟。

> 💡 想用命令行部署？见文末「方法三」。

---

## 方法一：直接粘贴代码（最简单，推荐）

### 1. 登录 Cloudflare 仪表板

打开浏览器访问 [https://dash.cloudflare.com/](https://dash.cloudflare.com/) 并登录你的账号。

### 2. 创建 Worker 服务

1. 左侧菜单点击 **Workers 和 Pages**；
2. 点击 **创建应用程序** → 选择 **创建 Worker**；
3. 为 Worker 指定一个**全局唯一**的名称，例如 `github-release-monitor`；
4. 点击 **部署**，等待创建完成。

### 3. 粘贴代码

1. 在刚创建的 Worker 页面点击 **编辑代码**，进入在线代码编辑器；
2. 删除编辑器中所有默认代码；
3. 打开本项目仓库中的 [`index.js`](../index.js)，将**全部内容**复制并粘贴到编辑器中；
4. 点击右上角 **保存并部署**。

### 4. 创建并绑定 D1 数据库（必须）

本项目使用 Cloudflare D1（SQLite 数据库）保存监控状态，**必须**创建并绑定，否则接口会返回 `503`。

1. 左侧菜单进入 **Workers 和 Pages** → **D1**；
2. 点击 **创建数据库**，名称填 `github-release-monitor`（位置可按需选择，默认即可）；
3. 创建完成后，进入数据库详情页，**复制 `database_id`**（一长串 UUID，后面绑定要用）；
4. 回到你的 Worker 页面，进入 **设置** → **绑定**；
5. 点击 **添加** → 选择 **D1 数据库**；
6. **变量名称**填 `DB`，**数据库**选择刚才创建的 `github-release-monitor`；
7. 点击 **保存**。

> 数据表会在 Worker 首次运行时**自动创建**，无需手动建表或执行迁移。

### 5. 配置环境变量（重要）

返回 Worker 页面，进入 **设置** → **变量和机密**。

在 **环境变量 / 机密** 区域，点击 **添加**，依次添加以下配置。**所有涉及密钥的变量请务必勾选「加密」（机密）**：

| 变量名 | 是否必填 | 说明 | 示例 |
| --- | --- | --- | --- |
| `WEBHOOK_URL` | ✅ 必填 | 通知推送目标地址（POST JSON），见下方「通知渠道配置」 | `https://your-wxpush.workers.dev/wxsend` |
| `API_KEY` | ✅ 必填 | 管理面板与 API 的访问密钥，设置一串足够复杂的随机字符串 | `aB3$kF9...`（随机生成） |
| `WEBHOOK_AUTH_TOKEN` | ❌ 选填 | 推送时携带的 `Authorization` 请求头值（部分渠道需要，如 wxpush） | 渠道提供的 token |
| `GITHUB_TOKEN` | ❌ 选填（推荐） | GitHub Personal Access Token，提高 API 限额（60→5000 次/小时），支持监控私有仓库 | `github_pat_...` |

添加完成后点击 **保存**。

### 6. 配置定时触发器（Cron）

1. 进入 Worker 的 **设置** → **触发器**；
2. 找到 **Cron 触发器**，点击 **添加 Cron 触发器**；
3. 输入 `*/5 * * * *`（每 5 分钟唤醒一次），点击 **添加**；
4. 保存后确认触发器状态为「已启用」。

> Worker 内部会自动控制检查节奏（默认每 5 分钟检查一个仓库、8 小时完成一轮），Cron 频率只需保证「至少每 5 分钟一次」即可，无需精确匹配仓库数量。

### 7. 验证部署

1. 回到 Worker 的 **概览** 页面，点击访问地址（形如 `https://github-release-monitor.<你的子域>.workers.dev`）；
2. 应看到 **「GitHub Release 监控控制台」** 管理面板；
3. 在面板 **「监控仓库」** 输入框添加一个仓库，例如 `openai/openai-cookbook`，点击添加；
4. 在面板点击 **「测试」**，确认收到通知（首次测试会强制推送一次）；
5. 若测试失败，检查 `WEBHOOK_URL` / `WEBHOOK_AUTH_TOKEN` 与通知渠道配置是否一致（见下方教程）。

✅ 部署完成！之后 Worker 会按周期自动监控并推送通知。

---

## 方法二：关联 GitHub 仓库自动部署（持续集成）

如果你希望**推送代码后自动部署**，可以把本仓库直接连接到 Cloudflare：

1. **Fork / 克隆项目**：将本仓库 Fork 到你自己的 GitHub 账号（或克隆后推送到你自己的仓库）；
2. 登录 Cloudflare，进入 **Workers 和 Pages** → **创建应用程序** → **Workers** 选项卡；
3. 选择 **连接到 Git 仓库**，按提示授权 GitHub 并选择你的仓库；
4. **生产分支**选择 `main`；Cloudflare 会自动读取 `wrangler.toml`（无需手动填写构建命令）；
5. 在配置页选择/创建 **D1 数据库** 并绑定（变量名 `DB`）；
6. 在 **环境变量** 区域添加方法一第 5 步的变量（同样勾选加密）；
7. 点击 **保存并部署**。

此后每次向 `main` 推送代码，Cloudflare 都会自动重新部署。

> 注意：通过 Git 关联部署时，`wrangler.toml` 中的 `database_id` 会被 Cloudflare 托管覆盖；如遇绑定问题，直接在 Worker 的 **设置 → 绑定** 中手动选择数据库即可。

---

## 方法三：本地命令行部署（可选）

适合习惯命令行的用户：

```bash
# 1. 克隆项目
git clone https://github.com/<你的账号>/github-release-monitor.git
cd github-release-monitor

# 2. 安装依赖
npm install

# 3. 登录 Cloudflare（浏览器授权）
npx wrangler login

# 4. 创建 D1 数据库，并把输出的 database_id 填入 wrangler.toml
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

---

## 常见问题

**Q：面板打开后接口报 503？**
A：几乎都是 D1 数据库未绑定。检查 Worker **设置 → 绑定** 中是否有变量名为 `DB` 的 D1 绑定。

**Q：添加仓库后一直没有通知？**
A：依次检查：① `WEBHOOK_URL` 是否正确；② 渠道是否要求 `Authorization`（wxpush 需要）；③ 通知模板字段是否与渠道要求一致；④ 点击面板「测试」确认链路。

**Q：`API_KEY` 忘了设置，面板操作提示 Unauthorized？**
A：进入 **设置 → 变量和机密** 添加 `API_KEY` 后即可。面板的所有接口都通过请求头 `X-API-Key` 校验。

**Q：想让 Worker 检查得更频繁？**
A：面板「参数设置」中可调整「仓库检查间隔」（5~60 分钟）与「完整周期时长」（1~48 小时）。

---

## 下一步

- 📨 [通知渠道设置教程](./notification-channels.md) —— 微信（wxpush）、Telegram、Discord、企业微信、钉钉等渠道的完整对接方法
- 📖 [README](../README.md) —— 项目总览与环境变量总表
