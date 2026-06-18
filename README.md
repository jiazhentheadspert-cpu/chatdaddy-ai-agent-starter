# ChatDaddy AI Agent Starter

一个公开安全版的 WhatsApp AI 回复 Agent starter。

它做三件事：

1. 接收 ChatDaddy webhook 的顾客消息。
2. 让 AI 判断：要批准、转人工、订单、Follow-up，固定 Flow 才自动跑。
3. 在 Dashboard 处理 Case，并可写入 Google Sheet 做复盘。

这个 repo 不包含任何真实顾客资料、API token、Google Sheet 链接或生产账号。

## 适合谁

- 已经用 ChatDaddy / WhatsApp Business API。
- 有 ManyChat-style Automation Flow，想加入 AI 判断。
- 需要客服一页式 Dashboard：看顾客状态、批准回复、转人工、复盘学习。

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
dashboard/index.html          客服 / Admin Dashboard
google-sheets/Code.gs         Google Sheet Apps Script 记录表
docs/ONBOARDING_ZH.md         项目 onboarding 方式
docs/CHATDADDY_SETUP_ZH.md    ChatDaddy 设置步骤
docs/AI_REPLY_RULES_ZH.md     AI 回复规则设计
examples/*.json               测试 payload 和 runtime config
```

## 安全原则

- 不要 commit `.env`、`.dev.vars`、`wrangler.toml`、customer data。
- API key 只用 `wrangler secret put`。
- Dashboard 必须用 `ADMIN_TOKEN`。
- 真实顾客资料只存在你的 Worker/KV/Sheet，不进 GitHub。

详细看 [docs/SECURITY_ZH.md](docs/SECURITY_ZH.md)。
