# Meta CAPI 成交回流

目标：让客服在 Dashboard 确认成交后，把 `Purchase` 和 RM 金额回传到 Meta Ads Manager。

## 最小闭环

```text
ChatDaddy / WhatsApp 顾客
-> Dashboard Case
-> 客服确认已付款或 COD 已确认
-> 按「记录成交」
-> Worker 记录成交
-> Worker 同步 ChatDaddy 字段
-> Worker 发送 Meta CAPI Purchase
-> Ads Manager 收到 Purchase + value
```

## 不能乱按

只有这两种情况可以按「记录成交」：

- 已收到付款。
- COD 订单已经确认。

顾客说“我要”、“可以”、“有兴趣”不等于成交，不要送 `Purchase`。

## Dashboard 会送什么

Dashboard 调用：

```http
POST /api/hermas/projects/{project_key}/cases/{case_id}/mark-purchase
```

Body:

```json
{
  "amount_rm": 378,
  "currency": "MYR",
  "order_id": "PROJECT_20260623_001",
  "confirmMetaSend": true
}
```

Worker 会做：

1. 把 Case 标成 `purchase_confirmed`。
2. 同步 ChatDaddy tag / custom fields。
3. Meta credentials 齐全时发送 `Purchase`。

如果 Meta credentials 不齐，Worker 只记录成交，不会假装已经回流。

## 去重规则

Dashboard 手动「记录成交」和 ChatDaddy paid/COD webhook 都可能触发 `Purchase`。Worker 必须用这组字段去重：

```text
Purchase + order_id + currency + amount/order_value
```

同一笔订单只送一次。Dashboard 先送、ChatDaddy 后触发，或 ChatDaddy 先触发、Dashboard 后再按，第二次都应该标成 `deduped`，不能重复送 Ads Manager。

## ChatDaddy Custom Fields

建议每个项目都建同一组字段：

```text
lead_status
order_status
payment_status
purchase_status
order_id
amount_rm
order_value
currency
ctwa_clid
source_id
ad_id
campaign_id
adset_id
flow_id
flow_name
button_clicked
```

成交最少需要：

```text
payment_status = paid
purchase_status = confirmed
amount_rm = 378
order_value = 378
currency = MYR
order_id = PROJECT_20260623_001
```

`amount_rm` 和 `order_value` 用数字，不要写 `RM378`。

## Meta 设置

每个广告账户需要：

- Meta Pixel ID
- Meta CAPI Access Token
- Test Event Code，可选但建议测试时填

配置后先保持自动追踪关闭，只测试手动事件。

```bash
./set_meta_capi_secrets.command
./check_meta_capi_status.command
./SEND_Meta_CAPI_Test_Event.command
```

Test Event 在 Meta Events Manager 看到后，才考虑开启自动追踪。

如果只要 ChatDaddy `payment_status / purchase_status` 已确认后自动送 `Purchase`，先开 Purchase-only 开关：

```bash
./setup/set_meta_capi_purchase_auto_track.command
```

这个开关只处理 paid / COD confirmed + `amount_rm` 或 `order_value` 的 webhook，不会打开 Lead、Receipt、Flow Step 自动追踪。

上线前先用示例 payload 测一次：

```bash
API_BASE=https://your-worker.workers.dev \
PROJECT_KEY=demo \
./setup/test_chatdaddy_paid_webhook_purchase.command
```

示例 payload 在 `examples/chatdaddy-paid-purchase-webhook.json`。

```bash
./set_meta_capi_auto_track.command
```

## 自动事件和手动成交的区别

- 手动成交：客服按「记录成交」，只送 `Purchase`，要求金额。
- ChatDaddy paid webhook：字段显示已付款 / COD confirmed 且有金额时，才可以自动送 `Purchase`。
- 自动追踪：ChatDaddy webhook 触发 Lead、ViewContent、AddPaymentInfo 等事件。

Pilot 期间建议：

```text
手动成交先上线
自动 Lead / Receipt / Flow Step 先观察
确认不会重复或乱送后再打开自动追踪
```

## 复制到其他项目

复制新项目只换：

1. `project_key`
2. ChatDaddy webhook URL 的 project key
3. Meta Pixel ID + CAPI Access Token
4. ChatDaddy Flow ID / custom fields

Dashboard 和 Worker 逻辑不用重写。
