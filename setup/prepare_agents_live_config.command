#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

echo "=============================================="
echo "Prepare Hermas Agents Live Config"
echo "=============================================="
echo ""
echo "小白版：这里放 Supabase URL。它不是密码。"
echo "真正的 key 等下会放进 Cloudflare secret，不会进 GitHub。"
echo ""

if [[ -z "${SUPABASE_URL:-}" ]]; then
  read -r "?Paste Supabase URL: " SUPABASE_URL
fi

export SUPABASE_URL
export HERMAS_PROJECT_KEY="${HERMAS_PROJECT_KEY:-beyoute}"

node scripts/prepare_agents_live_config.mjs

echo ""
echo "下一步：按 setup/set_agents_live_secrets.command，把 key 放进 Cloudflare。"
echo ""
read -r "?按 Enter 关闭..." || true
