"""Per-model token pricing and cost computation.

Prices are USD per 1,000,000 tokens. Costs are computed at ingest time and
stored on each usage record so historical price changes never rewrite history.

Override / extend the table without code changes via the `ANALYTICS_PRICING_JSON`
env var — either an inline JSON object or a path to a JSON file, e.g.

    ANALYTICS_PRICING_JSON='{"my-model":{"input":1.0,"output":3.0,"cached":0.25}}'
    ANALYTICS_PRICING_JSON=/etc/analytics/pricing.json
"""
from __future__ import annotations

import json
import os
from functools import lru_cache

from .config import get_settings

# model name (lowercased) -> {input, output, cached} USD / 1M tokens.
_DEFAULT_PRICING: dict[str, dict[str, float]] = {
    "gpt-4o": {"input": 2.5, "output": 10.0, "cached": 1.25},
    "gpt-4o-mini": {"input": 0.15, "output": 0.6, "cached": 0.075},
    "gpt-4.1": {"input": 2.0, "output": 8.0, "cached": 0.5},
    "gpt-4.1-mini": {"input": 0.4, "output": 1.6, "cached": 0.1},
    "o3": {"input": 2.0, "output": 8.0, "cached": 0.5},
    "claude-3-5-sonnet": {"input": 3.0, "output": 15.0, "cached": 0.3},
    "claude-3-7-sonnet": {"input": 3.0, "output": 15.0, "cached": 0.3},
    "claude-sonnet-4": {"input": 3.0, "output": 15.0, "cached": 0.3},
    "deepseek-chat": {"input": 0.27, "output": 1.1, "cached": 0.07},
    "deepseek-reasoner": {"input": 0.55, "output": 2.19, "cached": 0.14},
    "gemini-2.0-flash": {"input": 0.1, "output": 0.4, "cached": 0.025},
    "gemini-1.5-pro": {"input": 1.25, "output": 5.0, "cached": 0.3125},
}


def _load_overrides() -> dict[str, dict[str, float]]:
    raw = get_settings().pricing_json.strip()
    if not raw:
        return {}
    if os.path.isfile(raw):
        with open(raw, encoding="utf-8") as fh:
            data = json.load(fh)
    else:
        data = json.loads(raw)
    return {k.lower(): v for k, v in data.items()}


@lru_cache
def _pricing_table() -> dict[str, dict[str, float]]:
    table = dict(_DEFAULT_PRICING)
    table.update(_load_overrides())
    return table


def _match_model(model: str | None) -> dict[str, float] | None:
    if not model:
        return None
    table = _pricing_table()
    key = model.lower()
    if key in table:
        return table[key]
    # Prefix match so "gpt-4o-2024-08-06" resolves to "gpt-4o".
    candidates = [name for name in table if key.startswith(name)]
    if candidates:
        return table[max(candidates, key=len)]
    return None


def compute_cost_usd(
    model: str | None,
    input_tokens: int,
    output_tokens: int,
    cached_input_tokens: int = 0,
) -> float:
    """Return the USD cost for a single call, or 0.0 for unknown models.

    Cached input tokens are billed at the cached rate and are assumed to be a
    SUBSET already included in `input_tokens`, so the non-cached remainder is
    billed at the standard input rate.
    """
    price = _match_model(model)
    if price is None:
        return 0.0
    fresh_input = max(input_tokens - cached_input_tokens, 0)
    cost = (
        fresh_input / 1_000_000 * price.get("input", 0.0)
        + cached_input_tokens / 1_000_000 * price.get("cached", price.get("input", 0.0))
        + output_tokens / 1_000_000 * price.get("output", 0.0)
    )
    return round(cost, 6)


def is_known_model(model: str | None) -> bool:
    return _match_model(model) is not None
