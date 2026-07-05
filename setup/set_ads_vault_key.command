#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

CONFIG_FILE="${WRANGLER_CONFIG:-wrangler.agents.local.toml}"

echo "=============================================="
echo "Set Hermas Ads Vault Key"
echo "=============================================="
echo ""
echo "小白版：这个会给 Worker 设置一把广告回流加密钥。"
echo "以后 Admin 页面保存 Meta Token 时，会先加密再放 Supabase。"
echo "这个不会发送顾客讯息，也不会开启自动发送。"
echo ""

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "不能继续：找不到 $CONFIG_FILE"
  echo "请先准备 wrangler.agents.local.toml，或设置 WRANGLER_CONFIG。"
  read -r "?按 Enter 关闭..." || true
  exit 1
fi

SECRET_VALUE="$(openssl rand -base64 48)"
printf "%s" "$SECRET_VALUE" | npx wrangler secret put HERMAS_ADS_VAULT_KEY --config "$CONFIG_FILE"

echo ""
echo "OK：HERMAS_ADS_VAULT_KEY 已设置。"
echo "下一步：部署 Worker，然后在 Admin Dashboard 填每个项目的广告回流资料。"
echo ""
read -r "?按 Enter 关闭..." || true
