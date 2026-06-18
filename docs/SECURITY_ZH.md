# 安全说明

公开 GitHub repo 不能放：

- `.env`
- `.dev.vars`
- `wrangler.toml` 真实版本
- API token
- ChatDaddy Account ID 如果你不想公开
- Google Sheet `/exec` URL
- 顾客电话、姓名、地址、receipt
- 真实聊天记录
- 生产 runtime config

这个 starter 只放：

- 通用 Worker 代码
- 通用 Dashboard
- Google Sheet Apps Script 模板
- Demo payload
- 文档

## 正确放 secret

用 Cloudflare Wrangler:

```bash
wrangler secret put OPENAI_API_KEY
wrangler secret put CHATDADDY_API_KEY
wrangler secret put CHATDADDY_WEBHOOK_SECRET
wrangler secret put ADMIN_TOKEN
wrangler secret put GOOGLE_SHEET_SECRET
```

不要把 secret 写进 GitHub。
