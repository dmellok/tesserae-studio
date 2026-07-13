"""One test per Golden Rule (CLAUDE.md): a widget that breaks the rule produces
its finding, and a clean widget produces none."""

from __future__ import annotations

from studio_server.linter import lint_widget, sanitize_js

# A clean, fragment-first widget: valid manifest, well-behaved client.js, smoke
# test, no server. Mutated per test to trip exactly one rule.
CLEAN_JS = (
    "export default function (shadow, ctx) {\n"
    '  const f = ctx.cell.fragment || "full";\n'
    '  shadow.innerHTML = `<div class="w">${f}</div>`;\n'
    "}\n"
)
CLEAN_MANIFEST = {
    "tesserae_compat": "1.x",
    "name": "Clean",
    "version": "0.1.0",
    "kind": "widget",
    "icon": "ph-sparkle",
    "supports": {"sizes": ["md"]},
    "fragments": [{"id": "value", "label": "Value"}],
}
CLEAN_FILES = {"client.js": CLEAN_JS, "tests/test_smoke.py": "def test_x(): pass"}


def ids(files, manifest):
    return {f["rule"] for f in lint_widget(files, manifest)}


def errors(files, manifest):
    return [f for f in lint_widget(files, manifest) if f["level"] == "error"]


def test_clean_widget_has_no_findings():
    assert lint_widget(CLEAN_FILES, CLEAN_MANIFEST) == []


def test_no_animation():
    files = {**CLEAN_FILES, "client.js": CLEAN_JS + "\n/* x */ .a{ transition: all 0.2s; }"}
    assert "no-animation" in ids(files, CLEAN_MANIFEST)


def test_no_animation_allows_chart_animation_false():
    files = {**CLEAN_FILES, "client.js": CLEAN_JS + "\nconst c = { animation: false };"}
    assert "no-animation" not in ids(files, CLEAN_MANIFEST)


def test_no_client_fetch():
    files = {**CLEAN_FILES, "client.js": CLEAN_JS + "\nfetch('/x');"}
    assert "no-client-fetch" in ids(files, CLEAN_MANIFEST)


def test_no_remote_script():
    files = {
        **CLEAN_FILES,
        "client.js": CLEAN_JS + '\nx.innerHTML = `<script src="https://cdn/x.js"></script>`;',
    }
    assert "no-remote-script" in ids(files, CLEAN_MANIFEST)


def test_no_hardcoded_hex():
    files = {**CLEAN_FILES, "client.js": CLEAN_JS + "\n.a{ color: #ff0000; }"}
    assert "no-hardcoded-hex" in ids(files, CLEAN_MANIFEST)


def test_hex_identity_optout():
    files = {**CLEAN_FILES, "client.js": CLEAN_JS + "\n.team{ color: #ff0000; /* identity */ }"}
    assert "no-hardcoded-hex" not in ids(files, CLEAN_MANIFEST)


def test_no_media_queries():
    files = {**CLEAN_FILES, "client.js": CLEAN_JS + "\n@media (min-width: 400px) { .a{} }"}
    assert "no-media-queries" in ids(files, CLEAN_MANIFEST)


def test_no_custom_fonts_fontface():
    files = {**CLEAN_FILES, "client.js": CLEAN_JS + "\n@font-face { font-family: X; }"}
    assert "no-custom-fonts" in ids(files, CLEAN_MANIFEST)


def test_no_custom_fonts_absolute_family():
    files = {**CLEAN_FILES, "client.js": CLEAN_JS + "\n.a{ font-family: Arial, sans-serif; }"}
    assert "no-custom-fonts" in ids(files, CLEAN_MANIFEST)


def test_font_family_inherit_and_var_ok():
    files = {
        **CLEAN_FILES,
        "client.js": CLEAN_JS
        + "\n.a{ font-family: inherit; } .b{ font-family: var(--font-family); }",
    }
    assert "no-custom-fonts" not in ids(files, CLEAN_MANIFEST)


def test_no_shadow_append():
    files = {**CLEAN_FILES, "client.js": CLEAN_JS + "\nshadow.appendChild(el);"}
    assert "no-shadow-append" in ids(files, CLEAN_MANIFEST)


def test_export_default_required():
    files = {**CLEAN_FILES, "client.js": "function render(){}"}
    assert "export-default" in ids(files, CLEAN_MANIFEST)


def test_fragment_branching_required_when_declared():
    js = 'export default function (s, ctx) { s.innerHTML = "x"; }'
    assert "fragment-branching" in ids({**CLEAN_FILES, "client.js": js}, CLEAN_MANIFEST)


def test_fragment_first_warns_when_no_fragments():
    manifest = {**CLEAN_MANIFEST, "fragments": []}
    assert "fragment-first" in ids(CLEAN_FILES, manifest)


def test_phosphor_weight_prefers_bold():
    files = {**CLEAN_FILES, "client.js": CLEAN_JS + '\nx = `<i class="ph-fill ph-sun"></i>`;'}
    assert "phosphor-weight" in ids(files, CLEAN_MANIFEST)


def test_no_ad_hoc_border():
    files = {**CLEAN_FILES, "client.js": CLEAN_JS + "\n.a{ border: 1px solid gray; }"}
    assert "no-ad-hoc-border" in ids(files, CLEAN_MANIFEST)


def test_no_raise_in_server():
    files = {**CLEAN_FILES, "server.py": "def fetch(o, s, *, ctx):\n    raise ValueError('x')\n"}
    assert "no-raise" in ids(files, CLEAN_MANIFEST)


def test_declare_egress_when_server_fetches():
    files = {
        **CLEAN_FILES,
        "server.py": "def fetch(o, s, *, ctx):\n    return fetch_json('http://x')\n",
    }
    assert "declare-egress" in ids(files, CLEAN_MANIFEST)


def test_egress_ok_when_declared():
    files = {
        **CLEAN_FILES,
        "server.py": "def fetch(o, s, *, ctx):\n    return fetch_json('http://x')\n",
    }
    manifest = {
        **CLEAN_MANIFEST,
        "requires": ["network:host"],
        "data_schema": {"fields": [], "sample": {}},
    }
    assert "declare-egress" not in ids(files, manifest)


def test_data_schema_when_server():
    files = {**CLEAN_FILES, "server.py": "def fetch(o, s, *, ctx):\n    return {}\n"}
    assert "data-schema" in ids(files, CLEAN_MANIFEST)


def test_smoke_test_expected():
    files = {"client.js": CLEAN_JS}  # no tests/test_smoke.py
    assert "smoke-test" in ids(files, CLEAN_MANIFEST)


# -- False positives: pattern rules must see code, not comments/strings -------
# sanitize_js blanks comments and '/" string contents (keeping line numbers)
# before the pattern rules run. Template literals are preserved verbatim, since
# that is where real widget CSS (and its real violations) lives.


def test_hex_in_line_comment_not_flagged():
    files = {**CLEAN_FILES, "client.js": CLEAN_JS + "\n// brand swatch is #ff0000 in the mock"}
    assert "no-hardcoded-hex" not in ids(files, CLEAN_MANIFEST)


def test_hex_in_block_comment_not_flagged():
    files = {**CLEAN_FILES, "client.js": CLEAN_JS + "\n/* palette note: #abcdef, #123 */"}
    assert "no-hardcoded-hex" not in ids(files, CLEAN_MANIFEST)


def test_hex_in_string_not_flagged():
    files = {**CLEAN_FILES, "client.js": CLEAN_JS + '\nconst label = "use #ff0000 sparingly";'}
    assert "no-hardcoded-hex" not in ids(files, CLEAN_MANIFEST)


def test_media_in_string_not_flagged():
    files = {**CLEAN_FILES, "client.js": CLEAN_JS + "\nconst hint = 'avoid @media in widgets';"}
    assert "no-media-queries" not in ids(files, CLEAN_MANIFEST)


def test_fetch_in_comment_not_flagged():
    files = {**CLEAN_FILES, "client.js": CLEAN_JS + "\n// never call fetch() here; use server.py"}
    assert "no-client-fetch" not in ids(files, CLEAN_MANIFEST)


def test_fetch_in_string_not_flagged():
    files = {**CLEAN_FILES, "client.js": CLEAN_JS + '\nconst msg = "no fetch() in client.js";'}
    assert "no-client-fetch" not in ids(files, CLEAN_MANIFEST)


def test_real_violations_in_template_literal_still_flagged():
    # Widget CSS lives in a backtick template; preserving it verbatim is what
    # keeps these rules working. A hex and an @media there must still fire.
    css = (
        "export default function (shadow, ctx) {\n"
        "  const f = ctx.cell.fragment;\n"
        "  shadow.innerHTML = `<style>\n"
        "    .w { color: #ff0000; }\n"
        "    @media (min-width: 400px) { .w { color: red; } }\n"
        '  </style><div class="w">${f}</div>`;\n'
        "}\n"
    )
    found = ids({**CLEAN_FILES, "client.js": css}, CLEAN_MANIFEST)
    assert "no-hardcoded-hex" in found
    assert "no-media-queries" in found


def test_hex_identity_optout_in_template_literal():
    css = (
        "export default function (shadow, ctx) {\n"
        "  const f = ctx.cell.fragment;\n"
        "  shadow.innerHTML = `<style>.team{ color: #ff0000; /* identity */ }</style>${f}`;\n"
        "}\n"
    )
    assert "no-hardcoded-hex" not in ids({**CLEAN_FILES, "client.js": css}, CLEAN_MANIFEST)


def test_sanitize_js_preserves_line_numbers():
    src = "a;\n/* multi\nline\ncomment */\n'string with\\nescape';\n`template #ff0000`;\n"
    out = sanitize_js(src)
    assert src.count("\n") == out.count("\n")
    assert "#ff0000" in out  # template literal preserved verbatim
    assert "multi" not in out  # block comment blanked


def test_select_choices_required():
    manifest = {
        **CLEAN_MANIFEST,
        "cell_options": [{"name": "mode", "type": "select", "default": "a"}],
    }
    assert "select-choices" in ids(CLEAN_FILES, manifest)


def test_select_choices_misnamed_options_key():
    manifest = {
        **CLEAN_MANIFEST,
        "cell_options": [
            {"name": "mode", "type": "select", "options": [{"value": "a", "label": "A"}]}
        ],
    }
    findings = [f for f in lint_widget(CLEAN_FILES, manifest) if f["rule"] == "select-choices"]
    assert findings and "'options'" in findings[0]["message"]


def test_select_with_choices_ok():
    manifest = {
        **CLEAN_MANIFEST,
        "cell_options": [
            {"name": "mode", "type": "select", "choices": [{"value": "a", "label": "A"}]},
            {"name": "src", "type": "multiselect", "choices_from": "items"},
            {"name": "label", "type": "string"},
        ],
    }
    assert "select-choices" not in ids(CLEAN_FILES, manifest)


def test_manifest_schema_validation():
    schema = {
        "type": "object",
        "required": ["name", "kind"],
        "properties": {"kind": {"enum": ["widget"]}},
    }
    bad = {**CLEAN_MANIFEST, "kind": "not-a-kind"}
    findings = lint_widget(CLEAN_FILES, bad, schema=schema)
    assert any(f["rule"] == "manifest-schema" for f in findings)
