# Aider polyglot — full flow (learning / smoke test)
#
# 在项目根目录另开终端跑 `npm start` 启动 Agent，然后：
#   conda activate py311
#   cd eval/aider-polyglot
#   .\run_one_polyglot.ps1                                  # 默认 Python 前 5 题
#   .\run_one_polyglot.ps1 -Slugs "bowling","poker" -RunId poly-small
#
# 三步：prepare -> run -> evaluate

param(
    [string]   $Language  = "python",
    [string[]] $Slugs     = @(),
    [int]      $Limit     = 5,
    [string]   $RunId     = "poly-1",
    [string]   $ModelName = "claude-opus-4.6",
    [string]   $AgentUrl  = "http://localhost:4567"
)

$ErrorActionPreference = "Stop"

Write-Host "`n=== [1/3] prepare: 克隆 benchmark + 拷贝题目 ===" -ForegroundColor Cyan
if ($Slugs.Count -gt 0) {
    python run_polyglot_eval.py prepare --language $Language --slugs $Slugs
} else {
    python run_polyglot_eval.py prepare --language $Language --limit $Limit
}

Write-Host "`n=== [2/3] run: 让 Agent 做题 ===" -ForegroundColor Cyan
python run_polyglot_eval.py run --agent-url $AgentUrl

Write-Host "`n=== [3/3] evaluate: 跑测试、统计通过率 ===" -ForegroundColor Cyan
python run_polyglot_eval.py evaluate --run-id $RunId --model-name $ModelName

Write-Host "`n=== 完成！ ===" -ForegroundColor Green
Write-Host "  汇总分数: $ModelName.$RunId.json"
Write-Host "  测试日志: logs/$RunId/<id>.txt"
