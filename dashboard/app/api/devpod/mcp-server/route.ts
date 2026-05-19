import { NextResponse } from "next/server";

// GET /api/devpod/mcp-server
//
// Returns the Python MCP server as text/plain. /devpod-connect.sh
// curls this and writes it to ~/.night-pr-reviewer/mcp_server.py.
//
// The script:
//   * spins up a local cloudflared tunnel,
//   * registers the resulting public URL at /api/devpod/register,
//   * loops every 30 minutes calling /api/devpod/ping,
//   * runs an HTTP server on the requested port that exposes
//     /execute and /health for the dashboard to drive.
//
// We serve it dynamically rather than from /public/ so the
// DASHBOARD_URL constant is always in sync with the deployment that
// served the script — if someone clones the project under a
// different domain they don't have to remember to edit this file.
//
// No auth: the only sensitive value the script ever sees is the
// user's own --token, which they paste in themselves at runtime.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// NB: this string is interpolated as a JS template literal, so any
// literal `\` and `${` inside the Python source MUST be escaped
// (\\ and \${ respectively). Python f-string interpolation
// (f"...{x}...") is fine because we use single curly braces, but
// JS-style ${...} would otherwise be evaluated by Next.
const SCRIPT = `#!/usr/bin/env python3
"""Night PR Reviewer — DevPod MCP Server
Runs inside the developer's DevPod. Exposes tools Openclaw can call.
"""
import argparse, json, os, subprocess, sys, threading, time
import urllib.request, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DASHBOARD_URL = "https://night-pr-reviewer-v2-saas.vercel.app"

def get_tunnel_url(port):
    import re
    proc = subprocess.Popen(
        ["cloudflared", "tunnel", "--url", f"http://localhost:{port}"],
        stderr=subprocess.PIPE, stdout=subprocess.PIPE, text=True
    )
    for line in proc.stderr:
        m = re.search(r'https://[a-z0-9-]+\\.trycloudflare\\.com', line)
        if m:
            return m.group(0), proc
    return None, proc

def register(token, tunnel_url, workspace_id, port):
    username = token.split(":")[0] if ":" in token else token
    data = json.dumps({
        "github_username": username,
        "tunnel_url": tunnel_url,
        "workspace_id": workspace_id,
        "secret": token,
        "capabilities": {
            "run_command": True,
            "run_tests": True,
            "start_app": True,
            "expose_port": True
        }
    }).encode()
    req = urllib.request.Request(
        f"{DASHBOARD_URL}/api/devpod/register",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())

def ping_loop(token, interval=1800):
    username = token.split(":")[0] if ":" in token else token
    while True:
        time.sleep(interval)
        try:
            data = json.dumps({
                "github_username": username,
                "secret": token
            }).encode()
            req = urllib.request.Request(
                f"{DASHBOARD_URL}/api/devpod/ping",
                data=data,
                headers={"Content-Type": "application/json"},
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=10) as r:
                pass
        except Exception as e:
            print(f"[ping] failed: {e}", file=sys.stderr)

class MCPHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # silence default logs

    def _json(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"status": "ok", "service": "night-pr-reviewer-mcp"})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/execute":
            self._json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")

        cmd_type = body.get("type", "run_command")
        command = body.get("command", "")
        repo = body.get("repo", "")

        print(f"[mcp] {cmd_type}: {command[:80]}")

        try:
            if cmd_type == "run_command":
                result = subprocess.run(
                    command, shell=True, capture_output=True,
                    text=True, timeout=120,
                    cwd=os.path.expanduser("~")
                )
                self._json(200, {
                    "stdout": result.stdout[-10000:],
                    "stderr": result.stderr[-2000:],
                    "exit_code": result.returncode,
                    "success": result.returncode == 0
                })

            elif cmd_type == "run_tests":
                # Auto-detect test runner
                cwd = body.get("cwd", os.path.expanduser("~"))
                if os.path.exists(os.path.join(cwd, "package.json")):
                    cmd = "npm test -- --json 2>/dev/null || npm test"
                elif os.path.exists(os.path.join(cwd, "requirements.txt")):
                    cmd = "pytest --json-report --json-report-file=/tmp/pytest-report.json -v 2>&1; cat /tmp/pytest-report.json 2>/dev/null"
                elif os.path.exists(os.path.join(cwd, "go.mod")):
                    cmd = "go test ./... -json"
                else:
                    cmd = command or "echo 'No test runner detected'"

                result = subprocess.run(
                    cmd, shell=True, capture_output=True,
                    text=True, timeout=300, cwd=cwd
                )
                self._json(200, {
                    "stdout": result.stdout[-20000:],
                    "stderr": result.stderr[-2000:],
                    "exit_code": result.returncode,
                    "success": result.returncode == 0,
                    "test_runner": "auto-detected"
                })

            elif cmd_type == "expose_port":
                port = body.get("port", 3000)
                import re
                proc = subprocess.Popen(
                    ["cloudflared", "tunnel", "--url", f"http://localhost:{port}"],
                    stderr=subprocess.PIPE, text=True
                )
                url = None
                for line in proc.stderr:
                    m = re.search(r'https://[a-z0-9-]+\\.trycloudflare\\.com', line)
                    if m:
                        url = m.group(0)
                        break
                self._json(200, {"url": url, "port": port, "success": bool(url)})

            elif cmd_type == "start_app":
                entrypoint = command or body.get("entrypoint", "")
                cwd = body.get("cwd", os.path.expanduser("~"))
                proc = subprocess.Popen(
                    entrypoint, shell=True,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    text=True, cwd=cwd
                )
                time.sleep(3)  # let app boot
                if proc.poll() is None:
                    self._json(200, {
                        "started": True, "pid": proc.pid,
                        "message": f"App started with pid {proc.pid}"
                    })
                else:
                    out, err = proc.communicate(timeout=5)
                    self._json(200, {
                        "started": False,
                        "stdout": out[-2000:], "stderr": err[-2000:]
                    })
            else:
                self._json(400, {"error": f"unknown type: {cmd_type}"})

        except subprocess.TimeoutExpired:
            self._json(408, {"error": "Command timed out"})
        except Exception as e:
            self._json(500, {"error": str(e)})

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--token", required=True)
    parser.add_argument("--port", type=int, default=7777)
    parser.add_argument("--ping", action="store_true")
    args = parser.parse_args()

    if args.ping:
        username = args.token.split(":")[0] if ":" in args.token else args.token
        data = json.dumps({"github_username": username, "secret": args.token}).encode()
        req = urllib.request.Request(
            f"{DASHBOARD_URL}/api/devpod/ping", data=data,
            headers={"Content-Type": "application/json"}, method="POST"
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            print(r.read().decode())
        return

    workspace_id = os.environ.get(
        "DEVPOD_WORKSPACE_ID",
        subprocess.getoutput("hostname")
    )

    print(f"Starting MCP server on port {args.port}...")
    print("Getting Cloudflare tunnel...")

    tunnel_url, tunnel_proc = get_tunnel_url(args.port)
    if not tunnel_url:
        print("❌ Cloudflare tunnel failed. Is cloudflared installed?")
        print("Install: curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared")
        sys.exit(1)

    print(f"Tunnel: {tunnel_url}")
    result = register(args.token, tunnel_url, workspace_id, args.port)
    print(f"✅ Connected! Dashboard shows you as live.")
    print(f"   Session expires: {result.get('expires_at', 'unknown')}")
    print(f"   Press Ctrl+C to disconnect.")

    # Start ping loop in background
    t = threading.Thread(target=ping_loop, args=(args.token,), daemon=True)
    t.start()

    # Start MCP HTTP server
    server = ThreadingHTTPServer(("0.0.0.0", args.port), MCPHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\\n Disconnecting...")
        tunnel_proc.terminate()
        server.server_close()

if __name__ == "__main__":
    main()
`;

export async function GET() {
  return new NextResponse(SCRIPT, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Disposition": 'inline; filename="mcp_server.py"',
    },
  });
}
