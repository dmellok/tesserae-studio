"""Scaffold a widget bundle: a shared ``<name>_core`` companion plugin plus
member widgets that read its ``choices()`` / data, following Tesserae's real
family pattern (calendar_core, ha_core). The core is ``kind: "data"`` with a
``blueprint()`` admin page; members are ``kind: "widget"`` that reach the core
via ``current_app.config["PLUGIN_REGISTRY"].get("<core_id>")``.

Generated code is lint-clean and never raises from server.py.
"""

from __future__ import annotations

import json
from typing import Any

from .scaffold import ScaffoldError, slugify
from .scaffold import _client_js as _member_client_js
from .scaffold import _normalise_fragment
from .scaffold import _smoke_test


def scaffold_bundle_files(
    name: str, members: list[dict[str, Any]] | None, admin: bool = True
) -> tuple[str, list[str], dict[str, dict[str, str]]]:
    """Return ``(core_id, member_ids, {folder_id: {relpath: content}})``.

    ``members`` is a list of ``{name, icon?}``; defaults to one "Items" member.
    """
    slug = slugify(name)
    core_id = f"{slug}_core"
    members = members or [{"name": "Items"}]

    folders: dict[str, dict[str, str]] = {}
    folders[core_id] = _core_files(name, core_id, slug, admin)

    member_ids: list[str] = []
    for m in members:
        mname = str(m.get("name") or "").strip()
        if not mname:
            raise ScaffoldError("each member needs a name")
        mslug = slugify(mname)
        member_id = mslug if mslug.startswith(slug) else f"{slug}_{mslug}"
        member_ids.append(member_id)
        folders[member_id] = _member_files(mname, member_id, core_id, m.get("icon"))
    return core_id, member_ids, folders


# -- core companion --------------------------------------------------------
def _core_files(name: str, core_id: str, slug: str, admin: bool) -> dict[str, str]:
    manifest: dict[str, Any] = {
        "tesserae_compat": "1.x",
        "name": f"{name} Core",
        "version": "0.1.0",
        "kind": "data",
        "description": f"Shared config + data for the {slug}_* widget family. Edit its items on the admin page; each member picks which to show.",
        "icon": "ph-stack",
        "supports": {"sizes": ["xs", "sm", "md", "lg"]},
    }
    files = {
        "plugin.json": json.dumps(manifest, indent=2) + "\n",
        "server.py": _core_server(core_id, admin),
    }
    if admin:
        files[f"templates/{core_id}/index.html"] = _core_admin_template(name, core_id)
    return files


def _core_server(core_id: str, admin: bool) -> str:
    imports = "from flask import Blueprint, current_app, redirect, render_template, request, url_for" if admin \
        else "from flask import current_app"
    blueprint = _core_blueprint(core_id) if admin else ""
    return f'''"""{core_id}: shared config + data for the family. Members read it via
``current_app.config["PLUGIN_REGISTRY"].get("{core_id}")``. Config (a list of
items) lives in this plugin's data_dir; edit it on the admin page. Never raises."""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

{imports}

CORE_ID = "{core_id}"


def _data_dir() -> Path:
    plugin = current_app.config["PLUGIN_REGISTRY"].get(CORE_ID)
    if plugin is None:
        raise RuntimeError(f"{{CORE_ID}} plugin not registered")
    return plugin.data_dir


def _items_path() -> Path:
    return _data_dir() / "items.json"


def load_items() -> list[dict[str, Any]]:
    try:
        return json.loads(_items_path().read_text())
    except (OSError, json.JSONDecodeError):
        return []


def _save_items(items: list[dict[str, Any]]) -> None:
    path = _items_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(items, indent=2))


def choices(name: str) -> list[dict[str, str]]:
    """Choices for members' ``choices_from`` cell options."""
    return [{{"value": it["id"], "label": it["name"]}} for it in load_items()]


def get_data(item_ids: list[str] | None = None) -> list[dict[str, Any]]:
    """The data members render. Filtered to ``item_ids`` when given.

    Replace the stub body with a real fetch (app.plugin_http.fetch_json), cached
    in the data_dir, and declare requires: ["network:host"] in plugin.json."""
    items = load_items()
    if item_ids:
        items = [it for it in items if it["id"] in item_ids]
    return items
{blueprint}'''


def _core_blueprint(core_id: str) -> str:
    return f'''

def blueprint() -> "Blueprint":
    bp = Blueprint(f"{{CORE_ID}}_admin", __name__, template_folder="templates")

    @bp.get("/")
    def index() -> str:
        return render_template(f"{{CORE_ID}}/index.html", items=load_items())

    @bp.post("/add")
    def add() -> "Any":
        label = (request.form.get("name") or "").strip()
        if label:
            items = load_items()
            items.append({{"id": uuid.uuid4().hex[:8], "name": label}})
            _save_items(items)
        return redirect(url_for(".index"))

    @bp.post("/delete/<item_id>")
    def delete(item_id: str) -> "Any":
        _save_items([it for it in load_items() if it["id"] != item_id])
        return redirect(url_for(".index"))

    return bp
'''


def _core_admin_template(name: str, core_id: str) -> str:
    return f'''{{% extends "_base.html" %}}
{{% block title %}}{name} Core, Tesserae{{% endblock %}}
{{% block main %}}
<div class="page-head">
  <h1><i class="ph-bold ph-stack" aria-hidden="true"></i> {name}</h1>
  <p class="page-blurb">Items the {core_id.rsplit("_", 1)[0]}_* widgets read. Add or remove them here.</p>
</div>

<section class="card">
  <form method="post" action="{{{{ url_for('{core_id}_admin.add') }}}}" class="form">
    <div class="field">
      <label for="name">Name</label>
      <input type="text" id="name" name="name" placeholder="Item name" required autofocus>
    </div>
    <div class="actions"><button type="submit" class="btn">Add item</button></div>
  </form>
</section>

<section class="card">
  {{% if items %}}
  <ul class="list">
    {{% for it in items %}}
    <li>
      <span>{{{{ it.name }}}}</span>
      <form method="post" action="{{{{ url_for('{core_id}_admin.delete', item_id=it.id) }}}}" style="display:inline">
        <button type="submit" class="btn ghost">Remove</button>
      </form>
    </li>
    {{% endfor %}}
  </ul>
  {{% else %}}
  <p>No items yet. Add one above.</p>
  {{% endif %}}
</section>
{{% endblock %}}
'''


# -- member widget ---------------------------------------------------------
def _member_files(name: str, member_id: str, core_id: str, icon: Any) -> dict[str, str]:
    frags = [_normalise_fragment({"id": "list", "label": "List", "icon": "ph-list"})]
    manifest: dict[str, Any] = {
        "tesserae_compat": "1.x",
        "name": name,
        "version": "0.1.0",
        "kind": "widget",
        "description": f"{name}, reads the {core_id} companion.",
        "icon": str(icon or "ph-list-bullets"),
        "supports": {"sizes": ["xs", "sm", "md", "lg"]},
        "cell_options": [
            {"name": "items", "type": "multiselect", "label": "Items", "choices_from": "items"},
        ],
        "fragments": [
            {k: v for k, v in {"id": f["id"], "label": f["label"], "icon": f["icon"], "w": f["w"], "h": f["h"]}.items() if v is not None}
            for f in frags
        ],
        # Has a server.py; mine the real fields once the core has items.
        "data_schema": {"fields": [], "sample": {}},
    }
    return {
        "plugin.json": json.dumps(manifest, indent=2) + "\n",
        "client.js": _member_client_js(name, "list-body", str(icon or "ph-list-bullets"), frags),
        "server.py": _member_server(core_id),
        "tests/test_smoke.py": _smoke_test(member_id),
    }


def _member_server(core_id: str) -> str:
    return f'''"""Reads the {core_id} companion for its data. Gets the core from the
registry and delegates; returns a friendly error if it is not installed. Never
raises."""

from __future__ import annotations

from typing import Any

from flask import current_app

CORE_ID = "{core_id}"


def _core() -> "Any":
    return current_app.config["PLUGIN_REGISTRY"].get(CORE_ID)


def choices(name: str) -> list[dict[str, str]]:
    core = _core()
    if core is not None and core.server_module is not None:
        return core.server_module.choices(name)
    return []


def fetch(options: dict[str, Any], settings: dict[str, Any], *, ctx: dict[str, Any]) -> dict[str, Any]:
    del settings, ctx
    core = _core()
    if core is None or core.server_module is None:
        return {{"error": "{core_id} plugin not installed.", "items": []}}
    item_ids = options.get("items") or []
    if isinstance(item_ids, str):
        item_ids = [s for s in item_ids.replace(",", " ").split() if s]
    return {{"items": core.server_module.get_data(item_ids)}}
'''
