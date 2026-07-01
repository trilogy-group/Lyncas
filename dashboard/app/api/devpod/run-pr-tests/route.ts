import { type NextRequest } from "next/server";
import {
  createSupabaseServerClient,
  getUser,
} from "@/lib/supabase/server";
import { resolveGithubToken } from "@/lib/github-token";
import {
  verdictToDbOverall,
  type CheckResult,
  type SandboxChecks,
  type SandboxProgressEvent,
  type SandboxStep,
  type SandboxVerdict,
  type SecretScanResult,
} from "@/lib/types";

// POST /api/devpod/run-pr-tests
//
// Drives the same sandbox sequence as agent/devpod_tester.py, but on
// demand from the dashboard chat UI's "🧪 Run sandbox test" button.
// Streams progress as Server-Sent Events so the user sees per-step
// "running" → "done" transitions instead of a single long-pending
// request.
//
// Step order, mirroring the Python flow:
//   1. clone     — copy/clone the PR branch
//   2. install   — best-effort dependency install
//   3. tests     — auto-detected test runner
//   4. build     — `npm run build` / `go build` / no-op for Python
//   5. app       — start_app + multi-port probe + expose_port (the
//                  pre-v2 "expose" step is folded into this one
//                  because emitting two events for one user-visible
//                  thing was just noise).
//   6. complete  — terminal event with the rich verdict + duration_ms
//
// Auth: Supabase JWT. Looks up the caller's own active DevPod session
// + GitHub installation token for the repo, then fans out sequential
// MCP /execute calls.
//
// On completion, upserts pr_sandbox_results so the chat report
// (isReport=true) and the chat sidebar can read the result back
// later without rerunning the suite. The DB column is bounded to
// the legacy 4-value enum by migration 015's CHECK, so the rich
// verdict gets mapped down via verdictToDbOverall() before insert —
// the SSE stream + the UI keep the richer information.
//
// We deliberately do NOT call /api/devpod/execute internally — that
// endpoint is JWT-auth, route-level, and would round-trip the
// command through HTTP twice. Calling the user's tunnel directly
// keeps the latency floor low and means an upstream tunnel error is
// visible in this route's own try/catch.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Tunnel-side per-step timeout cap (the slowest MCP server-side
// cap is 300s on run_tests; we wait a hair longer so a server-side
// timeout reaches us as a clean error rather than as an aborted
// fetch). The build step is bounded server-side at 180s.
const MCP_TIMEOUT_MS = 360_000;
const MAX_OUTPUT_BYTES = 16 * 1024;
const APP_BIND_TIMEOUT_SEC = 8;

// Mirrors APP_PORT_CANDIDATES in agent/devpod_tester.py — see the
// comment there for why we probe rather than force a single port.
const APP_PORT_CANDIDATES = [3000, 8000, 8080, 5000] as const;

// Where we clone the PR into on the DevPod. Mirrors
// SANDBOX_CLONE_DIR in agent/devpod_tester.py — both paths must
// agree on the destination or the webhook-driven run and the
// chat-button-driven run will drift (the agent persists with
// /tmp/pr-test as cwd while the dashboard re-runs would persist
// with $HOME/pr-test-N as cwd, and a follow-up re-test would not
// find the prior tree).
const SANDBOX_CLONE_DIR = "/tmp/pr-test";

// Sentinel printed at the tail of the clone command. The dashboard
// route applies the same stricter rule as the Python script: an
// exit-zero from git is not by itself proof of a clean checkout
// (codespaces-base has been seen leaving partial trees on a
// mid-fetch network blip). The marker on stdout is the only thing
// that promotes the clone to clone_success=true.
const CLONE_SUCCESS_MARKER = "CLONE_SUCCESS";

interface MCPResponse {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  success?: boolean;
  error?: string;
  url?: string | null;
  started?: boolean;
  pid?: number;
  port?: number;
  test_runner?: string;
  build_runner?: string;
}

interface RequestBody {
  repo?: unknown;
  pr_number?: unknown;
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function truncate(text: string, limit = MAX_OUTPUT_BYTES): string {
  if (!text) return "";
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "\n…[truncated]";
}

// Same heuristic used in agent/devpod_tester.py._count_passed_failed —
// keep both in sync or the dashboard and the webhook-driven runs
// disagree on counts. Strategies are tried in order; the first that
// yields a non-zero count wins so a noisy log doesn't double-count.
function countPassedFailed(blob: string): { passed: number; failed: number } {
  const firstInt = (re: RegExp): number => {
    const m = re.exec(blob);
    return m ? Number(m[1]) : 0;
  };

  // 1. jest / pytest / cargo ("N passed; M failed").
  let passed = firstInt(/(\d+)\s+passed/);
  let failed = firstInt(/(\d+)\s+failed/);
  if (passed || failed) return { passed, failed };

  // 2. mocha.
  passed = firstInt(/(\d+)\s+passing/);
  failed = firstInt(/(\d+)\s+failing/);
  if (passed || failed) return { passed, failed };

  // 3. go test -v — per-test result lines.
  const goPass = (blob.match(/^--- PASS:/gm) ?? []).length;
  const goFail = (blob.match(/^--- FAIL:/gm) ?? []).length;
  if (goPass || goFail) return { passed: goPass, failed: goFail };

  // 4. rspec.
  const examples = firstInt(/(\d+)\s+examples?/);
  const failures = firstInt(/(\d+)\s+failures?/);
  if (examples || failures)
    return { passed: Math.max(examples - failures, 0), failed: failures };

  // 5. dotnet ("Passed!  - Failed: 0, Passed: 5, ...").
  passed = firstInt(/Passed:\s*(\d+)/);
  failed = firstInt(/Failed:\s*(\d+)/);
  if (passed || failed) return { passed, failed };

  return { passed: 0, failed: 0 };
}

function looksLikeNoTests(blob: string): boolean {
  const b = blob.toLowerCase();
  return (
    b.includes("no test runner detected") ||
    b.includes("no tests found") ||
    b.includes("no tests collected") ||
    b.includes("no tests ran") ||
    b.includes("found 0 test")
  );
}

async function postExecute(
  tunnelUrl: string,
  body: Record<string, unknown>,
): Promise<MCPResponse> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), MCP_TIMEOUT_MS);
  try {
    const res = await fetch(tunnelUrl.replace(/\/$/, "") + "/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
      cache: "no-store",
    });
    const text = await res.text();
    try {
      return JSON.parse(text) as MCPResponse;
    } catch {
      return {
        error: `non-JSON MCP response (HTTP ${res.status})`,
        stderr: text.slice(0, 1000),
        exit_code: -1,
      };
    }
  } catch (e) {
    return {
      error:
        (e as Error).name === "AbortError"
          ? `step timed out after ${MCP_TIMEOUT_MS / 1000}s`
          : (e as Error).message,
      exit_code: -1,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Compose the same one-line shell expression used by
// agent/devpod_tester.py._checkout_command. Centralizing the literal
// would mean a shared file, which the build doesn't import — keep
// this in sync with the Python helper. v2 dropped the workspace-copy
// fast-path; both runners now use a deterministic clone into
// SANDBOX_CLONE_DIR and require the CLONE_SUCCESS marker on
// stdout to promote the run to clone_success=true.
function checkoutCommand(
  repo: string,
  prNumber: number,
  ghToken: string | null,
): string {
  const cloneUrl = ghToken
    ? `https://x-access-token:${ghToken}@github.com/${repo}.git`
    : `https://github.com/${repo}.git`;
  return [
    `rm -rf ${SANDBOX_CLONE_DIR}`,
    `git clone --depth=1 "${cloneUrl}" ${SANDBOX_CLONE_DIR}`,
    `cd ${SANDBOX_CLONE_DIR}`,
    `git fetch origin pull/${prNumber}/head:pr-branch`,
    `git checkout pr-branch`,
    `echo ${CLONE_SUCCESS_MARKER}`,
  ].join(" && ");
}

// --- Stack detection (Phase 2) -------------------------------------------
//
// Mirrors devpod_tester.py's _detect_command / _parse_detect /
// _stack_commands. Detection lives in the orchestrator; the MCP server
// is a dumb executor that runs whatever command we hand it. Keep this
// matrix identical to the Python one or the EC2 path and the chat path
// will produce different verdicts for the same PR.

const DETECT_DONE_MARKER = "LYNCAS_DETECT_DONE";

const DETECT_FILES: ReadonlyArray<readonly [string, string]> = [
  ["pkg", "package.json"],
  ["pnpm_lock", "pnpm-lock.yaml"],
  ["yarn_lock", "yarn.lock"],
  ["bun_lock", "bun.lockb"],
  ["npm_lock", "package-lock.json"],
  ["requirements", "requirements.txt"],
  ["pyproject", "pyproject.toml"],
  ["setuppy", "setup.py"],
  ["pipfile", "Pipfile"],
  ["gomod", "go.mod"],
  ["cargo", "Cargo.toml"],
  ["gemfile", "Gemfile"],
  ["pom", "pom.xml"],
  ["composer", "composer.json"],
];

interface DetectResult {
  flags: Record<string, boolean>;
  scripts: Record<string, string>;
}

function detectCommand(): string {
  const parts: string[] = [`cd ${SANDBOX_CLONE_DIR} 2>/dev/null || exit 0`];
  for (const [key, fname] of DETECT_FILES) {
    parts.push(
      `( [ -f ${fname} ] && echo "LYNCAS_DETECT:${key}=1" ` +
        `|| echo "LYNCAS_DETECT:${key}=0" )`,
    );
  }
  parts.push(
    `( ( [ -f build.gradle ] || [ -f build.gradle.kts ] ) ` +
      `&& echo "LYNCAS_DETECT:gradle=1" ` +
      `|| echo "LYNCAS_DETECT:gradle=0" )`,
  );
  parts.push(
    `( ls *.csproj >/dev/null 2>&1 ` +
      `&& echo "LYNCAS_DETECT:csproj=1" ` +
      `|| echo "LYNCAS_DETECT:csproj=0" )`,
  );
  parts.push(
    `( [ -f package.json ] ` +
      `&& ( echo LYNCAS_PKG_START; head -c 8000 package.json; ` +
      `echo; echo LYNCAS_PKG_END ) || true )`,
  );
  parts.push(`echo ${DETECT_DONE_MARKER}`);
  return parts.join(" ; ");
}

function parseDetect(stdout: string): DetectResult {
  const flags: Record<string, boolean> = {};
  const pkgLines: string[] = [];
  let inPkg = false;
  for (const line of (stdout ?? "").split(/\n/)) {
    const s = line.trim();
    if (s === "LYNCAS_PKG_START") {
      inPkg = true;
      continue;
    }
    if (s === "LYNCAS_PKG_END") {
      inPkg = false;
      continue;
    }
    if (inPkg) {
      pkgLines.push(line);
      continue;
    }
    if (s.startsWith("LYNCAS_DETECT:")) {
      const kv = s.slice("LYNCAS_DETECT:".length);
      const eq = kv.indexOf("=");
      if (eq >= 0) flags[kv.slice(0, eq)] = kv.slice(eq + 1).trim() === "1";
    }
  }
  let scripts: Record<string, string> = {};
  if (pkgLines.length) {
    try {
      const pkg = JSON.parse(pkgLines.join("\n")) as {
        scripts?: Record<string, unknown>;
      };
      if (pkg.scripts && typeof pkg.scripts === "object") {
        scripts = Object.fromEntries(
          Object.entries(pkg.scripts).map(([k, v]) => [k, String(v)]),
        );
      }
    } catch {
      // Truncated / malformed package.json — treat as no scripts.
    }
  }
  return { flags, scripts };
}

function nodePackageManager(flags: Record<string, boolean>): string {
  if (flags.pnpm_lock) return "pnpm";
  if (flags.yarn_lock) return "yarn";
  if (flags.bun_lock) return "bun";
  return "npm";
}

interface StackCommands {
  label: string;
  install: string;
  test: string;
  build: string;
}

// Returns the (label, install, test, build) commands for the detected
// stack. Language precedence: Node → Python → Go → Rust → Java → Ruby →
// PHP → .NET. Mirrors _stack_commands in agent/devpod_tester.py.
function resolveStack(detect: DetectResult): StackCommands {
  const { flags, scripts } = detect;
  const cd = `cd ${SANDBOX_CLONE_DIR} && `;
  const hasScript = (name: string): boolean => {
    const val = scripts[name] ?? "";
    if (name === "test")
      return Boolean(val) && !val.includes("no test specified");
    return Boolean(val);
  };

  // Node / JS / TS
  if (flags.pkg) {
    const pm = nodePackageManager(flags);
    let install: string;
    let run: string;
    let testScript: string;
    if (pm === "npm") {
      install = "npm install --no-audit --no-fund 2>&1";
      run = "npm run";
      testScript = "npm test";
    } else if (pm === "pnpm") {
      install =
        "corepack pnpm install --frozen-lockfile 2>&1 || pnpm install 2>&1";
      run = "pnpm run";
      testScript = "pnpm test";
    } else if (pm === "yarn") {
      install = "yarn install --frozen-lockfile 2>&1 || yarn install 2>&1";
      run = "yarn run";
      testScript = "yarn test";
    } else {
      install = "bun install 2>&1";
      run = "bun run";
      testScript = "bun test";
    }
    const test = hasScript("test")
      ? `${testScript} 2>&1`
      : "npx --no-install vitest run 2>&1 " +
        "|| npx --no-install jest 2>&1 " +
        "|| npx --no-install mocha 2>&1 " +
        `|| echo "no test runner detected"`;
    const build = hasScript("build")
      ? `${run} build 2>&1`
      : `echo "no build script in package.json"`;
    return {
      label: `Node (${pm})`,
      install: cd + install,
      test: cd + test,
      build: cd + build,
    };
  }

  // Python
  if (flags.requirements || flags.pyproject || flags.setuppy || flags.pipfile) {
    let install: string;
    if (flags.requirements) install = "pip install -r requirements.txt 2>&1";
    else if (flags.pyproject || flags.setuppy)
      install = "pip install -e . 2>&1 || pip install . 2>&1";
    else install = "pip install pipenv 2>&1 && pipenv install --dev 2>&1";
    return {
      label: "Python",
      install: cd + install,
      test:
        cd +
        "python -m pytest -q 2>&1 || python -m unittest discover -v 2>&1",
      build: cd + "python -m compileall -q . 2>&1",
    };
  }

  // Go
  if (flags.gomod) {
    return {
      label: "Go",
      install: cd + "go mod download 2>&1",
      test:
        cd +
        "go test ./... -v -race -cover 2>&1 || go test ./... -v -cover 2>&1",
      build: cd + "go build ./... 2>&1",
    };
  }

  // Rust
  if (flags.cargo) {
    return {
      label: "Rust",
      install: cd + "cargo fetch 2>&1",
      test: cd + "cargo test 2>&1",
      build: cd + "cargo build 2>&1",
    };
  }

  // Java / Kotlin
  if (flags.pom) {
    return {
      label: "Java (maven)",
      install: cd + "mvn -q -DskipTests dependency:resolve 2>&1 || true",
      test: cd + "mvn -q test 2>&1",
      build: cd + "mvn -q -DskipTests package 2>&1",
    };
  }
  if (flags.gradle) {
    const gw = "( [ -x ./gradlew ] && ./gradlew";
    return {
      label: "Java (gradle)",
      install:
        cd + `${gw} dependencies 2>&1 ) || gradle dependencies 2>&1 || true`,
      test: cd + `${gw} test 2>&1 ) || gradle test 2>&1`,
      build: cd + `${gw} build -x test 2>&1 ) || gradle build -x test 2>&1`,
    };
  }

  // Ruby
  if (flags.gemfile) {
    return {
      label: "Ruby",
      install: cd + "bundle install 2>&1",
      test: cd + "bundle exec rspec 2>&1 || bundle exec rake test 2>&1",
      build: cd + `echo "Ruby project — no build step"`,
    };
  }

  // PHP
  if (flags.composer) {
    return {
      label: "PHP",
      install: cd + "composer install 2>&1",
      test:
        cd +
        "( [ -x ./vendor/bin/phpunit ] && ./vendor/bin/phpunit 2>&1 ) " +
        "|| composer test 2>&1",
      build: cd + `echo "PHP project — no build step"`,
    };
  }

  // .NET
  if (flags.csproj) {
    return {
      label: ".NET",
      install: cd + "dotnet restore 2>&1",
      test: cd + "dotnet test 2>&1",
      build: cd + "dotnet build 2>&1",
    };
  }

  // Unknown
  return {
    label: "unknown",
    install: cd + `echo "no deps detected"`,
    test: cd + `echo "no test runner detected"`,
    build: cd + `echo "no build needed"`,
  };
}

function startAppCommand(): string {
  return (
    `cd ${SANDBOX_CLONE_DIR} && ` +
    `export PORT=3000 && ` +
    `( npm start 2>&1 ` +
    `|| python app.py 2>&1 ` +
    `|| python main.py 2>&1 ` +
    `|| go run . 2>&1 ` +
    `|| echo "no entrypoint detected" )`
  );
}

// Returns a shell expression that polls each candidate port once
// per second for up to APP_BIND_TIMEOUT_SEC seconds and prints the
// first responding port to stdout. Mirrors the Python equivalent
// in devpod_tester.py — see comment there for the rationale.
function portDetectCommand(): string {
  const ports = APP_PORT_CANDIDATES.join(" ");
  return (
    `for i in $(seq 1 ${APP_BIND_TIMEOUT_SEC}); do ` +
    `  for p in ${ports}; do ` +
    `    if curl -sI --max-time 1 "http://localhost:$p" ` +
    `      >/dev/null 2>&1; then ` +
    `      echo $p; exit 0; ` +
    `    fi; ` +
    `  done; ` +
    `  sleep 1; ` +
    `done; ` +
    `exit 1`
  );
}

// --- Phase 3: quality checks ---------------------------------------------
//
// Diff-aware static analysis, security, and coverage that run LEFT of the
// preview gate. Mirrors the helpers in agent/devpod_tester.py — every check
// is best-effort and tool-guarded ("skip" != "fail"), only the diff secret
// scan is blocking. SAST (semgrep) is EC2-only per the plan's Vercel-budget
// watch-out; this route marks it skipped.

const CHECK_SKIP_MARKER = "LYNCAS_SKIP";

// High-confidence secret patterns scanned against ADDED diff lines only.
// Conservative on purpose — a false positive blocks a good PR. Mirrors
// _SECRET_PATTERNS in agent/devpod_tester.py.
const SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["AWS access key id", /AKIA[0-9A-Z]{16}/],
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{36,}/],
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/],
  ["Slack token", /xox[baprs]-[0-9A-Za-z-]{10,}/],
  ["Private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  [
    "Hardcoded credential",
    /(api[_-]?key|secret|password|passwd|token|access[_-]?key)\s*[:=]\s*['"][A-Za-z0-9_-]{16,}['"]/i,
  ],
];

interface PrFile {
  filename: string;
  patch?: string;
}

// Fetch the PR's changed files (filename + patch) via the GitHub API. Used
// for diff awareness (secret scan on added lines + changed-file count).
// Returns [] on any failure so diff-dependent checks degrade to "skip".
async function fetchPrFiles(
  repo: string,
  prNumber: number,
  token: string | null,
): Promise<PrFile[]> {
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "lyncas-sandbox",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(
      `https://api.github.com/repos/${repo}/pulls/${prNumber}/files?per_page=100`,
      { headers, cache: "no-store" },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) return [];
    return data.filter(
      (f): f is PrFile =>
        typeof f === "object" &&
        f !== null &&
        typeof (f as PrFile).filename === "string",
    );
  } catch {
    return [];
  }
}

// Regex-scan ADDED diff lines for secrets (newly-added only). Mirrors
// _scan_secrets in agent/devpod_tester.py.
function scanSecrets(files: PrFile[]): SecretScanResult {
  if (!files.length)
    return { status: "skip", tool: "regex-diff", count: 0, findings: [] };
  const findings: string[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const patch = f.patch ?? "";
    const path = f.filename || "?";
    for (const line of patch.split(/\n/)) {
      if (!line.startsWith("+") || line.startsWith("+++")) continue;
      const content = line.slice(1);
      for (const [label, rx] of SECRET_PATTERNS) {
        if (rx.test(content)) {
          const key = `${path}: ${label}`;
          if (!seen.has(key)) {
            seen.add(key);
            findings.push(key);
          }
          break;
        }
      }
    }
  }
  return {
    status: findings.length ? "fail" : "pass",
    tool: "regex-diff",
    count: findings.length,
    findings: findings.slice(0, 20),
  };
}

function summarizeCheck(output: string, ok: boolean): string {
  if (ok) return "passed";
  for (const line of (output ?? "").split(/\n/).reverse()) {
    const s = line.trim();
    if (s) return s.slice(0, 200);
  }
  return "failed";
}

type CheckBuilder = readonly [tool: string, command: string] | null;

function lintCommand(cd: string, flags: Record<string, boolean>): CheckBuilder {
  const skip = `echo ${CHECK_SKIP_MARKER}`;
  if (flags.pkg)
    return [
      "eslint",
      cd +
        `if npx --no-install eslint --version >/dev/null 2>&1; then npx --no-install eslint . 2>&1; else ${skip}; fi`,
    ];
  if (flags.requirements || flags.pyproject || flags.setuppy || flags.pipfile)
    return [
      "ruff/flake8",
      cd +
        `if command -v ruff >/dev/null 2>&1; then ruff check . 2>&1; elif command -v flake8 >/dev/null 2>&1; then flake8 2>&1; else ${skip}; fi`,
    ];
  if (flags.gomod) return ["go vet", cd + "go vet ./... 2>&1"];
  if (flags.cargo)
    return [
      "clippy",
      cd +
        `if cargo clippy --version >/dev/null 2>&1; then cargo clippy 2>&1; else ${skip}; fi`,
    ];
  return null;
}

function typecheckCommand(
  cd: string,
  flags: Record<string, boolean>,
): CheckBuilder {
  const skip = `echo ${CHECK_SKIP_MARKER}`;
  if (flags.pkg)
    return [
      "tsc",
      cd +
        `if [ -f tsconfig.json ] && npx --no-install tsc --version >/dev/null 2>&1; then npx --no-install tsc --noEmit 2>&1; else ${skip}; fi`,
    ];
  if (flags.requirements || flags.pyproject || flags.setuppy || flags.pipfile)
    return [
      "mypy/pyright",
      cd +
        `if command -v mypy >/dev/null 2>&1; then mypy . 2>&1; elif command -v pyright >/dev/null 2>&1; then pyright 2>&1; else ${skip}; fi`,
    ];
  return null;
}

function auditCommand(
  cd: string,
  flags: Record<string, boolean>,
): CheckBuilder {
  const skip = `echo ${CHECK_SKIP_MARKER}`;
  if (flags.pkg)
    return [
      "npm audit",
      cd + `if [ -f package-lock.json ]; then npm audit 2>&1; else ${skip}; fi`,
    ];
  if (flags.requirements || flags.pyproject || flags.setuppy || flags.pipfile)
    return [
      "pip-audit",
      cd +
        `if command -v pip-audit >/dev/null 2>&1; then pip-audit 2>&1; else ${skip}; fi`,
    ];
  if (flags.gomod)
    return [
      "govulncheck",
      cd +
        `if command -v govulncheck >/dev/null 2>&1; then govulncheck ./... 2>&1; else ${skip}; fi`,
    ];
  if (flags.cargo)
    return [
      "cargo audit",
      cd +
        `if command -v cargo-audit >/dev/null 2>&1; then cargo audit 2>&1; else ${skip}; fi`,
    ];
  return null;
}

async function runCheck(
  tunnelUrl: string,
  repo: string,
  builder: CheckBuilder,
  timeout = 180,
): Promise<CheckResult> {
  if (builder === null)
    return { status: "skip", tool: "n/a", summary: "not applicable" };
  const [tool, command] = builder;
  const resp = await postExecute(tunnelUrl, {
    type: "run_command",
    repo,
    command,
    timeout,
  });
  const stdout = resp.stdout ?? "";
  const stderr = resp.stderr ?? "";
  if (resp.error)
    return {
      status: "skip",
      tool,
      summary: `could not run: ${resp.error}`.slice(0, 200),
    };
  if (stdout.includes(CHECK_SKIP_MARKER))
    return { status: "skip", tool, summary: "tool not available" };
  const ok = resp.success === true || resp.exit_code === 0;
  return {
    status: ok ? "pass" : "fail",
    tool,
    summary: summarizeCheck(stdout + "\n" + stderr, ok),
  };
}

// Opportunistically read a coverage % out of captured test output — no
// extra command. Mirrors _parse_coverage in agent/devpod_tester.py.
function parseCoverage(testOutput: string): {
  status: "ok" | "skip";
  pct: number | null;
  tool: string;
} {
  if (!testOutput) return { status: "skip", pct: null, tool: "n/a" };
  const mp = /TOTAL\s+\d+\s+\d+\s+(\d+(?:\.\d+)?)%/.exec(testOutput);
  if (mp) return { status: "ok", pct: Number(mp[1]), tool: "pytest-cov" };
  const mj = /All files\s*\|\s*([\d.]+)/.exec(testOutput);
  if (mj) return { status: "ok", pct: Number(mj[1]), tool: "istanbul" };
  return { status: "skip", pct: null, tool: "n/a" };
}

function computeVerdict(args: {
  cloneSuccess: boolean;
  installSuccess: boolean;
  testsPassed: number;
  testsFailed: number;
  testsOk: boolean;
  noTests: boolean;
  buildAttempted: boolean;
  buildSuccess: boolean;
  secretsBlockingFailed: boolean;
  appStarted: boolean;
  appUrl: string | null;
}): SandboxVerdict {
  if (!args.cloneSuccess || !args.installSuccess) return "error";
  if (args.buildAttempted && !args.buildSuccess) return "build_failed";
  // A newly-added secret in the diff is high-severity + blocking.
  if (args.secretsBlockingFailed) return "security_failed";
  // testsOk is exit-code-aware: a non-zero test run with no parseable
  // count still flags as failing (Phase 2). Mirrors _compute_verdict.
  if (!args.noTests && !args.testsOk) return "tests_failed";
  if (args.noTests) return "no_tests";
  if (args.appStarted && args.appUrl) return "pass";
  return "pass_no_preview";
}

// Phase 1 preview gate — decide whether start_app / expose_port may run.
// Mirrors _compute_gate in agent/devpod_tester.py; keep the two in sync.
function computeGate(args: {
  cloneSuccess: boolean;
  installSuccess: boolean;
  buildAttempted: boolean;
  buildSuccess: boolean;
  testsFailed: number;
  testsOk: boolean;
  noTests: boolean;
  secretsBlockingFailed: boolean;
  secretsCount: number;
  blockOnTestFailure: boolean;
  requireTestsForPreview: boolean;
}): { passed: boolean; reason: string } {
  if (!args.cloneSuccess || !args.installSuccess)
    return { passed: false, reason: "clone or install failed" };
  if (args.buildAttempted && !args.buildSuccess)
    return { passed: false, reason: "build failed" };
  if (args.secretsBlockingFailed) {
    const plural = args.secretsCount === 1 ? "secret" : "secrets";
    const n = args.secretsCount || "a";
    return { passed: false, reason: `${n} ${plural} detected in the diff` };
  }
  if (args.blockOnTestFailure && !args.noTests && !args.testsOk) {
    if (args.testsFailed > 0) {
      const plural = args.testsFailed === 1 ? "test" : "tests";
      return { passed: false, reason: `${args.testsFailed} ${plural} failed` };
    }
    return { passed: false, reason: "tests failed" };
  }
  if (args.requireTestsForPreview && args.noTests)
    return {
      passed: false,
      reason: "no tests found and this repo requires tests for a preview",
    };
  return { passed: true, reason: "" };
}

export async function POST(request: NextRequest) {
  const user = await getUser().catch(() => null);
  if (!user) return jsonError("Not authenticated", 401);

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return jsonError("Body must be JSON", 400);
  }
  const repo = typeof body.repo === "string" ? body.repo.trim() : "";
  const prNumberRaw =
    typeof body.pr_number === "number"
      ? body.pr_number
      : Number(body.pr_number);
  if (!repo || !Number.isFinite(prNumberRaw) || prNumberRaw <= 0) {
    return jsonError("`repo` + `pr_number` are required", 400);
  }
  const prNumber = Math.trunc(prNumberRaw);

  const supabase = await createSupabaseServerClient();

  // Active session lookup. Same liveness rule as /api/devpod/status:
  // status='active' AND expires_at in the future. We don't trust
  // the caller's claim that DevPod is live — they may be racing a
  // /disconnect.
  const { data: session } = await supabase
    .from("devpod_sessions")
    .select("id, tunnel_url, status, expires_at")
    .eq("user_id", user.id)
    .order("connected_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const live =
    !!session &&
    session.status === "active" &&
    Date.parse(session.expires_at) > Date.now();
  if (!session || !live) {
    return jsonError("No active DevPod session", 404);
  }

  // GitHub token for the (private-repo) clone fallback.
  const resolved = await resolveGithubToken({
    supabase,
    userId: user.id,
    repo,
    fallbackPat: process.env.PR_REVIEWER_PAT,
  });
  // No-token is fine for public repos; the clone URL falls back to
  // an anonymous https://github.com/... clone. Private repos will
  // 404 inside the DevPod, which we surface as clone failure.

  // Per-repo preview-gate config (Phase 1). Migration-tolerant: select *
  // and fall back to the documented defaults (block=true, require=false)
  // if the row or the migration-021 columns are absent.
  let blockOnTestFailure = true;
  let requireTestsForPreview = false;
  let blockOnSecrets = true;
  try {
    const { data: rule } = await supabase
      .from("repo_rules")
      .select("*")
      .eq("repo", repo)
      .maybeSingle();
    if (rule) {
      if (typeof rule.sandbox_block_on_test_failure === "boolean")
        blockOnTestFailure = rule.sandbox_block_on_test_failure;
      if (typeof rule.sandbox_require_tests_for_preview === "boolean")
        requireTestsForPreview = rule.sandbox_require_tests_for_preview;
      if (typeof rule.sandbox_block_on_secrets === "boolean")
        blockOnSecrets = rule.sandbox_block_on_secrets;
    }
  } catch {
    // Keep defaults — a missing table/columns must not break the run.
  }

  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function emit(evt: SandboxProgressEvent) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));
      }
      function emitStep(
        step: SandboxStep,
        status: "running" | "done" | "error",
        extra: Partial<SandboxProgressEvent> = {},
      ) {
        emit({ step, status, ...extra });
      }

      try {
        // ----- Step 1: clone / copy + checkout -----
        // Marker check mirrors agent/devpod_tester.py: an exit-zero
        // from git alone is not sufficient — codespaces-base has
        // been observed leaving partial trees on mid-fetch network
        // blips. Stdout must contain CLONE_SUCCESS for the clone to
        // promote to success.
        emitStep("clone", "running");
        const checkout = await postExecute(session.tunnel_url, {
          type: "run_command",
          repo,
          command: checkoutCommand(repo, prNumber, resolved.token),
        });
        const cloneExitZero =
          checkout.success === true || checkout.exit_code === 0;
        const cloneMarkerSeen = (checkout.stdout ?? "").includes(
          CLONE_SUCCESS_MARKER,
        );
        const cloneSuccess = cloneExitZero && cloneMarkerSeen;
        const cloneError = cloneSuccess
          ? undefined
          : !cloneMarkerSeen && cloneExitZero
            ? "clone command exited 0 but CLONE_SUCCESS marker missing — likely a partial checkout"
            : (checkout.error ?? checkout.stderr);
        emitStep("clone", cloneSuccess ? "done" : "error", {
          success: cloneSuccess,
          ...(cloneSuccess ? {} : { error: cloneError }),
        });

        // ----- Step 1b: detect the stack (Phase 2, no SSE step) -----
        // One silent probe round-trip after checkout; the orchestrator
        // (not the MCP server) decides the install / test / build
        // commands. Defaults to the harmless "unknown" matrix if the
        // probe returns nothing.
        let detectResult: DetectResult = { flags: {}, scripts: {} };
        let stack = resolveStack(detectResult);
        if (cloneSuccess) {
          const detect = await postExecute(session.tunnel_url, {
            type: "run_command",
            repo,
            command: detectCommand(),
          });
          detectResult = parseDetect(detect.stdout ?? "");
          stack = resolveStack(detectResult);
        }

        // ----- Step 2: install -----
        // Gated on cloneSuccess — same contract the agent enforces.
        // A failed clone means downstream steps cannot produce
        // meaningful signal, so we short-circuit straight to the
        // verdict computation below.
        let installSuccess = false;
        if (cloneSuccess) {
          emitStep("install", "running");
          const install = await postExecute(session.tunnel_url, {
            type: "run_command",
            repo,
            command: stack.install,
            // cargo / maven / dotnet restores can exceed the default
            // 120s run_command cap; older MCP servers ignore `timeout`.
            timeout: 300,
          });
          installSuccess =
            install.success === true || install.exit_code === 0;
          emitStep("install", installSuccess ? "done" : "error", {
            success: installSuccess,
            ...(installSuccess ? {} : { error: install.stderr ?? install.error }),
          });
        }

        // ----- Steps 2b–2d: quality checks (Phase 3) -----
        // Lint, type-check, and security (diff secret scan + dependency
        // audit) run LEFT of the gate, after deps are installed. SAST
        // (semgrep) is EC2-only per the plan's Vercel-budget watch-out.
        // Only the secret scan can block; the rest are advisory.
        const cdPrefix = `cd ${SANDBOX_CLONE_DIR} && `;
        let lintResult: CheckResult = {
          status: "skip",
          tool: "n/a",
          summary: "not applicable",
        };
        let typecheckResult: CheckResult = {
          status: "skip",
          tool: "n/a",
          summary: "not applicable",
        };
        let auditResult: CheckResult = {
          status: "skip",
          tool: "n/a",
          summary: "not applicable",
        };
        const sastResult: CheckResult = {
          status: "skip",
          tool: "semgrep",
          summary: "runs on EC2",
        };
        let secretsResult: SecretScanResult = {
          status: "skip",
          tool: "regex-diff",
          count: 0,
          findings: [],
        };
        let changedFileCount = 0;

        if (cloneSuccess && installSuccess) {
          // Diff awareness + secret scan (no MCP round-trip — pure API).
          const prFiles = await fetchPrFiles(repo, prNumber, resolved.token);
          changedFileCount = prFiles.length;
          secretsResult = scanSecrets(prFiles);

          emitStep("lint", "running");
          lintResult = await runCheck(
            session.tunnel_url,
            repo,
            lintCommand(cdPrefix, detectResult.flags),
          );
          emitStep("lint", lintResult.status === "fail" ? "error" : "done", {
            success: lintResult.status !== "fail",
            detail: `${lintResult.tool}: ${lintResult.status}`,
          });

          emitStep("typecheck", "running");
          typecheckResult = await runCheck(
            session.tunnel_url,
            repo,
            typecheckCommand(cdPrefix, detectResult.flags),
          );
          emitStep(
            "typecheck",
            typecheckResult.status === "fail" ? "error" : "done",
            {
              success: typecheckResult.status !== "fail",
              detail: `${typecheckResult.tool}: ${typecheckResult.status}`,
            },
          );

          emitStep("security", "running");
          auditResult = await runCheck(
            session.tunnel_url,
            repo,
            auditCommand(cdPrefix, detectResult.flags),
          );
          // The security step is "error" only when a blocking secret is
          // found; audit/sast are advisory and never red the step.
          const secretsBad =
            blockOnSecrets && secretsResult.status === "fail";
          emitStep("security", secretsBad ? "error" : "done", {
            success: !secretsBad,
            detail:
              `secrets: ${secretsResult.count} · ` +
              `audit: ${auditResult.status}`,
          });
        }

        // ----- Step 3: run tests -----
        let testsPassed = 0;
        let testsFailed = 0;
        let testOutput = "";
        let noTests = false;
        // Exit-code-aware "did tests pass" signal — defaults to true so
        // the skipped path (clone/install failed) isn't read as failing.
        let testsOk = true;
        if (cloneSuccess && installSuccess) {
          emitStep("tests", "running");
          const testResp = await postExecute(session.tunnel_url, {
            type: "run_tests",
            repo,
            cwd: SANDBOX_CLONE_DIR,
            // Phase 2: orchestrator-supplied command; the MCP server runs
            // it verbatim (older servers re-detect for the big three).
            command: stack.test,
          });
          const blob =
            (testResp.stdout ?? "") +
            (testResp.stderr ? "\n" + testResp.stderr : "");
          ({ passed: testsPassed, failed: testsFailed } =
            countPassedFailed(blob));
          testOutput = blob;
          const testExitZero =
            testResp.success === true || testResp.exit_code === 0;
          noTests =
            looksLikeNoTests(blob) ||
            (testsPassed === 0 && testsFailed === 0 && testExitZero);
          // OK iff nothing parsed as failed AND the runner exited 0; the
          // exit-code half catches runners we can't parse a count from.
          testsOk = noTests || (testExitZero && testsFailed === 0);
          emitStep("tests", "done", {
            passed: testsPassed,
            failed: testsFailed,
            success: !noTests && testsOk,
          });
        }

        // ----- Step 4: build -----
        // Attempted whenever clone + install both passed; the
        // MCP server's build handler auto-detects npm / go / py
        // and times out at 180s. An older MCP server returns
        // {"error":"unknown type: build"} and we soft-skip that
        // case so unupgraded DevPods don't get red-flagged.
        let buildAttempted = false;
        let buildSuccess = false;
        let buildOutput = "";
        if (cloneSuccess && installSuccess) {
          emitStep("build", "running");
          const buildResp = await postExecute(session.tunnel_url, {
            type: "build",
            repo,
            cwd: SANDBOX_CLONE_DIR,
            // Phase 2: orchestrator-supplied build command. Older MCP
            // servers ignore it and fall back to their own detection.
            command: stack.build,
          });
          const errStr = (buildResp.error ?? "").toLowerCase();
          if (errStr.includes("unknown type")) {
            // MCP server too old — emit `done` with success=true
            // so the UI doesn't show this as a failure. The card
            // also reads buildAttempted to suppress the row.
            emitStep("build", "done", {
              success: true,
              build_output: "(MCP server too old; build skipped)",
            });
          } else {
            buildAttempted = true;
            buildSuccess =
              buildResp.success === true || buildResp.exit_code === 0;
            buildOutput =
              (buildResp.stdout ?? "") +
              (buildResp.stderr ? "\n" + buildResp.stderr : "");
            emitStep("build", buildSuccess ? "done" : "error", {
              success: buildSuccess,
              build_output: truncate(buildOutput, 4_000),
              ...(buildSuccess ? {} : { error: buildResp.error }),
            });
          }
        }

        // ----- Assemble Phase 3 checks blob -----
        // Coverage is read opportunistically from the captured test output
        // (no extra command). The blob is persisted + streamed on complete.
        const checks: SandboxChecks = {
          diff: { changed_files: changedFileCount, base: null },
          lint: lintResult,
          typecheck: typecheckResult,
          security: {
            secrets: secretsResult,
            audit: auditResult,
            sast: sastResult,
          },
          coverage: parseCoverage(testOutput),
          // Phase 4: generated tests are EC2-only (no Anthropic key here,
          // no budget for a Claude call + test run in the Vercel route).
          // The webhook/orchestrator path populates this for real.
          generated: {
            status: "skip",
            framework: "n/a",
            written: 0,
            passed: 0,
            failed: 0,
            summary: "runs on EC2 (webhook path)",
            bug_candidate: false,
          },
        };
        const secretsBlockingFailed =
          blockOnSecrets && secretsResult.status === "fail";

        // ----- Preview gate (Phase 1 + Phase 3) -----
        // Decide whether the live preview may run BEFORE starting the
        // app. Withholds the preview on a failing build, failing tests,
        // (strict repos) missing tests, or a newly-added secret in the
        // diff. Config is per-repo.
        const gate = computeGate({
          cloneSuccess,
          installSuccess,
          buildAttempted,
          buildSuccess,
          testsFailed,
          testsOk,
          noTests,
          secretsBlockingFailed,
          secretsCount: secretsResult.count,
          blockOnTestFailure,
          requireTestsForPreview,
        });

        // ----- Step 5: start app + detect port + expose -----
        // Runs only when the preview gate passed. A blocked gate means a
        // failing build, failing tests, or (strict repos) missing tests.
        let appStarted = false;
        let appUrl: string | null = null;
        let appPort: number | null = null;
        if (gate.passed) {
          emitStep("app", "running");
          const start = await postExecute(session.tunnel_url, {
            type: "start_app",
            repo,
            command: startAppCommand(),
            cwd: SANDBOX_CLONE_DIR,
          });
          appStarted = start.started === true;

          if (appStarted) {
            const probe = await postExecute(session.tunnel_url, {
              type: "run_command",
              repo,
              command: portDetectCommand(),
            });
            const probeOut = (probe.stdout ?? "").trim();
            if (probe.exit_code === 0 && probeOut) {
              const last = probeOut
                .split(/\n/)
                .map((s) => s.trim())
                .filter(Boolean)
                .pop();
              const n = last ? Number(last) : NaN;
              if (Number.isFinite(n)) appPort = n;
            }

            if (appPort) {
              const expose = await postExecute(session.tunnel_url, {
                type: "expose_port",
                repo,
                port: appPort,
              });
              appUrl = typeof expose.url === "string" ? expose.url : null;
            }
          }

          emitStep("app", appStarted ? "done" : "error", {
            success: appStarted,
            url: appUrl,
          });
        }

        // ----- Aggregate -----
        const verdict = computeVerdict({
          cloneSuccess,
          installSuccess,
          testsPassed,
          testsFailed,
          testsOk,
          noTests,
          buildAttempted,
          buildSuccess,
          secretsBlockingFailed,
          appStarted,
          appUrl,
        });
        const overallDb = verdictToDbOverall(verdict);
        const duration_ms = Date.now() - startedAt;

        // Persist. Best-effort — a DB error here must not eat the
        // SSE "complete" event the UI is waiting for. We map the
        // rich verdict to the legacy enum because migration 015's
        // CHECK constraint forbids the new values; the rich
        // verdict survives in the SSE stream + the card.
        try {
          // Encode the build status into the test_output column
          // so the dashboard's chat report can still see "build
          // passed/failed" even though we don't have a column
          // for it. Mirrors devpod_tester.py.
          const persistedTestOutput = buildAttempted
            ? `[build: ${buildSuccess ? "pass" : "FAIL"}]\n` +
              (buildOutput ? `${buildOutput.slice(0, 2000)}\n---\n` : "") +
              testOutput
            : testOutput;

          const baseRow = {
            repo,
            pr_number: prNumber,
            user_id: user.id,
            session_id: session.id,
            tests_passed: testsPassed,
            tests_failed: testsFailed,
            test_output: truncate(persistedTestOutput),
            app_url: appUrl,
            app_started: appStarted,
            clone_success: cloneSuccess,
            install_success: installSuccess,
            overall: overallDb,
            duration_ms,
          };
          // Phase 3 columns (migration 022). If the migration hasn't been
          // applied the upsert errors on the unknown columns — retry with
          // just the base row so the core result still lands.
          const richRow = {
            ...baseRow,
            checks,
            gate_passed: gate.passed,
            gate_reason: gate.passed ? null : gate.reason,
          };
          const { error: upsertErr } = await supabase
            .from("pr_sandbox_results")
            .upsert(richRow, { onConflict: "repo,pr_number" });
          if (upsertErr) {
            await supabase
              .from("pr_sandbox_results")
              .upsert(baseRow, { onConflict: "repo,pr_number" });
          }
        } catch (e) {
          console.warn(
            `[run-pr-tests] persist failed: ${(e as Error).message}`,
          );
        }

        emit({
          step: "complete",
          status: "done",
          overall: verdict,
          duration_ms,
          url: appUrl,
          gate_passed: gate.passed,
          ...(gate.passed ? {} : { gate_reason: gate.reason }),
          checks,
        });
        controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
        controller.close();
      } catch (e) {
        emitStep("complete", "error", { error: (e as Error).message });
        controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
