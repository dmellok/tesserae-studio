"""mine_data_schema: reverse-engineer a widget's live data into a bindable
``data_schema`` (fields + sample), so the canvas can bind fields by dotted path.

Classifies each flattened field (num/str/arr), humanises labels, infers units,
diffs against the declared schema, and (optionally) writes it back. Paths come
from Tesserae's flattener (see flatten.py), never a reimplemented grammar.
Full contract in docs/build-spec.md.
"""

from __future__ import annotations

import re
from typing import Any

_ISO_DATETIME = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}")
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class MineError(Exception):
    """Mining could not proceed (no data, errored fetch with no sample)."""


def leaf_key(path: str) -> str:
    """Last segment of a dotted / pluck path: current.temp -> temp,
    hourly[].temp -> temp, rain_chance -> rain_chance."""
    parts = [p for p in path.replace("[]", ".").split(".") if p]
    return parts[-1] if parts else path


def humanize(key: str) -> str:
    """Sentence-case the leaf key: rain_chance -> 'Rain chance',
    windSpeed -> 'Wind speed' (first word capitalised, rest lowercased,
    all-caps acronyms kept)."""
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", key.replace("_", " ").replace("-", " "))
    words = spaced.split()
    if not words:
        return key
    out = [words[0] if words[0].isupper() else words[0].capitalize()]
    out += [w if w.isupper() else w.lower() for w in words[1:]]
    return " ".join(out)


def infer_unit(key: str, sample: Any) -> str | None:
    k = key.lower()
    if any(t in k for t in ("humidity", "chance", "probability", "percent", "_pct")):
        return "%"
    if "pressure" in k:
        return "hPa"
    if any(t in k for t in ("wind", "gust", "speed")):
        return "km/h"
    if k in ("temp", "temperature", "feels", "high", "low", "apparent") or k.endswith("_temp"):
        return "°"
    return None


def _iso_format(sample: Any) -> str | None:
    if isinstance(sample, str):
        if _ISO_DATETIME.match(sample):
            return "HH:mm"
        if _ISO_DATE.match(sample):
            return "MMM d"
    return None


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def classify(raw: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
    """Turn one flattened field into a bindable field (+ optional warning), or
    (None, warning) when it is not directly bindable (raw array of objects)."""
    path, ftype = raw["path"], raw["type"]
    sample = raw.get("sample")
    is_pluck = "[]" in path
    key = leaf_key(path)
    base = {"name": path, "label": humanize(key), "sample": sample}

    if ftype == "object[]":
        return None, f"'{path}' is an array of objects; bind '{path}[].<field>' for a chart, not '{path}'."

    if ftype == "array":
        numeric = isinstance(sample, list) and bool(sample) and all(_is_number(v) for v in sample)
        return {**base, "type": "arr", "display": "sparkline" if numeric else "list",
                "chartable": numeric}, None

    if is_pluck:
        numeric = ftype in ("int", "float")
        return {**base, "type": "arr", "display": "sparkline" if numeric else "list",
                "chartable": numeric}, None

    if ftype in ("int", "float"):
        return {**base, "type": "num", "display": "number", "chartable": False}, None
    if ftype == "bool":
        return {**base, "type": "str", "display": "boolean", "chartable": False}, None
    if ftype == "NoneType":
        return ({**base, "type": "str", "display": "text", "chartable": False},
                f"'{path}' was null; type guessed as str, confirm with live data.")
    # str and anything else
    field = {**base, "type": "str", "display": "text", "chartable": False}
    fmt = _iso_format(sample)
    if fmt:
        field["format"] = fmt
    return field, None


def _truncate_sample(data: Any, depth: int = 0) -> Any:
    """Compact snapshot: arrays to first 3, strings to 60, depth-capped."""
    if depth > 5:
        return "…"
    if isinstance(data, dict):
        return {k: _truncate_sample(v, depth + 1) for k, v in data.items()}
    if isinstance(data, list):
        return [_truncate_sample(v, depth + 1) for v in data[:3]]
    if isinstance(data, str) and len(data) > 60:
        return data[:60] + "…"
    return data


def mine(
    raw_fields: list[dict[str, Any]],
    data: Any,
    declared: dict[str, Any] | None,
    *,
    max_fields: int = 64,
) -> dict[str, Any]:
    """Core mining, source-agnostic. ``raw_fields`` are flattener output,
    ``declared`` is the manifest's current ``data_schema`` (or None)."""
    warnings: list[str] = []
    # Deterministic: sort by path, cap.
    ordered = sorted(raw_fields, key=lambda f: f["path"])
    if len(ordered) > max_fields:
        warnings.append(f"more than {max_fields} fields; capped (some paths omitted).")
        ordered = ordered[:max_fields]

    fields: list[dict[str, Any]] = []
    for raw in ordered:
        field, warn = classify(raw)
        if warn:
            warnings.append(warn)
        if field is None:
            continue
        unit = infer_unit(leaf_key(field["name"]), field.get("sample"))
        if unit:
            field["unit"] = unit
        fields.append(field)

    # Preserve author-declared unit/label/color where a name still exists.
    declared_fields = (declared or {}).get("fields") or []
    declared_by_name = {f.get("name"): f for f in declared_fields if isinstance(f, dict)}
    for field in fields:
        prev = declared_by_name.get(field["name"])
        if prev:
            if prev.get("unit"):
                field["unit"] = prev["unit"]  # never overwrite an author unit
            if prev.get("label"):
                field["label"] = prev["label"]

    # Manifest shape: only name/type/label/unit (+ optional format).
    schema_fields = [
        {k: v for k, v in f.items() if k in ("name", "type", "label", "unit", "format")}
        for f in fields
    ]
    data_schema: dict[str, Any] = {"fields": schema_fields, "sample": _truncate_sample(data)}
    if (declared or {}).get("color"):
        data_schema["color"] = declared["color"]

    diff = _drift(schema_fields, declared_fields)
    return {"fields": fields, "data_schema": data_schema, "diff": diff, "warnings": warnings}


def _drift(mined: list[dict], declared: list[dict]) -> dict[str, list]:
    mined_by = {f["name"]: f for f in mined}
    decl_by = {f.get("name"): f for f in declared if isinstance(f, dict)}
    added = sorted(n for n in mined_by if n not in decl_by)
    removed = sorted(n for n in decl_by if n not in mined_by)
    changed = sorted(
        n for n in mined_by
        if n in decl_by
        and (mined_by[n].get("type") != decl_by[n].get("type")
             or mined_by[n].get("unit") != decl_by[n].get("unit"))
    )
    return {"added": added, "removed": removed, "changed": changed}


def apply_to_manifest(manifest: dict[str, Any], data_schema: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of ``manifest`` with the mined data_schema merged in,
    preserving an author ``color`` and dropping fields no longer in the data
    (they are surfaced in the diff, not silently kept)."""
    merged = dict(manifest)
    prev = merged.get("data_schema") or {}
    ds = dict(data_schema)
    if prev.get("color") and "color" not in ds:
        ds["color"] = prev["color"]
    merged["data_schema"] = ds
    return merged
