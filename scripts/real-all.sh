#!/usr/bin/env bash
# 有 key 时一条命令跑完全部真跑验收：T3（标注）→ T4（小克聊天 + 摘要）。
#   bash scripts/real-all.sh
# key 从 shell 的 ANTHROPIC_API_KEY 拿；没有就读 ~/.config/reader/key（一行，就是 key 本身），再没有读 ~/.config/reader/.env（ANTHROPIC_API_KEY=…）。不打印 key。
# 花费上限合计 $2：T3 默认 $1.5、T4 默认 $0.5（可用 BUDGET_T3 / BUDGET_T4 改）。超了脚本自己停并写半截报告。
# 结果：shots/t3-*.png、shots/t3-data/report.json、shots/t4-data/report.json（shots/ 不入仓）。
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -f "$HOME/.config/reader/key" ]; then
  # 本机 key 文件：一行就是 key 本身（chmod 600）。去掉空白/换行，不回显。
  ANTHROPIC_API_KEY="$(tr -d '[:space:]' < "$HOME/.config/reader/key")"
fi
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -f "$HOME/.config/reader/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$HOME/.config/reader/.env"
  set +a
fi
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "没有 ANTHROPIC_API_KEY（shell 和 ~/.config/reader/.env 都没有）：待 key" >&2
  exit 2
fi
export ANTHROPIC_API_KEY

echo "== T3 标注真跑（预算 \$${BUDGET_T3:-1.5}）=="
node scripts/vrun.mjs scripts/t3-real.ts --budget "${BUDGET_T3:-1.5}"
echo
echo "== T4 小克真跑（预算 \$${BUDGET_T4:-0.5}）=="
node scripts/vrun.mjs scripts/t4-real.ts --budget "${BUDGET_T4:-0.5}"
echo
node -e '
const fs = require("fs");
for (const f of ["shots/t3-data/report.json", "shots/t4-data/report.json"]) {
  if (!fs.existsSync(f)) { console.log(f, "没生成"); continue; }
  const r = JSON.parse(fs.readFileSync(f, "utf8"));
  const usd = typeof r.usd === "number" ? r.usd : Object.values(r.usd || {}).reduce((a, b) => a + b, 0);
  console.log(f, "花费 $" + usd.toFixed(4), r.stopped ? "中途停：" + r.stopped : "", r.allPass === undefined ? "" : r.allPass ? "T4 全过" : "T4 有不过的，看 checks");
}'
