<div align="center">

# GitHub Release Monitor

**运行在 Cloudflare Workers 上的 GitHub Release 监控与通知服务**

自动监听关注的仓库，发布新版本时通过 Webhook 推送通知（企业微信 / 钉钉 / Telegram / 自建服务）。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Runtime: Cloudflare Workers](https://img.shields.io/badge/runtime-Cloudflare%20Workers-F38020.svg)]()
[![UI: Material Design 3](https://img.shields.io/badge/UI-Material%20Design%203-6750A4.svg)](docs/MD3_DESIGN.md)

</div>

---

## 教程文档

部署与配置以文档为准，README 仅作概览。

- [🚀 部署指南（图形化，无需本地环境）](docs/deployment-guide.md) — 方法一/二/三、环境变量、绑定、排错
- [📨 通知渠道设置](docs/notification-channels.md) — wxpush 微信 / Telegram / Discord / 企业微信 / 钉钉 / Bark
- [🎨 UI 设计规范（Material Design 3）](docs/MD3_DESIGN.md) — 设计令牌、组件、动效、明暗主题规范

## 功能特性

- 纯 Serverless，部署到 Cloudflare Workers，零服务器维护
- Cron 定时轮询 + 状态机，仓库间隔与周期时长可调
- D1 持久化，记录检查状态、版本、错误计数，重启不丢
- ETag 条件请求，命中 304 不消耗 GitHub API 配额
- 模板化通知，标题/内容/字段可自定义
- **站内通知中心**：更新以服务端为准，关掉即删除，换设备/换浏览器状态一致
- **免打扰时段**：指定时段内不推送，期间的更新保留并在结束后补发
- 批量导入（TXT）/ 导出仓库列表，支持 `owner/repo|备注` 格式
- 每个仓库可单独填写备注，失焦自动保存
- 扁平 Material Design 3 界面，明暗双主题自动跟随系统
- API 鉴权（`X-API-Key`）

## 工作原理

```mermaid
flowchart LR
    A["Cloudflare Cron<br/>（默认每 5 分钟）"] --> B["github-release-monitor<br/>Cloudflare Worker"]
    B --> C["GitHub Releases API"]
    C -->|"最新 tag / 304"| B
    B <--> D[("D1 数据库<br/>状态 · 仓库 · 缓存")]
    B -->|"发现新版本"| E["Webhook 推送"]
    E --> F["企业微信 / 钉钉 /<br/>Telegram / 自建服务"]
    B -->|"写入 release_events"| G["站内通知中心"]
    H["管理面板 Dashboard"] -->|"X-API-Key"| B
```

Worker 内部为简单状态机：waiting（等待周期结束，默认 8 小时）→ checking（每 5 分钟取下一仓库查最新 Release）→ tag 变化则推送并更新，全部查完回到 waiting。

## 部署

详见[部署指南](docs/deployment-guide.md)。要点：

- **图形化（推荐）**：Cloudflare 后台创建 Worker、粘贴 `index.js`、绑定 D1（名称 `DB`）、配变量，约 10 分钟。
- **命令行（未实测）**：`npx wrangler login` → `wrangler d1 create` → `wrangler secret put` → `npm run deploy`。
- 所有配置在 Cloudflare 后台（变量和机密 / 绑定），与 GitHub Secrets 无关。
- 方法二需注意 `wrangler.toml` 的 `database_id` 占位符不会自动覆盖，详见部署指南。

## 环境变量与绑定

配在 Cloudflare 后台（Worker → 设置 → 变量和机密 / 绑定），不在代码与仓库中。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `WEBHOOK_URL` | 是 | 通知推送目标（POST JSON），完整格式见[通知渠道文档](docs/notification-channels.md) |
| `API_KEY` | 是 | 管理面板与 API 访问密钥，随机串（如 `openssl rand -hex 16`） |
| `WEBHOOK_AUTH_TOKEN` | 否 | 推送携带的 `Authorization` 值，部分渠道需要 |
| `GITHUB_TOKEN` | 否 | GitHub Token，提升 API 限额、支持私有仓库 |

**D1 绑定**：名称 `DB`（代码 `env.DB` 访问），后台「绑定」里添加 D1 数据库并选库，无需手填 UUID。数据表首次运行时自动创建。

## 管理面板

访问 Worker 域名打开控制台：增删监控仓库（`作者/仓库名`）、调检查间隔（5–60 分钟）与周期时长（1–48 小时）、编辑通知模板、在线测试、手动触发周期。「正在监控的项目」列表含「备注」列，可内联填写每个仓库的用途以便区分，失焦自动保存。

面板由 `API_KEY` 保护，打开时需在地址后加 `?key=<API_KEY>`（或请求头 `X-API-Key`）；`API_KEY` 即部署时配置的环境变量，无复杂度要求。直接打开裸域名会提示「鉴权失败」，补上 key 即可。详见[部署指南](docs/deployment-guide.md) 步骤 6。

界面为扁平 Material Design 3：层级由 tonal 表面色表达而非阴影，按钮为胶囊形，明暗主题自动跟随系统。

| 浅色 | 深色 |
| --- | --- |
| ![管理面板（浅色）](docs/assets/dashboard-screenshot.png) | ![管理面板（深色）](docs/assets/dashboard-dark.png) |

右侧抽屉收纳通知中心与设置，设置按分组折叠：

![通知中心抽屉](docs/assets/drawer-notifications.png)

![设置抽屉](docs/assets/drawer-settings.png)

## HTTP API

所有 `/api/*` 需鉴权：`X-API-Key: <API_KEY>`（或 `?key=`）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/get-settings` | 读参数与状态 |
| POST | `/api/save-settings` | 存参数（`repoIntervalMinutes` / `cycleIntervalHours` / `dnd`） |
| GET | `/api/get-notification-config` | 读通知模板 |
| POST | `/api/save-notification-config` | 存通知模板 |
| GET | `/api/get-notify-channel` | 读自定义 Webhook 通道 |
| POST | `/api/save-notify-channel` | 存自定义 Webhook 通道 |
| GET | `/api/get-inapp-channel` | 读站内通知开关 |
| POST | `/api/save-inapp-channel` | 存站内通知开关 |
| GET | `/api/get-updates` | 读站内未关闭通知列表 |
| POST | `/api/dismiss-update` | 关闭并**永久删除**某条通知，`{ "id": 123 }` |
| POST | `/api/clear-updates` | 清空全部站内通知 |
| GET | `/api/get-repos` | 读仓库列表（含健康状态） |
| POST | `/api/add-repo` | 加仓库，`{ "repo": "作者/仓库名" }` |
| POST | `/api/delete-repo` | 删仓库 |
| POST | `/api/update-note` | 更新仓库备注 |
| POST | `/api/import-repos` | 批量导入仓库 |
| GET | `/api/export-repos` | 导出仓库列表 |
| GET | `/api/test` | 测首个仓库并推送（10 秒限频） |
| POST | `/api/trigger-cycle` | 手动触发新一轮检测 |

## 容错与告警

- GitHub 限流 / 5xx：退避重试一次
- 连续失败 5 次触发一次告警，24 小时过期，恢复后连续 3 次成功清除
- 仓库改名自动迁移记录
- **404 不再直接判死**：`/releases/latest` 返回 404 时，先探测仓库本体；仓库仍在则回退读取 `releases` 列表取最新非草稿版本
  - 仓库存在但从未发过正式 Release → 标记「无发布」，不算失效
  - 仓库本体也 404 → 按可恢复失败计次告警，不再一次性标记永久失败
- 旧版本遗留的「永久失败」标记改为 6 小时冷却后复查，恢复成功即自动清除

## 健康状态说明

列表徽章共五种，鼠标悬停可看判定依据：

| 徽章 | 含义 | 处理 |
| --- | --- | --- |
| 正常 | 最近一次检测成功 | — |
| 无发布 | 仓库存在但没有正式 Release | 正常现象，不算故障 |
| 观察中 | 曾判定失效，复查已恢复 | 自动清除 |
| 异常 | 连续失败但未达阈值 | 继续观察 |
| 失效 | 仓库本体 404 且连续失败达阈值 | 检查仓库是否改名/删除 |

## 常见问题

**Q：刚添加仓库就收到一条通知？**
A：正常。首次监控会推送当前最新 Release 作基线，确认链路通畅；之后仅新版本通知。

**Q：在一台设备上关掉通知，另一台设备还在？**
A：不会。关闭操作是服务端删除（`DELETE FROM release_events`），所有设备下次拉取即同步消失。

**Q：需要付费吗？**
A：Cloudflare 免费版即可（每日 10 万请求、D1 免费额度），个人使用足够。注意免费计划每账号最多 5 个 cron trigger。

**Q：没有 GITHUB_TOKEN 可以吗？**
A：可以，但匿名限额 60 次/小时。仓库多或监控私有仓库时建议配置。

## 致谢

Webhook 推送参考 [frankiejun/wxpush](https://github.com/frankiejun/wxpush)（MIT）。

## 友情链接

- [Linux.do 社区](https://linux.do/)

## License

[MIT](LICENSE) © github-release-monitor contributors
