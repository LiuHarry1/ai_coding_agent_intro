#!/usr/bin/env python3
"""Windows-friendly entry for `python -m swebench.harness.run_evaluation`."""

from __future__ import annotations

import runpy
import sys
import types

if sys.platform == "win32":
    resource = types.ModuleType("resource")
    resource.setrlimit = lambda *args, **kwargs: None  # type: ignore[attr-defined]
    sys.modules["resource"] = resource

runpy.run_module("swebench.harness.run_evaluation", run_name="__main__")
