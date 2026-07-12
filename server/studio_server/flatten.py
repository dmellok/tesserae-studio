"""Flatten a payload into bindable dot-paths.

Copied verbatim from Tesserae's ``app/mcp_api.py`` (``_flatten_fields`` /
``_trunc``) so the paths Studio mines for ``source="sample"`` are byte-for-byte
the paths the canvas offers. For ``source="live"`` Studio uses the field list the
running Tesserae returns (the same function), so both sources share one grammar.

Keep in sync with Tesserae; the linter's schema drift check surfaces divergence.
"""

from __future__ import annotations

from typing import Any


def _trunc(value: Any) -> Any:
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    s = str(value)
    return s if len(s) <= 60 else s[:60] + "…"


def flatten_fields(
    data: Any, prefix: str = "", out: list[dict[str, Any]] | None = None, depth: int = 0
) -> list[dict[str, Any]]:
    if out is None:
        out = []
    if len(out) >= 80 or depth > 5:
        return out
    if isinstance(data, dict):
        for k, v in data.items():
            flatten_fields(v, f"{prefix}.{k}" if prefix else str(k), out, depth + 1)
    elif isinstance(data, list):
        if data and isinstance(data[0], dict):
            flatten_fields(data[0], f"{prefix}[]", out, depth + 1)
            out.append({"path": prefix, "type": "object[]", "len": len(data)})
        else:
            out.append({"path": prefix, "type": "array", "len": len(data), "sample": data[:3]})
    elif prefix:
        out.append({"path": prefix, "type": type(data).__name__, "sample": _trunc(data)})
    return out
