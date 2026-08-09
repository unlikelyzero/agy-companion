/**
 * Transport layer for driving Google's Antigravity CLI (`agy`) from
 * agy-companion.
 *
 * This is NOT a port of Codex's app-server-broker.mjs / app-server.mjs. Codex
 * talks to a persistent JSON-RPC "app-server" process over stdio: real
 * bidirectional streaming, native `outputSchema` enforcement, ACP-style
 * cancel semantics. `agy` 1.0.1 has none of that (confirmed against a real
 * install; see docs/SPIKE-findings.md referenced from the README). `agy`
 * only exposes a non-interactive `--print` mode that blocks until it has a
 * final answer and prints it to stdout — there is no thread/turn protocol,
 * no reasoning-summary stream, and no way to recover a conversation id for
 * a specific past run (only `--continue`, which resumes agy's own
 * most-recently-used conversation).
 *
 * So this module is deliberately much simpler than codex.mjs: spawn `agy
 * --print ...`, tail its stdout/stderr, detect the one interactive prompt
 * agy can emit (a Google OAuth "authentication required" screen) and fail
 * fast instead of hanging, and — for the two review commands, which need
 * structured JSON back — parse + validate the final answer locally against
 * schemas/review-output.schema.json with one retry on malformed output.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

import { readJsonFile } from "./fs.mjs";
import { binaryAvailable, runCommand } from "./process.mjs";
import { validateAgainstSchema } from "./schema-validate.mjs";

const AUTH_REQUIRED_PATTERN = /authentication required/i;
const URL_PATTERN = /(https?:\/\/\S+)/;
const DEFAULT_RUN_TIMEOUT_MS = 15 * 60 * 1000;
const UPSTREAM_HEADLESS_AUTH_ISSUE = "https://github.com/google-antigravity/antigravity-cli/issues/78";

export class AgyAuthRequiredError extends Error {
  constructor(authUrl, rawOutput) {
    super(
      authUrl
        ? `agy requires interactive Google OAuth login. Visit this URL to authenticate, then retry: ${authUrl}`
        : "agy requires interactive Google OAuth login, but no login URL could be captured from its output."
    );
    this.name = "AgyAuthRequiredError";
    this.authUrl = authUrl ?? null;
    this.rawOutput = rawOutput ?? "";
  }
}

export class AgyTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`agy did not finish within ${Math.round(timeoutMs / 1000)}s.`);
    this.name = "AgyTimeoutError";
  }
}

export function getAgyAvailability(cwd) {
  return binaryAvailable("agy", ["--version"], { cwd });
}

/**
 * agy 1.0.1 has no `whoami` / `account status` equivalent, and probing auth
 * by actually running a prompt would consume the user's quota and could
 * block on an interactive OAuth screen. So, unlike Codex's
 * `getCodexAuthStatus` (which calls the app-server's `account/read` RPC),
 * this can only report whether the binary is present — actual login state
 * is only discoverable by running a real command, at which point
 * `AgyAuthRequiredError` (surfaced through job status/result) reports the
 * OAuth URL to visit.
 */
export function getAgyAuthStatus(cwd) {
  const availability = getAgyAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: null,
      detail: availability.detail,
      source: "availability"
    };
  }

  return {
    available: true,
    loggedIn: null,
    detail:
      "agy has no headless auth-status check. Login state is only known once a command runs: " +
      `if agy needs Google OAuth login it will report the login URL through /agy:status instead of hanging ` +
      `(tracked upstream: ${UPSTREAM_HEADLESS_AUTH_ISSUE}).`,
    source: "unknown"
  };
}

/**
 * agy has no shared background runtime / broker (Codex's app-server can be
 * reused across commands via a broker socket). Every agy-companion command
 * spawns its own `agy --print` process, so this always reports the same
 * "direct" mode. The function still exists, mirroring codex.mjs's
 * `getSessionRuntimeStatus`, so job-control/render code has one thing to
 * call regardless of transport.
 */
export function getSessionRuntimeStatus() {
  return {
    mode: "direct",
    label: "direct invocation",
    detail: "Each /agy:* command spawns its own `agy --print` process; there is no shared background runtime.",
    endpoint: null
  };
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

function buildAgyArgs(options) {
  const args = ["--print", options.prompt ?? ""];
  if (options.continueLatest) {
    args.push("--continue");
  }
  for (const dir of options.addDirs ?? []) {
    args.push("--add-dir", dir);
  }
  if (options.write) {
    args.push("--dangerously-skip-permissions");
  }
  if (options.sandbox) {
    args.push("--sandbox");
  }
  return args;
}

function cleanAgyStderr(stderr) {
  return String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .join("\n");
}

/**
 * Spawns `agy --print <prompt>` and resolves once the process exits, or
 * rejects with `AgyAuthRequiredError` the moment an OAuth prompt is
 * detected on stdout (rather than waiting for agy's own internal timeout to
 * hang the whole job), or `AgyTimeoutError` if it runs past `timeoutMs`.
 *
 * `options.tailFile`, if set, receives raw stdout/stderr chunks as they
 * arrive so a background job can be tailed live via /agy:status — agy gives
 * no structured progress events, only the eventual final answer, so this is
 * the only "liveness" signal available.
 */
export function runAgyPrompt(cwd, options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_RUN_TIMEOUT_MS);
  const args = buildAgyArgs(options);

  options.onProgress?.({ message: "Starting agy.", phase: "starting" });

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let authAlreadyDetected = false;

    const child = spawnImpl("agy", args, {
      cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill?.("SIGTERM");
      reject(new AgyTimeoutError(timeoutMs));
    }, timeoutMs);
    timer.unref?.();

    function tail(chunk) {
      if (!options.tailFile) {
        return;
      }
      try {
        fs.appendFileSync(options.tailFile, chunk);
      } catch {
        // Best-effort tailing only; never fail the run because the log couldn't be written.
      }
    }

    function checkForAuthPrompt() {
      if (authAlreadyDetected || !AUTH_REQUIRED_PATTERN.test(stdout)) {
        return;
      }
      authAlreadyDetected = true;
      const urlMatch = stdout.match(URL_PATTERN);
      options.onProgress?.({
        message: "agy requires interactive Google OAuth login.",
        phase: "auth-required"
      });
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill?.("SIGTERM");
      reject(new AgyAuthRequiredError(urlMatch?.[1] ?? null, stdout));
    }

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      tail(text);
      checkForAuthPrompt();
    });

    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      tail(text);
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error?.code === "ENOENT") {
        reject(
          new Error(
            "agy CLI is not installed or is not on PATH. Install the Antigravity CLI, then rerun `/agy:setup`."
          )
        );
        return;
      }
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.onProgress?.({ message: "agy finished.", phase: "finalizing" });
      resolve({
        status: code ?? (signal ? 1 : 0),
        signal: signal ?? null,
        stdout,
        stderr: cleanAgyStderr(stderr)
      });
    });
  });
}

function extractJsonCandidate(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return null;
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

/**
 * Parses `rawOutput` as JSON and validates it against `schema`.
 * Returns `{ ok, data, error }`.
 */
export function parseAndValidateStructuredOutput(rawOutput, schema) {
  const candidate = extractJsonCandidate(rawOutput);
  if (!candidate) {
    return { ok: false, data: null, error: "agy did not return any output." };
  }

  let data;
  try {
    data = JSON.parse(candidate);
  } catch (error) {
    return { ok: false, data: null, error: `Response is not valid JSON: ${error.message}` };
  }

  const { valid, errors } = validateAgainstSchema(data, schema);
  if (!valid) {
    return { ok: false, data: null, error: `JSON did not match the review schema: ${errors[0]}` };
  }

  return { ok: true, data, error: null };
}

const STRUCTURED_RETRY_PROMPT =
  "Your last response was not valid JSON matching the schema. Return ONLY the corrected JSON with no prose, no markdown code fences, and no extra text before or after it.";

/**
 * Runs `agy --print <prompt>`, parses the final answer as JSON against
 * `schema`, and — since agy has no server-side schema enforcement the way
 * Codex's app-server does — retries exactly once with a corrective
 * `agy --continue` prompt if parsing/validation fails before giving up and
 * surfacing the parse error to the caller.
 */
export async function runAgyStructured(cwd, options = {}) {
  const first = await runAgyPrompt(cwd, options);
  const firstParsed = parseAndValidateStructuredOutput(first.stdout, options.schema);
  if (firstParsed.ok) {
    return {
      status: 0,
      stdout: first.stdout,
      stderr: first.stderr,
      parsed: firstParsed.data,
      parseError: null,
      retried: false
    };
  }

  options.onProgress?.({
    message: `agy's response did not match the expected schema (${firstParsed.error}); retrying once.`,
    phase: "finalizing"
  });

  const second = await runAgyPrompt(cwd, {
    ...options,
    prompt: STRUCTURED_RETRY_PROMPT,
    continueLatest: true
  });
  const secondParsed = parseAndValidateStructuredOutput(second.stdout, options.schema);

  return {
    status: secondParsed.ok ? 0 : 1,
    stdout: second.stdout,
    stderr: second.stderr,
    parsed: secondParsed.ok ? secondParsed.data : null,
    parseError: secondParsed.ok ? null : secondParsed.error,
    rawOutput: second.stdout,
    retried: true
  };
}

/**
 * Best-effort touched-files detection for write-capable task runs. Codex's
 * app-server reports exact file-change items as part of the turn protocol;
 * agy reports nothing structured, so this instead diffs `git status
 * --porcelain` before and after the run. It silently returns an empty list
 * outside a git repository or if git itself fails — this is a nice-to-have,
 * not a guarantee.
 */
export function captureGitStatusSnapshot(cwd) {
  const result = runCommand("git", ["status", "--porcelain"], { cwd });
  if (result.error || result.status !== 0) {
    return null;
  }
  return new Set(
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );
}

export function diffGitStatusSnapshots(before, after) {
  if (!before || !after) {
    return [];
  }
  const changed = new Set();
  for (const line of after) {
    if (!before.has(line)) {
      changed.add(line.replace(/^.{0,3}\s*/, ""));
    }
  }
  for (const line of before) {
    if (!after.has(line)) {
      changed.add(line.replace(/^.{0,3}\s*/, ""));
    }
  }
  return [...changed].sort();
}

export { UPSTREAM_HEADLESS_AUTH_ISSUE };
