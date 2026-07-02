# ReplyPilot AI Agent Starter

一个公开安全版的 WhatsApp AI 客服运营中控台 starter。

当前定位：

```text
Demo / Pilot ready
```

适合给一个品牌真实试跑、验证客服闭环、再复制到下一个项目。它还不是陌生客户自助注册、自助计费、自助上线的完整 SaaS。

它做三件事：

1. 接收 ChatDaddy webhook 的顾客消息。
2. 让 AI 判断：要批准、转人工、订单、Follow-up，固定 Flow 才自动跑。
3. 在 Dashboard 处理 Case，并可写入 Google Sheet 做复盘。

这个 repo 不包含任何真实顾客资料、API token、Google Sheet 链接或生产账号。

## 适合谁

- 已经用 ChatDaddy / WhatsApp Business API。
- 有 ManyChat-style Automation Flow，想加入 AI 判断。
- 需要客服一页式 Dashboard：看顾客状态、批准回复、转人工、复盘学习。
- 接受先用 Pilot / Managed setup 跑通一个品牌，再复制到更多品牌。

## 不适合谁

- 期待像成熟 SaaS 一样，陌生客户自己注册、自己付款、自己连接、自己上线。
- 没有人负责连接 ChatDaddy webhook、Flow、Google Sheet 和上线检查。
- 想一开始就全自动发送所有 AI 回复，不做人工批准和风险控制。

## 架构

```text
WhatsApp
  -> ChatDaddy webhook
  -> Cloudflare Worker AI Agent
  -> Dashboard approval / auto send
  -> ChatDaddy send message or trigger flow
  -> Google Sheet log
```

## 快速开始

IT 开发交接主文档：

```text
docs/AI_REPLY_SYSTEM_FLOW_ZH.md
docs/IT_DEVELOPMENT_HANDOFF_AI_REPLY_HERMAS_ZH.md
docs/HERMAS_CLOUDFLARE_AGENTS_SDK_ROADMAP.md
```

`AI_REPLY_SYSTEM_FLOW_ZH.md` 是老板真实 Flow：客服只盯 Dashboard、价格图前后怎么回答和接 Flow、什么时候人工、人工后怎么复盘学习、ManyChat 怎么对标、Mark as Paid 怎么回流 Ads Manager。

这份文档解释完整流程：Hermas approval-first、Dashboard 操作、ChatDaddy/Manychat adapter、Case 状态、学习复盘、Meta Purchase 回流、API 合约、上线 gate、以及哪些内容不能进入 GitHub。

`HERMAS_CLOUDFLARE_AGENTS_SDK_ROADMAP.md` 是下一步 Cloudflare Agents SDK 迁移路线：Agent runtime、Supabase、ChatDaddy webhook、onboarding 框架、自动回复等级和老板/Tech Team 需要提供的资料。

Dashboard demo:

```text
https://jiazhentheadspert-cpu.github.io/chatdaddy-ai-agent-starter/
```

打开就会进入 Login 页面。现在是可演示版本，不需要真实账号密码：

- Owner：老板 / 系统拥有者，看全部。
- Admin：运营负责人，处理 Case 和复盘。
- Staff：客服，只看要批准 / 要人工 / 订单，不看 Token、API、系统设置。

也可以直接给团队不同入口：

```text
Owner: dashboard/?project_key=beyoute&role=owner&view=overview
Admin: dashboard/?project_key=beyoute&role=admin&view=overview
Staff: dashboard/?project_key=beyoute&role=staff&view=cases
```

正式上线后，这些会换成真实账号登录；现在的公开版先用来确认操作流程和权限体验。

## SaaS v1 登录和团队管理

正式版本已经改成账号登录：

```text
login.html       管理员 / 客服邮箱密码登录
admin.html       管理台：项目、成员、连接状态、上线准备
dashboard/       客服操作台：待处理、批准、转人工、订单/付款、自动记录
```

账号登录使用 Worker + D1：

```text
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/session
GET  /api/me/projects
GET  /api/admin/users
POST /api/admin/users
PATCH /api/admin/users/{user_id}
POST /api/admin/users/{user_id}/reset-password
POST /api/admin/projects/{project_key}/members
```

session 存在 HttpOnly cookie。正式客服不需要知道安全码，也不应该在 URL、浏览器储存或客服页面看到 token。

默认 CORS 来源是公开 demo 的 GitHub Pages 域名；如果生产前端改成其他域名，IT 要把 Worker 里的允许来源改成生产域名，或直接把前端和 Worker 放在同域。

第一次建立 admin：

1. 先跑 D1 migration：`migrations/0003_saas_auth.sql`。
2. 用旧 `ADMIN_TOKEN` 只做一次 bootstrap，调用 `POST /api/admin/users` 创建 admin 账号。
3. 之后 admin 用邮箱密码登录 `admin.html` 创建 staff、分配项目、停用账号或重置密码。
4. staff 登录后默认进入 `dashboard/?role=staff&view=cases`，只看顾客处理，不看系统配置。

新项目复制仍默认 `approval_first`。上线前必须通过项目资料、渠道连接、客服边界、测试 case 和 secrets 不外露检查。

Owner/admin 新公司设置入口：

```text
setup/index.html
```

这个页面只问业务问题：公司、品牌大脑、客服回复资料、审批边界、AI 成本保护。它不收 API key、provider token、webhook secret、database credentials、ChatDaddy Flow ID 或 Manychat credentials。创建出来的项目仍然是 approval-first，不会直接让 AI 接管发送。

Owner/admin 渠道连接入口：

```text
channel-setup/index.html
```

这个页面只登记 channel metadata，并给技术人员安全存放凭证的 checklist。真实 credentials 必须放在 Cloudflare secrets 或 provider vault，不进入 Dashboard、不进入 project package。

上线成熟度清单看：

```text
docs/PRODUCTION_READINESS_ZH.md
```

进入 Dashboard 后，如果没有填 API URL 和 Admin Token，会自动进入 Public Demo 模式。你可以直接试：

- 切换行业场景
- 点击顾客 Case
- 看 Word Cloud
- 改 AI 建议回复
- 点批准发送
- 点转人工
- 点以后类似 Case 自动通过

如果要连接真实系统，才需要输入自己的 Worker API URL 和 Admin Token。

1. 安装依赖。

```bash
npm install
```

2. 复制配置。

```bash
cp wrangler.toml.example wrangler.toml
```

3. 建 Cloudflare KV，把 KV id 放进 `wrangler.toml`。

```bash
npx wrangler kv namespace create AGENT_KV
```

4. 放 secrets。

```bash
npm run secret:openai
npm run secret:chatdaddy
npm run secret:admin
npm run secret:webhook
```

5. 本地测试。

```bash
npm run dev
```

6. 部署。

```bash
npm run deploy
```

7. 把 Worker webhook URL 放到 ChatDaddy。

```text
https://YOUR_WORKER.workers.dev/api/channels/chatdaddy/webhook?project_key=demo
```

8. 打开 Dashboard。

```text
dashboard/index.html
```

在 Dashboard 输入：

- API URL: `https://YOUR_WORKER.workers.dev`
- Admin Token: 你放进 `ADMIN_TOKEN` 的值
- Project Key: `demo`

## ChatDaddy Webhook Activity

建议先勾：

- `message-insert`
- `message-update`
- `message-status-update` 如果账号有这个选项

先不要一开始开全自动。建议先：

1. `AUTO_SEND=false`
2. Dashboard 审批 20-50 个真实 case
3. 找出稳定低风险类型
4. 再逐步开启已验证的自动规则

## 核心闭环

```text
顾客问问题
  -> AI 判断 intent / stage / risk
  -> 广告关键词：ChatDaddy Step 1 自己发，AI 不补发
  -> 顾客疑问：Dashboard 待批准，客服确认后再发
  -> 中风险：Dashboard 批准
  -> 高风险：转人工
  -> 已下单：收资料 / 交给订单流程
  -> 每次决定写入 history
  -> 人工批准后可点 Learn，以后类似 case 少审批
```

## 文件说明

```text
src/worker.js                 Cloudflare Worker
admin.html                    Admin 管理台
login.html                    邮箱密码登录入口
dashboard/index.html          客服 / Admin Dashboard
google-sheets/Code.gs         Google Sheet Apps Script 记录表
migrations/0003_saas_auth.sql D1 账号、session、项目成员和审计表
docs/ONBOARDING_ZH.md         项目 onboarding 方式
docs/CHATDADDY_SETUP_ZH.md    ChatDaddy 设置步骤
docs/META_CAPI_PURCHASE_ZH.md Meta Purchase + RM 金额回流
docs/AI_REPLY_RULES_ZH.md     AI 回复规则设计
docs/AI_REPLY_SYSTEM_FLOW_ZH.md  老板真实 Flow 和 IT 开发方向
docs/IT_DEVELOPMENT_HANDOFF_AI_REPLY_HERMAS_ZH.md  IT 开发交接总流程
setup/check_ads_manager_purchase_go_live.command  Ads Manager 回流验收
setup/set_meta_capi_purchase_auto_track.command   只开启 ChatDaddy paid -> Purchase 自动回流
setup/test_chatdaddy_paid_webhook_purchase.command ChatDaddy paid webhook 测试
examples/*.json               测试 payload 和 runtime config
```

## 安全原则

- 不要 commit `.env`、`.dev.vars`、`wrangler.toml`、customer data。
- API key 只用 `wrangler secret put`。
- Dashboard 必须用 `ADMIN_TOKEN`。
- 真实顾客资料只存在你的 Worker/KV/Sheet，不进 GitHub。
- Staff 入口不应该显示 API URL、Admin Token、Webhook Secret 或 runtime 设置。
- Pilot 阶段先保持 Flow 自动触发关闭，确认稳定后再逐步开放。
- 全自动客服接管必须走 Hermas autonomous gate；复制项目时先保持客服批准优先。
- Meta Purchase 必须用稳定 `order_id + currency + amount/order_value` 去重。同一成交不能重复回流 Ads Manager；已经记录成交但当时 Meta 未接好时，只能在同一张 Case 按「补回流 Meta」。

详细看 [docs/SECURITY_ZH.md](docs/SECURITY_ZH.md)。
