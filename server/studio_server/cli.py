"""Console-script entrypoint: run the Studio server with uvicorn.

Bind host and port come from STUDIO_HOST / STUDIO_PORT so the same ``tesserae-studio``
command works for a local install (127.0.0.1) and a container (0.0.0.0). The built
front end is served by the app itself when ``web/dist`` exists, so this is the only
process needed in production.
"""

from __future__ import annotations

import os

# Home Assistant add-on options -> Studio env. HA Supervisor writes the add-on's
# configured options to /data/options.json for every add-on; map the ones we
# expose there onto the env vars the app reads. A no-op anywhere that file is
# absent (i.e. every non-HA install), and env already set by the operator wins.
_HA_OPTIONS = "/data/options.json"
_HA_ENV_MAP = {
    "tesserae_url": "STUDIO_TESSERAE_URL",
    "mcp_token": "STUDIO_TESSERAE_MCP_TOKEN",
}


def _load_ha_options() -> None:
    if not os.path.exists(_HA_OPTIONS):
        return
    import json

    try:
        with open(_HA_OPTIONS) as fh:
            opts = json.load(fh)
    except (OSError, ValueError):
        return
    for key, env in _HA_ENV_MAP.items():
        value = opts.get(key)
        if value and not os.environ.get(env):
            os.environ[env] = str(value)


def main() -> None:
    import uvicorn

    _load_ha_options()
    host = os.environ.get("STUDIO_HOST", "127.0.0.1")
    port = int(os.environ.get("STUDIO_PORT", "8770"))
    uvicorn.run("studio_server.app:app", host=host, port=port)


if __name__ == "__main__":
    main()
