#!/bin/zsh
set -e

if [[ -z "${API_BASE:-}" ]]; then
  echo "STOP: set API_BASE first."
  echo "Example:"
  echo "API_BASE=https://your-worker.workers.dev PROJECT_KEY=demo ./setup/test_chatdaddy_paid_webhook_purchase.command"
  exit 1
fi

PROJECT_KEY="${PROJECT_KEY:-demo}"
PAYLOAD_FILE="${PAYLOAD_FILE:-examples/chatdaddy-paid-purchase-webhook.json}"

echo "================================================"
echo "ChatDaddy Paid Webhook -> Purchase Test"
echo "================================================"
echo ""
echo "API:      $API_BASE"
echo "Project:  $PROJECT_KEY"
echo "Payload:  $PAYLOAD_FILE"
echo ""

if [[ ! -f "$PAYLOAD_FILE" ]]; then
  echo "STOP: missing payload file: $PAYLOAD_FILE"
  exit 1
fi

/usr/bin/python3 - "$API_BASE" "$PROJECT_KEY" "$PAYLOAD_FILE" <<'PY'
import json
import sys
import urllib.error
import urllib.request

api_base, project_key, payload_file = sys.argv[1:]
api_base = api_base.rstrip("/")

with open(payload_file, "r", encoding="utf-8") as handle:
    payload = json.load(handle)

request = urllib.request.Request(
    f"{api_base}/mock/inbound?project_key={project_key}",
    data=json.dumps(payload).encode("utf-8"),
    headers={
        "content-type": "application/json",
        "accept": "application/json",
        "user-agent": "AI-Reply-ChatDaddy-Paid-Webhook-Test/1.0",
    },
    method="POST",
)

try:
    with urllib.request.urlopen(request, timeout=30) as response:
        status = response.status
        result = json.loads(response.read().decode("utf-8"))
except urllib.error.HTTPError as error:
    status = error.code
    raw = error.read().decode("utf-8", errors="replace")
    try:
        result = json.loads(raw)
    except Exception:
        result = {"raw": raw}

ads = result.get("adsTracking") or {}
normalized = result.get("normalized") or {}
custom_fields = ((normalized.get("metadata") or {}).get("custom_fields") or {})

print(json.dumps({
    "http_status": status,
    "ok": result.get("ok"),
    "event_type": normalized.get("eventType"),
    "payment_status": custom_fields.get("payment_status"),
    "purchase_status": custom_fields.get("purchase_status"),
    "amount_rm": custom_fields.get("amount_rm"),
    "order_value": custom_fields.get("order_value"),
    "ads_tracking": ads,
}, ensure_ascii=False, indent=2))
PY

echo ""
echo "Expected:"
echo "- ads_tracking.event_name = Purchase"
echo "- ads_tracking.event_key = payment_confirmed"
echo "- If it says missing amount, fix amount_rm/order_value in ChatDaddy."
