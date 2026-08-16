# 📨 通知渠道设置教程

本项目通过 **Webhook（POST JSON）** 推送通知。你只需要配置两个环境变量：

- `WEBHOOK_URL` —— 推送目标地址；
- `WEBHOOK_AUTH_TOKEN` —— （可选）推送到目标时携带的 `Authorization` 请求头值。

然后根据渠道要求，在管理面板的「通知模板」里调整消息字段即可。

---

## 0. 先理解模板引擎

管理面板的「通知模板」是一份 JSON，包含 `update`（新版本通知）与 `alert`（异常告警）两个对象。

模板引擎规则：

- **顶层字符串字段**支持变量替换，例如 `"content": "{repo_name} 发布了 {tag}"`；
- **其他类型字段**（数字、布尔、嵌套对象）会原样透传；
- 可用变量见下表（不允许使用未声明的变量，否则保存会被拒绝）。

| 通知类型 | 可用变量 |
| --- | --- |
| `update`（新版本） | `{repo}` 完整仓库名（`作者/仓库名`）、`{repo_name}` 仓库名、`{url}` / `{repo_url}` Releases 链接、`{tag}` 最新版本标签 |
| `alert`（异常） | `{repo}` 完整仓库名、`{message}` 异常信息 |

> 大多数渠道会忽略额外字段，因此可以放心保留默认模板的 `title` / `content` 等字段。

---

## 1. 微信消息推送：wxpush（与项目同源，推荐）

本项目推送部分参考自 [frankiejun/wxpush](https://github.com/frankiejun/wxpush)（MIT）。wxpush 是一个极简免费的**微信模板消息推送服务**，支持微信原生弹窗 + 声音提醒。

### 前置准备

1. 按 [wxpush 部署指南](https://github.com/frankiejun/wxpush) 部署好 wxpush 服务（约 5 分钟）；
2. 在微信公众平台准备好**服务号**（需「模板消息」权限）、模板消息 ID、接收人 OpenID。

### 配置

| 配置项 | 值 |
| --- | --- |
| `WEBHOOK_URL` | `https://<你的wxpush地址>/wxsend` |
| `WEBHOOK_AUTH_TOKEN` | 你的 wxpush `API_TOKEN` |

### 通知模板（可直接使用默认模板）

wxpush 的 `/wxsend` 接口读取 `title` 与 `content` 字段，与本项目默认模板完全对齐，**无需修改**：

```json
{
  "update": {
    "title": "📢 项目更新通知",
    "content": "{repo_name}\n{url}",
    "platform": "GitHub",
    "username": "{repo_name}",
    "eventLabel": "📢",
    "taskType": "项目更新",
    "taskStatus": "{tag}",
    "filename": "{repo_name}",
    "error": "{url}"
  },
  "alert": {
    "title": "🚨 监控异常告警",
    "content": "{repo}\n{message}",
    "platform": "GitHub Monitor",
    "username": "System Alert",
    "eventLabel": "🚨",
    "taskType": "异常通知",
    "taskStatus": "Failed",
    "filename": "{repo}",
    "error": "{message}"
  }
}
```

想更简洁可以只保留两个字段：

```json
{
  "update": { "title": "📢 项目更新通知", "content": "{repo_name} 发布了新版本 {tag}\n{url}" },
  "alert": { "title": "🚨 监控异常告警", "content": "{repo}\n{message}" }
}
```

---

## 2. Telegram Bot

### 获取 Webhook 地址

1. 在 Telegram 中向 **@BotFather** 发送 `/newbot`，按提示创建机器人，获得 `BOT_TOKEN`；
2. 获取 `chat_id`：给机器人发一条消息后，向 **@userinfobot** 发送 `/start`，即可看到你的 `id`（或调用 `getUpdates` API 查询）。

### 配置

| 配置项 | 值 |
| --- | --- |
| `WEBHOOK_URL` | `https://api.telegram.org/bot<BOT_TOKEN>/sendMessage` |
| `WEBHOOK_AUTH_TOKEN` | 留空 |

### 通知模板

`chat_id` 是固定值（顶层字符串、不含变量），`text` 支持变量：

```json
{
  "update": {
    "chat_id": "123456789",
    "text": "📢 {repo_name} 发布了新版本 {tag}\n🔗 {url}"
  },
  "alert": {
    "chat_id": "123456789",
    "text": "🚨 监控异常：{repo}\n{message}"
  }
}
```

---

## 3. Discord Webhook

### 获取 Webhook 地址

进入你的 Discord 服务器 → 频道右上角 **设置（齿轮）** → **集成（Integrations）** → **Webhooks** → **新建 Webhook** → 复制 Webhook URL。

### 配置

| 配置项 | 值 |
| --- | --- |
| `WEBHOOK_URL` | 复制的 Discord Webhook URL（形如 `https://discord.com/api/webhooks/...`） |
| `WEBHOOK_AUTH_TOKEN` | 留空 |

### 通知模板

Discord 的 Webhook 读取顶层 `content` 字段，支持 Markdown：

```json
{
  "update": {
    "content": "📢 **{repo_name}** 发布了新版本 **{tag}**\n🔗 {url}"
  },
  "alert": {
    "content": "🚨 监控异常：**{repo}**\n{message}"
  }
}
```

---

## 4. Slack Incoming Webhook

### 获取 Webhook 地址

访问 [api.slack.com/apps](https://api.slack.com/apps) → 创建 App → 启用 **Incoming Webhooks** → 添加新 Webhook 并选择频道 → 复制 Webhook URL。

### 配置

| 配置项 | 值 |
| --- | --- |
| `WEBHOOK_URL` | 复制的 Slack Webhook URL（形如 `https://hooks.slack.com/services/...`） |
| `WEBHOOK_AUTH_TOKEN` | 留空 |

### 通知模板

Slack 读取顶层 `text` 字段，支持 Markdown：

```json
{
  "update": {
    "text": "📢 *{repo_name}* 发布了新版本 *{tag}*\n{url}"
  },
  "alert": {
    "text": "🚨 监控异常：*{repo}*\n{message}"
  }
}
```

---

## 5. 企业微信群机器人

### 获取 Webhook 地址

企业微信群里 → 右上角 **群设置** → **群机器人** → **添加机器人** → 复制 Webhook URL（形如 `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx`）。

### 配置

| 配置项 | 值 |
| --- | --- |
| `WEBHOOK_URL` | 复制的企业微信机器人 Webhook URL |
| `WEBHOOK_AUTH_TOKEN` | 留空 |

### 通知模板

企业微信要求 `{ "msgtype": "text", "text": { "content": "..." } }` 的**嵌套结构**。受当前模板引擎限制（仅顶层字符串字段支持变量替换），嵌套内容里无法注入动态变量，可使用固定文案：

```json
{
  "update": {
    "msgtype": "text",
    "text": { "content": "📢 GitHub Release 监控：有项目发布了新版本，请前往面板查看。" }
  },
  "alert": {
    "msgtype": "text",
    "text": { "content": "🚨 GitHub Release 监控异常，请前往面板查看。" }
  }
}
```

> 💡 需要动态内容时，可自建一个「中转」Webhook：把本项目的扁平 JSON 转成企业微信格式后再转发（本项目推送逻辑本身也支持这类自建服务，见第 8 节）。

---

## 6. 钉钉群机器人

### 获取 Webhook 地址

钉钉群 → **群设置** → **智能群助手** → **添加机器人**（选「自定义」）→ 安全设置选 **「自定义关键词」**（本项目 `WEBHOOK_URL` 是固定值、无法动态计算加签，选加签会使推送全部失败）→ 复制 Webhook URL（形如 `https://oapi.dingtalk.com/robot/send?access_token=xxx`）。

### 配置

| 配置项 | 值 |
| --- | --- |
| `WEBHOOK_URL` | 复制的钉钉机器人 Webhook URL |
| `WEBHOOK_AUTH_TOKEN` | 留空 |

### 通知模板

钉钉同样要求嵌套结构，固定文案写法：

```json
{
  "update": {
    "msgtype": "text",
    "text": { "content": "📢 GitHub Release 监控：有项目发布了新版本，请前往面板查看。" }
  },
  "alert": {
    "msgtype": "text",
    "text": { "content": "🚨 GitHub Release 监控异常，请前往面板查看。" }
  }
}
```

> 关键词需出现在 `content` 中，例如固定加 `GitHub` 字样。钉钉加签依赖每次请求的动态签名，本项目不支持，请勿选择。

---

## 7. Bark（iOS 推送）

### 获取 Webhook 地址

App Store 安装 **Bark** → 打开 App 复制推送地址（形如 `https://api.day.app/<你的KEY>`）。

### 配置

| 配置项 | 值 |
| --- | --- |
| `WEBHOOK_URL` | 你的 Bark 推送地址（`https://api.day.app/<KEY>`） |
| `WEBHOOK_AUTH_TOKEN` | 留空 |

### 通知模板

Bark 读取顶层 `title` 与 `body` 字段：

```json
{
  "update": {
    "title": "📢 项目更新通知",
    "body": "{repo_name} 发布了新版本 {tag}\n{url}"
  },
  "alert": {
    "title": "🚨 监控异常告警",
    "body": "{repo}\n{message}"
  }
}
```

---

## 8. 自建 / 其他 Webhook

只要目标接口接收 **POST JSON**，都可以对接：

1. `WEBHOOK_URL` 填你的接口地址；
2. 若接口需要鉴权，把 token 填到 `WEBHOOK_AUTH_TOKEN`（会作为 `Authorization` 请求头发送）；
3. 在「通知模板」中按对方接口的字段要求配置 `update` / `alert` 两个对象（顶层字符串字段支持变量，见第 0 节）。

常见示例（ntfy 自托管推送）：

```json
{
  "update": {
    "topic": "github-release-monitor",
    "title": "📢 项目更新通知",
    "message": "{repo_name} 发布了新版本 {tag}\n{url}"
  },
  "alert": {
    "topic": "github-release-monitor",
    "title": "🚨 监控异常告警",
    "message": "{repo}\n{message}"
  }
}
```

---

## 9. 测试与排错

1. **面板测试**：打开管理面板 → 点击 **「测试」**，会强制对第一个仓库推送一次（10 秒内限一次）。测试成功表示链路通畅；
2. **查看返回**：面板会显示测试结果，包括 `push_ok`（Webhook 是否推送成功）；
3. **常见失败**：
   - `push_ok: false`：检查 `WEBHOOK_URL` 是否正确、渠道是否要求 `Authorization`（wxpush 需要）、模板字段是否与渠道要求一致；
   - 渠道无反应但 `push_ok: true`：模板字段与渠道不匹配（例如企业微信缺少嵌套结构），对照上文调整；
   - GitHub 拉取失败（不是推送失败）：检查 `GITHUB_TOKEN` 是否有效、仓库名拼写是否正确。

---

## 下一步

- 🚀 [部署指南](./deployment-guide.md) —— 从零开始图形化部署
- 📖 [README](../README.md) —— 项目总览与环境变量总表
