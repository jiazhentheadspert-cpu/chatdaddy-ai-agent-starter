#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

SQL_FILE="migrations/0007_project_ads_connections.sql"

echo "=============================================="
echo "Copy Project Ads Connections Migration"
echo "=============================================="
echo ""
echo "小白版：这个按钮会复制「每个项目的广告回流设置表」SQL。"
echo "它不会发送顾客讯息，不会开启自动回复，也不会保存任何 Meta Token。"
echo ""

if [[ ! -f "$SQL_FILE" ]]; then
  echo "不能继续：找不到 $SQL_FILE"
  read -r "?按 Enter 关闭..." || true
  exit 1
fi

if command -v pbcopy >/dev/null 2>&1; then
  pbcopy < "$SQL_FILE"
  echo "OK：SQL 已复制到剪贴板。"
else
  echo "不能自动复制。请手动复制这个文件内容：$SQL_FILE"
fi

echo ""
echo "下一步："
echo "1. 打开 Supabase"
echo "2. 左边点 SQL Editor"
echo "3. New query"
echo "4. 粘贴"
echo "5. 点 Run"
echo "6. 成功后回 Dashboard 设置广告回流"
echo ""
read -r "?按 Enter 关闭..." || true
