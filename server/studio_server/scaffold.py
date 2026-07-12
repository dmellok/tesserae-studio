"""Scaffold a new widget into the workspace, and duplicate an existing one.

The generated widget is fragment-first and lint-clean by construction: an ES
module that branches on ``ctx.cell.fragment``, paints from Spectra tokens only,
sizes with container queries, sets ``shadow.innerHTML`` once, uses Phosphor
``ph-bold`` icons, and never fetches from the client. It is a real starting
point, not a stub the author has to unlearn.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

# Archetype -> (body class, default icon). The body class is the Spectra
# archetype the widget renders under (see the widget contract).
_ARCHETYPES: dict[str, tuple[str, str]] = {
    "stat": ("stat-body", "ph-sparkle"),
    "list": ("list-body", "ph-list-bullets"),
    "chart": ("chart-body", "ph-chart-line"),
    "status": ("status-body", "ph-circle-wavy-check"),
    "calendar": ("cal-body", "ph-calendar-dots"),
    "weather": ("wx-body", "ph-cloud-sun"),
    "image": ("img-body", "ph-image"),
}
_DEFAULT_FRAGMENTS: dict[str, list[dict[str, Any]]] = {
    "stat": [{"id": "value", "label": "Value"}, {"id": "label", "label": "Label"}],
    "list": [{"id": "items", "label": "Items"}],
    "chart": [{"id": "chart", "label": "Chart"}, {"id": "latest", "label": "Latest"}],
    "status": [{"id": "state", "label": "State"}],
}


class ScaffoldError(Exception):
    """A bad scaffold/duplicate request (name clash, unknown source)."""


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", name.strip().lower()).strip("_")
    if not slug:
        raise ScaffoldError("name produces an empty id")
    return slug


def scaffold_files(
    name: str,
    archetype: str = "stat",
    fragments: list[dict[str, Any]] | None = None,
    with_server: bool = False,
) -> tuple[str, dict[str, str]]:
    """Return ``(key, {relpath: content})`` for a new widget. Does not write."""
    key = slugify(name)
    if archetype not in _ARCHETYPES:
        archetype = "stat"
    body_class, icon = _ARCHETYPES[archetype]
    frags = (
        fragments
        if fragments
        else _DEFAULT_FRAGMENTS.get(archetype, [{"id": "detail", "label": "Detail"}])
    )
    frags = [_normalise_fragment(f) for f in frags]

    files: dict[str, str] = {
        "plugin.json": _manifest(key, name, icon, frags, with_server),
        "client.js": _client_js(name, body_class, icon, frags),
        "tests/test_smoke.py": _smoke_test(key),
    }
    if with_server:
        files["server.py"] = _server_py()
    return key, files


def _normalise_fragment(f: dict[str, Any]) -> dict[str, Any]:
    fid = slugify(str(f.get("id") or f.get("label") or "part"))
    return {
        "id": fid,
        "label": str(f.get("label") or fid.replace("_", " ").title()),
        "icon": f.get("icon"),
        "w": int(f["w"]) if isinstance(f.get("w"), int) else 200,
        "h": int(f["h"]) if isinstance(f.get("h"), int) else 160,
    }


def _manifest(
    key: str, name: str, icon: str, frags: list[dict[str, Any]], with_server: bool
) -> str:
    manifest: dict[str, Any] = {
        "tesserae_compat": "1.x",
        "name": name,
        "version": "0.1.0",
        "kind": "widget",
        "description": f"{name}, scaffolded by Tesserae Studio.",
        "icon": icon,
        "supports": {"sizes": ["xs", "sm", "md", "lg"]},
        "cell_options": [
            {"name": "title", "type": "string", "label": "Title", "default": name},
        ],
        "fragments": [
            {
                k: v
                for k, v in {
                    "id": f["id"],
                    "label": f["label"],
                    "icon": f["icon"],
                    "w": f["w"],
                    "h": f["h"],
                }.items()
                if v is not None
            }
            for f in frags
        ],
    }
    if with_server:
        # A polite network fetch declares egress; the stub below fetches nothing,
        # so leave requires off until the author adds a real host.
        manifest["data_schema"] = {"fields": [], "sample": {}}
    return json.dumps(manifest, indent=2) + "\n"


def _client_js(name: str, body_class: str, icon: str, frags: list[dict[str, Any]]) -> str:
    cases = "\n".join(
        f'''    case "{f["id"]}":
      body = `<div class="tile"><div class="tile-label">{f["label"]}</div>`
           + `<div class="tile-value">${{value}}</div></div>`;
      break;'''
        for f in frags
    )
    return f'''// {name}, scaffolded by Tesserae Studio.
//
// Fragment-first: branches on ctx.cell.fragment so each piece stands alone on
// the Panels canvas. Paints from Spectra tokens, sizes with container queries,
// no animations, no fetch. Flesh out the bodies below with your real fields.

export default function (shadow, ctx) {{
  const data = ctx.data || {{}};
  const o = (ctx.cell && ctx.cell.options) || {{}};
  const fragment = (ctx.cell && ctx.cell.fragment) || "full";
  const title = o.title ?? "{name}";
  // Bind a real field from ctx.data here once you have a server.py / data_schema.
  const value = data.value ?? "…";

  const styles = `
    <link rel="stylesheet" href="/static/style/spectra-widgets.css" />
    <style>
      .w {{ box-sizing: border-box; width: 100%; height: 100%;
           container-type: size; color: var(--text-primary); background: var(--surface); }}
      .{body_class} {{ width: 100%; height: 100%; display: flex; flex-direction: column;
                   gap: 3cqmin; padding: 6cqmin; }}
      .head {{ display: flex; align-items: center; gap: 3cqmin; color: var(--text-secondary); }}
      .head .ph {{ color: var(--accent-4); font-size: 9cqmin; }}
      .head .title {{ font-size: 7cqmin; }}
      .metric {{ font-size: 26cqmin; font-weight: 700; line-height: 1;
                font-variant-numeric: tabular-nums; }}
      .tile {{ width: 100%; height: 100%; display: flex; flex-direction: column;
              align-items: center; justify-content: center; gap: 2cqmin; padding: 6cqmin;
              background: var(--surface-sunken); border-radius: 4cqmin; }}
      .tile-label {{ font-size: 9cqmin; color: var(--text-secondary); }}
      .tile-value {{ font-size: 34cqmin; font-weight: 700; font-variant-numeric: tabular-nums; }}
    </style>`;

  let body;
  switch (fragment) {{
{cases}
    default:
      body = `<div class="head"><i class="ph ph-bold {icon}"></i>`
           + `<span class="title">${{title}}</span></div>`
           + `<div class="metric">${{value}}</div>`;
  }}

  shadow.innerHTML = `${{styles}}<div class="w"><div class="{body_class}">${{body}}</div></div>`;
}}
'''


def _server_py() -> str:
    return '''"""Server for the scaffolded widget. Runs on the Tesserae side, never the
client. Return a JSON-serialisable dict, or {"error": "friendly message"};
never raise. Declare egress in plugin.json requires: ["network:host"] and cache
polite fetches in ctx["data_dir"] once you add a real host."""

from __future__ import annotations

from typing import Any


def fetch(
    options: dict[str, Any], settings: dict[str, Any], *, ctx: dict[str, Any]
) -> dict[str, Any]:
    # Replace with a real fetch via app.plugin_http.fetch_json / fetch_text.
    return {"value": 0}
'''


def _smoke_test(key: str) -> str:
    return f'''"""{key} smoke: renders at every declared size with no network call."""

from __future__ import annotations

import pytest
from flask.testing import FlaskClient


@pytest.mark.parametrize("size", ["xs", "sm", "md", "lg"])
def test_{key}_renders(client: FlaskClient, size: str) -> None:
    resp = client.get(f"/_test/render?plugin={key}&size={{size}}")
    assert resp.status_code == 200
'''


def copy_widget(src_dir: Path, dest_dir: Path) -> list[str]:
    """Copy a widget folder into the workspace, skipping caches. Returns the
    relative paths written."""
    if dest_dir.exists():
        raise ScaffoldError(f"target already exists: {dest_dir.name}")
    written: list[str] = []
    for path in sorted(src_dir.rglob("*")):
        rel = path.relative_to(src_dir)
        if any(part in {"__pycache__", ".git"} for part in rel.parts):
            continue
        if path.is_dir():
            continue
        dest = dest_dir / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, dest)
        written.append(rel.as_posix())
    return written
