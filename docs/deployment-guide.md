# 部署指南（图形化，无需本地环境）

本指南教你仅通过 Cloudflare 网页控制台完成部署，全程约 10 到 15 分钟。习惯命令行见文末「方法三」。

## 前置准备

开始之前备好以下三项：

- **Cloudflare 账号**。免费版即可，无需绑卡。
- **一个可接收消息的 Webhook 地址**。企业微信机器人、钉钉机器人、Telegram Bot、或自建服务均可。格式与获取方式见[通知渠道文档](docs/notification-channels.md)。
- **GitHub Personal Access Token（可选，推荐）**。不设也能用，但匿名 API 限额只有 60 次/小时。设了可提到 5000 次/小时，并支持监控私有仓库。

## 三种方式一览

| 方式 | 难度 | 适合场景 | 环境变量 / 密钥放哪 | 数据库绑定怎么设 |
| --- | --- | --- | --- | --- |
| 方法一 直接粘贴代码 | 低 | 不想碰 Git，最快上手 | Cloudflare 后台（Worker → 设置 → 变量和机密） | 后台「绑定」里手动加，名称 `DB` |
| 方法二 关联 GitHub 自动部署 | 中 | 推送代码即自动重新部署 | Cloudflare 后台（部署配置页的「环境变量」区） | 部署配置页选 D1 并绑定，名称 `DB` |
| 方法三 本地命令行 | 中 | 习惯 CLI / 需要本地调试 | `wrangler secret put` 或 `.dev.vars` | 写在 `wrangler.toml` 的 `[[d1_databases]]` |

## 先说清楚：配置到底放哪里

这是最容易混淆的地方，先读这一段。

- **环境变量和密钥一律配在 Cloudflare 后台。** 包括 `WEBHOOK_URL`、`API_KEY`、`WEBHOOK_AUTH_TOKEN`、`GITHUB_TOKEN`。它们运行时由 Worker 的 `env` 对象读取（代码里是 `env.WEBHOOK_URL` 等）。GitHub 的「Settings → Secrets」与此流程无关，写了也不会被读取。只有改用「GitHub Actions 自己跑 `wrangler deploy`」时才需要 GitHub 机密，本仓库三种方式都不走那条路径。
- **数据库绑定名固定为 `DB`。** 代码通过 `env.DB` 访问数据库。你在 Cloudflare 绑定界面填的「变量名称 / 绑定名称」就是 `DB`，不是 `database_id`。
- **`database_id` 你不用管（除非用方法三）。** 它是 `wrangler.toml` 里的一串 UUID 字段。Git 关联部署时，Cloudflare 会托管并自动覆盖这个 ID。你只需在配置页从下拉列表「选数据库」，不用手填 UUID。

> 一句话：配置跟着运行时走，全部在 Cloudflare 一侧。`DB` 是绑定名不是字段名，选库即可不选 UUID。

## wrangler.toml 是什么（方法二用户必看）

方法二里 Cloudflare 会自动读取仓库根目录的 `wrangler.toml`。你不需要改它，但了解结构能避免困惑：

```toml
name = "github-release-monitor"
main = "index.js"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"              # 这就是代码里 env.DB 的绑定名
database_name = "github-release-monitor"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  # UUID，仅方法三手填；方法二被托管覆盖

[triggers]
crons = ["*/5 * * * *"]     # 每 5 分钟唤醒一次
```

关键认知：

- `binding = "DB"` 决定了绑定名。方法二你在网页填的「绑定名称」必须和它一致，都是 `DB`。
- `database_id` 在方法二由 Cloudflare 托管写入，你不要在网页里抄这串 UUID。
- 构建命令（build command）Cloudflare 会自动检测，留空即可。

---

## 方法一：直接粘贴代码（最简单，推荐）

### 1. 登录 Cloudflare 仪表板

打开 https://dash.cloudflare.com/ 并登录。确认左侧菜单能看到「Workers 和 Pages」与「D1」。

### 2. 创建 Worker 服务

1. 左侧菜单点击 **Workers 和 Pages**；
2. 点击 **创建应用程序** → 选择 **创建 Worker**；
3. 为 Worker 指定一个全局唯一的名称，例如 `github-release-monitor`；
4. 点击 **部署**，等待创建完成（约 10 秒）。

### 3. 粘贴代码

1. 在刚创建的 Worker 页面点击 **编辑代码**，进入在线编辑器；
2. 删除编辑器里所有默认代码（默认是 hello world 模板）；
3. 打开本项目仓库的 `index.js`，将全部内容复制并粘贴到编辑器；
4. 点击右上角 **保存并部署**。

> 粘贴后如果出现语法报错，通常是复制不完整。重新全选 `index.js` 再贴一次。

### 4. 创建并绑定 D1 数据库（必须）

本项目用 Cloudflare D1（SQLite）保存监控状态，必须创建并绑定，否则接口返回 `503`。

1. 左侧菜单进入 **Workers 和 Pages** → **D1**；
2. 点击 **创建数据库**，名称填 `github-release-monitor`；
3. 记下创建成功的提示，点击 **完成**；
4. 回到 Worker 页面，打开 **设置** → **绑定**；
5. 点击 **添加** → 选择 **D1 数据库**；
6. **变量名称**填 `DB`，**数据库**从下拉列表选择刚创建的 `github-release-monitor`；
7. 点击 **保存**。

> 数据表会在 Worker 首次运行时自动创建，无需手动建表或执行迁移。这里选的是「数据库名」，不是 UUID。UUID 由 Cloudflare 在后台自动关联。
>
> 绑定保存后，Cloudflare 会提示「需要重新部署以使绑定生效」。点击确认重新部署，否则代码读到的 `env.DB` 为空。

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

> 变量保存后若页面提示重新部署，点确认。改了任意变量都必须重新部署才会生效。
> `DB` 不在这里配，它在第 4 步的「绑定」里。

### 6. 配置定时触发器（Cron）

1. 进入 Worker 的 **设置** → **触发器**；
2. 找到 **Cron 触发器**，点击 **添加 Cron 触发器**；
3. 输入 `*/5 * * * *`（每 5 分钟唤醒一次），点击 **添加**；
4. 保存后确认触发器状态为「已启用」。

> Cloudflare 的 Cron 使用 **UTC 时区**。每 5 分钟一次即可，Worker 内部会自动控制检查节奏（默认每 5 分钟检查一个仓库、8 小时完成一轮），无需精确匹配仓库数量。

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

### 2.1 Fork 或克隆项目

- 在 GitHub 打开本仓库，点击右上角 **Fork**，选择你自己的账号，等待复制完成；
- 或克隆后推送到你自己名下的仓库。

### 2.2 连接 Git 仓库

1. 登录 Cloudflare，进入 **Workers 和 Pages** → **创建应用程序** → **Workers** 选项卡；
2. 选择 **连接到 Git 仓库**；
3. 首次会跳转到 GitHub 授权页，点击 **Authorize Cloudflare** 允许访问；
4. 在仓库列表里选择你 Fork 出来的 `github-release-monitor`；
5. **生产分支**选择 `main`。

> Cloudflare 会自动读取仓库里的 `wrangler.toml`，**构建命令留空即可**（`main = "index.js"`，无需 npm build）。若页面出现「构建命令」输入框，直接留空。

### 2.3 绑定 D1 数据库

在配置页找到 **D1 数据库 / 绑定** 区域：

1. 点击 **创建数据库** 或选择已有的 `github-release-monitor`；
2. 绑定名称填 `DB`；
3. 数据库从下拉列表选你刚创建的 `github-release-monitor`（不需要手填 UUID）。

### 2.4 配置环境变量

在同一配置页的 **环境变量** 区域添加以下变量（`WEBHOOK_URL` / `API_KEY` 必填，另两个选填），涉密项同样勾选「加密」：

- `WEBHOOK_URL`
- `API_KEY`
- `WEBHOOK_AUTH_TOKEN`
- `GITHUB_TOKEN`

### 2.5 保存并部署

点击 **保存并部署**。Cloudflare 会拉取代码、绑定数据库、注入变量并上线。首次部署约 1 到 2 分钟。

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

## 部署后验证与排错

部署完成后用这张表快速定位问题：

| 现象 | 可能原因 | 处理方式 |
| --- | --- | --- |
| 面板打开报 `503` | D1 未绑定或绑定名不是 `DB` | 进 **设置 → 绑定** 确认有变量名 `DB` 的 D1 绑定；Git 部署偶尔未生效，手动选一次 |
| 面板提示 `Unauthorized` | 未设 `API_KEY` | 进 **设置 → 变量和机密** 添加 `API_KEY`，重新部署 |
| 添加仓库后无通知 | `WEBHOOK_URL` 错 / 渠道要 `Authorization` 头 | 核对地址与 `WEBHOOK_AUTH_TOKEN`；点面板「测试」验证链路 |
| 面板空白 / 部署失败 | 代码粘贴不全或 `index.js` 不完整 | 重新全量复制 `index.js` 再保存部署 |
| 通知延迟数小时 | Cron 每 5 分钟只查一个仓库 | 属正常节奏，8 小时完成一轮；可在面板调「仓库检查间隔」 |
| 改了变量没生效 | 变量保存后未重新部署 | 在变量页保存后点重新部署确认 |

---

## 常见误区

**Q：环境变量应该写在 GitHub 的 Secrets 里吗？**
A：不应该。方法二走的是 Cloudflare 自己的 Git 流水线，运行期只读 Cloudflare 后台的「变量和机密」。GitHub Secrets 只有当你用 GitHub Actions 部署时才生效，本仓库三种方式都不依赖它。

**Q：数据库变量名写 DB 还是 database_id？内容填库名还是 UUID？**
A：变量名写 `DB`（代码 `env.DB` 引用的绑定名）。`database_id` 是 `wrangler.toml` 的字段，不是绑定名。Git 部署时在配置页从下拉列表「选数据库」即可，不用手填 UUID；UUID 由 Cloudflare 后台自动关联。

**Q：Cron 的时间是北京时间吗？**
A：不是。Cloudflare Cron 用 UTC。但 Cron 只负责「每 5 分钟唤醒」，具体检查节奏由 Worker 内部状态机控制，与你的本地时区无关，无需换算。

**Q：需要付费吗？**
A：免费版够用。Workers 免费额度每日 10 万次请求，D1 有免费存储与读写额度，个人监控几个到几十个仓库完全在免费范围内。

**Q：改了环境变量要重新部署吗？**
A：要。在「变量和机密」保存后，页面会提示重新部署，点确认。不重新部署，运行中的 Worker 仍读旧值。

**Q：面板打开后接口报 503？**
A：几乎都是 D1 未绑定。检查 Worker **设置 → 绑定** 中是否有变量名为 `DB` 的 D1 绑定。Git 部署偶尔绑定未生效，手动在「绑定」里选一次数据库即可。

**Q：想让 Worker 检查得更频繁？**
A：面板「参数设置」中可调整「仓库检查间隔」（5 到 60 分钟）与「完整周期时长」（1 到 48 小时）。

---

## 下一步

- 通知渠道设置教程 —— 微信（wxpush）、Telegram、Discord、企业微信、钉钉等渠道的完整对接方法
- README —— 项目总览与环境变量总表
