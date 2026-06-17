#!/usr/bin/env python3
"""
Aider polyglot mini-eval harness for the local coding agent.

Evaluates the same HTTP agent used by ``eval/swe-bench`` (``npm start`` ->
``POST /chat``) on the `Aider polyglot benchmark
<https://github.com/Aider-AI/polyglot-benchmark>`_: 225 Exercism exercises across
C++, Go, Java, JavaScript, Python and Rust. For each exercise the agent edits a
stub solution file so the language's unit tests pass; we then run those tests to
score it.

Three subcommands, normally run in order:

  1. prepare   Clone the polyglot-benchmark repo and copy selected exercises into
               workspaces/ (the reference solution is removed so the agent can't
               cheat). Writes runs/manifest.json.
  2. run       POST each exercise's instructions to the agent (/chat); the agent
               edits files in its workspace. Saves a trace per exercise.
  3. evaluate  Restore the original test files (anti-tamper), run the language's
               test command in each workspace, and report the pass rate.

Example (Python smoke test):

  python run_polyglot_eval.py prepare  --language python --limit 5
  python run_polyglot_eval.py run      --agent-url http://localhost:4567
  python run_polyglot_eval.py evaluate --run-id poly-1

Only Python works out of the box (needs pytest). Go/Rust/etc. are graded only if
their toolchain (`go`, `cargo`, ...) is on PATH; otherwise they're skipped.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

# Windows consoles default to cp1252, which can't encode characters like "→".
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", line_buffering=True)  # type: ignore[attr-defined]
    except (AttributeError, ValueError):
        pass


# --------------------------------------------------------------------------
# Paths & configuration
# --------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parent
REPO = ROOT / "repo"                 # cached clone of polyglot-benchmark
WORKSPACES = ROOT / "workspaces"
RUNS = ROOT / "runs"
MANIFEST_PATH = RUNS / "manifest.json"
TRACES_DIR = RUNS / "traces"
LOGS_DIR = ROOT / "logs"

BENCHMARK_REPO_URL = "https://github.com/Aider-AI/polyglot-benchmark.git"
DEFAULT_MODEL_NAME = "claude-opus-4.6"
DEFAULT_LIMIT = 5
RUN_TIMEOUT_SEC = 3600
TEST_TIMEOUT_SEC = 300


# Per-language config. ``tool`` is the executable checked on PATH (None = always
# available, e.g. Python via the current interpreter). ``test_cmd`` builds the
# grading command given the list of test files (relative to the workspace).
def _python_test_cmd(test_files: list[str]) -> list[str]:
    return [sys.executable, "-m", "pytest", "-q", *test_files]


LANGUAGES: dict[str, dict] = {
    "python": {
        "tool": None,  # uses the current Python interpreter + pytest
        "test_cmd": _python_test_cmd,
        # Make grading hermetic: don't auto-load third-party pytest plugins from
        # the surrounding conda env (e.g. langsmith), which can import unrelated
        # packages and crash on a polluted PYTHONPATH.
        "env": {"PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1"},
    },
    "go": {
        "tool": "go",
        "test_cmd": lambda _tf: ["go", "test", "./..."],
    },
    "rust": {
        "tool": "cargo",
        "test_cmd": lambda _tf: ["cargo", "test", "--", "--include-ignored"],
    },
    "javascript": {
        "tool": "npm",
        # Exercism JS needs deps installed first; see evaluate()'s setup hook.
        "test_cmd": lambda _tf: ["npm", "test"],
        "setup_cmd": lambda: ["npm", "install", "--no-audit", "--no-fund"],
    },
}


# --------------------------------------------------------------------------
# git helpers
# --------------------------------------------------------------------------
def _git_env() -> dict[str, str]:
    env = os.environ.copy()
    env["GIT_HTTP_VERSION"] = "1.1"  # avoid flaky HTTP/2 clone failures on Windows
    return env


def clone_benchmark(retries: int = 3) -> None:
    """Shallow-clone the polyglot-benchmark repo into REPO (idempotent)."""
    if (REPO / ".git").exists():
        print(f"[prepare] benchmark repo already present at {REPO}")
        return
    if REPO.exists():
        shutil.rmtree(REPO)
    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            print(f"[prepare] cloning {BENCHMARK_REPO_URL} (try {attempt})")
            subprocess.run(
                ["git", "clone", "--depth", "1", BENCHMARK_REPO_URL, str(REPO)],
                check=True,
                env=_git_env(),
            )
            return
        except subprocess.CalledProcessError as e:
            last_err = e
            print(f"[prepare] clone failed ({e}), retrying...")
            if REPO.exists():
                shutil.rmtree(REPO, ignore_errors=True)
    raise RuntimeError(
        f"Failed to clone polyglot-benchmark after {retries} attempts.\n"
        f"Check network access to github.com (proxy/VPN/firewall).\nLast error: {last_err}"
    )


# --------------------------------------------------------------------------
# Exercise discovery & materialization
# --------------------------------------------------------------------------
def practice_dir(language: str) -> Path:
    return REPO / language / "exercises" / "practice"


def list_slugs(language: str) -> list[str]:
    base = practice_dir(language)
    if not base.is_dir():
        raise SystemExit(f"No exercises for language '{language}' at {base}")
    return sorted(p.name for p in base.iterdir() if (p / ".meta" / "config.json").exists())


def read_config(language: str, slug: str) -> dict:
    cfg_path = practice_dir(language) / slug / ".meta" / "config.json"
    return json.loads(cfg_path.read_text(encoding="utf-8"))


def read_instructions(workspace: Path) -> str:
    """Concatenate the .docs markdown files (introduction + instructions + append)."""
    docs = workspace / ".docs"
    if not docs.is_dir():
        return ""
    order = ["introduction.md", "instructions.md", "instructions.append.md"]
    parts: list[str] = []
    for name in order:
        f = docs / name
        if f.exists():
            parts.append(f.read_text(encoding="utf-8").strip())
    # include any other .md not already covered
    for f in sorted(docs.glob("*.md")):
        if f.name not in order:
            parts.append(f.read_text(encoding="utf-8").strip())
    return "\n\n".join(p for p in parts if p)


def materialize_workspace(language: str, slug: str, dest: Path) -> dict:
    """Copy an exercise into ``dest`` fresh, stripping the reference solution.

    Returns the exercise config. Wipes ``dest`` first so this doubles as a reset.
    """
    src = practice_dir(language) / slug
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(src, dest)
    cfg = read_config(language, slug)
    files = cfg.get("files", {})
    # Remove the example/exemplar reference solution so the agent can't read it.
    for rel in files.get("example", []) + files.get("exemplar", []):
        p = dest / rel
        if p.exists():
            p.unlink()
    return cfg


def restore_test_files(entry: dict) -> None:
    """Overwrite the workspace's test files with pristine copies from the repo.

    Prevents the agent from passing by editing tests.
    """
    src = practice_dir(entry["language"]) / entry["slug"]
    workspace = Path(entry["workspace"])
    for rel in entry["test_files"]:
        s = src / rel
        d = workspace / rel
        if s.exists():
            d.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(s, d)


# --------------------------------------------------------------------------
# Manifest
# --------------------------------------------------------------------------
def load_manifest() -> list[dict]:
    if not MANIFEST_PATH.exists():
        raise SystemExit("No manifest — run `prepare` first.")
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def filter_manifest(manifest: list[dict], ids: list[str] | None) -> list[dict]:
    if not ids:
        return manifest
    by_id = {m["id"]: m for m in manifest}
    missing = [i for i in ids if i not in by_id]
    if missing:
        raise SystemExit(f"Ids not in manifest: {missing}")
    return [by_id[i] for i in ids]


# --------------------------------------------------------------------------
# Subcommand: prepare
# --------------------------------------------------------------------------
def prepare(language: str, slugs: list[str] | None, limit: int, all_exercises: bool) -> None:
    if language not in LANGUAGES:
        raise SystemExit(f"Unsupported language '{language}'. Choose from {list(LANGUAGES)}.")
    clone_benchmark()

    available = list_slugs(language)
    if slugs:
        unknown = [s for s in slugs if s not in available]
        if unknown:
            raise SystemExit(f"Unknown {language} exercises: {unknown}")
        selected = slugs
    elif all_exercises:
        selected = available
    else:
        selected = available[:limit]

    manifest: list[dict] = []
    for slug in selected:
        iid = f"{language}__{slug}"
        workspace = WORKSPACES / iid
        cfg = materialize_workspace(language, slug, workspace)
        files = cfg.get("files", {})
        manifest.append(
            {
                "id": iid,
                "language": language,
                "slug": slug,
                "workspace": str(workspace),
                "solution_files": files.get("solution", []),
                "test_files": files.get("test", []),
            }
        )
        print(f"[prepare] {iid}: solution={files.get('solution', [])} test={files.get('test', [])}")

    RUNS.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"[prepare] wrote {MANIFEST_PATH} ({len(manifest)} exercises)")


# --------------------------------------------------------------------------
# Subcommand: run
# --------------------------------------------------------------------------
def build_prompt(instructions: str, solution_files: list[str], test_files: list[str], test_cmd: str) -> str:
    sol = ", ".join(solution_files)
    tst = ", ".join(test_files)
    return (
        "You are solving a coding exercise. The files are already in your workspace.\n\n"
        "<instructions>\n"
        f"{instructions.strip()}\n"
        "</instructions>\n\n"
        f"Implement the solution by editing ONLY these file(s): {sol}\n\n"
        "Rules:\n"
        "1. Do NOT change the names of existing functions or classes — the tests reference them.\n"
        "2. Use only the standard library; do NOT install any packages.\n"
        f"3. Do NOT modify the test file(s): {tst}.\n"
        f"4. You can run the tests yourself with: {test_cmd}\n"
        "5. Iterate until the tests pass. Do NOT commit.\n"
        "6. When done, briefly summarize your solution and the test result."
    )


def check_agent_health(agent_url: str) -> None:
    import requests

    try:
        resp = requests.get(f"{agent_url.rstrip('/')}/health", timeout=10)
        resp.raise_for_status()
    except Exception as e:
        raise SystemExit(
            f"Agent not reachable at {agent_url}/health — start it with `npm start`. ({e})"
        )


def call_agent(agent_url: str, payload: dict, timeout_sec: int) -> dict:
    import requests

    resp = requests.post(
        f"{agent_url.rstrip('/')}/chat?stream=false",
        json=payload,
        headers={"Accept": "application/json"},
        timeout=timeout_sec,
    )
    resp.raise_for_status()
    return resp.json()


def test_cmd_for(entry: dict) -> list[str]:
    return LANGUAGES[entry["language"]]["test_cmd"](entry["test_files"])


def run_agent(agent_url: str, timeout_sec: int, ids: list[str] | None, fresh: bool) -> None:
    manifest = load_manifest()
    to_run = filter_manifest(manifest, ids)
    check_agent_health(agent_url)
    TRACES_DIR.mkdir(parents=True, exist_ok=True)

    def trace_path(iid: str) -> Path:
        return TRACES_DIR / f"{iid}.json"

    ran = skipped = 0
    for entry in to_run:
        iid = entry["id"]
        workspace = Path(entry["workspace"])

        if not fresh and trace_path(iid).exists():
            t = json.loads(trace_path(iid).read_text(encoding="utf-8"))
            if "error" not in t:
                print(f"[run] === {iid} === (skipped, already done)")
                skipped += 1
                continue

        print(f"\n[run] === {iid} ===")
        # Reset workspace to a pristine copy (also re-hides the reference solution).
        materialize_workspace(entry["language"], entry["slug"], workspace)
        instructions = read_instructions(workspace)
        cmd_str = " ".join(test_cmd_for(entry))

        payload = {
            "message": build_prompt(instructions, entry["solution_files"], entry["test_files"], cmd_str),
            "workspace": str(workspace),
            "mode": "agent",
            "stream": False,
        }
        trace = {"id": iid, "workspace": str(workspace), "agent_url": agent_url}
        try:
            data = call_agent(agent_url, payload, timeout_sec)
            trace["session_id"] = data.get("session_id")
            trace["final_text"] = (data.get("text") or "")[:4000]
        except Exception as e:
            trace["error"] = str(e)
            trace_path(iid).write_text(json.dumps(trace, indent=2), encoding="utf-8")
            print(f"[run] {iid}: agent error — {e}")
            continue

        trace_path(iid).write_text(json.dumps(trace, indent=2), encoding="utf-8")
        ran += 1
        print(f"[run] {iid}: done")

    print(f"\n[run] done: {ran} ran, {skipped} skipped")


# --------------------------------------------------------------------------
# Subcommand: evaluate
# --------------------------------------------------------------------------
def toolchain_available(language: str) -> bool:
    tool = LANGUAGES[language]["tool"]
    if tool is None:
        return True
    return shutil.which(tool) is not None


def run_tests(entry: dict) -> tuple[bool, str]:
    """Run the language's test command in the workspace; return (passed, output)."""
    workspace = Path(entry["workspace"])
    lang_cfg = LANGUAGES[entry["language"]]

    test_env = os.environ.copy()
    test_env.update(lang_cfg.get("env", {}))

    # Language-specific one-time setup (e.g. `npm install` for JS).
    setup = lang_cfg.get("setup_cmd")
    if setup is not None:
        try:
            subprocess.run(
                setup(), cwd=workspace, capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=TEST_TIMEOUT_SEC, env=test_env,
            )
        except Exception as e:  # noqa: BLE001 — setup failures surface as test failures
            return False, f"setup failed: {e}"

    cmd = test_cmd_for(entry)
    try:
        result = subprocess.run(
            cmd, cwd=workspace, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=TEST_TIMEOUT_SEC, env=test_env,
        )
    except subprocess.TimeoutExpired:
        return False, f"TIMEOUT after {TEST_TIMEOUT_SEC}s running: {' '.join(cmd)}"
    output = f"$ {' '.join(cmd)}\n[returncode={result.returncode}]\n{result.stdout}\n{result.stderr}"
    return result.returncode == 0, output


def evaluate(run_id: str, ids: list[str] | None, model_name: str) -> None:
    manifest = load_manifest()
    to_eval = filter_manifest(manifest, ids)
    log_dir = LOGS_DIR / run_id
    log_dir.mkdir(parents=True, exist_ok=True)

    results: dict[str, dict] = {}
    passed_ids: list[str] = []
    failed_ids: list[str] = []
    skipped_ids: list[str] = []

    for entry in to_eval:
        iid = entry["id"]
        if not toolchain_available(entry["language"]):
            tool = LANGUAGES[entry["language"]]["tool"]
            print(f"[evaluate] {iid}: SKIP — '{tool}' not on PATH")
            skipped_ids.append(iid)
            results[iid] = {"status": "skipped", "reason": f"{tool} not installed"}
            continue

        # Anti-tamper: restore pristine test files before grading.
        restore_test_files(entry)
        ok, output = run_tests(entry)
        (log_dir / f"{iid}.txt").write_text(output, encoding="utf-8")
        results[iid] = {"status": "pass" if ok else "fail"}
        if ok:
            passed_ids.append(iid)
            print(f"[evaluate] {iid}: PASS")
        else:
            failed_ids.append(iid)
            print(f"[evaluate] {iid}: FAIL  (log: {log_dir / (iid + '.txt')})")

    graded = len(passed_ids) + len(failed_ids)
    pass_rate = (len(passed_ids) / graded) if graded else 0.0
    report = {
        "run_id": run_id,
        "model_name_or_path": model_name,
        "total_instances": len(to_eval),
        "graded_instances": graded,
        "resolved_instances": len(passed_ids),
        "pass_rate": round(pass_rate, 4),
        "resolved_ids": passed_ids,
        "failed_ids": failed_ids,
        "skipped_ids": skipped_ids,
        "results": results,
    }
    report_path = ROOT / f"{model_name}.{run_id}.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(f"\n[evaluate] {report_path.name}: passed {len(passed_ids)}/{graded} (pass_rate={pass_rate:.1%})")
    if skipped_ids:
        print(f"[evaluate]   skipped (no toolchain): {len(skipped_ids)}")
    if passed_ids:
        print(f"[evaluate]   passed: {', '.join(passed_ids)}")
    if failed_ids:
        print(f"[evaluate]   failed: {', '.join(failed_ids)}")


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Aider polyglot mini-eval")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_prep = sub.add_parser("prepare", help="Clone benchmark and copy exercises into workspaces/")
    p_prep.add_argument("--language", default="python", choices=list(LANGUAGES), help="Exercise language")
    p_prep.add_argument("--slugs", nargs="+", default=None, help="Specific exercise slugs (e.g. bowling poker)")
    p_prep.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="First N exercises (if --slugs omitted)")
    p_prep.add_argument("--all", dest="all_exercises", action="store_true", help="Use all exercises for the language")

    p_run = sub.add_parser("run", help="Run the agent on each exercise")
    p_run.add_argument("--agent-url", default="http://localhost:4567")
    p_run.add_argument("--timeout-sec", type=int, default=RUN_TIMEOUT_SEC)
    p_run.add_argument("--ids", nargs="+", default=None, help="Run only these manifest ids")
    p_run.add_argument("--fresh", action="store_true", help="Re-run even already-completed exercises")

    p_eval = sub.add_parser("evaluate", help="Run tests and report pass rate")
    p_eval.add_argument("--run-id", default="poly-1")
    p_eval.add_argument("--ids", nargs="*", default=None, help="Defaults to all in manifest")
    p_eval.add_argument("--model-name", default=DEFAULT_MODEL_NAME)

    return parser


def main() -> None:
    args = build_parser().parse_args()
    if args.cmd == "prepare":
        prepare(args.language, args.slugs, args.limit, args.all_exercises)
    elif args.cmd == "run":
        run_agent(args.agent_url, args.timeout_sec, args.ids, args.fresh)
    elif args.cmd == "evaluate":
        evaluate(args.run_id, args.ids, args.model_name)


if __name__ == "__main__":
    main()
