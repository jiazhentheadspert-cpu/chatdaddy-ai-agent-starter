# 正式上线成熟度清单

这份清单用来区分三种状态：

```text
Demo：可以演示流程，但不接真实顾客。
Pilot：可以给一个品牌真实试跑，有人负责设置和监督。
SaaS Ready：陌生客户可以自己注册、连接、上线和排错。
```

当前公开版适合 Demo / Pilot。要对陌生客户正式开放，先补齐下面不需要额外付费服务的基础项。

## 1. 入口和角色

必须完成：

- 每个项目有一个固定入口。
- Owner / Admin / Staff 入口分开。
- Staff 不显示 API URL、Admin Token、Webhook Secret、Runtime 设置。
- 登录页明确显示当前是 Demo、Pilot 还是 Live。
- 客服入口默认进入顾客 Case，不进入系统设置。

验收标准：

```text
客服打开链接后，只看到顾客待办和处理按钮。
客服看不到密钥、配置、部署、Google Sheet 设置。
```

## 2. 项目隔离

必须完成：

- 每个项目有独立 `project_key`。
- Runtime config、ChatDaddy Flow、Google Sheet、Webhook target 都按项目隔离。
- 新项目复制时不能覆盖旧项目设置。
- Dashboard URL 必须带项目身份，不能默认误进 Beyoute。

验收标准：

```text
创建 test project 后，测试 webhook、Sheet、Dashboard 不影响 Beyoute。
```

## 3. 上线 Gate

必须完成：

- 真实顾客入口 OK。
- AI 判断 OK。
- 低风险自动文字回复 OK。
- 高风险强制转人工 OK。
- Google Sheet 记录 OK。
- Flow 自动触发默认关闭，先走人工批准。
- 暂存记录为 0 或已明确提示。

验收标准：

```text
最终检查显示 9/9，通过后才允许进入 Pilot。
```

## 4. 错误处理

必须完成：

- Webhook 没收到文字时，页面告诉用户下一步。
- ChatDaddy API token 失效时，页面显示连接异常。
- Google Sheet 写入失败时，先进入暂存队列。
- 暂存队列可以导出和补写。
- 任何发送失败都不能静默丢失。

验收标准：

```text
系统失败时，用户知道是哪里坏了、下一步要做什么、资料有没有丢。
```

## 5. 操作审计

必须完成：

- AI 建议回复有记录。
- 人工批准、退回、转人工有记录。
- 自动发送有记录。
- Google Sheet 有顾客原话、AI 建议、风险、动作、处理人、时间。
- 学习规则必须能追溯来源 case。

验收标准：

```text
老板可以回看：谁批准了什么、AI 为什么这样判断、下次会不会自动处理。
```

## 5.1 广告成交回流

必须完成：

- ChatDaddy 有 `payment_status`, `purchase_status`, `amount_rm`, `order_value`, `currency`, `order_id` 字段。
- Dashboard 只有在已付款或 COD 已确认时才允许按「记录成交」。
- `Purchase` 事件必须带 `value` 和 `currency=MYR`。
- Meta Pixel ID 和 CAPI Access Token 已经放进 Worker secrets。
- Test Event 已经在 Meta Events Manager 看到。
- 自动追踪默认关闭，测试通过后才开。

验收标准：

```text
客服按「记录成交」后，Case 变成已成交；Meta Test Events 能看到 Purchase 和 RM 金额。
```

## 6. 客服工作边界

必须完成：

- 客服只处理 ChatDaddy Inbox / Dashboard Case。
- 客服不碰 Cloudflare、Supabase、Wrangler、API token。
- 客服不知道下一步时，只看一个入口。
- 医疗、退款、投诉、低信心默认转人工。

验收标准：

```text
给新客服一条链接和一份短 SOP，客服可以开始处理 Case。
```

## 7. 当前不做的事项

这些不是当前优先级：

- 计费系统
- 套餐限制
- 自助购买
- 发票
- Stripe
- 大规模多租户权限后台

当前商业方式更适合：

```text
帮客户部署和运营的 AI Agent Pilot / Managed Service
```

不是：

```text
完全自助注册、自己付费、自己上线的成熟 SaaS
```

## 8. 对外表述

推荐说法：

```text
这是一个可上线试跑的 AI 客服运营中控台。
先用 Pilot 模式部署到一个品牌，确认真实回复、转人工、记录表和复盘闭环，再复制到下一个品牌。
```

不要说：

```text
客户无需任何设置，马上像成熟 SaaS 一样自助上线。
```
