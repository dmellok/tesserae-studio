"""Package a widget/bundle and generate a marketplace catalog entry for the
`dmellok/tesserae-widgets` catalog.

The catalog is audit-only: a PR adds a `widgets.json` entry + a
`screenshots/<id>/lg.png`; the tarball is the widget's own repo release archive
(`tarball_url`), never committed here. So Studio: builds the tarball + sha256
(for self-hosting or inspection), fetches the release tarball's sha256 when a
`tarball_url` is given, assembles the entry (auto-filling identity from the
manifest, folders for bundles), and validates it against the real
marketplace.schema.json. Opening the PR is a separate, gated step.
"""

from __future__ import annotations

import hashlib
import io
import tarfile
from pathlib import Path
from typing import Any

import httpx

TAGS = [
    "calendar",
    "clock",
    "finance",
    "github",
    "home-assistant",
    "media",
    "news",
    "sports",
    "transit",
    "utility",
    "weather",
]


class PublishError(Exception):
    """A packaging/entry request that can't proceed (bad input)."""


# -- family / folders detection --------------------------------------------
def bundle_folders(all_keys: list[str], widget: str) -> list[str] | None:
    """If ``widget`` belongs to a ``<fam>_core`` family, return the family's
    folders (core first), else None (a single-widget entry)."""
    fam: str | None = None
    if widget.endswith("_core"):
        fam = widget[: -len("_core")]
    elif f"{widget.rsplit('_', 1)[0]}_core" in all_keys and "_" in widget:
        fam = widget.rsplit("_", 1)[0]
    else:
        # widget could be a member whose family core exists under a longer prefix
        for k in all_keys:
            if k.endswith("_core"):
                p = k[: -len("_core")]
                if widget == p or widget.startswith(p + "_"):
                    fam = p
                    break
    if not fam or f"{fam}_core" not in all_keys:
        return None
    members = sorted(k for k in all_keys if k == f"{fam}_core" or k.startswith(fam + "_"))
    core = [k for k in members if k.endswith("_core")]
    rest = [k for k in members if not k.endswith("_core")]
    return core + rest


# -- packaging -------------------------------------------------------------
_IGNORE_DIRS = {"__pycache__", ".git", ".studio", "node_modules", ".pytest_cache"}
_IGNORE_SUFFIXES = {".pyc"}


def package(workspace_root: Path, folders: list[str]) -> tuple[bytes, str]:
    """Tar the given folders (single widget or a bundle) and return
    ``(gzip_bytes, sha256_hex)``. The tar is rooted at each folder name, so a
    bundle is a tar of subfolders, matching the catalog's layout auto-detection."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for fid in folders:
            wdir = (workspace_root / fid).resolve()
            if not (wdir / "plugin.json").is_file():
                raise PublishError(f"{fid} is not a workspace plugin")
            for path in sorted(wdir.rglob("*")):
                rel = path.relative_to(wdir)
                if any(part in _IGNORE_DIRS for part in rel.parts):
                    continue
                if not path.is_file() or path.suffix in _IGNORE_SUFFIXES:
                    continue
                tar.add(path, arcname=f"{fid}/{rel.as_posix()}")
    data = buf.getvalue()
    return data, hashlib.sha256(data).hexdigest()


async def sha256_of_url(url: str) -> str:
    async with httpx.AsyncClient(follow_redirects=True, timeout=60.0) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        return hashlib.sha256(resp.content).hexdigest()


# -- catalog entry ---------------------------------------------------------
def build_catalog_entry(
    manifest: dict[str, Any],
    *,
    entry_id: str,
    folders: list[str] | None,
    opts: dict[str, Any],
) -> dict[str, Any]:
    """Assemble a marketplace entry, auto-filling identity from ``manifest`` and
    taking release/author/tags/source from ``opts``. Does not validate."""
    author = opts.get("author") or {}
    if not author.get("name"):
        raise PublishError("author.name is required")
    tags = opts.get("tags") or []
    if not tags:
        raise PublishError(f"at least one tag is required (from: {', '.join(TAGS)})")
    release = opts.get("release") or {}
    for k in ("version", "tarball_url", "sha256"):
        if not release.get(k):
            raise PublishError(f"release.{k} is required")

    entry: dict[str, Any] = {
        "id": entry_id,
        "name": opts.get("name") or str(manifest.get("name") or entry_id),
        "description": (opts.get("description") or str(manifest.get("description") or ""))[:280],
        "icon": opts.get("icon") or str(manifest.get("icon") or "ph-puzzle-piece"),
        "author": {
            k: v
            for k, v in {"name": author.get("name"), "github": author.get("github")}.items()
            if v
        },
        "tags": tags,
        "kind": "widget",
        "tesserae_compat": str(manifest.get("tesserae_compat") or "1.x"),
        "screenshot_sizes": opts.get("screenshot_sizes") or ["lg"],
        "release": {
            "version": str(release["version"]),
            "tarball_url": str(release["tarball_url"]),
            "sha256": str(release["sha256"]),
        },
    }
    if opts.get("official") is not None:
        entry["official"] = bool(opts["official"])
    if opts.get("source"):
        entry["source"] = str(opts["source"])
    if folders and len(folders) > 1:
        entry["folders"] = folders
    return entry


def validate_entry(entry: dict[str, Any], marketplace_schema: dict[str, Any]) -> list[str]:
    """Validate one entry against the marketplace schema (in an index wrapper).
    Returns human-readable error strings ([] when valid)."""
    try:
        import jsonschema
    except Exception:  # noqa: BLE001
        return []
    index = {"version": 1, "widgets": [entry]}
    validator = jsonschema.Draft202012Validator(marketplace_schema)
    out: list[str] = []
    for err in sorted(validator.iter_errors(index), key=lambda e: list(e.path)):
        path = ".".join(str(p) for p in err.path) or "(root)"
        out.append(f"{path}: {err.message}")
    return out


def pr_body(entry: dict[str, Any]) -> str:
    rel = entry["release"]
    folders = entry.get("folders")
    return "\n".join(
        [
            f"Adds **{entry['name']}** (`{entry['id']}`) to the catalog.",
            "",
            f"- **kind:** {entry['kind']}"
            + (f" (bundle: {', '.join(folders)})" if folders else ""),
            f"- **tags:** {', '.join(entry['tags'])}",
            f"- **version:** {rel['version']}",
            f"- **source:** {entry.get('source', '(not set)')}",
            f"- **tarball:** {rel['tarball_url']}",
            f"- **sha256:** `{rel['sha256']}`",
            "",
            "Screenshot(s): " + ", ".join(entry["screenshot_sizes"]) + ".",
            "",
            "_Prepared by Tesserae Studio._",
        ]
    )


def assemble_pr(
    repo: str,
    entry: dict[str, Any],
    new_index_json: str,
    screenshot_png: bytes | None,
    *,
    title: str,
    body: str,
    push: bool,
) -> dict[str, Any]:
    """Clone the catalog repo to a temp dir, branch, write the updated
    widgets.json + screenshots/<id>/lg.png, and commit. When ``push`` is true,
    push the branch and open the PR with ``gh``; otherwise stop after the local
    commit (for safe verification). Returns a summary. Raises on tooling errors."""
    import shutil
    import subprocess
    import tempfile

    tmp = Path(tempfile.mkdtemp(prefix="studio-catalog-"))
    work = tmp / "repo"

    def run(*args: str, check: bool = True) -> subprocess.CompletedProcess:
        return subprocess.run(
            args,
            cwd=str(work) if work.exists() else None,
            capture_output=True,
            text=True,
            check=check,
        )

    try:
        subprocess.run(
            ["gh", "repo", "clone", repo, str(work), "--", "--depth", "1"],
            capture_output=True,
            text=True,
            check=True,
        )
        branch = f"studio/widget-{entry['id']}"
        run("git", "checkout", "-b", branch)
        (work / "widgets.json").write_text(new_index_json)
        if screenshot_png is not None:
            shot = work / "screenshots" / entry["id"] / "lg.png"
            shot.parent.mkdir(parents=True, exist_ok=True)
            shot.write_bytes(screenshot_png)
        run("git", "add", "-A")
        run(
            "git",
            "-c",
            "user.name=Tesserae Studio",
            "-c",
            "user.email=studio@tesserae.local",
            "commit",
            "-m",
            title,
        )
        diffstat = run("git", "show", "--stat", "--oneline", "HEAD").stdout
        result: dict[str, Any] = {
            "branch": branch,
            "committed": True,
            "pushed": False,
            "diffstat": diffstat.strip(),
            "workdir": str(work),
        }
        if push:
            run("git", "push", "-u", "origin", branch)
            pr = run(
                "gh", "pr", "create", "-R", repo, "--head", branch, "--title", title, "--body", body
            )
            result["pushed"] = True
            result["pr_url"] = pr.stdout.strip()
            shutil.rmtree(tmp, ignore_errors=True)
        return result
    except subprocess.CalledProcessError as exc:
        raise PublishError(f"{' '.join(exc.cmd)}: {exc.stderr or exc.stdout}") from exc


def upsert_into_index(index: dict[str, Any], entry: dict[str, Any]) -> dict[str, Any]:
    """Add or replace ``entry`` in a widgets.json index by id, sorted by id."""
    widgets = [w for w in index.get("widgets", []) if w.get("id") != entry["id"]]
    widgets.append(entry)
    widgets.sort(key=lambda w: w.get("id", ""))
    return {**index, "widgets": widgets}
