# SWE-bench 单条完整流程（学习用）
# Instance: sympy__sympy-20590（官方文档推荐的验证用例，体积最小）
#
# 用法：在项目根目录另开终端跑 `npm start`，然后：
#   cd eval/swe-bench
#   .\run_one.ps1
#
# 四步：prepare → run → collect → evaluate

$ErrorActionPreference = "Stop"
$Instance = "sympy__sympy-20590"
$RunId = "learn-1"
$env:HF_DATASETS_OFFLINE = "1"   # 用本地缓存，避免连 HuggingFace 超时

Write-Host "`n=== [1/4] prepare: 克隆 repo ===" -ForegroundColor Cyan
conda activate python3_11
python run_eval.py prepare --instance-ids $Instance

Write-Host "`n=== [2/4] run: 让 Agent 修 bug（约 3-10 分钟）===" -ForegroundColor Cyan
python run_eval.py run --agent-url http://localhost:4567 --timeout-sec 1800 --model-name claude-opus-4.6

Write-Host "`n=== [3/4] collect: 收集 git diff ===" -ForegroundColor Cyan
python run_eval.py collect --model-name claude-opus-4.6

Write-Host "`n=== [4/4] evaluate: Docker 官方评测 ===" -ForegroundColor Cyan
Write-Host "  首次需本地构建镜像（--force-rebuild），约 15-30 分钟；镜像已存在则几分钟" -ForegroundColor DarkGray
python run_eval.py evaluate --run-id $RunId --instance-ids $Instance --max-workers 1 --force-rebuild

Write-Host "`n=== 完成！查看结果 ===" -ForegroundColor Green
Write-Host "  patch:  runs/predictions.jsonl"
Write-Host "  报告: logs/run_evaluation/$RunId/claude-opus-4.6/$Instance/report.json"
Write-Host "  日志: logs/run_evaluation/$RunId/claude-opus-4.6/$Instance/run_instance.log"
