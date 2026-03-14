import chalk from "chalk";
import ora from "ora";

// ── 颜色方案 ──────────────────────────────────────────────
const colors = {
  step: chalk.bgCyan.black.bold,
  tool: chalk.yellow.bold,
  args: chalk.gray,
  result: chalk.white,
  agent: chalk.green.bold,
  error: chalk.red.bold,
  info: chalk.cyan,
  dim: chalk.dim,
};

// ── 分隔线 ─────────────────────────────────────────────────
const LINE = chalk.dim("─".repeat(60));
const DOUBLE_LINE = chalk.dim("═".repeat(60));

// ── Spinner ────────────────────────────────────────────────
let spinner = null;

export function startThinking(label = "Thinking...") {
  if (spinner) {
    spinner.text = chalk.cyan(label);
    return;
  }
  spinner = ora({
    text: chalk.cyan(label),
    spinner: "dots",
  }).start();
}

export function stopThinking() {
  if (spinner) {
    spinner.stop();
    spinner = null;
  }
}

// ── 显示函数 ────────────────────────────────────────────────

export function showWelcome(title, info = {}) {
  console.log();
  console.log(DOUBLE_LINE);
  console.log(chalk.bold.cyan(`  ${title}`));
  for (const [key, value] of Object.entries(info)) {
    console.log(chalk.dim(`  ${key}: ${value}`));
  }
  console.log(chalk.dim('  输入 "exit" 退出'));
  console.log(DOUBLE_LINE);
  console.log();
}

export function showStep(n) {
  console.log();
  console.log(colors.step(` STEP ${n} `) + " " + colors.dim("LLM 调用"));
}

export function showToolCall(name, args) {
  const argsStr = JSON.stringify(args);
  const short = argsStr.length > 100 ? argsStr.substring(0, 100) + "…" : argsStr;
  console.log(`  ${colors.tool("⚡ " + name)}`);
  console.log(`  ${colors.args("   " + short)}`);
}

export function showToolResult(result, maxLen = 500) {
  const lines = result.split("\n");
  const preview = lines.slice(0, 15).join("\n");
  const truncated = preview.length > maxLen ? preview.substring(0, maxLen) : preview;

  console.log(colors.dim("  ┌─ result ─────────────────────────────"));
  for (const line of truncated.split("\n")) {
    console.log(colors.dim("  │ ") + colors.result(line));
  }
  if (lines.length > 15 || result.length > maxLen) {
    console.log(colors.dim(`  │ … (${lines.length} lines total)`));
  }
  console.log(colors.dim("  └────────────────────────────────────────"));
}

export function showAgentResponse(text) {
  console.log();
  console.log(LINE);
  console.log(colors.agent("🤖 Agent:"));
  console.log();
  if (text) {
    for (const line of text.split("\n")) {
      console.log("  " + line);
    }
  }
  console.log(LINE);
}

export function showStats(steps) {
  console.log(colors.dim(`  ✓ 共 ${steps} 步完成`));
}

export function showError(message) {
  console.log();
  console.log(colors.error("✖ Error: " + message));
}

// ── 多行输入支持 ─────────────────────────────────────────────
// 粘贴多行文本时，所有行在几 ms 内到达
// 用 debounce 把它们合并成一条完整输入
//
// 关键：busy 标志防止 agent 运行期间接受新输入导致重复执行
export function createMultilineREPL(rl, onInput) {
  let buffer = [];
  let timer = null;
  let busy = false;

  const prompt = () => {
    buffer = [];
    process.stdout.write(chalk.bold("You > "));
  };

  rl.on("line", (line) => {
    if (busy) return;

    buffer.push(line);
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const fullInput = buffer.join("\n").trim();
      buffer = [];

      if (!fullInput) {
        prompt();
        return;
      }
      if (fullInput === "exit" || fullInput === "quit") {
        console.log("\nBye! 👋");
        rl.close();
        return;
      }

      const inputLines = fullInput.split("\n");
      if (inputLines.length > 1) {
        console.log(colors.dim(`  ↳ 收到 ${inputLines.length} 行输入`));
      }

      busy = true;
      try {
        await onInput(fullInput);
      } finally {
        busy = false;
      }
      console.log();
      prompt();
    }, 200);
  });

  prompt();
}

export { chalk };
