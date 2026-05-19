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

echo "🚀 Starting Night PR Reviewer MCP server..."
python3 "$INSTALL_DIR/mcp_server.py" --token "$TOKEN" --port "$PORT"
SCRIPT

chmod +x "$INSTALL_DIR/devpod-connect"

SHELL_RC="$HOME/.bashrc"
[[ "$SHELL" == *zsh* ]] && SHELL_RC="$HOME/.zshrc"
grep -q "night-pr-reviewer" "$SHELL_RC" 2>/dev/null || \\
  echo 'export PATH="$HOME/.night-pr-reviewer:$PATH"' >> "$SHELL_RC"
export PATH="$INSTALL_DIR:$PATH"

echo ""
echo "✅ Installation complete!"
echo ""
echo "Run: devpod-connect --token YOUR_TOKEN"
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
