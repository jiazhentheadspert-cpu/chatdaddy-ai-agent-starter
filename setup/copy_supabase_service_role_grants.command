#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

SQL_FILE="migrations/0006_supabase_service_role_grants.sql"

echo "=============================================="
echo "Copy Hermas Supabase Service Role Grants"
echo "=============================================="
echo ""
echo "小白版：403 是 Supabase 表还没授权给 service_role。"
echo "这个按钮只会把修复权限的 SQL 复制到剪贴板。"
echo ""

if [[ ! -f "$SQL_FILE" ]]; then
  echo "不能继续：找不到 $SQL_FILE"
  read -r "?按 Enter 关闭..." || true
  exit 1
fi

if command -v pbcopy >/dev/null 2>&1; then
  pbcopy < "$SQL_FILE"
  echo "OK：权限 SQL 已复制到剪贴板。"
else
  echo "不能自动复制。请手动复制这个文件内容：$SQL_FILE"
fi

echo ""
echo "下一步："
echo "1. 回 Supabase"
echo "2. 左边点 SQL Editor"
echo "3. New query"
echo "4. 粘贴"
echo "5. 点 Run"
echo "6. 成功后回来 Terminal 再跑：./setup/run_supabase_beyoute_seed.command"
echo ""
read -r "?按 Enter 关闭..." || true
