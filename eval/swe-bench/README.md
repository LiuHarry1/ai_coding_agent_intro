# SWE-bench Lite 迷你评测

用 [SWE-bench Lite](https://www.swebench.com/) 的真实开源 bug，端到端评测本地 coding agent：
让 agent 修 bug → 收集 `git diff` → 用 SWE-bench 官方 Docker harness 打分。

整个流程分四步：

```
prepare  →  run  →  collect  →  evaluate
克隆仓库     Agent修bug   收集补丁     Docker评测打分
```

---

## 1. 前置条件

| 依赖 | 说明 |
|---|---|
| **Python 3.11 (conda `py311`)** | 跑评测脚本。本仓库约定 `conda activate py311`。 |
| **Docker Desktop** | `evaluate` 步骤在容器里跑测试，必须先启动 Docker。 |
| **Node.js** | 启动本地 agent 服务（`npm start`）。 |
| **Agent 配置** | `~/.ai-agent/config.json` 里配好 `provider`（模型地址 / model 名）。 |
| 网络 | 首次需联网下载数据集和拉取镜像；之后可离线。 |

> Windows 注意：脚本已内置两处兼容处理 —— 控制台 UTF-8 输出、以及把送进容器的 `eval.sh`/`patch.diff` 换行规范成 LF（详见末尾 FAQ）。无需手动处理。

---

## 2. 一次性安装

```powershell
conda activate py311
cd eval/swe-bench
pip install -r requirements.txt
```

---

## 3. 启动 Agent 服务

`run` 步骤通过 HTTP 调用 agent，所以先在**项目根目录**另开一个终端把它跑起来：

```powershell
# 在仓库根目录
npm start
# 看到 "[server] listening on http://localhost:4567" 即就绪
```

健康检查（任意终端）：

```powershell
Invoke-WebRequest http://localhost:4567/health -UseBasicParsing
# 期望: {"status":"ok"}
```

---

## 4. 手动执行四步

下面命令都在 `eval/swe-bench/` 目录、`py311` 环境下执行。
本例用一条最小官方验证用例 `sympy__sympy-20590`，`--run-id` 自取一个本次运行的名字（如 `my-1`）。

```powershell
conda activate py311
cd eval/swe-bench
$env:HF_DATASETS_OFFLINE = "1"   # 数据集已缓存后加这行，避免连 HuggingFace 超时
```

### 第 1 步 · prepare —— 克隆仓库到 `workspaces/`

```powershell
python run_eval.py prepare --instance-ids sympy__sympy-20590
```

- 把每条实例的仓库浅克隆到 `workspaces/<instance_id>/` 并检出到 `base_commit`。
- 写出 `runs/manifest.json`。
- 多条用空格分隔：`--instance-ids id1 id2 id3`。

### 第 2 步 · run —— 让 Agent 修 bug

```powershell
python run_eval.py run --agent-url http://localhost:4567 --model-name claude-opus-4.6
```

- 逐条把 issue 发给 agent（`POST /chat`），完成后采集该 workspace 的 `git diff` 作为补丁。
- 结果写入 `runs/predictions.jsonl`，每条的对话信息存到 `runs/traces/<id>.json`。
- 每条耗时约 3–15 分钟（取决于仓库大小）。可选 `--timeout-sec`（默认 3600）。

### 第 3 步 · collect —— 收集补丁

```powershell
python run_eval.py collect --model-name claude-opus-4.6
```

- 重新从 `workspaces/` 读取 `git diff` 覆盖写 `runs/predictions.jsonl`。
- `run` 已经写过补丁，这步主要用于「不重跑 agent、只重新收集/重打分」。`--model-name` 要和 `run` 一致。

### 第 4 步 · evaluate —— Docker 官方评测

```powershell
python run_eval.py evaluate --run-id my-1 --max-workers 3
```

- 默认从 swebench 官方镜像源**拉取预构建镜像**，在容器里打补丁并跑测试。
- 不传 `--instance-ids` 时，**自动评测 `predictions.jsonl` 里的全部实例**。
- `--max-workers N` 并行评测 N 条。
- 跑完会打印分数，例如：

```
[evaluate] claude-opus-4.6.my-1.json: resolved 1/1
[evaluate]   resolved: sympy__sympy-20590
```

> ⚠️ **不要加 `--force-rebuild`**：它会在本地重建镜像并执行 `git clone --branch <分支>`，而部分仓库（如 sympy 的 `1.7`）上游已删除该分支，会导致镜像构建失败。默认的拉取预构建镜像方式不受影响。

---

## 5. 查看结果

| 内容 | 位置 |
|---|---|
| **汇总分数** | `claude-opus-4.6.<run-id>.json`（`resolved_instances` / `total_instances`） |
| 单条测试详情 | `logs/run_evaluation/<run-id>/<model>/<instance>/report.json` |
| 容器测试输出 | `logs/run_evaluation/<run-id>/<model>/<instance>/test_output.txt` |
| 提交的补丁 | `runs/predictions.jsonl` |
| Agent 对话轨迹 | `runs/traces/<instance>.json` |

`report.json` 里 `resolved: true` 即该条通过；`tests_status` 列出 `FAIL_TO_PASS`（需修复转通过）和 `PASS_TO_PASS`（需保持通过）的明细。

---

## 6. 选实例：推荐从「小仓库」开始

SWE-bench Lite 共 300 条、12 个仓库。**最轻、评测最快**的仓库：
`pallets/flask`、`psf/requests`、`mwaskom/seaborn`、`pylint-dev/pylint`。

已验证可一键跑通的几条小实例：

```powershell
python run_eval.py prepare --instance-ids pallets__flask-4992 psf__requests-3362 pylint-dev__pylint-5859
```

较重（仓库大、镜像大、首次较慢）的：`django/django`、`astropy/astropy`、`sympy/sympy`、`scikit-learn`、`matplotlib`。

---

## 7. 便捷脚本（可选）

`run_one.ps1` 把四步串起来：

```powershell
# 默认单条 sympy
.\run_one.ps1

# 自定义实例 + run-id
.\run_one.ps1 -Instances "psf__requests-3362","pallets__flask-4992" -RunId small-1 -MaxWorkers 3
```

---

## 8. FAQ / 排错

- **`evaluate` 一直卡住不动**：通常在拉取预构建镜像（较大），属正常。可看 `logs/run_evaluation/<run-id>/<model>/<instance>/run_instance.log` 确认进度。
- **`Agent not reachable`**：忘了 `npm start`，或端口不是 4567，用 `--agent-url` 指定。
- **数据集下载慢/超时**：首次联网下载一次后，设置 `$env:HF_DATASETS_OFFLINE="1"` 走本地缓存。
- **所有测试（含 PASS_TO_PASS）全失败**：多半是补丁/脚本以 CRLF 进了 Linux 容器。本仓库的 `run_harness.py` 已自动把 `.sh`/`.diff` 规范成 LF，正常情况下不会遇到。
- **`conda` 找不到**：若 conda 不在 PATH，可直接用环境内解释器，例如
  `& "$env:USERPROFILE\AppData\Local\anaconda3\envs\py311\python.exe" run_eval.py ...`。

---

## 文件结构

```
eval/swe-bench/
├── run_eval.py      # 主入口：prepare / run / collect / evaluate 四个子命令
├── run_harness.py   # SWE-bench 官方 harness 的 Windows 兼容封装
├── run_one.ps1      # 串起四步的便捷脚本
├── requirements.txt # Python 依赖（swebench / datasets / requests）
├── README.md        # 本文档
├── workspaces/      # [生成] 克隆的仓库
├── runs/            # [生成] manifest.json / predictions.jsonl / traces/
└── logs/            # [生成] 评测与镜像构建日志
```

> `workspaces/`、`runs/`、`logs/` 和 `*.json` 报告均为生成产物，已在 `.gitignore` 中忽略。
