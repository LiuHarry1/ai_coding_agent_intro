#!/usr/bin/env python3
"""
SWE-bench Lite mini-eval harness for the local coding agent.

The pipeline has four subcommands, normally run in order:

  1. prepare   Clone each instance's repo at its base commit into workspaces/
               and write runs/manifest.json.
  2. run       POST the issue to the agent (/chat), then capture the resulting
               git diff as a prediction. Also saves a trace per instance.
  3. collect   Re-collect git diffs from workspaces/ into predictions.jsonl
               (lets you re-grade without re-running the agent).
  4. evaluate  Grade predictions with the official SWE-bench Docker harness.

Example (single-instance smoke test):

  python run_eval.py prepare  --instance-ids sympy__sympy-20590
  python run_eval.py run      --agent-url http://localhost:4567 --model-name claude-opus-4.6
  python run_eval.py collect  --model-name claude-opus-4.6
  python run_eval.py evaluate --run-id smoke-1 --instance-ids sympy__sympy-20590

Note: do NOT pass --force-rebuild for instances whose upstream branch was
deleted (e.g. sympy's "1.7"). force-rebuild clones that branch live and fails;
the default path pulls prebuilt images from the swebench namespace instead.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

from datasets import load_dataset

# Windows consoles default to cp1252, which can't encode characters like "→"
# used in status messages. Force UTF-8 so the pipeline doesn't crash on print.
# line_buffering=True keeps progress visible when stdout is piped/redirected.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", line_buffering=True)  # type: ignore[attr-defined]
    except (AttributeError, ValueError):
        pass


# --------------------------------------------------------------------------
# Paths & configuration
# --------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parent
WORKSPACES = ROOT / "workspaces"
RUNS = ROOT / "runs"
MANIFEST_PATH = RUNS / "manifest.json"
PREDICTIONS_PATH = RUNS / "predictions.jsonl"
TRACES_DIR = RUNS / "traces"

DATASET = "princeton-nlp/SWE-bench_Lite"
SPLIT = "test"
EVAL_CACHE_LEVEL = "env"
EVAL_TIMEOUT_SEC = 1800
DEFAULT_MODEL_NAME = "claude-opus-4.6"

# Small, commonly-used smoke instances (sympy is the official gold-validation id).
DEFAULT_INSTANCES = [
    "sympy__sympy-20590",
    "astropy__astropy-12907",
    "django__django-10914",
    "pallets__flask-4992",
    "psf__requests-3362",
    "pylint-dev__pylint-5859",
    ""
]


# --------------------------------------------------------------------------
# git helpers
# --------------------------------------------------------------------------
def git(args: list[str], cwd: Path) -> str:
    """Run a git command, returning stripped stdout (raises on failure)."""
    result = subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=_git_env(),
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"git {' '.join(args)} failed in {cwd}:\n{result.stderr or result.stdout}"
        )
    return result.stdout.strip()


def _git_env() -> dict[str, str]:
    env = os.environ.copy()
    # Avoid flaky HTTP/2 clone failures on Windows.
    env["GIT_HTTP_VERSION"] = "1.1"
    return env


def reset_workspace(workspace: Path, base_commit: str) -> None:
    """Restore a workspace to a pristine checkout of its base commit."""
    git(["reset", "--hard", base_commit], workspace)
    git(["clean", "-fdx"], workspace)


def commit_available(workspace: Path, commit: str) -> bool:
    """True if `commit` is already present in the local object database."""
    result = subprocess.run(
        ["git", "cat-file", "-t", commit],
        cwd=workspace,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=_git_env(),
    )
    return result.returncode == 0 and result.stdout.strip() == "commit"


def fetch_commit(workspace: Path, commit: str, retries: int = 3) -> None:
    """Fetch a single commit from origin, with retries for flaky networks."""
    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            git(["fetch", "--depth", "1", "origin", commit], workspace)
            return
        except RuntimeError as e:
            last_err = e
            if attempt < retries:
                print(f"[prepare] fetch failed (try {attempt}/{retries}), retrying...")
    raise RuntimeError(
        f"git fetch --depth 1 origin {commit} failed after {retries} attempts.\n"
        f"Check network access to github.com (proxy/VPN/firewall).\n"
        f"Last error: {last_err}"
    )


def collect_patch(workspace: Path) -> str:
    """Return the workspace's git diff, normalized to Unix (LF) line endings."""
    patch = git(["diff", "--no-color"], workspace)
    if not patch.strip():
        patch = git(["diff", "--no-color", "HEAD"], workspace)
    # The SWE-bench Docker harness expects LF patches.
    return patch.replace("\r\n", "\n").replace("\r", "\n")


# --------------------------------------------------------------------------
# Dataset & manifest
# --------------------------------------------------------------------------
def _datasets_cache_dir() -> Path:
    if os.environ.get("HF_DATASETS_CACHE"):
        return Path(os.environ["HF_DATASETS_CACHE"])
    hf_home = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface"))
    return hf_home / "datasets"


def _dataset_cached() -> bool:
    slug = DATASET.lower().replace("/", "___")
    return (_datasets_cache_dir() / slug).is_dir()


def _enable_hf_offline() -> None:
    os.environ["HF_DATASETS_OFFLINE"] = "1"
    os.environ["HF_HUB_OFFLINE"] = "1"


def load_instances(instance_ids: list[str]) -> list[dict]:
    offline = os.environ.get("HF_DATASETS_OFFLINE", "").lower() in ("1", "true", "yes")
    if not offline and _dataset_cached():
        print("[dataset] local cache found — loading offline (skip huggingface.co)")
        _enable_hf_offline()
    ds = load_dataset(DATASET, split=SPLIT)
    by_id = {row["instance_id"]: row for row in ds}
    missing = [i for i in instance_ids if i not in by_id]
    if missing:
        raise SystemExit(f"Unknown instance ids: {missing}")
    return [by_id[i] for i in instance_ids]


def load_manifest() -> list[dict]:
    if not MANIFEST_PATH.exists():
        raise SystemExit("No manifest — run `prepare` first.")
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def read_prediction_ids() -> list[str]:
    """Instance ids present in predictions.jsonl (preserves order)."""
    return list(load_predictions().keys())


def load_predictions() -> dict[str, dict]:
    """Load predictions.jsonl as {instance_id: record}."""
    if not PREDICTIONS_PATH.exists():
        return {}
    preds: dict[str, dict] = {}
    for line in PREDICTIONS_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            rec = json.loads(line)
            preds[rec["instance_id"]] = rec
    return preds


def load_trace(instance_id: str) -> dict | None:
    path = TRACES_DIR / f"{instance_id}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def instance_run_complete(instance_id: str, predictions: dict[str, dict]) -> bool:
    """True if a prior run finished successfully (trace exists, no error, prediction saved)."""
    if instance_id not in predictions:
        return False
    trace = load_trace(instance_id)
    return trace is not None and "error" not in trace


def write_predictions(predictions: dict[str, dict], manifest: list[dict]) -> None:
    """Write predictions.jsonl in manifest order (only instances that have a record)."""
    RUNS.mkdir(parents=True, exist_ok=True)
    with PREDICTIONS_PATH.open("w", encoding="utf-8") as pred_f:
        for item in manifest:
            iid = item["instance_id"]
            if iid in predictions:
                pred_f.write(json.dumps(predictions[iid]) + "\n")


def prediction_record(instance_id: str, model_name: str, patch: str) -> str:
    """Serialize one prediction as a JSONL line."""
    return json.dumps(
        {
            "instance_id": instance_id,
            "model_name_or_path": model_name,
            "model_patch": patch,
        }
    )


def patch_summary(patch: str) -> str:
    return f"{len(patch)} chars, {len(patch.splitlines())} lines"


def filter_manifest(manifest: list[dict], instance_ids: list[str] | None) -> list[dict]:
    """Return manifest rows for `instance_ids` (full manifest if ids omitted)."""
    if not instance_ids:
        return manifest
    by_id = {item["instance_id"]: item for item in manifest}
    missing = [iid for iid in instance_ids if iid not in by_id]
    if missing:
        raise SystemExit(f"Instance ids not in manifest: {missing}")
    return [by_id[iid] for iid in instance_ids]


# --------------------------------------------------------------------------
# Subcommand: prepare
# --------------------------------------------------------------------------
def clone_instance(instance: dict, retries: int = 3) -> Path:
    iid = instance["instance_id"]
    dest = WORKSPACES / iid
    dest.parent.mkdir(parents=True, exist_ok=True)
    commit = instance["base_commit"]
    url = f"https://github.com/{instance['repo']}.git"

    if dest.exists() and (dest / ".git").exists():
        if commit_available(dest, commit):
            print(f"[prepare] {iid}: workspace exists, resetting to base_commit (local)")
            reset_workspace(dest, commit)
            return dest
        head = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=dest,
            capture_output=True,
            env=_git_env(),
        )
        if head.returncode != 0:
            print(f"[prepare] {iid}: incomplete workspace, removing and recloning")
            shutil.rmtree(dest)
        else:
            print(f"[prepare] {iid}: workspace exists but commit missing, fetching from origin")
            fetch_commit(dest, commit, retries=retries)
            reset_workspace(dest, commit)
            return dest

    if dest.exists():
        shutil.rmtree(dest)

    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            print(f"[prepare] {iid}: shallow clone {instance['repo']} @ {commit[:8]} (try {attempt})")
            dest.mkdir(parents=True)
            subprocess.run(["git", "init"], cwd=dest, check=True, env=_git_env())
            subprocess.run(["git", "remote", "add", "origin", url], cwd=dest, check=True, env=_git_env())
            fetch_commit(dest, commit, retries=1)
            git(["checkout", "FETCH_HEAD"], dest)
            return dest
        except Exception as e:
            last_err = e
            print(f"[prepare] {iid}: clone failed ({e}), retrying...")
            if dest.exists():
                shutil.rmtree(dest, ignore_errors=True)

    raise RuntimeError(
        f"Failed to prepare {iid} after {retries} attempts.\n"
        f"Check network access to github.com (proxy/VPN/firewall).\n"
        f"Last error: {last_err}"
    )


def prepare(instance_ids: list[str]) -> None:
    instances = load_instances(instance_ids)
    manifest = []
    for inst in instances:
        workspace = clone_instance(inst)
        manifest.append(
            {
                "instance_id": inst["instance_id"],
                "repo": inst["repo"],
                "base_commit": inst["base_commit"],
                "workspace": str(workspace),
                "problem_statement": inst["problem_statement"],
            }
        )
    RUNS.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"[prepare] wrote {MANIFEST_PATH} ({len(manifest)} instances)")


# --------------------------------------------------------------------------
# Subcommand: run
# --------------------------------------------------------------------------
def build_prompt(problem_statement: str) -> str:
    return (
        "You are fixing a real open-source bug. The repository is already checked out "
        "in your workspace at the correct base commit.\n\n"
        "<issue>\n"
        f"{problem_statement.strip()}\n"
        "</issue>\n\n"
        "Instructions:\n"
        "1. Reproduce the issue if possible (run the relevant tests).\n"
        "2. Find the root cause and implement a minimal fix in the source code.\n"
        "3. Run the relevant tests to verify the fix.\n"
        "4. Do NOT modify test files unless the issue explicitly requires it.\n"
        "5. Do NOT commit — your changes will be collected as a git diff.\n"
        "6. When done, summarize what you changed and which tests you ran."
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


def run_agent(
    agent_url: str,
    timeout_sec: int,
    model_name: str,
    *,
    instance_ids: list[str] | None = None,
    fresh: bool = False,
) -> None:
    manifest = load_manifest()
    to_run = filter_manifest(manifest, instance_ids)
    check_agent_health(agent_url)
    TRACES_DIR.mkdir(parents=True, exist_ok=True)

    predictions = load_predictions()
    if fresh:
        if instance_ids:
            for iid in instance_ids:
                predictions.pop(iid, None)
            print(f"[run] fresh run — re-running {len(to_run)} selected instance(s)")
        else:
            predictions = {}
            print(f"[run] fresh run — re-running all {len(manifest)} instances")
    else:
        completed = [i["instance_id"] for i in to_run if instance_run_complete(i["instance_id"], predictions)]
        pending = len(to_run) - len(completed)
        if instance_ids:
            print(f"[run] selected {len(to_run)} instance(s)")
        if completed:
            print(f"[run] resume — skipping {len(completed)} completed, {pending} pending")
        elif not instance_ids:
            print(f"[run] starting {len(to_run)} instances")

    def save_trace(iid: str, trace: dict) -> None:
        (TRACES_DIR / f"{iid}.json").write_text(json.dumps(trace, indent=2), encoding="utf-8")

    ran = 0
    skipped = 0
    for item in to_run:
        iid = item["instance_id"]
        workspace = Path(item["workspace"])

        if not fresh and instance_run_complete(iid, predictions):
            patch = predictions[iid].get("model_patch", "")
            print(f"\n[run] === {iid} === (skipped, already done)")
            print(f"[run] {iid}: patch {patch_summary(patch)}")
            skipped += 1
            continue

        print(f"\n[run] === {iid} ===")
        print(f"[run] workspace: {workspace}")

        reset_workspace(workspace, item["base_commit"])

        payload = {
            "message": build_prompt(item["problem_statement"]),
            "workspace": str(workspace),
            "mode": "agent",
            "stream": False,
        }
        trace = {"instance_id": iid, "workspace": str(workspace), "agent_url": agent_url}
        try:
            data = call_agent(agent_url, payload, timeout_sec)
            trace["session_id"] = data.get("session_id")
            trace["final_text"] = data.get("text", "")[:4000]
        except Exception as e:
            trace["error"] = str(e)
            save_trace(iid, trace)
            print(f"[run] {iid}: agent error — {e}")
            continue

        patch = collect_patch(workspace)
        trace["patch_lines"] = len(patch.splitlines())
        save_trace(iid, trace)

        predictions[iid] = {
            "instance_id": iid,
            "model_name_or_path": model_name,
            "model_patch": patch,
        }
        write_predictions(predictions, manifest)
        ran += 1
        print(f"[run] {iid}: patch {patch_summary(patch)}")

    print(f"\n[run] predictions → {PREDICTIONS_PATH}")
    print(f"[run] done: {len(predictions)} total ({ran} ran, {skipped} skipped)")


# --------------------------------------------------------------------------
# Subcommand: collect
# --------------------------------------------------------------------------
def collect_predictions(model_name: str) -> None:
    manifest = load_manifest()
    with PREDICTIONS_PATH.open("w", encoding="utf-8") as pred_f:
        for item in manifest:
            iid = item["instance_id"]
            patch = collect_patch(Path(item["workspace"]))
            pred_f.write(prediction_record(iid, model_name, patch) + "\n")
            print(f"[collect] {iid}: {patch_summary(patch)}")
    print(f"[collect] predictions → {PREDICTIONS_PATH}")


# --------------------------------------------------------------------------
# Subcommand: evaluate
# --------------------------------------------------------------------------
def print_summary(run_id: str) -> None:
    """Print resolved/total from the harness summary report, if present."""
    reports = sorted(ROOT.glob(f"*.{run_id}.json"), key=lambda p: p.stat().st_mtime)
    if not reports:
        return
    data = json.loads(reports[-1].read_text(encoding="utf-8"))
    resolved = data.get("resolved_instances", 0)
    total = data.get("total_instances", 0)
    print(f"\n[evaluate] {reports[-1].name}: resolved {resolved}/{total}")
    if data.get("resolved_ids"):
        print(f"[evaluate]   resolved: {', '.join(data['resolved_ids'])}")
    unresolved = [i for i in data.get("submitted_ids", []) if i not in data.get("resolved_ids", [])]
    if unresolved:
        print(f"[evaluate]   unresolved: {', '.join(unresolved)}")


def ensure_docker_host() -> None:
    """Set DOCKER_HOST when Docker Desktop uses a non-default socket (common on macOS)."""
    if os.environ.get("DOCKER_HOST"):
        return
    for sock in (
        Path.home() / ".docker" / "run" / "docker.sock",
        Path("/var/run/docker.sock"),
    ):
        if sock.exists():
            os.environ["DOCKER_HOST"] = f"unix://{sock}"
            return


def check_docker() -> None:
    """Fail fast with a clear message if the Docker daemon is not reachable."""
    try:
        import docker
    except ImportError:
        raise SystemExit(
            "Docker Python package not installed — run `pip install -r requirements.txt`."
        )

    ensure_docker_host()
    try:
        client = docker.from_env()
        client.ping()
    except Exception as e:
        raise SystemExit(
            "Docker is not running or not reachable.\n"
            "  macOS: open Docker Desktop and wait until the whale icon shows *Running*.\n"
            "  Linux: start the docker service (e.g. `sudo systemctl start docker`).\n"
            f"  ({e})"
        )


def evaluate(run_id: str, instance_ids: list[str], max_workers: int, force_rebuild: bool) -> None:
    if not PREDICTIONS_PATH.exists():
        raise SystemExit("No predictions.jsonl — run `collect` or `run` first.")

    check_docker()

    # Default to whatever is in predictions.jsonl so the ids never have to be
    # retyped (and never silently fall back to a wrong default set).
    if not instance_ids:
        instance_ids = read_prediction_ids()
    if not instance_ids:
        raise SystemExit("No instance ids to grade — predictions.jsonl is empty.")

    cmd = [
        sys.executable,
        str(ROOT / "run_harness.py"),
        "--dataset_name", DATASET,
        "--split", SPLIT,
        "--predictions_path", str(PREDICTIONS_PATH),
        "--max_workers", str(max_workers),
        "--run_id", run_id,
        "--cache_level", EVAL_CACHE_LEVEL,
        "--timeout", str(EVAL_TIMEOUT_SEC),
        "--force_rebuild", str(force_rebuild).lower(),
        "--instance_ids", *instance_ids,
    ]
    if force_rebuild:
        # force_rebuild builds locally; it cannot pull from the swebench namespace.
        cmd.extend(["--namespace", "none"])

    print("[evaluate] " + " ".join(cmd))
    subprocess.run(cmd, cwd=ROOT, check=False)
    print_summary(run_id)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="SWE-bench Lite mini-eval")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_prep = sub.add_parser("prepare", help="Clone repos for instances")
    p_prep.add_argument(
        "--instance-ids", nargs="+", default=DEFAULT_INSTANCES, help="SWE-bench Lite instance ids"
    )

    p_run = sub.add_parser("run", help="Run agent and collect patches")
    p_run.add_argument("--agent-url", default="http://localhost:4567")
    p_run.add_argument("--timeout-sec", type=int, default=3600)
    p_run.add_argument("--model-name", default=DEFAULT_MODEL_NAME)
    p_run.add_argument(
        "--instance-ids",
        nargs="+",
        default=None,
        help="Run only these instances (default: all in manifest)",
    )
    p_run.add_argument(
        "--fresh",
        action="store_true",
        help="Re-run from scratch (default: resume). With --instance-ids, only those are reset",
    )

    p_collect = sub.add_parser("collect", help="Collect git diff patches from workspaces")
    p_collect.add_argument("--model-name", default=DEFAULT_MODEL_NAME)

    p_eval = sub.add_parser("evaluate", help="Grade predictions with Docker harness")
    p_eval.add_argument("--run-id", default="smoke-1")
    p_eval.add_argument(
        "--instance-ids",
        nargs="*",
        default=None,
        help="Defaults to all ids in predictions.jsonl",
    )
    p_eval.add_argument("--max-workers", type=int, default=1)
    p_eval.add_argument("--force-rebuild", action="store_true")

    return parser


def main() -> None:
    args = build_parser().parse_args()

    if args.cmd == "prepare":
        prepare(args.instance_ids)
    elif args.cmd == "run":
        run_agent(
            args.agent_url,
            args.timeout_sec,
            args.model_name,
            instance_ids=args.instance_ids,
            fresh=args.fresh,
        )
    elif args.cmd == "collect":
        collect_predictions(args.model_name)
    elif args.cmd == "evaluate":
        evaluate(args.run_id, args.instance_ids, args.max_workers, args.force_rebuild)


if __name__ == "__main__":
    main()
