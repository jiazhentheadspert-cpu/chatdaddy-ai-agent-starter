#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

echo "=============================================="
echo "Check Hermas Agents Live Launch"
echo "=============================================="
echo ""
echo "小白版：检查现在的 Agents Worker 有没有准备好接 Supabase + ChatDaddy。"
echo "这个检查不会打印任何 key。"
echo ""

node scripts/check_agents_live_launch_preflight.mjs
node --check src/hermas-agents-worker.js
npm run check:agents

echo ""
echo "完成。"
