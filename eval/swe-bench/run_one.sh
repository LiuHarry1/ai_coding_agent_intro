#!/usr/bin/env bash
# SWE-bench 完整流程（学习/冒烟用）
#
# 在项目根目录另开终端跑 `npm start` 启动 Agent，然后：
#   conda activate llm_ft
#   cd eval/swe-bench
#   ./run_one.sh                                    # 默认单条 sympy
#   ./run_one.sh psf__requests-3362 pallets__flask-4992 small-1 3
#
# 四步：prepare → run → collect → evaluate
#
# 用法:
#   ./run_one.sh [instance_id ...] [run_id] [max_workers]
# 最后两个参数若分别为非 instance 字符串和整数，则当作 run_id / max_workers。

set -euo pipefail

MODEL_NAME="${MODEL_NAME:-claude-opus-4.6}"
AGENT_URL="${AGENT_URL:-http://localhost:4567}"
RUN_ID="learn-1"
MAX_WORKERS=1
INSTANCES=(sympy__sympy-20590)

if [[ $# -gt 0 ]]; then
  args=("$@")
  n=${#args[@]}

  if [[ $n -ge 2 ]] && [[ "${args[$((n - 1))]}" =~ ^[0-9]+$ ]]; then
    MAX_WORKERS="${args[$((n - 1))]}"
    n=$((n - 1))
  fi
  if [[ $n -ge 2 ]] && [[ "${args[$((n - 1))]}" != *"__"* ]]; then
    RUN_ID="${args[$((n - 1))]}"
    n=$((n - 1))
  fi

  if [[ $n -gt 0 ]]; then
    INSTANCES=("${args[@]:0:$n}")
  fi
fi

export HF_DATASETS_OFFLINE=1

echo
echo "=== [1/4] prepare: 克隆 repo ==="
python run_eval.py prepare --instance-ids "${INSTANCES[@]}"

echo
echo "=== [2/4] run: 让 Agent 修 bug（每条约 3-15 分钟）==="
python run_eval.py run --agent-url "$AGENT_URL" --timeout-sec 1800 --model-name "$MODEL_NAME"

echo
echo "=== [3/4] collect: 收集 git diff ==="
python run_eval.py collect --model-name "$MODEL_NAME"

echo
echo "=== [4/4] evaluate: Docker 官方评测 ==="
echo "  默认从 swebench 官方镜像源拉取预构建镜像。"
echo "  注意：不要加 --force-rebuild —— 本地重建会 git clone 上游已删除的分支而失败。"
python run_eval.py evaluate --run-id "$RUN_ID" --max-workers "$MAX_WORKERS"

echo
echo "=== 完成！查看结果 ==="
echo "  汇总分数: ${MODEL_NAME}.${RUN_ID}.json"
echo "  单条报告: logs/run_evaluation/${RUN_ID}/${MODEL_NAME}/<instance>/report.json"
