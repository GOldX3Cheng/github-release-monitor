# 部署指南（图形化，无需本地环境）

仅通过 Cloudflare 网页控制台完成部署，全程约 10 到 15 分钟。

## 前置准备

- **Cloudflare 账号**。免费版即可，创建 D1、部署 Worker 均无需绑卡；仅超过免费额度或升级 Workers Paid（$5/月）才计费。
- **一个可接收消息的 Webhook 地址**。企业微信、钉钉、Telegram 机器人或自建服务均可，格式见[通知渠道文档](docs/notification-channels.md)。
- **GitHub Personal Access Token（可选，推荐）**。不设也能用，但匿名 API 限额仅 60 次/小时；设为 5000 次/小时，并支持监控私有仓库。

## 三种部署方式

| 方式 | 难度 | 说明 |
| --- | --- | --- |
| 方法一 直接粘贴代码 | 低 | 推荐，一次性部署，最稳 |
| 方法二 关联 GitHub 自动部署 | 中 | 推送即部署；D1 的 `database_id` 需手动处理（见方法二说明） |
| 方法三 本地命令行 | 中 | 未实测 |

## 配置位置（通用）

所有配置在 Cloudflare 后台，与 GitHub Secrets 无关。

| 项目 | 配置位置 | 说明 |
| --- | --- | --- |
| 环境变量 / 密钥 | Worker → 设置 → 变量和机密 | `WEBHOOK_URL`、`API_KEY`、`WEBHOOK_AUTH_TOKEN`、`GITHUB_TOKEN`，涉密项勾「加密」 |
| D1 绑定 | Worker → 设置 → 绑定 | 绑定名称 `DB`，下拉选库 |
| `database_id` | wrangler.toml | 方法二、方法三填真实值；方法一无需 |

代码用 `env.WEBHOOK_URL` 等读变量、用 `env.DB` 读库，绑定名必须是 `DB`。

---

## 方法一：直接粘贴代码（推荐）

### 1. 创建 Worker

1. 左侧菜单 **Workers 和 Pages** → **创建应用程序** → **创建 Worker**；
2. 名称填 `github-release-monitor`，点击 **部署**（约 10 秒）。

### 2. 粘贴代码

1. 进入 Worker 页面 **编辑代码**；
2. 清空默认模板，将仓库 `index.js` 全量复制粘贴；
3. 点击 **保存并部署**。

### 3. 创建并绑定 D1（必须）

1. **Workers 和 Pages** → **D1** → **创建数据库**，名称 `github-release-monitor`；
2. Worker 页面 **设置** → **绑定** → **添加** → **D1 数据库**；
3. 变量名称填 `DB`，数据库选刚创建的 `github-release-monitor`，保存；
4. 按提示重新部署使绑定生效。

数据表在首次运行时自动创建，无需手动建表。不绑定会返回 `503`。

### 4. 配置环境变量

**设置** → **变量和机密** → **添加**，涉密项勾「加密」。

| 变量名 | 必填 | 说明 | 示例 |
| --- | --- | --- | --- |
| `WEBHOOK_URL` | 必填 | 通知推送目标（POST JSON） | `https://your-wxpush.workers.dev/wxsend` |
| `API_KEY` | 必填 | 管理面板与 API 访问密钥，随机字符串 | `aB3kF9...` |
| `WEBHOOK_AUTH_TOKEN` | 选填 | 推送携带的 `Authorization` 值（部分渠道需要） | 渠道提供的 token |
| `GITHUB_TOKEN` | 选填（推荐） | 提高 API 限额，支持私有仓库 | `github_pat_...` |

保存后重新部署生效。

### 5. 配置 Cron

**设置** → **触发器** → **添加 Cron 触发器**，输入 `*/5 * * * *`。Cron 用 **UTC**，每 5 分钟唤醒一次，检查节奏由 Worker 内部状态机控制。

### 6. 验证

访问 Worker 地址（形如 `https://github-release-monitor.<子域>.workers.dev`），应看到管理面板。添加仓库（如 `openai/openai-cookbook`）并点「测试」，确认收到通知。

---

## 方法二：关联 GitHub 自动部署

### 1. Fork 仓库

GitHub 打开本仓库，**Fork** 到你的账号。

### 2. 连接 Git

1. Cloudflare **Workers 和 Pages** → **创建应用程序** → **Workers** → **连接到 Git 仓库**；
2. 授权 Cloudflare 访问 GitHub，选择 Fork 出的仓库；
3. 生产分支选 `main`（构建命令留空）。

### 3. 绑定 D1 并配置变量

在部署配置页：

- **D1 数据库 / 绑定**：创建或选择 `github-release-monitor`，绑定名称 `DB`；
- **环境变量**：添加 `WEBHOOK_URL`、`API_KEY`（必填），`WEBHOOK_AUTH_TOKEN`、`GITHUB_TOKEN`（选填），涉密项勾「加密」。

变量在 Cloudflare 配置页填，与 GitHub Secrets 无关。

### 4. 保存并部署

点击 **保存并部署**，约 1 到 2 分钟上线。此后向 `main` 推送即自动部署。

### 关于 database_id（重要）

`wrangler.toml` 里 `database_id` 默认是占位符 `REPLACE_WITH_YOUR_D1_DATABASE_ID`（非法 UUID）。方法二 Git 部署时 Cloudflare **不会自动覆盖**它，重部署校验该字段并报 `no valid database_id`。

处理（二选一）：

- 去 Cloudflare **D1** → 数据库「概览」复制真实 `database_id`，在你 Fork 的仓库把 `wrangler.toml` 里的占位符替换为真实 UUID 并提交；
- 或改用方法一，全程后台操作，不碰 `wrangler.toml`。

---

## 方法三：本地命令行（未实测）

适合习惯 CLI 的用户，以下步骤未经实际验证，仅供参考。

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

# 6. 部署 / 本地调试
npm run deploy
npm run dev
```

---

## 验证与排错

| 现象 | 可能原因 | 处理方式 |
| --- | --- | --- |
| 面板报 `503` | D1 未绑定或绑定名不是 `DB` | **设置 → 绑定** 确认有变量名 `DB` 的 D1 绑定 |
| 重部署报 `no valid database_id` | `wrangler.toml` 的 `database_id` 仍是占位符 | 去 D1「概览」复制真实 id 替换占位符并提交（见方法二） |
| 面板提示 `Unauthorized` | 未设 `API_KEY` | **设置 → 变量和机密** 添加 `API_KEY`，重新部署 |
| 添加仓库后无通知 | `WEBHOOK_URL` 错 / 渠道要 `Authorization` 头 | 核对地址与 `WEBHOOK_AUTH_TOKEN`，点面板「测试」 |
| 面板空白 / 部署失败 | 代码粘贴不全 | 重新全量复制 `index.js` 再保存部署 |
| 通知延迟数小时 | Cron 每 5 分钟只查一个仓库 | 正常节奏，8 小时完成一轮，可在面板调检查间隔 |
| 改了变量没生效 | 变量保存后未重新部署 | 变量页保存后点重新部署确认 |

---

## 常见问题

**Q：环境变量应该写在 GitHub 的 Secrets 里吗？**
A：不应该。三种方式都走 Cloudflare 自己的流水线，运行期只读 Cloudflare 后台的「变量和机密」。GitHub Secrets 只有用 GitHub Actions 部署时才生效。

**Q：数据库绑定名写 DB 还是 database_id？**
A：绑定名写 `DB`（代码 `env.DB` 引用）。`database_id` 是 `wrangler.toml` 的字段，不是绑定名。方法二必须把它从占位符改成真实 UUID，否则重部署报错。

**Q：Cron 的时间是北京时间吗？**
A：不是，Cloudflare Cron 用 UTC。它只负责每 5 分钟唤醒，检查节奏由 Worker 内部状态机控制。

**Q：需要付费吗？**
A：免费版够用。Workers 每日 10 万次请求、D1 有免费存储与读写额度，个人监控几十个仓库在免费范围内。

**Q：改了环境变量要重新部署吗？**
A：要。变量保存后页面会提示重新部署，点确认，否则运行中的 Worker 仍读旧值。

---

## 下一步

- 通知渠道设置教程（微信 wxpush、Telegram、Discord、企业微信、钉钉）
- README（项目总览与环境变量总表）
