#!/bin/zsh
set -e

if [[ -z "${API_BASE:-}" ]]; then
  echo "STOP: set API_BASE first."
  echo "Example:"
  echo "API_BASE=https://your-worker.workers.dev DASHBOARD_URL=https://your-domain/dashboard ./setup/check_ads_manager_purchase_go_live.command"
  exit 1
fi

DASHBOARD_URL="${DASHBOARD_URL:-}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"

echo "================================================"
echo "Ads Manager Purchase Go-Live Check"
echo "================================================"
echo ""
echo "API:       $API_BASE"
echo "Dashboard: ${DASHBOARD_URL:-skipped}"
echo ""

/usr/bin/python3 - "$API_BASE" "$DASHBOARD_URL" "$ADMIN_TOKEN" <<'PY'
import json
import sys
import urllib.error
import urllib.request

api_base, dashboard_url, admin_token = sys.argv[1:]
api_base = api_base.rstrip("/")

def fetch_json(path, *, data=None, headers=None, method=None):
    request = urllib.request.Request(
        f"{api_base}{path}",
        data=data,
        headers={
            "accept": "application/json",
            "user-agent": "AI-Reply-Ads-GoLive-Check/1.0",
            **(headers or {}),
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = {"raw": raw}
        return error.code, parsed

def fetch_text(url):
    request = urllib.request.Request(
        url,
        headers={
            "accept": "text/html,*/*",
            "user-agent": "AI-Reply-Ads-GoLive-Check/1.0",
        },
    )
    with urllib.request.urlopen(request, timeout=25) as response:
        return response.status, response.read().decode("utf-8", errors="replace")

checks = []
status_code, status = fetch_json("/api/meta-capi/status")
meta = status.get("meta_capi", {})
configured = bool(meta.get("configured"))

checks.append(("Worker reachable", status_code == 200 and status.get("ok") is True, f"HTTP {status_code}"))
checks.append(("Meta Pixel ID", bool(meta.get("pixel_id")), "set" if meta.get("pixel_id") else "missing"))
checks.append(("Meta CAPI Access Token", bool(meta.get("access_token_configured")), "set" if meta.get("access_token_configured") else "missing"))
checks.append(("Auto tracking", True, "ON" if meta.get("auto_track_enabled") else "OFF"))
checks.append(("Purchase webhook auto tracking", True, "ON" if meta.get("purchase_auto_track_enabled") else "OFF"))

if dashboard_url:
    try:
        separator = "&" if "?" in dashboard_url else "?"
        dashboard_status, dashboard_html = fetch_text(f"{dashboard_url}{separator}v=go-live-check")
        checks.append(("Dashboard reachable", dashboard_status == 200, f"HTTP {dashboard_status}"))
        checks.append(("Dashboard Meta warning copy", "广告回流未接 Meta Pixel/CAPI" in dashboard_html, "present" if "广告回流未接 Meta Pixel/CAPI" in dashboard_html else "missing"))
        checks.append(("Dashboard Meta success copy", "已记录成交，并已回流 Meta RM" in dashboard_html, "present" if "已记录成交，并已回流 Meta RM" in dashboard_html else "missing"))
        checks.append(("Dashboard mark-purchase wiring", "记录成交" in dashboard_html and "mark-purchase" in dashboard_html, "present" if "记录成交" in dashboard_html and "mark-purchase" in dashboard_html else "missing"))
    except Exception as error:
        checks.append(("Dashboard reachable", False, str(error)))

if admin_token:
    payload = json.dumps({
        "amount_rm": 12.34,
        "currency": "MYR",
        "confirmMetaSend": False,
        "source": "go_live_route_probe",
    }).encode("utf-8")
    probe_status, probe = fetch_json(
        "/api/hermas/projects/demo/cases/__go_live_probe_do_not_create__/mark-purchase",
        data=payload,
        headers={
            "content-type": "application/json",
            "x-admin-token": admin_token,
        },
        method="POST",
    )
    checks.append(("Mark-purchase endpoint", probe_status in {400, 404} or probe.get("ok") is False, f"HTTP {probe_status} {probe.get('error') or probe.get('message') or ''}".strip()))
else:
    checks.append(("Mark-purchase endpoint", True, "skipped; set ADMIN_TOKEN to probe route"))

print("CHECKS")
for name, ok, note in checks:
    print(f"- {'OK' if ok else 'NO':2} {name}: {note}")

print("")
print("RESULT")
hard_fail = [name for name, ok, _ in checks if not ok and name not in {"Meta Pixel ID", "Meta CAPI Access Token"}]
if hard_fail:
    print("NOT READY: Dashboard / Worker wiring still has problems.")
    print("Fix:", ", ".join(hard_fail))
elif not configured:
    print("NOT LIVE YET: Dashboard can record purchase, but Ads Manager will not receive Purchase until Meta Pixel ID + CAPI Access Token are set.")
else:
    print("READY FOR TEST: Meta credentials are present. Send one Purchase test event and confirm it in Meta Events Manager before real go-live.")

print("")
print("SAFETY")
print("- Purchase only after payment received or COD order confirmed.")
print("- ChatDaddy paid webhook also needs amount_rm/order_value.")
print("- Duplicate Purchase is blocked by order_id + currency + amount/order_value.")
print("- Customer saying '我要 / 有 / interested' is not a Purchase.")
print("- Auto Lead / Receipt / Flow tracking stays separate from manual Purchase.")
PY
