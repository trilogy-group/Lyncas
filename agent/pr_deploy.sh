#!/usr/bin/env bash
# pr_deploy.sh — clone a PR, install/build/run it, and expose a live
# Cloudflare preview URL. Designed to be *watched live* in the dashboard
# Terminal tab: every step echoes a clear banner, and the final preview
# link is printed as `PREVIEW URL: https://…` so it's easy to spot.
#
#   Usage: bash pr_deploy.sh <owner/repo> <pr_number>
#
# Auth: reads GITHUB_TOKEN_PAT from the environment, or from agent/.env
# next to this script. The token is never echoed.
#
# TESTING-PHASE NOTES:
#   * No isolation — this runs on the shared house-terminal box. Don't
#     point it at untrusted PRs until container isolation lands.
#   * Best-effort stack detection (Node / Python / Go). Unknown stacks
#     get a clear message rather than a silent hang.
#   * Keeps the app + tunnel in the foreground so the preview stays live
#     while you watch; Ctrl+C tears both down.

set -uo pipefail

# ---- pretty output --------------------------------------------------------
if [ -t 1 ]; then
  B="\033[1m"; DIM="\033[2m"; GRN="\033[32m"; YEL="\033[33m"; RED="\033[31m"; CYN="\033[36m"; RST="\033[0m"
else
  B=""; DIM=""; GRN=""; YEL=""; RED=""; CYN=""; RST=""
fi
step() { printf "\n${B}${CYN}▸ %s${RST}\n" "$1"; }
ok()   { printf "${GRN}✓ %s${RST}\n" "$1"; }
warn() { printf "${YEL}! %s${RST}\n" "$1"; }
die()  { printf "\n${RED}✗ %s${RST}\n" "$1"; exit 1; }

REPO="${1:-}"
PR="${2:-}"

[ -n "$REPO" ] || die "usage: pr_deploy.sh <owner/repo> <pr_number>"
[ -n "$PR" ]   || die "usage: pr_deploy.sh <owner/repo> <pr_number>"
[[ "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "invalid repo: $REPO"
[[ "$PR" =~ ^[0-9]+$ ]] || die "invalid pr number: $PR"

# ---- token ----------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "${GITHUB_TOKEN_PAT:-}" ] && [ -f "$SCRIPT_DIR/.env" ]; then
  set -a; . "$SCRIPT_DIR/.env"; set +a
fi
TOKEN="${GITHUB_TOKEN_PAT:-}"
[ -n "$TOKEN" ] || die "GITHUB_TOKEN_PAT not set (export it or add it to agent/.env)"

printf "${B}Lyncas PR deploy${RST} ${DIM}— %s PR #%s${RST}\n" "$REPO" "$PR"

WORKDIR="/tmp/lyncas-deploy-${PR}"
APP_PID=""; CF_PID=""
cleanup() {
  [ -n "$CF_PID" ]  && kill "$CF_PID"  2>/dev/null
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

# ---- 1. clone -------------------------------------------------------------
step "Cloning $REPO (PR #$PR)"
rm -rf "$WORKDIR"
git clone --depth 1 "https://x-access-token:${TOKEN}@github.com/${REPO}.git" "$WORKDIR" 2>&1 \
  | sed 's/x-access-token:[^@]*@/x-access-token:***@/g' \
  || die "clone failed"
cd "$WORKDIR" || die "cannot enter $WORKDIR"
git fetch --depth 1 origin "pull/${PR}/head:pr-${PR}" 2>&1 \
  | sed 's/x-access-token:[^@]*@/x-access-token:***@/g' \
  || die "could not fetch PR #$PR (is the number right?)"
git checkout "pr-${PR}" >/dev/null 2>&1 || die "could not check out PR branch"
ok "Checked out PR #$PR at $(git rev-parse --short HEAD)"

# ---- 2. detect stack ------------------------------------------------------
step "Detecting stack"
STACK="unknown"
if [ -f package.json ]; then STACK="node"
elif [ -f requirements.txt ] || [ -f pyproject.toml ]; then STACK="python"
elif [ -f go.mod ]; then STACK="go"
fi
ok "Stack: $STACK"

PORT=3000
START_CMD=""

case "$STACK" in
  node)
    step "Installing dependencies (npm)"
    if [ -f package-lock.json ]; then npm ci 2>&1 || npm install 2>&1; else npm install 2>&1; fi
    if grep -q '"build"' package.json; then
      step "Building (npm run build)"
      npm run build 2>&1 || warn "build failed — trying to start anyway"
    fi
    if grep -q '"start"' package.json; then START_CMD="npm start"; else START_CMD="npm run dev"; fi
    PORT=3000
    ;;
  python)
    step "Installing dependencies (pip)"
    [ -f requirements.txt ] && { pip install --break-system-packages -r requirements.txt 2>&1 || pip install -r requirements.txt 2>&1; }
    if [ -f manage.py ]; then START_CMD="python3 manage.py runserver 0.0.0.0:8000"; PORT=8000
    elif [ -f app.py ]; then START_CMD="python3 app.py"; PORT=5000
    elif [ -f main.py ]; then START_CMD="python3 main.py"; PORT=8000
    else die "no python entrypoint found (manage.py / app.py / main.py)"; fi
    ;;
  go)
    step "Building (go build)"
    go build -o /tmp/lyncas-app-"$PR" ./... 2>&1 || warn "go build reported issues"
    START_CMD="go run ."
    PORT=8080
    ;;
  *)
    die "unsupported stack — no package.json / requirements.txt / go.mod found"
    ;;
esac

# ---- 3. start app ---------------------------------------------------------
step "Starting app: $START_CMD"
PORT="$PORT" HOST=0.0.0.0 bash -lc "$START_CMD" > /tmp/lyncas-app-"$PR".log 2>&1 &
APP_PID=$!
ok "App launched (pid $APP_PID) — waiting for it to listen…"

# ---- 4. probe for a listening port ---------------------------------------
CANDIDATES=("$PORT" 3000 8000 8080 5000 4000)
FOUND=""
for _ in $(seq 1 30); do
  sleep 1
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    printf "${DIM}---- app log ----${RST}\n"; tail -n 40 /tmp/lyncas-app-"$PR".log
    die "app process exited before binding a port"
  fi
  for p in "${CANDIDATES[@]}"; do
    if (command -v ss >/dev/null && ss -ltn 2>/dev/null | grep -q ":${p} ") \
       || (command -v curl >/dev/null && curl -s -o /dev/null "http://localhost:${p}"); then
      FOUND="$p"; break
    fi
  done
  [ -n "$FOUND" ] && break
done
[ -n "$FOUND" ] || { printf "${DIM}---- app log ----${RST}\n"; tail -n 40 /tmp/lyncas-app-"$PR".log; die "app never bound a port"; }
PORT="$FOUND"
ok "App is listening on port $PORT"

# ---- 5. cloudflare tunnel -------------------------------------------------
step "Opening Cloudflare tunnel to :$PORT"
CF_BIN="$(command -v cloudflared || echo "$HOME/.lyncas/cloudflared")"
[ -x "$CF_BIN" ] || die "cloudflared not found — install it first"
CF_LOG="/tmp/lyncas-cf-${PR}.log"
"$CF_BIN" tunnel --url "http://localhost:${PORT}" > "$CF_LOG" 2>&1 &
CF_PID=$!
URL=""
for _ in $(seq 1 30); do
  sleep 1
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$CF_LOG" | head -1)"
  [ -n "$URL" ] && break
  kill -0 "$CF_PID" 2>/dev/null || { tail -n 20 "$CF_LOG"; die "cloudflared exited"; }
done
[ -n "$URL" ] || die "tunnel did not produce a URL"

printf "\n${B}${GRN}════════════════════════════════════════════${RST}\n"
printf "${B}${GRN} PREVIEW URL: %s${RST}\n" "$URL"
printf "${B}${GRN}════════════════════════════════════════════${RST}\n"
printf "${DIM}Serving PR #%s of %s on port %s. Press Ctrl+C to stop.${RST}\n\n" "$PR" "$REPO" "$PORT"

# ---- 6. stay alive so the preview keeps working ---------------------------
wait "$CF_PID"
