#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="$ROOT_DIR/wrangler.agents.local.toml"

echo "=============================================="
echo "Set Hermas Agents Live Secrets"
echo "=============================================="
echo ""
echo "小白版：这里会把钥匙放进 Cloudflare，不会显示在屏幕，不会写进 GitHub。"
echo ""

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "不能继续：找不到 $CONFIG_FILE"
  echo "请先按 setup/prepare_agents_live_config.command"
  read -r "?按 Enter 关闭..." || true
  exit 1
fi

cd "$ROOT_DIR"

put_secret() {
  local key="$1"
  local label="$2"
  local required="${3:-required}"
  local value=""
  echo ""
  if [[ "$required" == "optional" ]]; then
    read -r "?$label（可空，直接 Enter 跳过）: " value
    if [[ -z "$value" ]]; then
      echo "Skip $key"
      return 0
    fi
  else
    while [[ -z "$value" ]]; do
      read -r "?$label: " value
    done
  fi
  printf "%s" "$value" | npx wrangler secret put "$key" --config "$CONFIG_FILE"
  unset value
}

put_secret "SUPABASE_SERVICE_ROLE_KEY" "Paste Supabase SERVICE_ROLE_KEY"
put_secret "CHATDADDY_WEBHOOK_SECRET" "Paste ChatDaddy webhook secret"
put_secret "CHATDADDY_API_KEY" "Paste ChatDaddy API key"
put_secret "OPENAI_API_KEY" "Paste OpenAI API key" "optional"

echo ""
echo "OK：Cloudflare secrets 已设置。"
echo "下一步：按 setup/check_agents_live_launch.command 检查，再按 setup/test_agents_webhook_smoke.command 测试。"
echo ""
read -r "?按 Enter 关闭..." || true
