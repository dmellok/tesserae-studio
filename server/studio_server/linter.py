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


def sanitize_js(src: str) -> str:
    """Blank out JS comments and ``'``/``"`` string contents so the pattern
    rules match real code, not incidental text (a hex in a comment, ``@media``
    inside a message string, a ``fetch(`` in a doc comment). Blanked spans become
    spaces, newlines are kept, so line numbers stay exact.

    Template literals (backticks) are preserved verbatim: widget CSS lives there,
    so blanking them would hide the hex / media-query / animation / font
    violations these rules are meant to catch. A ``/* identity */`` opt-out is a
    comment and so is blanked here; the hex rule reads that marker off the raw
    source, not this sanitized copy.
    """
    out: list[str] = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        # Line comment: blank to end of line.
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            while i < n and src[i] != "\n":
                out.append(" ")
                i += 1
            continue
        # Block comment: blank to the closing */, keeping newlines.
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            while i < n and not (src[i] == "*" and i + 1 < n and src[i + 1] == "/"):
                out.append("\n" if src[i] == "\n" else " ")
                i += 1
            if i < n:  # the '*'
                out.append(" ")
                i += 1
            if i < n:  # the '/'
                out.append(" ")
                i += 1
            continue
        # Template literal: copy verbatim, tracking ${...} so a backtick inside
        # an interpolation doesn't close it early.
        if c == "`":
            out.append(c)
            i += 1
            depth = 0
            while i < n:
                ch = src[i]
                if ch == "\\" and i + 1 < n:
                    out.append(ch)
                    out.append(src[i + 1])
                    i += 2
                    continue
                if ch == "`" and depth == 0:
                    out.append(ch)
                    i += 1
                    break
                if ch == "$" and i + 1 < n and src[i + 1] == "{":
                    depth += 1
                    out.append("${")
                    i += 2
                    continue
                if ch == "}" and depth > 0:
                    depth -= 1
                    out.append(ch)
                    i += 1
                    continue
                out.append(ch)
                i += 1
            continue
        # Single / double quoted string: keep the quotes, blank the contents.
        if c in ('"', "'"):
            out.append(c)
            i += 1
            while i < n:
                ch = src[i]
                if ch == "\\" and i + 1 < n:
                    out.append("  ")
                    i += 2
                    continue
                if ch == c:
                    out.append(ch)
                    i += 1
                    break
                if ch == "\n":  # unterminated; bail at the newline
                    out.append("\n")
                    i += 1
                    break
                out.append(" ")
                i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


# -- client.js rules --------------------------------------------------------
def _r_no_animation(files, manifest):
    js = sanitize_js(files.get("client.js", ""))
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
    js = sanitize_js(files.get("client.js", ""))
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
    raw = files.get("client.js", "")
    js = sanitize_js(raw)
    raw_lines = raw.splitlines()
    for line, m in _lines(r"#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b", js):
        # Read the opt-out marker off the raw line: sanitize_js blanks the
        # /* identity */ comment, but line numbers still align.
        line_text = raw_lines[line - 1] if line - 1 < len(raw_lines) else ""
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
    js = sanitize_js(files.get("client.js", ""))
    for line, _ in _lines(r"@media\b", js):
        yield Finding(
            "no-media-queries",
            ERROR,
            "No media queries; cells can be any size. Use container queries (cqw/cqh/cqmin).",
            "client.js",
            line,
        )


def _r_no_custom_fonts(files, manifest):
    js = sanitize_js(files.get("client.js", ""))
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
    js = sanitize_js(files.get("client.js", ""))
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
    js = sanitize_js(files.get("client.js", ""))
    for line, _ in _lines(r"\bph-fill\b", js):
        yield Finding(
            "phosphor-weight",
            WARNING,
            "Prefer ph-bold over ph-fill (fill blobs on Spectra 6).",
            "client.js",
            line,
        )


def _r_no_ad_hoc_border(files, manifest):
    js = sanitize_js(files.get("client.js", ""))
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


def _r_select_choices(files, manifest):
    """A select/multiselect cell_option needs its choice list under ``choices``
    (or a ``choices_from`` key). A mis-named ``options`` key parses fine but the
    Tesserae config dropdown reads ``choices`` and renders empty."""
    opts = manifest.get("cell_options")
    if not isinstance(opts, list):
        return
    for opt in opts:
        if not isinstance(opt, dict) or opt.get("type") not in ("select", "multiselect"):
            continue
        name = opt.get("name", "?")
        choices = opt.get("choices")
        if (isinstance(choices, list) and choices) or (
            isinstance(opt.get("choices_from"), str) and opt.get("choices_from")
        ):
            continue
        if "options" in opt:
            yield Finding(
                "select-choices",
                ERROR,
                f"cell_option '{name}' ({opt.get('type')}) puts its choice list under "
                "'options'; the key must be 'choices' (or use choices_from). The config "
                "dropdown renders empty otherwise.",
                "plugin.json",
            )
        else:
            yield Finding(
                "select-choices",
                ERROR,
                f"cell_option '{name}' ({opt.get('type')}) has no 'choices' or 'choices_from'; "
                "its config dropdown would be empty.",
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
    _r_select_choices,
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
