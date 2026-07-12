#!/bin/sh
# Tesserae Studio container entrypoint.
#
# Starts as root only long enough to fix ownership of the persistent data
# volume (the #1 Docker bind-mount gotcha: a host ./data created by uid 1000
# vs the container's studio uid 1001), then re-execs the process unprivileged
# under gosu. Idempotent on subsequent boots.
set -e

# Seed and own the authored-widget workspace so writes succeed. STUDIO_WORKDIR
# defaults into the data volume when the operator points it there (compose / HA).
: "${STUDIO_WORKDIR:=}"

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
