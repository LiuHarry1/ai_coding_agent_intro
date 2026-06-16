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
| **Python (conda `llm_ft`)** | 跑评测脚本。本仓库约定 `conda activate llm_ft`。 |
| **Docker Desktop** | `evaluate` 步骤在容器里跑测试，必须先启动 Docker。 |
| **Node.js** | 启动本地 agent 服务（`npm start`）。 |
| **Agent 配置** | `~/.ai-agent/config.json` 里配好 `provider`（模型地址 / model 名）。 |
| 网络 | 首次需联网下载数据集和拉取镜像；之后可离线。 |

**macOS 注意**

- 安装 [Docker Desktop for Mac](https://www.docker.com/products/docker-desktop/)，菜单栏鲸鱼图标显示 *Running* 后再跑 `evaluate`。
- Apple Silicon（M 系列）会通过 Rosetta/QEMU 拉 x86_64 镜像，首次拉取和评测会比 Intel Mac 慢一些，属正常。
- macOS 上 git 默认 LF 换行，一般不会出现 Windows 那种 CRLF 进容器的问题。

**Windows 注意**

- 脚本已内置两处兼容处理 —— 控制台 UTF-8 输出、以及把送进容器的 `eval.sh`/`patch.diff` 换行规范成 LF（详见末尾 FAQ）。无需手动处理。

---

## 2. 一次性安装

**macOS / Linux**

```bash
conda activate llm_ft
cd eval/swe-bench
pip install -r requirements.txt
```

**Windows (PowerShell)**

```powershell
conda activate llm_ft
cd eval/swe-bench
pip install -r requirements.txt
```

---

## 3. 启动 Agent 服务

`run` 步骤通过 HTTP 调用 agent，所以先在**项目根目录**另开一个终端把它跑起来：

**macOS / Linux**

```bash
# 在仓库根目录
npm start
# 看到 "[server] listening on http://localhost:4567" 即就绪
```

健康检查（任意终端）：

```bash
curl -s http://localhost:4567/health
# 期望: {"status":"ok"}
```

**Windows (PowerShell)**

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

下面命令都在 `eval/swe-bench/` 目录、`llm_ft` 环境下执行。
本例用一条最小官方验证用例 `sympy__sympy-20590`，`--run-id` 自取一个本次运行的名字（如 `my-1`）。

**macOS / Linux**

```bash
conda activate llm_ft
cd eval/swe-bench
export HF_DATASETS_OFFLINE=1   # 可选；本地已有缓存时脚本会自动离线加载
```

**Windows (PowerShell)**

```powershell
conda activate llm_ft
cd eval/swe-bench
$env:HF_DATASETS_OFFLINE = "1"   # 可选；本地已有缓存时脚本会自动离线加载
```

### 第 1 步 · prepare —— 克隆仓库到 `workspaces/`

```bash
python run_eval.py prepare --instance-ids sympy__sympy-20590
```

- 把每条实例的仓库浅克隆到 `workspaces/<instance_id>/` 并检出到 `base_commit`。
- 写出 `runs/manifest.json`。
- 多条用空格分隔：`--instance-ids id1 id2 id3`。  
- sympy__sympy-20590 astropy__astropy-12907 django__django-10914 pallets__flask-4992 psf__requests-3362 pylint-dev__pylint-5859

### 第 2 步 · run —— 让 Agent 修 bug

```bash
python run_eval.py run --agent-url http://localhost:4567 --model-name claude-opus-4.6
```

- 逐条把 issue 发给 agent（`POST /chat`），完成后采集该 workspace 的 `git diff` 作为补丁。
- 结果写入 `runs/predictions.jsonl`，每条的对话信息存到 `runs/traces/<id>.json`。
- 每完成一条就落盘，中途中断后再次执行不会丢已完成的结果。
- 每条耗时约 3–15 分钟（取决于仓库大小）。可选 `--timeout-sec`（默认 3600）。

#### 重复运行：`run` 支持续跑 / 全新重跑 / 单条重跑

`run` 可以安全地重复执行。通过参数控制是「接着上次跑」还是「从头再来」：

| 场景 | 命令 |
|---|---|
| **续跑（默认）** — 跳过已成功实例，只跑未完成或上次报错的 | `python run_eval.py run --agent-url http://localhost:4567 --model-name claude-opus-4.6` |
| **全新重跑** — 忽略已有结果，manifest 里全部重跑 | 加上 `--fresh` |
| **单条重跑** — 只跑指定实例，其他 `predictions.jsonl` 记录保留 | 加上 `--instance-ids <id>` |
| **单条强制重跑** — 该条即使已成功（含空 patch）也重跑 | `--instance-ids <id> --fresh` |

**判定「已完成」**：`runs/traces/<id>.json` 存在且无 `error` 字段，且 `runs/predictions.jsonl` 里有对应记录。agent 报错时只会写 trace、不写 prediction，续跑时会自动重试该条。

**示例：6 条跑完后，只重跑 pylint（上次 patch 为空）**

```bash
python run_eval.py run \
  --agent-url http://localhost:4567 \
  --model-name claude-opus-4.6 \
  --instance-ids pylint-dev__pylint-5859 \
  --fresh
```

> 空 patch 也算 agent 成功完成，续跑时会跳过；要重跑必须加 `--fresh`。

**示例：中途中断后接着跑**

```bash
# 第一次跑到一半 Ctrl+C 中断
python run_eval.py run --agent-url http://localhost:4567 --model-name claude-opus-4.6

# 再次执行同一命令 —— 自动跳过已完成的，从第一条未完成的继续
python run_eval.py run --agent-url http://localhost:4567 --model-name claude-opus-4.6
```

输出示例：

```
[run] resume — skipping 5 completed, 1 pending
[run] === sympy__sympy-20590 === (skipped, already done)
[run] sympy__sympy-20590: patch 469 chars, 13 lines
...
[run] === pylint-dev__pylint-5859 ===
```

**示例：全部从头再来**

```bash
python run_eval.py run \
  --agent-url http://localhost:4567 \
  --model-name claude-opus-4.6 \
  --fresh
```


### 第 3 步 · collect —— 收集补丁

```bash
python run_eval.py collect --model-name claude-opus-4.6
```

- 重新从 `workspaces/` 读取 `git diff` 覆盖写 `runs/predictions.jsonl`。
- `run` 已经写过补丁，这步主要用于「不重跑 agent、只重新收集/重打分」。`--model-name` 要和 `run` 一致。

### 第 4 步 · evaluate —— Docker 官方评测

```bash
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

```bash
python run_eval.py prepare --instance-ids pallets__flask-4992 psf__requests-3362 pylint-dev__pylint-5859
```

较重（仓库大、镜像大、首次较慢）的：`django/django`、`astropy/astropy`、`sympy/sympy`、`scikit-learn`、`matplotlib`。

---

## 7. 便捷脚本（可选）

### macOS / Linux — `run_one.sh`

把四步串起来（用法与 Windows 版 `run_one.ps1` 相同）：

```bash
chmod +x run_one.sh   # 首次需要

# 默认单条 sympy
./run_one.sh

# 自定义实例 + run-id
./run_one.sh psf__requests-3362 pallets__flask-4992 small-1 3
# 参数: [instance_id ...] [run_id] [max_workers]
```

### Windows — `run_one.ps1`

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
- **`run` 想只重跑某一条 / 接着上次跑**：见上文「第 2 步 · run」中的「重复运行」小节；单条重跑用 `--instance-ids <id>`，强制重跑加 `--fresh`。
- **数据集下载慢/超时**：首次需联网下载一次；之后脚本检测到本地缓存会自动离线加载（也可手动设 `HF_DATASETS_OFFLINE=1`）。
- **所有测试（含 PASS_TO_PASS）全失败（Windows）**：多半是补丁/脚本以 CRLF 进了 Linux 容器。本仓库的 `run_harness.py` 已自动把 `.sh`/`.diff` 规范成 LF，正常情况下不会遇到。
- **Docker 报错 `FileNotFoundError` / `Docker is not running`**：`evaluate` 需要 Docker 守护进程。先打开 **Docker Desktop**，等菜单栏鲸鱼图标显示 *Running*，终端里 `docker info` 能正常输出后再跑 `evaluate`。若 `docker` 命令可用但 Python 仍报错，脚本会自动探测 `~/.docker/run/docker.sock`；也可手动设置 `export DOCKER_HOST=unix://$HOME/.docker/run/docker.sock`。
- **Docker 报错 / 权限问题（macOS）**：确认 Docker Desktop 已启动；若提示 socket 找不到，打开 Docker Desktop 等其完全就绪后再试。
- **`conda` 找不到**：
  - macOS/Linux：可直接用环境内解释器，例如 `~/miniforge3/envs/llm_ft/bin/python run_eval.py ...`（路径按你的 conda 安装位置调整）。
  - Windows：可直接用 `& "$env:USERPROFILE\miniforge3\envs\llm_ft\python.exe" run_eval.py ...`。

---

## 9. Mini-SWE-Agent 评估（对照基准）

除了评测**本仓库自研 agent**（`run_eval.py`），也可以用 [Mini-SWE-Agent](https://github.com/SWE-agent/mini-swe-agent) 作为**标准对照组**：它在 SWE-bench 官方 Docker 镜像里跑多轮 bash agent loop，再用同一套 harness 打分。

### 和 `run_eval.py` 的区别

| | **run_eval.py** | **run_mini_eval.py** |
|--|-----------------|----------------------|
| Agent | 本仓库 HTTP agent（`npm start`） | Mini-SWE-Agent（官方 bash loop） |
| 工作环境 | 宿主机 `workspaces/` | **每条实例一个 Docker 容器** |
| 需要 Node.js | 是 | 否 |
| 需要模型 API | 在 `~/.ai-agent/config.json` | LiteLLM 环境变量（见下） |
| 产出 | `runs/predictions.jsonl` | `mini-runs/<run-id>/preds.json` |

### 安装

```powershell
conda activate python3_11
cd eval/swe-bench
pip install -r requirements.txt
```

依赖里已包含 `mini-swe-agent` 和 `swe-rex`（Docker 环境后端）。

### 配置模型 API Key

Mini-SWE-Agent 通过 [LiteLLM](https://github.com/BerriAI/litellm) 调模型，在环境里设置对应 Key，例如：

```powershell
$env:ANTHROPIC_API_KEY = "sk-..."
# 或 OpenAI: $env:OPENAI_API_KEY = "sk-..."
```

默认模型为 `anthropic/claude-sonnet-4-5-20250929`，可用 `--model` 或环境变量 `MINI_SWE_MODEL` 覆盖。

### 两步流程

**第 1 步 · infer** — Mini-SWE-Agent 在 Docker 里修 bug：

```powershell
python run_mini_eval.py infer `
  --run-id mini-1 `
  --instance-ids sympy__sympy-20590 pallets__flask-4992 `
  --model anthropic/claude-sonnet-4-5-20250929 `
  --workers 1
```

- 输出目录：`mini-runs/mini-1/`
- 补丁文件：`mini-runs/mini-1/preds.json`
- 轨迹：`mini-runs/mini-1/<instance_id>/*.traj.json`
- **首次运行会拉取 SWE-bench 实例 Docker 镜像**，较慢属正常
- 中断后再次执行会**跳过** `preds.json` 里已有实例；要重跑加 `--redo-existing`

**第 2 步 · evaluate** — 官方 harness 打分（与 `run_eval.py evaluate` 相同）：

```powershell
python run_mini_eval.py evaluate --run-id mini-1 --max-workers 1
```

### 一键脚本

```powershell
.\run_one_mini.ps1
.\run_one_mini.ps1 -Instances "psf__requests-3362","pallets__flask-4992" -RunId mini-small-1
```

macOS / Linux：`./run_one_mini.sh`（用法同 `run_one.sh`）

### 调试单条（交互模式）

安装后可直接用官方 CLI 调试一条（不产出 `preds.json`）：

```powershell
mini-extra swebench-single --subset lite --split test -i sympy__sympy-20590 -m anthropic/claude-sonnet-4-5-20250929
```

文档：[mini-swe-agent.com — SWE-bench](https://mini-swe-agent.com/latest/usage/swebench/)

---

## 文件结构

```
eval/swe-bench/
├── run_eval.py      # 主入口：prepare / run / collect / evaluate 四个子命令
├── run_harness.py   # SWE-bench 官方 harness 的 Windows 兼容封装
├── run_one.sh       # [macOS/Linux] 串起四步的便捷脚本
├── run_one.ps1      # [Windows] 串起四步的便捷脚本
├── requirements.txt # Python 依赖（swebench / datasets / requests）
├── README.md        # 本文档
├── workspaces/      # [生成] 克隆的仓库
├── runs/            # [生成] manifest.json / predictions.jsonl / traces/
└── logs/            # [生成] 评测与镜像构建日志
```

> `workspaces/`、`runs/`、`logs/` 和 `*.json` 报告均为生成产物，已在 `.gitignore` 中忽略。
