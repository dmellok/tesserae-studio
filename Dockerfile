# Tesserae Studio, official Docker image.
#
# Two stages: a Node stage builds the front end to static files, and a slim
# Python runtime serves both that bundle and the API as a single process. Studio
# never runs a browser itself (faithful e-ink render is proxied to the connected
# Tesserae), so the runtime stays small, no Playwright / Chromium layer.

# ---- front-end build ------------------------------------------------------
FROM node:20-slim AS web
WORKDIR /web
# Install against the lockfile first for a cached dependency layer.
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build   # -> /web/dist

# ---- runtime --------------------------------------------------------------
FROM python:3.12-slim

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    # Studio's package sits at /app/server; put it on the path so the app
    # imports cleanly no matter how the process is launched, and so app.py's
    # repo-relative paths (web/dist, examples) resolve under /app.
    PYTHONPATH=/app/server \
    STUDIO_HOST=0.0.0.0 \
    STUDIO_PORT=8770 \
    # Flag the runtime so the app can hide the self-update path if it grows one.
    STUDIO_IN_DOCKER=1

WORKDIR /app

# Backend (editable so __file__ stays under /app and the console scripts land).
COPY server/ /app/server/
RUN pip install -e /app/server

# The built front end the server mounts at "/", and the seed examples workspace.
COPY --from=web /web/dist /app/web/dist
COPY examples/ /app/examples/

# gosu drops privileges in the entrypoint after fixing bind-mount ownership,
# the same pattern Tesserae uses so a host ./data mount with the wrong UID works.
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -r -u 1001 -m -d /home/studio studio \
    && mkdir -p /app/data \
    && chown -R studio:studio /app

# Persistent state: the authored-widget workspace + fetch caches live here.
VOLUME ["/app/data"]
EXPOSE 8770

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]
# tesserae-studio is the console script from pyproject [project.scripts]; it
# reads STUDIO_HOST / STUDIO_PORT and serves the API + built front end.
CMD ["tesserae-studio"]
