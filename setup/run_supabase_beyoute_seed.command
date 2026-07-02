#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

echo "=============================================="
echo "Run Hermas Supabase Beyoute Seed"
echo "=============================================="
echo ""
echo "小白版：这个按钮是帮 Supabase 建立 Beyoute 这个项目的基础资料。"
echo "它不会发送顾客讯息，也不会开启自动发送。"
echo ""

node scripts/apply_supabase_beyoute_seed_via_rest.mjs

echo ""
echo "完成。"
