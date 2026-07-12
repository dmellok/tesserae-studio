#!/bin/sh
# Tesserae Studio container entrypoint.
#
# Starts as root only long enough to (1) fix ownership of the persistent data
# volume and (2) read the Home Assistant add-on options, then re-execs the
# process unprivileged under gosu. Idempotent on subsequent boots.
set -e

: "${STUDIO_WORKDIR:=}"

# Home Assistant writes the add-on's options to /data/options.json. Read them
# here as root (the app runs as the unprivileged `studio` user, which may not be
# able to read that file) and export them as env so Settings.from_env picks them
# up. Only sets values the operator hasn't already provided via real env vars.
if [ -f /data/options.json ] && command -v python3 >/dev/null 2>&1; then
    eval "$(python3 - <<'PY'
import json, shlex
try:
    o = json.load(open("/data/options.json"))
except Exception:
    o = {}
import os
def emit(env, key):
    v = o.get(key)
    if isinstance(v, str) and v and not os.environ.get(env):
        print(f"export {env}={shlex.quote(v)}")
emit("STUDIO_TESSERAE_URL", "tesserae_url")
emit("STUDIO_TESSERAE_MCP_TOKEN", "mcp_token")
PY
)"
fi

if [ "$(id -u)" = "0" ]; then
    chown studio:studio /app/data 2>/dev/null || true
    chown -R studio:studio /app/data 2>/dev/null || true
    if [ -n "$STUDIO_WORKDIR" ]; then
        mkdir -p "$STUDIO_WORKDIR"
        chown -R studio:studio "$STUDIO_WORKDIR" 2>/dev/null || true
    fi
    exec gosu studio "$@"
fi

exec "$@"
