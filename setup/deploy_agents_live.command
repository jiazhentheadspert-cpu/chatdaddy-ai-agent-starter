#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="$ROOT_DIR/wrangler.agents.local.toml"

echo "=============================================="
echo "Deploy Hermas Agents Live"
echo "=============================================="
echo ""
echo "小白版：这个会部署 Cloudflare Agents Worker。"
echo "不会打开自动发送；系统仍然是 approval-first。"
echo ""

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "不能继续：找不到 $CONFIG_FILE"
  echo "请先按 setup/prepare_agents_live_config.command"
  read -r "?按 Enter 关闭..." || true
  exit 1
fi

echo "为了避免误点，请输入 DEPLOY 才继续。"
read -r "?Type DEPLOY: " CONFIRM
if [[ "$CONFIRM" != "DEPLOY" ]]; then
  echo "已取消。"
  read -r "?按 Enter 关闭..." || true
  exit 0
fi

cd "$ROOT_DIR"
npm run check:agents
npx wrangler deploy --config "$CONFIG_FILE"

echo ""
echo "OK：Agents Worker 已部署。"
echo "下一步：按 setup/test_agents_webhook_smoke.command，用测试讯息打一次。"
echo ""
read -r "?按 Enter 关闭..." || true
