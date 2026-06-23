#!/bin/zsh
set -e

echo "================================================"
echo "Meta CAPI Purchase Auto Track"
echo "================================================"
echo ""
echo "This controls ONLY ChatDaddy paid/COD-confirmed webhooks -> Meta Purchase."
echo "It does NOT turn on automatic Lead / Receipt / Flow Step tracking."
echo ""
echo "Run this inside your Worker project folder, after wrangler is connected."
echo ""
echo "1. Keep OFF"
echo "2. Turn ON"
echo ""
read -r "?Choose 1-2: " CHOICE || CHOICE="1"

case "$CHOICE" in
  2)
    echo ""
    read -r "?Type YES to allow paid ChatDaddy webhooks with amount to send Meta Purchase: " CONFIRM
    if [[ "$CONFIRM" != "YES" ]]; then
      echo "Cancelled."
      exit 0
    fi
    printf "%s" "true" | wrangler secret put META_CAPI_PURCHASE_AUTO_TRACK
    echo "ON: paid/COD-confirmed ChatDaddy webhooks with amount can send Meta Purchase."
    ;;
  *)
    printf "%s" "false" | wrangler secret put META_CAPI_PURCHASE_AUTO_TRACK
    echo "OFF: paid ChatDaddy webhooks only preview Purchase."
    ;;
esac

echo ""
echo "Next:"
echo "- Check /api/meta-capi/status"
echo "- Send one paid webhook test"
echo "- Watch /api/meta-capi/latest and Meta Events Manager"
