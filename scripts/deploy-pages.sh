#!/usr/bin/env bash
# 一键更新 GitHub Pages 静态演示：重建快照并推送到 gh-pages 分支
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/export-static.mjs

cd static-site
rm -rf .git
git init -q
git add -A
git -c user.name="power-admin" -c user.email="demo@local" commit -qm "deploy: $(date '+%Y-%m-%d %H:%M')"
REMOTE="$(git -C .. remote get-url origin)"
git push -f "$REMOTE" HEAD:gh-pages
rm -rf .git
echo "已发布到 ${REMOTE%.git} 的 gh-pages 分支"
