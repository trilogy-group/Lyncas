#!/usr/bin/env python3
"""Lyncas — House Terminal server.

Serves an INTERACTIVE PTY (a real login shell) over a WebSocket so a
dashboard user who has not connected their own DevPod can still open a
live terminal on a Lyncas-controlled Linux box from the browser
(/dashboard/terminal).

This is the first slice of Improvements.md item 4 — "internal testing
env that runs here in the dashboard via EC2 and does the same as the
DevPod would". For the current testing phase this is meant to run on
the SAME EC2 instance as the webhook handler, with NO per-user
isolation. Every connected browser gets a shell on the same box. Do
not point untrusted users at this until container/microVM isolation
lands.

Data flow:
    browser  --wss-->  Cloudflare quick tunnel  -->  this server (:7778)
                                                         |
                                                      pty.fork() -> bash

Auth:
    The browser obtains a short-lived HS256 token from the dashboard
    (/api/terminal/info, JWT-gated) and connects to
    wss://<tunnel>/?token=<jwt>. This server verifies the token's
    signature + expiry against the shared secret (DEVPOD_CONNECT_SECRET)
    before forking a shell. The tunnel URL is NOT the security boundary;
    the signed token is.

Wire protocol:
    server -> client : raw PTY output as BINARY frames (xterm writes it).
    client -> server : TEXT frames, tagged by the first character:
        "0" + data      -> keystrokes / input bytes (utf-8)
        "1" + json      -> resize, json = {"cols": C, "rows": R}
      (a bare/binary frame with no tag is treated as raw input too).

Run (on the EC2 box):
    export DEVPOD_CONNECT_SECRET=...   # same value as the Vercel env
    pip install websockets
    python3 terminal_server.py --label webhook-ec2

    # Already have a tunnel? Skip the auto one:
    python3 terminal_server.py --no-tunnel --ws-url https://foo.trycloudflare.com
"""

import argparse
import asyncio
import base64
import fcntl
import hashlib
import hmac
import json
import os
import pty
import shutil
import signal
import struct
import subprocess
import sys
import termios
import threading
import time
import urllib.parse
import urllib.request

try:
    import websockets
except ImportError:  # pragma: no cover - operator-facing message
    print(
        "[fatal] the `websockets` package is required.\n"
        "        Install it with: pip install websockets",
        file=sys.stderr,
    )
    sys.exit(1)

DEFAULT_DASHBOARD_URL = "https://lyncas.vercel.app"
DEFAULT_PORT = 7778
PING_INTERVAL_SEC = 1800  # 30 minutes, matches the DevPod CLI cadence


# --------------------------------------------------------------------------
# JWT (HS256) verification — stdlib only, no PyJWT dependency.
# --------------------------------------------------------------------------
def _b64url_decode(segment: str) -> bytes:
    padding = "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(segment + padding)


def verify_terminal_token(token: str, secret: str) -> bool:
    """Validate an HS256 JWT the dashboard minted for a terminal
    session. Checks the alg, signature (constant-time), and exp. Returns
    True only when every check passes."""
    if not token or not secret:
        return False
    parts = token.split(".")
    if len(parts) != 3:
        return False
    header_b64, payload_b64, sig_b64 = parts
    try:
        header = json.loads(_b64url_decode(header_b64))
    except Exception:
        return False
    if header.get("alg") != "HS256":
        return False

    signing_input = f"{header_b64}.{payload_b64}".encode()
    expected = hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()
    try:
        provided = _b64url_decode(sig_b64)
    except Exception:
        return False
    if not hmac.compare_digest(expected, provided):
        return False

    try:
        payload = json.loads(_b64url_decode(payload_b64))
    except Exception:
        return False
    exp = payload.get("exp")
    if not isinstance(exp, (int, float)):
        return False
    if time.time() > float(exp):
        return False
    return True


def _token_from_path(path: str) -> str:
    """Pull ?token=... out of the WebSocket request path."""
    if not path:
        return ""
    query = urllib.parse.urlparse(path).query
    return urllib.parse.parse_qs(query).get("token", [""])[0]


# --------------------------------------------------------------------------
# PTY <-> WebSocket bridge.
# --------------------------------------------------------------------------
def _set_winsize(fd: int, rows: int, cols: int) -> None:
    rows = max(1, min(rows, 1000))
    cols = max(1, min(cols, 1000))
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
    except OSError:
        pass


def _make_handler(secret: str):
    async def handle(websocket, *extra):
        # websockets >=11 passes only the connection; older versions pass
        # (connection, path). Support both.
        path = extra[0] if extra else getattr(
            getattr(websocket, "request", None), "path", ""
        )
        token = _token_from_path(path or "")
        if not verify_terminal_token(token, secret):
            await websocket.close(code=4401, reason="unauthorized")
            print("[ws] rejected: invalid or expired token", file=sys.stderr)
            return

        print("[ws] client connected — spawning shell", file=sys.stderr)
        pid, fd = pty.fork()
        if pid == 0:
            # Child: become an interactive login shell.
            os.environ["TERM"] = "xterm-256color"
            shell = os.environ.get("SHELL", "/bin/bash")
            try:
                os.execvp(shell, [shell, "-l"])
            except Exception:
                os._exit(1)
            return  # unreachable

        loop = asyncio.get_event_loop()
        flags = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

        send_q: asyncio.Queue = asyncio.Queue()

        def on_readable():
            try:
                data = os.read(fd, 65536)
            except BlockingIOError:
                return
            except OSError:
                data = b""
            if not data:
                loop.remove_reader(fd)
                send_q.put_nowait(None)  # EOF sentinel
                return
            send_q.put_nowait(data)

        loop.add_reader(fd, on_readable)

        async def sender():
            while True:
                data = await send_q.get()
                if data is None:
                    break
                try:
                    await websocket.send(data)
                except Exception:
                    break

        async def receiver():
            try:
                async for message in websocket:
                    if isinstance(message, bytes):
                        os.write(fd, message)
                        continue
                    if not message:
                        continue
                    tag, rest = message[0], message[1:]
                    if tag == "1":
                        try:
                            obj = json.loads(rest)
                            _set_winsize(
                                fd, int(obj.get("rows", 24)), int(obj.get("cols", 80))
                            )
                        except Exception:
                            pass
                    elif tag == "0":
                        os.write(fd, rest.encode())
                    else:
                        os.write(fd, message.encode())
            except Exception:
                pass

        sender_task = asyncio.create_task(sender())
        receiver_task = asyncio.create_task(receiver())
        try:
            await receiver_task
        finally:
            try:
                loop.remove_reader(fd)
            except Exception:
                pass
            send_q.put_nowait(None)
            try:
                await asyncio.wait_for(sender_task, timeout=2)
            except Exception:
                sender_task.cancel()
            try:
                os.close(fd)
            except OSError:
                pass
            try:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            except (OSError, ChildProcessError):
                pass
            print("[ws] client disconnected — shell reaped", file=sys.stderr)

    return handle


# --------------------------------------------------------------------------
# Cloudflare tunnel + dashboard registration (mirrors mcp_server.py).
# --------------------------------------------------------------------------
def get_tunnel_url(port: int):
    import re

    cf_path = shutil.which("cloudflared") or os.path.expanduser("~/.lyncas/cloudflared")
    if not os.path.exists(cf_path):
        return None, None
    proc = subprocess.Popen(
        [cf_path, "tunnel", "--url", f"http://localhost:{port}"],
        stderr=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    for line in proc.stderr:
        m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
        if m:
            return m.group(0), proc
    return None, proc


def _post_json(url: str, body: dict, timeout: int = 15) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        try:
            return json.loads(raw)
        except Exception:
            return {"raw": raw.decode(errors="replace")}


def register(dashboard_url: str, secret: str, ws_url: str, workspace_id: str, label: str) -> dict:
    return _post_json(
        f"{dashboard_url}/api/terminal/register",
        {
            "workspace_id": workspace_id,
            "label": label,
            "ws_url": ws_url,
            "secret": secret,
        },
    )


def ping_loop(dashboard_url: str, secret: str, workspace_id: str, interval: int = PING_INTERVAL_SEC):
    while True:
        time.sleep(interval)
        try:
            _post_json(
                f"{dashboard_url}/api/terminal/ping",
                {"workspace_id": workspace_id, "secret": secret},
                timeout=10,
            )
        except Exception as e:
            print(f"[ping] failed: {e}", file=sys.stderr)


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(description="Lyncas house terminal server")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--dashboard-url", default=os.environ.get("DASHBOARD_URL", DEFAULT_DASHBOARD_URL))
    parser.add_argument("--label", default=None, help="Display label shown in the dashboard header")
    parser.add_argument("--no-tunnel", action="store_true", help="Don't start cloudflared; use --ws-url")
    parser.add_argument("--ws-url", default=None, help="Pre-existing https tunnel URL (with --no-tunnel)")
    parser.add_argument("--secret", default=os.environ.get("DEVPOD_CONNECT_SECRET"), help="Shared secret; defaults to $DEVPOD_CONNECT_SECRET")
    args = parser.parse_args()

    secret = args.secret
    if not secret:
        print(
            "[fatal] no shared secret. Set DEVPOD_CONNECT_SECRET (same value "
            "as the Vercel env) or pass --secret.",
            file=sys.stderr,
        )
        sys.exit(1)

    workspace_id = os.environ.get("LYNCAS_TERMINAL_WORKSPACE_ID") or subprocess.getoutput("hostname").strip() or "house-terminal"
    label = args.label or workspace_id

    tunnel_proc = None
    if args.no_tunnel:
        ws_url = args.ws_url
        if not ws_url:
            print("[fatal] --no-tunnel requires --ws-url https://...", file=sys.stderr)
            sys.exit(1)
    else:
        print(f"[startup] starting cloudflared tunnel to :{args.port} ...")
        ws_url, tunnel_proc = get_tunnel_url(args.port)
        if not ws_url:
            print(
                "[fatal] cloudflared tunnel failed. Install it with:\n"
                "  curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 "
                "-o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared",
                file=sys.stderr,
            )
            sys.exit(1)

    print(f"[startup] tunnel: {ws_url}")
    try:
        result = register(args.dashboard_url, secret, ws_url, workspace_id, label)
        print(f"[startup] registered with dashboard: {result}")
    except Exception as e:
        print(f"[warn] register failed (dashboard won't show the terminal yet): {e}", file=sys.stderr)

    t = threading.Thread(target=ping_loop, args=(args.dashboard_url, secret, workspace_id), daemon=True)
    t.start()

    handler = _make_handler(secret)

    async def serve_forever():
        # max_size=None: terminal frames are small, but paste bursts can
        # be large; don't cap them. ping_interval keeps the tunnel warm.
        async with websockets.serve(
            handler, "0.0.0.0", args.port, max_size=None, ping_interval=20, ping_timeout=20
        ):
            print(f"[ready] house terminal listening on :{args.port}. Ctrl+C to stop.")
            await asyncio.Future()

    try:
        asyncio.run(serve_forever())
    except KeyboardInterrupt:
        print("\n[shutdown] stopping ...")
    finally:
        if tunnel_proc is not None:
            tunnel_proc.terminate()


if __name__ == "__main__":
    main()
