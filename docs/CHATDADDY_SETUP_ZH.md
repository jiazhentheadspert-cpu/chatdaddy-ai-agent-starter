# ChatDaddy 设置步骤

## 1. Webhook

在 ChatDaddy:

```text
Settings -> Developer -> Web Hooks -> Create
```

URL:

```text
https://YOUR_WORKER.workers.dev/api/channels/chatdaddy/webhook?project_key=demo
```

Activity 建议先勾：

- `message-insert`
- `message-update`
- `message-status-update` 如果有

Enabled 打开。

## 2. API Token

在 ChatDaddy:

```text
Settings -> Developer -> API Token
```

生成 token 后，放进 Worker secret:

```bash
npm run secret:chatdaddy
```

## 3. Flow / Bot ID

如果你有 ChatDaddy Automation Flow:

1. 打开 Flow 页面。
2. 找 Bot ID，或问 ChatDaddy 团队给 Bot ID。
3. 放进 `wrangler.toml` 或自己的 runtime config。

最小版只需要一个 `CHATDADDY_REPLY_BOT_ID`，用于把 AI 文案发回顾客。

## 4. 上线顺序

建议顺序：

```text
先接 webhook
-> Dashboard 能看到 Case
-> 先人工批准发送
-> 稳定后开低风险自动回复
-> 最后才接自动 Flow / Follow-up
```

不要第一天就全自动。
