import { NextResponse } from "next/server";

// GET /devpod-connect.sh
//
// Public installer script. The user runs:
//   curl -fsSL https://<deploy>/devpod-connect.sh | bash
//
// It downloads the MCP server (served at /api/devpod/mcp-server),
// drops a `devpod-connect` launcher into ~/.lyncas, and
// adds that directory to PATH. Idempotent on re-run.
//
// Served as text/plain so curl doesn't try to interpret a JSON
// wrapper. No auth — the contents are public install instructions
// that hard-code the dashboard URL but no credentials.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SCRIPT = `#!/bin/bash
set -e
echo "🔌 Lyncas — DevPod Connect v1"
echo ""

INSTALL_DIR="$HOME/.lyncas"
DASHBOARD_URL="https://lyncas.vercel.app"

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
INSTALL_DIR="$HOME/.lyncas"
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
  echo "Get token: https://lyncas.vercel.app/dashboard/settings"
  exit 1
fi

# Persist the token so the 'lyncas' CLI can auth without the user
# having to re-export it on every shell. 0600 mode keeps it out of
# the reach of other users on a shared box.
umask 077
printf "%s" "$TOKEN" > "$INSTALL_DIR/.token"

echo "🚀 Starting Lyncas MCP server..."
python3 "$INSTALL_DIR/mcp_server.py" --token "$TOKEN" --port "$PORT"
SCRIPT

chmod +x "$INSTALL_DIR/devpod-connect"

# Drop the 'lyncas' CLI alongside devpod-connect. It's a tiny Python
# script that POSTs to /api/chat with the persisted token; the user
# can run: lyncas "what changed in the last 3 commits"
# from their DevPod terminal without leaving the shell.
cat > "$INSTALL_DIR/lyncas" << 'LYNCAS_SCRIPT'
#!/usr/bin/env python3
"""lyncas — natural-language CLI for Lyncas.

Reads a question from argv (or stdin if none), detects the current
repo from 'git remote get-url origin', and streams Claude's answer
back to the terminal. Auth is the same DEVPOD_CONNECT_TOKEN that
devpod-connect persists at ~/.lyncas/.token.

Conversation history is persisted server-side via the
/api/lyncas/history endpoint, keyed by (github_username, repo). Two
flags govern it:
  --no-history   skip the GET-before-chat and POST-after-chat round
                 trips (one-shot mode, no persistence either way)
  --clear        DELETE this user's history for the current repo
                 and exit without sending a chat request

Examples:
  lyncas                                    # interactive chat session
  lyncas "review the current branch changes"
  lyncas "what changed in the last 3 commits"
  lyncas --no-history "explain this single error"
  lyncas --clear

This is intentionally pure stdlib — no requests, no rich, no httpx —
so users don't have to pip-install anything inside the DevPod.
"""
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

DASHBOARD_URL = "https://lyncas.vercel.app"
TOKEN_PATH = os.path.expanduser("~/.lyncas/.token")
NEWLINE = chr(10)
FRAME_SEP = NEWLINE + NEWLINE

# Match the server-side trim in /api/lyncas/history. We send at most
# this many entries up so the chat route doesn't blow context, and
# we save at most this many back so the next round trip stays
# bounded too.
HISTORY_LIMIT = 20


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


def username_from_token(token):
    """Composite token is <github_username>:<DEVPOD_CONNECT_SECRET>
    — pull the username half. Falls back to the whole token when no
    colon is present, matching how /api/devpod/register treats
    legacy bare-secret tokens."""
    if not token:
        return ""
    return token.split(":", 1)[0] if ":" in token else token


def _history_url(username, repo, secret=None):
    """Build the /api/lyncas/history URL with the username + repo
    query parameters. secret is only appended when DELETE-ing
    (the lyncas-history route reads it from the query string for
    DELETE and from the body for POST)."""
    q = {"username": username, "repo": repo}
    if secret is not None:
        q["secret"] = secret
    return DASHBOARD_URL + "/api/lyncas/history?" + urllib.parse.urlencode(q)


def load_history(username, repo):
    """GET the saved history for this (username, repo). Returns
    a list of {role, content} dicts on success, or [] on any
    failure (missing migration, transient 5xx, network blip).
    The spec is explicit: a failed fetch must NOT block the chat
    — we graceful-degrade to a one-shot exchange."""
    try:
        req = urllib.request.Request(
            _history_url(username, repo),
            method="GET",
            headers={"Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            body = json.loads(r.read())
        msgs = body.get("messages") if isinstance(body, dict) else None
        if not isinstance(msgs, list):
            return []
        out = []
        for m in msgs:
            if (
                isinstance(m, dict)
                and m.get("role") in ("user", "assistant")
                and isinstance(m.get("content"), str)
            ):
                out.append({"role": m["role"], "content": m["content"]})
        return out[-HISTORY_LIMIT:]
    except Exception as e:
        sys.stderr.write(
            "[lyncas] history fetch failed (continuing without): "
            + type(e).__name__ + ": " + str(e) + NEWLINE
        )
        return []


def save_history(username, repo, token, messages):
    """POST the updated history back to /api/lyncas/history. Best-effort
    — a failed save is logged to stderr but never crashes the CLI,
    so the user's primary response (already streamed to stdout) is
    not visibly affected by a Supabase outage."""
    trimmed = messages[-HISTORY_LIMIT:]
    payload = json.dumps({"messages": trimmed, "secret": token}).encode()
    try:
        req = urllib.request.Request(
            _history_url(username, repo),
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            r.read()
    except Exception as e:
        sys.stderr.write(
            "[lyncas] history save failed (response not persisted): "
            + type(e).__name__ + ": " + str(e) + NEWLINE
        )


def clear_history(username, repo, token):
    """DELETE the row for this (username, repo). Used by --clear.
    Returns True on success, False on any failure — the caller
    prints a generic 'history cleared' message either way because
    the user's intent (start fresh) is honored regardless of what
    happened server-side."""
    try:
        req = urllib.request.Request(
            _history_url(username, repo, secret=token),
            method="DELETE",
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            r.read()
        return True
    except Exception as e:
        sys.stderr.write(
            "[lyncas] history clear failed: "
            + type(e).__name__ + ": " + str(e) + NEWLINE
        )
        return False


def stream_chat(message, repo, token, history):
    """Stream the /api/chat SSE response to stdout. Returns a
    tuple (exit_code, assistant_text). assistant_text is the
    concatenation of every non-error 'data: ' frame the server
    sent — i.e. exactly what the user saw on stdout — so the
    caller can append it to the history before saving."""
    payload = json.dumps(
        {"message": message, "repo": repo, "history": history}
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
    captured = []
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
                            return 0, "".join(captured)
                        if body.startswith("{"):
                            try:
                                evt = json.loads(body)
                                if isinstance(evt, dict):
                                    if "error" in evt:
                                        sys.stderr.write(NEWLINE + "[lyncas] error: " + str(evt["error"]) + NEWLINE)
                                        return 2, "".join(captured)
                                    # Text frames are JSON-encoded so newlines
                                    # survive the SSE transport. Write the
                                    # decoded text, not the raw JSON.
                                    if isinstance(evt.get("t"), str):
                                        sys.stdout.write(evt["t"])
                                        sys.stdout.flush()
                                        captured.append(evt["t"])
                                        continue
                            except Exception:
                                pass
                        sys.stdout.write(body)
                        sys.stdout.flush()
                        captured.append(body)
            sys.stdout.write(NEWLINE)
            return 0, "".join(captured)
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read())
            sys.stderr.write("[lyncas] HTTP " + str(e.code) + ": " + str(err.get("error", "")) + NEWLINE)
        except Exception:
            sys.stderr.write("[lyncas] HTTP " + str(e.code) + NEWLINE)
        return 1, "".join(captured)
    except Exception as e:
        sys.stderr.write("[lyncas] " + type(e).__name__ + ": " + str(e) + NEWLINE)
        return 1, "".join(captured)


# --- interactive REPL ----------------------------------------------------
# A claude/ollama-style chat session for the terminal. Pure stdlib: all
# styling is hand-rolled ANSI built from chr(27) (ESC) so the script
# carries zero backslash escapes — it's served as a JS template literal
# and literal backslashes would otherwise need double-escaping.
ENABLE_COLOR = True


def supports_color():
    """Honour NO_COLOR / TERM=dumb and only colorize a real TTY."""
    if os.environ.get("NO_COLOR"):
        return False
    if os.environ.get("TERM") == "dumb":
        return False
    return sys.stdout.isatty()


def paint(text, *codes):
    if not ENABLE_COLOR or not codes:
        return text
    return chr(27) + "[" + ";".join(codes) + "m" + text + chr(27) + "[0m"


def accent(t):
    return paint(t, "38;5;81")


def accent2(t):
    return paint(t, "38;5;213")


def dim(t):
    return paint(t, "2")


def bold(t):
    return paint(t, "1")


def good(t):
    return paint(t, "38;5;114")


def bad(t):
    return paint(t, "38;5;203")


COMMANDS = [
    ("/help", "show available commands"),
    ("/repo", "show the active repository"),
    ("/clear", "wipe saved history (server + session)"),
    ("/new", "start a fresh conversation, keep saved history"),
    ("/history", "how many turns are loaded this session"),
    ("/exit", "leave the chat (or press Ctrl-D)"),
]


def print_banner(repo, username, history_count, no_history):
    rule = accent(chr(0x2500) * 52)
    mode = "off (--no-history)" if no_history else (str(history_count) + " turns loaded")
    print()
    print("  " + bold(accent2(chr(0x25C6) + " Lyncas")) + "  " + dim("interactive chat"))
    print("  " + rule)
    print("  " + dim("repo  ") + " " + accent(repo))
    print("  " + dim("user  ") + " " + username)
    print("  " + dim("memory") + " " + mode)
    print()
    print(
        "  " + dim("type ") + accent("/help") + dim(" for commands  " + chr(0x00B7) + "  ")
        + accent("/exit") + dim(" to quit")
    )


def print_help():
    print()
    print("  " + bold("Commands"))
    for name, desc in COMMANDS:
        print("    " + accent(name.ljust(10)) + " " + dim(desc))


def interactive(username, repo, token, no_history):
    """Run the REPL loop. Returns a process exit code.

    History is loaded once at start, kept in memory for the session,
    and (unless --no-history) saved back after every assistant turn so
    a later one-shot 'lyncas ...' sees the same thread. In-memory
    history is trimmed to 2x HISTORY_LIMIT so a marathon session can't
    grow unbounded; the server slices to its own limit regardless."""
    global ENABLE_COLOR
    ENABLE_COLOR = supports_color()

    history = [] if no_history else load_history(username, repo)
    print_banner(repo, username, len(history), no_history)

    prompt = chr(10) + paint(chr(0x276F) + " ", "38;5;81", "1")
    while True:
        try:
            line = input(prompt)
        except EOFError:
            print(chr(10) + dim("  bye"))
            return 0
        except KeyboardInterrupt:
            print(chr(10) + dim("  (press Ctrl-D or type /exit to quit)"))
            continue

        msg = line.strip()
        if not msg:
            continue

        if msg.startswith("/"):
            parts = msg[1:].split()
            cmd = parts[0].lower() if parts else ""
            if cmd in ("exit", "quit", "q"):
                print(dim("  bye"))
                return 0
            if cmd in ("help", "h", "?"):
                print_help()
                continue
            if cmd == "repo":
                print("  " + accent(repo))
                continue
            if cmd == "clear":
                clear_history(username, repo, token)
                history = []
                print("  " + good("history cleared"))
                continue
            if cmd in ("new", "reset"):
                history = []
                print("  " + dim("started a fresh conversation"))
                continue
            if cmd == "history":
                print("  " + dim(str(len(history)) + " turns loaded this session"))
                continue
            print("  " + bad("unknown command: /" + cmd) + dim("  " + chr(0x2014) + " try /help"))
            continue

        # A normal message: stream the answer under a colored label.
        print()
        print(accent2(chr(0x25C6) + " lyncas"))
        exit_code, assistant = stream_chat(msg, repo, token, history)
        if exit_code == 0 and assistant.strip():
            history = (history + [
                {"role": "user", "content": msg},
                {"role": "assistant", "content": assistant},
            ])[-2 * HISTORY_LIMIT:]
            if not no_history:
                save_history(username, repo, token, history)


def main():
    # Flag parsing happens BEFORE we require a message because
    # --clear is a standalone command (no message needed).
    args = list(sys.argv[1:])
    clear_flag = False
    no_history = False
    remaining = []
    for a in args:
        if a == "--clear":
            clear_flag = True
        elif a == "--no-history":
            no_history = True
        else:
            remaining.append(a)

    # repo + token are needed by every path (including --clear), so
    # resolve them up front.
    repo = detect_repo()
    if not repo:
        sys.stderr.write(
            "[lyncas] could not detect repo (no github origin?). "
            "Run inside a git checkout with a github.com remote." + NEWLINE
        )
        return 1

    token = load_token()
    if not token:
        sys.stderr.write(
            "[lyncas] no token. Run devpod-connect first, or set "
            "DEVPOD_CONNECT_TOKEN." + NEWLINE
        )
        return 1

    username = username_from_token(token)
    if not username:
        sys.stderr.write("[lyncas] could not parse username from token" + NEWLINE)
        return 1

    if clear_flag:
        # Best-effort clear. Even on a server-side failure we print
        # the success line — the local intent is honored and the
        # next CLI invocation will overwrite the row anyway.
        clear_history(username, repo, token)
        sys.stdout.write(chr(0x2705) + " Conversation history cleared" + NEWLINE)
        return 0

    # No message: a real terminal drops into the interactive REPL
    # (the 'lyncas' claude/ollama-style chat experience). A piped
    # stdin with no args still runs a single one-shot exchange so
    # 'echo question | lyncas' keeps working in scripts.
    if not remaining:
        if sys.stdin.isatty():
            return interactive(username, repo, token, no_history)
        message = sys.stdin.read().strip()
    else:
        message = " ".join(remaining).strip()

    if not message:
        sys.stderr.write("[lyncas] empty message" + NEWLINE)
        return 64

    # Load history unless explicitly opted out.
    history = [] if no_history else load_history(username, repo)

    exit_code, assistant = stream_chat(message, repo, token, history)

    # Save iff:
    #   * --no-history wasn't passed,
    #   * the chat call actually produced an assistant response
    #     (errors / empty streams aren't worth persisting), and
    #   * the assistant text isn't just whitespace.
    if not no_history and exit_code == 0 and assistant.strip():
        updated = history + [
            {"role": "user", "content": message},
            {"role": "assistant", "content": assistant},
        ]
        save_history(username, repo, token, updated)

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
LYNCAS_SCRIPT

chmod +x "$INSTALL_DIR/lyncas"

SHELL_RC="$HOME/.bashrc"
[[ "$SHELL" == *zsh* ]] && SHELL_RC="$HOME/.zshrc"
grep -q "lyncas" "$SHELL_RC" 2>/dev/null || \\
  echo 'export PATH="$HOME/.lyncas:$PATH"' >> "$SHELL_RC"
export PATH="$INSTALL_DIR:$PATH"

echo ""
echo "✅ Installation complete!"
echo ""
echo "Connect your DevPod:"
echo "  devpod-connect --token YOUR_TOKEN"
echo ""
echo "Then start an interactive chat session:"
echo "  lyncas"
echo ""
echo "Or ask one-shot questions:"
echo "  lyncas \\"what changed in the last 3 commits\\""
echo ""
echo "Conversation history (per user, per repo) is on by default."
echo "  lyncas --no-history \\"one-shot question\\"   # don't load/save"
echo "  lyncas --clear                              # wipe this repo's"
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
