"""Console-script entrypoint: run the Studio server with uvicorn.

Bind host and port come from STUDIO_HOST / STUDIO_PORT so the same ``tesserae-studio``
command works for a local install (127.0.0.1) and a container (0.0.0.0). The built
front end is served by the app itself when ``web/dist`` exists, so this is the only
process needed in production. Home Assistant add-on options are read inside
``Settings.from_env`` (config.py), so they apply here and under any other launcher.
"""

from __future__ import annotations

import os


def main() -> None:
    import uvicorn

    host = os.environ.get("STUDIO_HOST", "127.0.0.1")
    port = int(os.environ.get("STUDIO_PORT", "8770"))
    uvicorn.run("studio_server.app:app", host=host, port=port)


if __name__ == "__main__":
    main()
