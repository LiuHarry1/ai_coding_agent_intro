#!/usr/bin/env python3
"""Windows-friendly entry for `python -m swebench.harness.run_evaluation`."""

from __future__ import annotations

import runpy
import sys
import types
from pathlib import Path

if sys.platform == "win32":
    resource = types.ModuleType("resource")
    resource.setrlimit = lambda *args, **kwargs: None  # type: ignore[attr-defined]
    sys.modules["resource"] = resource

    # On Windows, swebench writes eval.sh / patch.diff with CRLF line endings
    # (Path.write_text uses text mode). Those files are copied verbatim into the
    # Linux evaluation container, where bash chokes on the trailing '\r'
    # ("set: pipefail: invalid option name", `conda activate testbed\r`, the
    # test patch failing to apply, etc.). Normalize text scripts to LF right
    # before they are sent into the container.
    import swebench.harness.docker_utils as _docker_utils

    _orig_copy_to_container = _docker_utils.copy_to_container

    def _copy_to_container_lf(container, src, dst):  # type: ignore[no-untyped-def]
        try:
            src_path = Path(src)
            if src_path.suffix in {".sh", ".diff"} and src_path.is_file():
                raw = src_path.read_bytes()
                normalized = raw.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
                if normalized != raw:
                    src_path.write_bytes(normalized)
        except OSError:
            pass
        return _orig_copy_to_container(container, src, dst)

    _docker_utils.copy_to_container = _copy_to_container_lf

runpy.run_module("swebench.harness.run_evaluation", run_name="__main__")
