#!/bin/zsh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

API_BASE="${API_BASE:-https://ctg-chatdaddy-hermas-agents-runtime.jiazhen-theadspert.workers.dev}"
PROJECT_KEY="${PROJECT_KEY:-beyoute}"
ADMIN_TOKEN_FILE="${ADMIN_TOKEN_FILE:-$ROOT_DIR/secrets/agent_runtime_admin_token.txt}"

echo "================================================"
echo "Set Project Ads Manager Connection"
echo "================================================"
echo ""
echo "This saves one project's Meta Pixel / CAPI token into the SaaS database."
echo "It does not send customer messages, enable auto-send, or trigger Flow."
echo "The access token is never printed."
echo ""

if [[ ! -f "$ADMIN_TOKEN_FILE" ]]; then
  echo "Cannot continue: admin token file not found:"
  echo "$ADMIN_TOKEN_FILE"
  echo ""
  read -r "?Press Enter to close..." || true
  exit 1
fi

read -r "?Project key [$PROJECT_KEY]: " INPUT_PROJECT_KEY
PROJECT_KEY="${INPUT_PROJECT_KEY:-$PROJECT_KEY}"

read -r "?Meta Pixel ID / Dataset ID: " PIXEL_ID
if [[ -z "$PIXEL_ID" ]]; then
  echo "Cannot continue: Pixel ID is required."
  echo ""
  read -r "?Press Enter to close..." || true
  exit 1
fi

read -r "?Meta Page ID (optional): " PAGE_ID
read -r "?Meta Ad Account ID (optional): " AD_ACCOUNT_ID
read -r "?Graph version [v23.0]: " GRAPH_VERSION
GRAPH_VERSION="${GRAPH_VERSION:-v23.0}"

echo ""
read -rs "?Meta CAPI Access Token (hidden): " ACCESS_TOKEN
echo ""
if [[ -z "$ACCESS_TOKEN" ]]; then
  echo "Cannot continue: Access Token is required."
  echo ""
  read -r "?Press Enter to close..." || true
  exit 1
fi

read -r "?Meta Test Event Code (optional): " TEST_EVENT_CODE

echo ""
echo "Saving ads connection for project: $PROJECT_KEY"

/usr/bin/python3 - "$API_BASE" "$PROJECT_KEY" "$ADMIN_TOKEN_FILE" "$PIXEL_ID" "$PAGE_ID" "$AD_ACCOUNT_ID" "$GRAPH_VERSION" "$ACCESS_TOKEN" "$TEST_EVENT_CODE" <<'PY'
import json
import sys
import urllib.error
import urllib.request

api_base, project_key, admin_token_file, pixel_id, page_id, ad_account_id, graph_version, access_token, test_event_code = sys.argv[1:]
api_base = api_base.rstrip("/")

with open(admin_token_file, "r", encoding="utf-8") as handle:
    admin_token = handle.read().strip()

payload = {
    "pixel_id": pixel_id.strip(),
    "page_id": page_id.strip(),
    "ad_account_id": ad_account_id.strip(),
    "graph_version": (graph_version.strip() or "v23.0"),
    "access_token": access_token.strip(),
    "test_event_code": test_event_code.strip(),
    "auto_track_enabled": False,
    "purchase_auto_track_enabled": False,
}

request = urllib.request.Request(
    f"{api_base}/api/admin/projects/{project_key}/ads-connection",
    data=json.dumps(payload).encode("utf-8"),
    method="PUT",
    headers={
        "accept": "application/json",
        "content-type": "application/json",
        "x-admin-token": admin_token,
        "user-agent": "Hermas-Project-Ads-Setup/1.0",
    },
)

try:
    with urllib.request.urlopen(request, timeout=30) as response:
        data = json.loads(response.read().decode("utf-8") or "{}")
except urllib.error.HTTPError as error:
    raw = error.read().decode("utf-8", errors="replace")
    try:
        data = json.loads(raw or "{}")
    except Exception:
        data = {"message": raw}
    print(f"Save failed: HTTP {error.code}.")
    print(data.get("message") or data.get("error") or "Unknown error")
    sys.exit(1)

if not data.get("ok"):
    print("Save failed.")
    print(data.get("message") or data.get("error") or "Unknown error")
    sys.exit(1)

ads = data.get("ads_connection") or {}
print("OK: ads connection saved.")
print(f"- project: {project_key}")
print(f"- status: {ads.get('status') or 'active'}")
print(f"- pixel: {'configured' if ads.get('pixel_id') else 'missing'}")
print(f"- token: {'encrypted and saved' if ads.get('access_token_configured') else 'missing'}")
print("- auto tracking: OFF")
print("- purchase webhook auto tracking: OFF")
PY

echo ""
read -r "?Send RM1.00 Meta Purchase test event now? Type YES to send: " SEND_TEST
if [[ "$SEND_TEST" == "YES" ]]; then
  /usr/bin/python3 - "$API_BASE" "$PROJECT_KEY" "$ADMIN_TOKEN_FILE" <<'PY'
import json
import sys
import urllib.error
import urllib.request

api_base, project_key, admin_token_file = sys.argv[1:]
api_base = api_base.rstrip("/")
with open(admin_token_file, "r", encoding="utf-8") as handle:
    admin_token = handle.read().strip()

request = urllib.request.Request(
    f"{api_base}/api/admin/projects/{project_key}/ads-connection/test",
    data=json.dumps({
        "event_name": "Purchase",
        "value": 1,
        "currency": "MYR",
        "confirmMetaSend": True,
    }).encode("utf-8"),
    method="POST",
    headers={
        "accept": "application/json",
        "content-type": "application/json",
        "x-admin-token": admin_token,
        "user-agent": "Hermas-Project-Ads-Test/1.0",
    },
)
try:
    with urllib.request.urlopen(request, timeout=30) as response:
        data = json.loads(response.read().decode("utf-8") or "{}")
except urllib.error.HTTPError as error:
    raw = error.read().decode("utf-8", errors="replace")
    try:
        data = json.loads(raw or "{}")
    except Exception:
        data = {"message": raw}
    print(f"Test failed: HTTP {error.code}.")
    print(data.get("message") or data.get("error") or data.get("next") or "Unknown error")
    sys.exit(1)

if not data.get("ok"):
    print("Test failed.")
    print(data.get("message") or data.get("error") or data.get("next") or "Unknown error")
    sys.exit(1)

print("OK: Meta Purchase test event sent. Check Meta Events Manager > Test events.")
PY
else
  echo "Skipped test event."
fi

echo ""
echo "Done."
echo ""
read -r "?Press Enter to close..." || true
