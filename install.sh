#!/usr/bin/env bash
# Tesserae Studio installer, macOS / Linux / Raspberry Pi.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/dmellok/tesserae-studio/main/install.sh | bash
#
# Optional env vars (pre-answer the prompts; useful in CI / scripts):
#   STUDIO_DIR=/path/to/install        (default: ~/tesserae-studio)
#   STUDIO_PORT=8770                    (default: 8770, prompted)
#   STUDIO_TESSERAE_URL=http://host:8765  live Tesserae for data + faithful render
#   PYTHON=python3.12                  (default: python3)
#   NONINTERACTIVE=1                   skip prompts, use defaults / env
#
# What it does:
#   1. Sanity-checks git, Python 3.11+, and Node 18+.
#   2. Clones (or `git pull`s) the repo to STUDIO_DIR.
#   3. Creates server/.venv and pip-installs the backend (editable).
#   4. Builds the front end (npm ci + npm run build) so the server can
#      serve it as a single process.
#   5. Writes run.sh and prints the run command.
#
# What it does NOT do: set up systemd/launchd auto-start, or touch system
# packages. If git / python3 / node aren't installed it tells you and bails.

set -euo pipefail

# ---------- pretty output ----------
if [[ -t 1 ]]; then
  C_BOLD="$(printf '\033[1m')"; C_DIM="$(printf '\033[2m')"
  C_GREEN="$(printf '\033[32m')"; C_YELLOW="$(printf '\033[33m')"
  C_RED="$(printf '\033[31m')"; C_OFF="$(printf '\033[0m')"
else
  C_BOLD=""; C_DIM=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_OFF=""
fi
info()  { printf '%s•%s %s\n'  "$C_DIM" "$C_OFF" "$*"; }
ok()    { printf '%s✓%s %s\n' "$C_GREEN" "$C_OFF" "$*"; }
warn()  { printf '%s!%s %s\n' "$C_YELLOW" "$C_OFF" "$*"; }
fail()  { printf '%s✗%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }
step()  { printf '\n%s== %s ==%s\n' "$C_BOLD" "$*" "$C_OFF"; }

# ---------- config ----------
INSTALL_DIR="${STUDIO_DIR:-$HOME/tesserae-studio}"
REPO_URL="${STUDIO_REPO:-https://github.com/dmellok/tesserae-studio.git}"
BRANCH="${STUDIO_BRANCH:-main}"
PYTHON="${PYTHON:-python3}"
PORT="${STUDIO_PORT:-}"
TESSERAE_URL="${STUDIO_TESSERAE_URL:-}"

TTY=""
if [[ -t 0 ]]; then TTY=/dev/stdin; elif [[ -r /dev/tty ]]; then TTY=/dev/tty; fi
prompt() {
  local question="$1" default="$2" answer=""
  if [[ "${NONINTERACTIVE:-0}" == "1" || -z "$TTY" ]]; then printf '%s\n' "$default"; return; fi
  read -r -p "${question} [${default}]: " answer < "$TTY" || answer=""
  printf '%s\n' "${answer:-$default}"
}

# ---------- sanity ----------
step "Sanity checks"
command -v git >/dev/null 2>&1 || fail "git not found. Install it first."
command -v "$PYTHON" >/dev/null 2>&1 || fail "$PYTHON not found. Install Python 3.11+ first."
command -v node >/dev/null 2>&1 || fail "node not found. Install Node 18+ first."
command -v npm  >/dev/null 2>&1 || fail "npm not found. Install Node 18+ first."

PY_VERSION="$("$PYTHON" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
PY_MAJOR="${PY_VERSION%%.*}"; PY_MINOR="${PY_VERSION##*.}"
if [[ "$PY_MAJOR" -lt 3 || ( "$PY_MAJOR" -eq 3 && "$PY_MINOR" -lt 11 ) ]]; then
  fail "Python 3.11+ required (found $PY_VERSION). Set PYTHON=python3.12 if you have a newer build."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  fail "Node 18+ required (found $(node -v))."
fi
ok "git, $PYTHON ($PY_VERSION), node $(node -v)"
info "Platform: $(uname -s) / $(uname -m)"

# ---------- interactive prompts ----------
if [[ -z "$PORT" ]]; then PORT="$(prompt "Serve Studio on which port?" "8770")"; fi
PORT="${PORT//[^0-9]/}"
if [[ -z "$PORT" || "$PORT" -lt 1 || "$PORT" -gt 65535 ]]; then warn "Invalid port, using 8770"; PORT=8770; fi
if [[ -z "$TESSERAE_URL" ]]; then
  TESSERAE_URL="$(prompt "Live Tesserae URL (for real data + faithful render; blank for standalone)" "http://localhost:8765")"
fi
info "Port: $PORT"; info "Tesserae: ${TESSERAE_URL:-<standalone>}"

# ---------- clone / update ----------
step "Source"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  info "Existing checkout at $INSTALL_DIR, pulling $BRANCH"
  git -C "$INSTALL_DIR" fetch --quiet origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout --quiet "$BRANCH"
  git -C "$INSTALL_DIR" pull --quiet --ff-only origin "$BRANCH"
  ok "Updated to $(git -C "$INSTALL_DIR" rev-parse --short HEAD)"
elif [[ -e "$INSTALL_DIR" ]]; then
  fail "$INSTALL_DIR exists but isn't a git checkout. Move or delete it, then re-run."
else
  info "Cloning $REPO_URL -> $INSTALL_DIR"
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
  ok "Cloned to $(git -C "$INSTALL_DIR" rev-parse --short HEAD)"
fi
cd "$INSTALL_DIR"

# ---------- backend ----------
step "Backend (Python)"
if [[ ! -d server/.venv ]]; then info "Creating server/.venv"; "$PYTHON" -m venv server/.venv; fi
info "Installing backend (editable)"
server/.venv/bin/pip install --quiet --upgrade pip
server/.venv/bin/pip install --quiet -e ./server
ok "Backend installed"

# ---------- front end ----------
step "Front end (Node)"
info "Installing + building web/ (this can take a minute)"
( cd web && npm ci --silent && npm run build --silent )
ok "Front end built to web/dist"

# ---------- launcher ----------
cat > run.sh <<EOF_RUN
#!/usr/bin/env bash
# Auto-generated by install.sh. Edit freely.
set -euo pipefail
cd "\$(dirname "\$0")"
export STUDIO_PORT="\${STUDIO_PORT:-${PORT}}"
export STUDIO_HOST="\${STUDIO_HOST:-127.0.0.1}"
export STUDIO_TESSERAE_URL="\${STUDIO_TESSERAE_URL:-${TESSERAE_URL}}"
exec server/.venv/bin/python -m uvicorn studio_server.app:app \\
  --app-dir server --host "\$STUDIO_HOST" --port "\$STUDIO_PORT"
EOF_RUN
chmod +x run.sh

# ---------- done ----------
step "Done"
printf '%sTesserae Studio is installed at %s%s\n' "$C_BOLD" "$INSTALL_DIR" "$C_OFF"
printf '\nStart it:\n'
printf '  cd %s\n' "$INSTALL_DIR"
printf '  ./run.sh\n'
printf '\nThen visit %shttp://localhost:%s/%s\n' "$C_BOLD" "$PORT" "$C_OFF"
printf '\nStandalone preview reads assets off a tesserae checkout on disk\n'
printf '(set STUDIO_TESSERAE_PATH). A live Tesserae (STUDIO_TESSERAE_URL) adds\n'
printf 'real fetch() data + faithful e-ink render. See the README.\n'
