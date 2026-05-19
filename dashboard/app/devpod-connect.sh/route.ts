import { NextResponse } from "next/server";

// GET /devpod-connect.sh
//
// Public installer script. The user runs:
//   curl -fsSL https://<deploy>/devpod-connect.sh | bash
//
// It downloads the MCP server (served at /api/devpod/mcp-server),
// drops a `devpod-connect` launcher into ~/.night-pr-reviewer, and
// adds that directory to PATH. Idempotent on re-run.
//
// Served as text/plain so curl doesn't try to interpret a JSON
// wrapper. No auth — the contents are public install instructions
// that hard-code the dashboard URL but no credentials.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SCRIPT = `#!/bin/bash
set -e
echo "🔌 Night PR Reviewer — DevPod Connect v1"
echo ""

INSTALL_DIR="$HOME/.night-pr-reviewer"
DASHBOARD_URL="https://night-pr-reviewer-v2-saas.vercel.app"

for tool in curl python3; do
  if ! command -v $tool &>/dev/null; then
    echo "❌ Required: $tool"
    exit 1
  fi
done

mkdir -p "$INSTALL_DIR"

# Install cloudflared if not present
if ! command -v cloudflared &>/dev/null; then
  echo "📦 Installing cloudflared..."
  ARCH=$(uname -m)
  if [ "$ARCH" = "x86_64" ]; then
    CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
  elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
    CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64"
  else
    echo "⚠️  Unknown architecture: $ARCH — install cloudflared manually"
    CF_URL=""
  fi

  if [ -n "$CF_URL" ]; then
    if command -v sudo &>/dev/null; then
      sudo curl -L "$CF_URL" -o /usr/local/bin/cloudflared
      sudo chmod +x /usr/local/bin/cloudflared
    else
      curl -L "$CF_URL" -o "$INSTALL_DIR/cloudflared"
      chmod +x "$INSTALL_DIR/cloudflared"
      # Add to PATH if not already there
      export PATH="$INSTALL_DIR:$PATH"
    fi
    echo "✅ cloudflared installed"
  fi
fi

echo "📦 Downloading MCP server..."
curl -fsSL "$DASHBOARD_URL/api/devpod/mcp-server" \\
  -o "$INSTALL_DIR/mcp_server.py"

cat > "$INSTALL_DIR/devpod-connect" << 'SCRIPT'
#!/bin/bash
set -e
INSTALL_DIR="$HOME/.night-pr-reviewer"
TOKEN="\${DEVPOD_CONNECT_TOKEN:-}"
PORT="\${DEVPOD_MCP_PORT:-7777}"

# Accept --token flag
while [[ "$#" -gt 0 ]]; do
  case $1 in
    --token) TOKEN="$2"; shift ;;
    --port) PORT="$2"; shift ;;
  esac
  shift
done

if [ -z "$TOKEN" ]; then
  echo "Usage: devpod-connect --token YOUR_TOKEN"
  echo "Get token: https://night-pr-reviewer-v2-saas.vercel.app/dashboard/settings"
  exit 1
fi

# Persist the token so the 'npr' CLI can auth without the user
# having to re-export it on every shell. 0600 mode keeps it out of
# the reach of other users on a shared box.
umask 077
printf "%s" "$TOKEN" > "$INSTALL_DIR/.token"

echo "🚀 Starting Night PR Reviewer MCP server..."
python3 "$INSTALL_DIR/mcp_server.py" --token "$TOKEN" --port "$PORT"
SCRIPT

chmod +x "$INSTALL_DIR/devpod-connect"

# Drop the 'npr' CLI alongside devpod-connect. It's a tiny Python
# script that POSTs to /api/chat with the persisted token; the user
# can run: npr "what changed in the last 3 commits"
# from their DevPod terminal without leaving the shell.
cat > "$INSTALL_DIR/npr" << 'NPR_SCRIPT'
#!/usr/bin/env python3
"""npr — natural-language CLI for Night PR Reviewer.

Reads a question from argv (or stdin if none), detects the current
repo from 'git remote get-url origin', and streams Claude's answer
back to the terminal. Auth is the same DEVPOD_CONNECT_TOKEN that
devpod-connect persists at ~/.night-pr-reviewer/.token.

Examples:
  npr "review the current branch changes"
  npr "what changed in the last 3 commits"
  npr "run tests and tell me if PR #5 is safe to merge"

This is intentionally pure stdlib — no requests, no rich, no httpx —
so users don't have to pip-install anything inside the DevPod.
"""
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

DASHBOARD_URL = "https://night-pr-reviewer-v2-saas.vercel.app"
TOKEN_PATH = os.path.expanduser("~/.night-pr-reviewer/.token")
NEWLINE = chr(10)
FRAME_SEP = NEWLINE + NEWLINE


def detect_repo():
    """Parse owner/name from 'git remote get-url origin'. Supports
    SSH (git@github.com:owner/name.git), HTTPS with .git, HTTPS
    without .git, and HTTPS with embedded credentials."""
    try:
        url = subprocess.check_output(
            ["git", "remote", "get-url", "origin"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
    except Exception:
        return None
    url = re.sub("^https://[^/@]+@", "https://", url)
    m = re.search(
        "github" + chr(92) + ".com[:/]([" + chr(92) + "w.-]+)/([" + chr(92) + "w.-]+?)(?:" + chr(92) + ".git)?/?$",
        url,
    )
    if not m:
        return None
    return m.group(1) + "/" + m.group(2)


def load_token():
    env = os.environ.get("DEVPOD_CONNECT_TOKEN", "").strip()
    if env:
        return env
    try:
        with open(TOKEN_PATH, "r") as f:
            return f.read().strip()
    except Exception:
        return None


def stream_chat(message, repo, token):
    payload = json.dumps(
        {"message": message, "repo": repo, "history": []}
    ).encode()
    req = urllib.request.Request(
        DASHBOARD_URL + "/api/chat",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-DevPod-Token": token,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            buf = ""
            for raw in r:
                chunk = raw.decode("utf-8", errors="replace")
                buf += chunk
                while FRAME_SEP in buf:
                    frame, buf = buf.split(FRAME_SEP, 1)
                    for line in frame.splitlines():
                        if not line.startswith("data: "):
                            continue
                        body = line[6:]
                        if body == "[DONE]":
                            sys.stdout.write(NEWLINE)
                            sys.stdout.flush()
                            return 0
                        if body.startswith("{"):
                            try:
                                evt = json.loads(body)
                                if isinstance(evt, dict) and "error" in evt:
                                    sys.stderr.write(NEWLINE + "[npr] error: " + str(evt["error"]) + NEWLINE)
                                    return 2
                            except Exception:
                                pass
                        sys.stdout.write(body)
                        sys.stdout.flush()
            sys.stdout.write(NEWLINE)
            return 0
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read())
            sys.stderr.write("[npr] HTTP " + str(e.code) + ": " + str(err.get("error", "")) + NEWLINE)
        except Exception:
            sys.stderr.write("[npr] HTTP " + str(e.code) + NEWLINE)
        return 1
    except Exception as e:
        sys.stderr.write("[npr] " + type(e).__name__ + ": " + str(e) + NEWLINE)
        return 1


def main():
    if len(sys.argv) < 2:
        if sys.stdin.isatty():
            sys.stderr.write(
                "Usage: npr \\"your question\\"" + NEWLINE
                + "       echo question | npr" + NEWLINE
            )
            return 64
        message = sys.stdin.read().strip()
    else:
        message = " ".join(sys.argv[1:]).strip()

    if not message:
        sys.stderr.write("[npr] empty message" + NEWLINE)
        return 64

    repo = detect_repo()
    if not repo:
        sys.stderr.write(
            "[npr] could not detect repo (no github origin?). "
            "Run inside a git checkout with a github.com remote." + NEWLINE
        )
        return 1

    token = load_token()
    if not token:
        sys.stderr.write(
            "[npr] no token. Run devpod-connect first, or set "
            "DEVPOD_CONNECT_TOKEN." + NEWLINE
        )
        return 1

    return stream_chat(message, repo, token)


if __name__ == "__main__":
    sys.exit(main())
NPR_SCRIPT

chmod +x "$INSTALL_DIR/npr"

SHELL_RC="$HOME/.bashrc"
[[ "$SHELL" == *zsh* ]] && SHELL_RC="$HOME/.zshrc"
grep -q "night-pr-reviewer" "$SHELL_RC" 2>/dev/null || \\
  echo 'export PATH="$HOME/.night-pr-reviewer:$PATH"' >> "$SHELL_RC"
export PATH="$INSTALL_DIR:$PATH"

echo ""
echo "✅ Installation complete!"
echo ""
echo "Connect your DevPod:"
echo "  devpod-connect --token YOUR_TOKEN"
echo ""
echo "Then ask the agent anything from your shell:"
echo "  npr \\"what changed in the last 3 commits\\""
echo ""
echo "Token: $DASHBOARD_URL/dashboard/settings"
`;

export async function GET() {
  return new NextResponse(SCRIPT, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      // Hint to browsers that this is a download. curl ignores it,
      // but a user who clicks the link in a browser gets a sensible
      // file name instead of the raw page.
      "Content-Disposition": 'inline; filename="devpod-connect.sh"',
    },
  });
}
