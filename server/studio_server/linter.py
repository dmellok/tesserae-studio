"""The widget linter: the Golden Rules from CLAUDE.md, encoded as checks.

Each rule is a small function over the widget's files + parsed manifest, yielding
``Finding``s. "Never" rules are errors (hard fails); "Always" rules that can't be
proven are warnings. ``lint_widget`` runs them all. Every rule has a unit test.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from dataclasses import asdict, dataclass
from typing import Any

ERROR = "error"
WARNING = "warning"


@dataclass
class Finding:
    rule: str
    level: str
    message: str
    file: str
    line: int | None = None


def _lines(pattern: str, text: str, flags: int = 0) -> Iterable[tuple[int, re.Match]]:
    for m in re.finditer(pattern, text, flags):
        yield text.count("\n", 0, m.start()) + 1, m


# -- client.js rules --------------------------------------------------------
def _r_no_animation(files, manifest):
    js = files.get("client.js", "")
    for pat in (
        r"@keyframes\b",
        r"\btransition(?:-[a-z]+)?\s*:",
        r"\banimation(?:-[a-z]+)?\s*:\s*(?!false)[a-z0-9]",
    ):
        for line, _ in _lines(pat, js):
            yield Finding(
                "no-animation",
                ERROR,
                "No CSS animations or transitions (the renderer screenshots a still frame).",
                "client.js",
                line,
            )


def _r_no_client_fetch(files, manifest):
    js = files.get("client.js", "")
    for line, _ in _lines(r"\bfetch\s*\(|\bXMLHttpRequest\b|new\s+WebSocket", js):
        yield Finding(
            "no-client-fetch",
            ERROR,
            "No network in client.js. All fetching lives in server.py.",
            "client.js",
            line,
        )
    for line, _ in _lines(r"""<script[^>]+src=|<link[^>]+href=["']https?://""", js):
        yield Finding(
            "no-remote-script",
            ERROR,
            "No remote scripts or stylesheets in client.js.",
            "client.js",
            line,
        )


def _r_no_hardcoded_hex(files, manifest):
    js = files.get("client.js", "")
    for line, m in _lines(r"#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b", js):
        line_text = js.splitlines()[line - 1] if line - 1 < len(js.splitlines()) else ""
        if "identity" in line_text.lower():
            continue  # opt-out for genuine data-identity colours (team/brand/flag)
        yield Finding(
            "no-hardcoded-hex",
            ERROR,
            f"Hard-coded hex {m.group(0)}. Paint from Spectra tokens "
            "(mark data-identity colours with an /* identity */ comment).",
            "client.js",
            line,
        )


def _r_no_media_queries(files, manifest):
    js = files.get("client.js", "")
    for line, _ in _lines(r"@media\b", js):
        yield Finding(
            "no-media-queries",
            ERROR,
            "No media queries; cells can be any size. Use container queries (cqw/cqh/cqmin).",
            "client.js",
            line,
        )


def _r_no_custom_fonts(files, manifest):
    js = files.get("client.js", "")
    for line, _ in _lines(r"@font-face\b", js):
        yield Finding(
            "no-custom-fonts", ERROR, "No custom fonts; inherit the page font.", "client.js", line
        )
    # An absolute font-family (not inherit / a token / a CSS var).
    for line, m in _lines(r"font-family\s*:\s*([^;{}]+)", js):
        val = m.group(1).strip().lower()
        if val.startswith(("inherit", "var(")):
            continue
        yield Finding(
            "no-custom-fonts",
            ERROR,
            "No absolute font-family; inherit the page font (or read var(--font-family)).",
            "client.js",
            line,
        )


def _r_no_shadow_append(files, manifest):
    js = files.get("client.js", "")
    for line, _ in _lines(r"shadow\s*\.\s*append(Child)?\s*\(", js):
        yield Finding(
            "no-shadow-append",
            ERROR,
            "Render is idempotent: set shadow.innerHTML, do not append to the shadow root.",
            "client.js",
            line,
        )


def _r_export_default(files, manifest):
    js = files.get("client.js")
    if js is None:
        yield Finding("client-js-required", ERROR, "A widget must ship a client.js.", "client.js")
        return
    if not re.search(r"export\s+default\s+(async\s+)?(function|\()", js):
        yield Finding(
            "export-default",
            ERROR,
            "client.js must `export default function(shadow, ctx) {}`.",
            "client.js",
        )
    if not re.search(r"shadow\s*\.\s*innerHTML\s*=", js):
        yield Finding(
            "set-innerhtml",
            WARNING,
            "Render by setting shadow.innerHTML (idempotent), not by appending.",
            "client.js",
        )


def _r_fragment_branching(files, manifest):
    js = files.get("client.js", "")
    frags = manifest.get("fragments")
    declares = isinstance(frags, list) and any(
        isinstance(f, dict) and f.get("id") not in (None, "full") for f in frags
    )
    branches = bool(re.search(r"ctx\s*\.\s*(cell\s*\.\s*)?fragment", js))
    if declares and not branches:
        yield Finding(
            "fragment-branching",
            ERROR,
            "Declares fragments but client.js never branches on ctx.cell.fragment.",
            "client.js",
        )
    if not declares:
        yield Finding(
            "fragment-first",
            WARNING,
            "No fragments declared. Decompose the widget into independently-placeable "
            "fragments so it is canvas-native.",
            "plugin.json",
        )


def _r_phosphor_weight(files, manifest):
    js = files.get("client.js", "")
    for line, _ in _lines(r"\bph-fill\b", js):
        yield Finding(
            "phosphor-weight",
            WARNING,
            "Prefer ph-bold over ph-fill (fill blobs on Spectra 6).",
            "client.js",
            line,
        )


def _r_no_ad_hoc_border(files, manifest):
    js = files.get("client.js", "")
    for line, m in _lines(r"\bborder(-(top|bottom|left|right))?\s*:\s*([^;{}]+)", js):
        if "none" in m.group(3).lower():
            continue
        yield Finding(
            "no-ad-hoc-border",
            WARNING,
            "Avoid ad-hoc borders for structure; use spacing, weight, and --surface-sunken.",
            "client.js",
            line,
        )


# -- server.py rules --------------------------------------------------------
# Require an actual call (a following paren) so a docstring/comment that merely
# names fetch_json/fetch_text doesn't read as making a network call.
_NETWORK_CALLS = (
    r"\b(?:fetch_json|fetch_text|urlopen)\s*\("
    r"|requests\s*\.\s*(?:get|post|put|request)\s*\("
    r"|httpx\s*\.\s*\w+\s*\("
)


def _r_no_raise(files, manifest):
    py = files.get("server.py")
    if py is None:
        return
    for line, _ in _lines(r"^\s*raise\b", py, re.MULTILINE):
        yield Finding(
            "no-raise",
            ERROR,
            'server.py must not raise; return {"error": "friendly message"}.',
            "server.py",
            line,
        )


def _r_declare_egress(files, manifest):
    py = files.get("server.py")
    if py is None:
        return
    if not re.search(_NETWORK_CALLS, py):
        return
    requires = manifest.get("requires") or []
    if not any(isinstance(r, str) and r.startswith("network:") for r in requires):
        yield Finding(
            "declare-egress",
            ERROR,
            'server.py makes network calls but plugin.json omits requires: ["network:host"].',
            "plugin.json",
        )


# -- manifest / structure rules --------------------------------------------
def _r_data_schema_when_server(files, manifest):
    if "server.py" in files and not manifest.get("data_schema"):
        yield Finding(
            "data-schema",
            WARNING,
            "Widget has a server.py but no data_schema. Mine one from real fetch() output "
            "so its fields are canvas-bindable.",
            "plugin.json",
        )


def _r_smoke_test(files, manifest):
    smoke = next((p for p in files if p.endswith("test_smoke.py")), None)
    if not smoke:
        yield Finding(
            "smoke-test",
            WARNING,
            "Ship a smoke test (tests/test_smoke.py) that renders at every declared size.",
            "tests/test_smoke.py",
        )


RULES: list[Callable[[dict, dict], Iterable[Finding]]] = [
    _r_no_animation,
    _r_no_client_fetch,
    _r_no_hardcoded_hex,
    _r_no_media_queries,
    _r_no_custom_fonts,
    _r_no_shadow_append,
    _r_export_default,
    _r_fragment_branching,
    _r_phosphor_weight,
    _r_no_ad_hoc_border,
    _r_no_raise,
    _r_declare_egress,
    _r_data_schema_when_server,
    _r_smoke_test,
]


def lint_widget(
    files: dict[str, str], manifest: dict[str, Any], *, schema: dict | None = None
) -> list[dict]:
    """Run every rule. ``files`` maps relpath -> text; ``manifest`` is the parsed
    plugin.json. Pass ``schema`` to also validate the manifest. Returns findings
    sorted by (file, line), errors surfaced first within a file."""
    findings: list[Finding] = []
    for rule in RULES:
        findings.extend(rule(files, manifest))
    if schema is not None:
        findings.extend(_validate_schema(manifest, schema))
    findings.sort(key=lambda f: (f.file, f.line or 0, f.level != ERROR))
    return [asdict(f) for f in findings]


def _validate_schema(manifest: dict, schema: dict) -> Iterable[Finding]:
    try:
        import jsonschema
    except Exception:  # noqa: BLE001 - schema check optional
        return
    validator = jsonschema.Draft202012Validator(schema)
    for err in sorted(validator.iter_errors(manifest), key=lambda e: e.path):
        path = ".".join(str(p) for p in err.path) or "(root)"
        yield Finding("manifest-schema", ERROR, f"{path}: {err.message}", "plugin.json")
