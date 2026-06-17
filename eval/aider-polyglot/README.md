# Aider polyglot 迷你评测

用 [Aider polyglot benchmark](https://github.com/Aider-AI/polyglot-benchmark)（225 道 Exercism 编程题，
覆盖 C++/Go/Java/JavaScript/Python/Rust）评测本仓库自研 coding agent：
让 agent 实现题目骨架文件 → 跑该语言的单元测试 → 统计**通过率（pass rate）**。

和 `eval/swe-bench` 互补：SWE-bench 测「仓库级 bug 修复」，polyglot 测「按需求从骨架实现/编辑代码」，
跑得更快、更适合做回归。

整个流程分三步：

```
prepare  →  run  →  evaluate
克隆题库     Agent做题   跑测试算通过率
```

---

## 1. 前置条件

| 依赖 | 说明 |
|---|---|
| **Python (conda `py311`)** | 跑评测脚本；Python 题用 `pytest` 打分。 |
| **Node.js** | 启动本地 agent 服务（`npm start`）。 |
| **Agent 配置** | `~/.ai-agent/config.json` 里配好模型。 |
| 网络 | 首次需联网 `git clone` 题库；之后离线即可。 |
| （可选）其它语言工具链 | 评测 Go/Rust 等需要 `go` / `cargo` 在 PATH 上，否则自动跳过。 |

> **Python 开箱即用**；其它语言只有在对应工具链已安装时才会被评测（否则 `evaluate` 标记为 skipped）。

---

## 2. 一次性安装

```powershell
conda activate py311
cd eval/aider-polyglot
pip install -r requirements.txt
```

---

## 3. 启动 Agent 服务

`run` 步骤通过 HTTP 调用 agent（与 `eval/swe-bench` 同一个契约）：

```powershell
# 在仓库根目录另开终端
npm start
# 看到 "[server] listening on http://localhost:4567" 即就绪
```

---

## 4. 三步流程

下面命令都在 `eval/aider-polyglot/` 目录、`py311` 环境下执行。

### 第 1 步 · prepare —— 克隆题库 + 拷贝题目到 `workspaces/`

```powershell
# Python 前 5 题（默认）
python run_polyglot_eval.py prepare --language python --limit 5

# 指定题目
python run_polyglot_eval.py prepare --language python --slugs bowling poker grep

# 整个语言（Python 共 34 题）
python run_polyglot_eval.py prepare --language python --all
```

- 浅克隆题库到 `repo/`，把每道题拷到 `workspaces/<language>__<slug>/`。
- **会删除参考答案**（`.meta/example.*`），避免 agent 直接抄。
- 写出 `runs/manifest.json`。

### 第 2 步 · run —— 让 Agent 做题

```powershell
python run_polyglot_eval.py run --agent-url http://localhost:4567
```

- 逐题把「题面 + 只能改哪些文件 + 测试命令」发给 agent（`POST /chat`）。
- 每题开跑前会把 workspace 重置为干净骨架（再次隐藏参考答案）。
- 轨迹存到 `runs/traces/<id>.json`；已完成的题再次执行会跳过（要重跑加 `--fresh`）。
- 只跑某几题：`--ids python__bowling python__poker`。

> Agent 自己可以在 workspace 里跑测试迭代；最终判分以第 3 步为准。

### 第 3 步 · evaluate —— 跑测试、算通过率

```powershell
python run_polyglot_eval.py evaluate --run-id poly-1 --model-name claude-opus-4.6
```

- **打分前会用题库里的原始测试文件覆盖 workspace**（防止 agent 改测试作弊）。
- 在每个 workspace 里跑该语言的测试命令（Python: `pytest`），返回码为 0 即通过。
- 输出汇总报告 `claude-opus-4.6.poly-1.json`，并打印通过率，例如：

```
[evaluate] claude-opus-4.6.poly-1.json: passed 4/5 (pass_rate=80.0%)
[evaluate]   passed: python__bowling, python__grep, ...
[evaluate]   failed: python__poker
```

---

## 5. 一键脚本

```powershell
.\run_one_polyglot.ps1
.\run_one_polyglot.ps1 -Slugs "bowling","poker" -RunId poly-small
```

macOS / Linux：

```bash
chmod +x run_one_polyglot.sh   # 首次需要
./run_one_polyglot.sh python poly-1
```

---

## 6. 查看结果

| 内容 | 位置 |
|---|---|
| **汇总分数 / 通过率** | `<model>.<run-id>.json`（`resolved_instances` / `pass_rate`） |
| 单题测试输出 | `logs/<run-id>/<id>.txt` |
| Agent 对话轨迹 | `runs/traces/<id>.json` |
| 题目工作区 | `workspaces/<id>/` |

---

## 7. 其它语言（Go / Rust / JS / …）

- 脚本对 `go`（`go test`）、`rust`（`cargo test`）、`javascript`（`npm install` + `npm test`）已内置命令，
  但**仅在对应工具链已安装时**才会评测，否则 `evaluate` 标记为 skipped。
- 用 `--language go` / `--language rust` 等切换；其余流程相同。
- C++ / Java 需要额外构建步骤，暂未默认接入。

---

## 8. 与 Aider 官方口径的差异

- 官方榜单用 **2 次尝试**（首次失败后把测试报错回喂给模型再修一次），报告的是 `pass_rate_2`。
- 本脚本是 **单次自主尝试**：agent 在一次会话里自己迭代（可自行跑测试），更贴合「自主 agent」的评测语义，
  对应 `pass_rate_1`。需要 2-attempt 协议可在 `run` 里扩展。

---

## 文件结构

```
eval/aider-polyglot/
├── run_polyglot_eval.py   # 主入口：prepare / run / evaluate
├── run_one_polyglot.ps1   # [Windows] 串起三步
├── run_one_polyglot.sh    # [macOS/Linux] 同上
├── requirements.txt       # Python 依赖（requests / pytest）
├── README.md              # 本文档
├── repo/                  # [生成] 克隆的题库
├── workspaces/            # [生成] 每题一个工作区
├── runs/                  # [生成] manifest.json / traces/
└── logs/                  # [生成] 各题测试输出
```

> `repo/`、`workspaces/`、`runs/`、`logs/` 和 `*.json` 报告均为生成产物，已在 `.gitignore` 中忽略。
