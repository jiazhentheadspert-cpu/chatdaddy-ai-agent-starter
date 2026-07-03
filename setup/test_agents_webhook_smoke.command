#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

echo "=============================================="
echo "Test Hermas Agents Webhook Smoke"
echo "=============================================="
echo ""
echo "小白版：这个只发送一条测试 payload 给 Worker。"
echo "它不会发 WhatsApp 给顾客；只检查 Worker 会不会产生正确建议。"
echo ""

if [[ -z "${AGENTS_API_BASE:-}" ]]; then
  read -r "?Paste Agents API base，例如 https://xxx.workers.dev 或 http://127.0.0.1:8787: " AGENTS_API_BASE
fi

if [[ -z "${CHATDADDY_WEBHOOK_SECRET:-}" ]]; then
  read -r "?Paste webhook secret（可空，直接 Enter 跳过）: " CHATDADDY_WEBHOOK_SECRET
fi

/usr/bin/python3 - "$AGENTS_API_BASE" "$CHATDADDY_WEBHOOK_SECRET" <<'PY'
import json
import sys
import time
import urllib.error
import urllib.request

api_base = sys.argv[1].rstrip("/")
secret = sys.argv[2]
url = f"{api_base}/api/channels/chatdaddy/webhook/beyoute-chatdaddy?project_key=beyoute&wait_for_decision=1"
now = int(time.time())
payload = {
    "id": f"smoke-{now}",
    "event": "message-insert",
    "accountId": "beyoute-chatdaddy",
    "message": {
        "id": f"msg-smoke-{now}",
        "type": "text",
        "direction": "inbound",
        "text": "等下付款",
        "createdAt": "2026-07-03T10:00:00+08:00"
    },
    "conversation": {"id": f"conv-smoke-{now}"},
    "contact": {
        "id": f"contact-smoke-{now}",
        "name": "Ester Fan",
        "displayName": "Ester Fan",
        "phone": "+60120000000"
    },
}

headers = {
    "content-type": "application/json",
    "accept": "application/json",
    "user-agent": "Hermas-Agents-Smoke-Test/1.0",
}
if secret:
    headers["x-webhook-secret"] = secret

request = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
try:
    with urllib.request.urlopen(request, timeout=30) as response:
        status = response.status
        body = response.read().decode("utf-8", errors="replace")
except urllib.error.HTTPError as error:
    status = error.code
    body = error.read().decode("utf-8", errors="replace")

try:
    result = json.loads(body)
except Exception:
    result = {"raw": body}

decision = result.get("decision") or {}
reply_text = decision.get("reply_text") or result.get("reply_text")
summary = {
    "http_status": status,
    "ok": result.get("ok"),
    "accepted": result.get("accepted"),
    "decision_status": result.get("decision_status"),
    "intent": decision.get("intent"),
    "next_action": decision.get("next_action"),
    "send_now": decision.get("send_now"),
    "trigger_flow_now": decision.get("trigger_flow_now"),
    "reply_text": reply_text,
    "supabase": result.get("supabase"),
}
print(json.dumps(summary, ensure_ascii=False, indent=2))

if status >= 400:
    sys.exit(1)
if decision and (decision.get("send_now") is not False or decision.get("trigger_flow_now") is not False):
    print("\nFAILED: approval-first safety flags are wrong.")
    sys.exit(1)
PY

echo ""
echo "完成。"
read -r "?按 Enter 关闭..." || true
