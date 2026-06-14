#!/usr/bin/env python3
"""
SWE-bench Lite mini-eval for the local coding agent.

Workflow:
  1. prepare  — clone repos for N instances
  2. run      — call POST /chat per instance, collect git diff patches
  3. evaluate — grade patches with the official SWE-bench Docker harness

Example (3-instance smoke test):
  python prepare.py --instance-ids astropy__astropy-12907 django__django-10914 sympy__sympy-20590
  python run_agent.py --agent-url http://localhost:4567
  python evaluate.py --run-id smoke-3
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

from datasets import load_dataset

ROOT = Path(__file__).resolve().parent
WORKSPACES = ROOT / "workspaces"
RUNS = ROOT / "runs"
DATASET = "princeton-nlp/SWE-bench_Lite"

# Small, commonly-used smoke instances (sympy is the official gold-validation id).
DEFAULT_INSTANCES = [
    "sympy__sympy-20590",
    "astropy__astropy-12907",
    "django__django-10914",
]


def load_instances(instance_ids: list[str]) -> list[dict]:
    ds = load_dataset(DATASET, split="test")
    by_id = {row["instance_id"]: row for row in ds}
    missing = [i for i in instance_ids if i not in by_id]
    if missing:
        raise SystemExit(f"Unknown instance ids: {missing}")
    return [by_id[i] for i in instance_ids]


def repo_url(repo: str) -> str:
    return f"https://github.com/{repo}.git"


def git(args: list[str], cwd: Path) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
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


def prepare_instance(instance: dict, retries: int = 3) -> Path:
    iid = instance["instance_id"]
    dest = WORKSPACES / iid
    dest.parent.mkdir(parents=True, exist_ok=True)
    commit = instance["base_commit"]
    url = repo_url(instance["repo"])

    if dest.exists() and (dest / ".git").exists():
        print(f"[prepare] {iid}: workspace exists, resetting to base_commit")
        git(["fetch", "--depth", "1", "origin", commit], dest)
        git(["reset", "--hard", commit], dest)
        git(["clean", "-fdx"], dest)
        return dest

    if dest.exists():
        import shutil

        shutil.rmtree(dest)

    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            print(f"[prepare] {iid}: shallow clone {instance['repo']} @ {commit[:8]} (try {attempt})")
            dest.mkdir(parents=True)
            subprocess.run(["git", "init"], cwd=dest, check=True, env=_git_env())
            subprocess.run(["git", "remote", "add", "origin", url], cwd=dest, check=True, env=_git_env())
            subprocess.run(
                ["git", "fetch", "--depth", "1", "origin", commit],
                cwd=dest,
                check=True,
                env=_git_env(),
            )
            git(["checkout", "FETCH_HEAD"], dest)
            return dest
        except Exception as e:
            last_err = e
            print(f"[prepare] {iid}: clone failed ({e}), retrying...")
            import shutil

            if dest.exists():
                shutil.rmtree(dest, ignore_errors=True)

    raise RuntimeError(f"Failed to prepare {iid} after {retries} attempts: {last_err}")


def prepare(instance_ids: list[str]) -> None:
    instances = load_instances(instance_ids)
    manifest = []
    for inst in instances:
        workspace = prepare_instance(inst)
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
    manifest_path = RUNS / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"[prepare] wrote {manifest_path} ({len(manifest)} instances)")


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


def collect_patch(workspace: Path) -> str:
    patch = git(["diff", "--no-color"], workspace)
    if not patch.strip():
        patch = git(["diff", "--no-color", "HEAD"], workspace)
    # SWE-bench Docker harness expects Unix (LF) patches.
    return patch.replace("\r\n", "\n").replace("\r", "\n")


def run_agent(
    agent_url: str,
    timeout_sec: int,
    model_name: str,
) -> None:
    import requests

    manifest_path = RUNS / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit("Run prepare.py first.")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    predictions_path = RUNS / "predictions.jsonl"
    traces_dir = RUNS / "traces"
    traces_dir.mkdir(parents=True, exist_ok=True)

    # Health check
    try:
        health = requests.get(f"{agent_url.rstrip('/')}/health", timeout=10)
        health.raise_for_status()
    except Exception as e:
        raise SystemExit(
            f"Agent not reachable at {agent_url}/health — start it with `npm start`. ({e})"
        )

    with predictions_path.open("w", encoding="utf-8") as pred_f:
        for item in manifest:
            iid = item["instance_id"]
            workspace = Path(item["workspace"])
            print(f"\n[run] === {iid} ===")
            print(f"[run] workspace: {workspace}")

            # Reset to clean base before each run
            git(["reset", "--hard", item["base_commit"]], workspace)
            git(["clean", "-fdx"], workspace)

            payload = {
                "message": build_prompt(item["problem_statement"]),
                "workspace": str(workspace),
                "mode": "agent",
                "stream": False,
            }

            trace = {"instance_id": iid, "workspace": str(workspace), "agent_url": agent_url}
            try:
                resp = requests.post(
                    f"{agent_url.rstrip('/')}/chat?stream=false",
                    json=payload,
                    headers={"Accept": "application/json"},
                    timeout=timeout_sec,
                )
                trace["status_code"] = resp.status_code
                resp.raise_for_status()
                data = resp.json()
                trace["session_id"] = data.get("session_id")
                trace["final_text"] = data.get("text", "")[:4000]
            except Exception as e:
                trace["error"] = str(e)
                (traces_dir / f"{iid}.json").write_text(
                    json.dumps(trace, indent=2), encoding="utf-8"
                )
                print(f"[run] {iid}: agent error — {e}")
                continue

            patch = collect_patch(workspace)
            trace["patch_lines"] = len(patch.splitlines())
            (traces_dir / f"{iid}.json").write_text(
                json.dumps(trace, indent=2), encoding="utf-8"
            )

            record = {
                "instance_id": iid,
                "model_name_or_path": model_name,
                "model_patch": patch,
            }
            pred_f.write(json.dumps(record) + "\n")
            pred_f.flush()
            print(f"[run] {iid}: patch {len(patch)} chars, {len(patch.splitlines())} lines")

    print(f"\n[run] predictions → {predictions_path}")


def collect_predictions(model_name: str) -> None:
    manifest_path = RUNS / "manifest.json"
    if not manifest_path.exists():
        raise SystemExit("Run prepare.py first.")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    predictions_path = RUNS / "predictions.jsonl"

    with predictions_path.open("w", encoding="utf-8") as pred_f:
        for item in manifest:
            workspace = Path(item["workspace"])
            patch = collect_patch(workspace)
            record = {
                "instance_id": item["instance_id"],
                "model_name_or_path": model_name,
                "model_patch": patch,
            }
            pred_f.write(json.dumps(record) + "\n")
            print(
                f"[collect] {item['instance_id']}: "
                f"{len(patch)} chars, {len(patch.splitlines())} lines"
            )

    print(f"[collect] predictions → {predictions_path}")


def evaluate(run_id: str, instance_ids: list[str], max_workers: int, force_rebuild: bool) -> None:
    predictions = RUNS / "predictions.jsonl"
    if not predictions.exists():
        raise SystemExit("No predictions.jsonl — run `collect` or `run` first.")

    cmd = [
        sys.executable,
        str(ROOT / "run_harness.py"),
        "--dataset_name",
        DATASET,
        "--split",
        "test",
        "--predictions_path",
        str(predictions),
        "--max_workers",
        str(max_workers),
        "--run_id",
        run_id,
        "--cache_level",
        "env",
        "--timeout",
        "1800",
        "--force_rebuild",
        str(force_rebuild).lower(),
    ]
    if instance_ids:
        cmd.extend(["--instance_ids", *instance_ids])
    if force_rebuild:
        # force_rebuild requires building locally; cannot pull from swebench namespace.
        cmd.extend(["--namespace", "none"])

    print("[evaluate] " + " ".join(cmd))
    subprocess.run(cmd, cwd=ROOT, check=False)


def main() -> None:
    parser = argparse.ArgumentParser(description="SWE-bench Lite mini-eval")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_prep = sub.add_parser("prepare", help="Clone repos for instances")
    p_prep.add_argument(
        "--instance-ids",
        nargs="+",
        default=DEFAULT_INSTANCES,
        help="SWE-bench Lite instance ids",
    )

    p_run = sub.add_parser("run", help="Run agent and collect patches")
    p_run.add_argument("--agent-url", default="http://localhost:4567")
    p_run.add_argument("--timeout-sec", type=int, default=3600)
    p_run.add_argument("--model-name", default="local-coding-agent")

    p_collect = sub.add_parser("collect", help="Collect git diff patches from workspaces")
    p_collect.add_argument("--model-name", default="claude-opus-4.6")

    p_eval = sub.add_parser("evaluate", help="Grade predictions with Docker harness")
    p_eval.add_argument("--run-id", default="smoke-3")
    p_eval.add_argument("--instance-ids", nargs="*", default=DEFAULT_INSTANCES)
    p_eval.add_argument("--max-workers", type=int, default=1)
    p_eval.add_argument("--force-rebuild", action="store_true")

    args = parser.parse_args()

    if args.cmd == "prepare":
        prepare(args.instance_ids)
    elif args.cmd == "run":
        run_agent(args.agent_url, args.timeout_sec, args.model_name)
    elif args.cmd == "collect":
        collect_predictions(args.model_name)
    elif args.cmd == "evaluate":
        evaluate(args.run_id, args.instance_ids, args.max_workers, args.force_rebuild)


if __name__ == "__main__":
    main()
