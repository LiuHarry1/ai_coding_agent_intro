# SWE-bench 完整流程（学习/冒烟用）
#
# 在项目根目录另开终端跑 `npm start` 启动 Agent，然后：
#   conda activate llm_ft
#   cd eval/swe-bench
#   .\run_one.ps1                                   # 默认单条 sympy
#   .\run_one.ps1 -Instances "psf__requests-3362","pallets__flask-4992" -RunId small-1
#
# 四步：prepare → run → collect → evaluate

param(
    [string[]] $Instances = @("sympy__sympy-20590"),
    [string]   $RunId     = "learn-1",
    [string]   $ModelName = "claude-opus-4.6",
    [string]   $AgentUrl  = "http://localhost:4567",
    [int]      $MaxWorkers = 1
)

$ErrorActionPreference = "Stop"
$env:HF_DATASETS_OFFLINE = "1"   # 用本地缓存，避免连 HuggingFace 超时

Write-Host "`n=== [1/4] prepare: 克隆 repo ===" -ForegroundColor Cyan
python run_eval.py prepare --instance-ids $Instances

Write-Host "`n=== [2/4] run: 让 Agent 修 bug（每条约 3-15 分钟）===" -ForegroundColor Cyan
python run_eval.py run --agent-url $AgentUrl --timeout-sec 1800 --model-name $ModelName

Write-Host "`n=== [3/4] collect: 收集 git diff ===" -ForegroundColor Cyan
python run_eval.py collect --model-name $ModelName

Write-Host "`n=== [4/4] evaluate: Docker 官方评测 ===" -ForegroundColor Cyan
Write-Host "  默认从 swebench 官方镜像源拉取预构建镜像。" -ForegroundColor DarkGray
Write-Host "  注意：不要加 --force-rebuild —— 本地重建会 git clone 上游已删除的分支而失败。" -ForegroundColor DarkGray
python run_eval.py evaluate --run-id $RunId --max-workers $MaxWorkers

Write-Host "`n=== 完成！查看结果 ===" -ForegroundColor Green
Write-Host "  汇总分数: claude-opus-4.6.$RunId.json"
Write-Host "  单条报告: logs/run_evaluation/$RunId/$ModelName/<instance>/report.json"
