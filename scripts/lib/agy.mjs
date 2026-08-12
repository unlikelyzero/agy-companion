/**
 * Transport layer for driving Google's Antigravity CLI (`agy`) from
 * agy-companion.
 *
 * This is NOT a port of Codex's app-server-broker.mjs / app-server.mjs. Codex
 * talks to a persistent JSON-RPC "app-server" process over stdio: real
 * bidirectional streaming, ACP-style cancel semantics. `agy` has no
 * persistent broker or thread/turn protocol — every command spawns its own
 * `agy --print ...` process that blocks until it has a final answer.
 *
 * CORRECTION (verified 2026-08 against a real `agy 1.1.11` install — see
 * README "Differences from codex-plugin-cc" for the full story): earlier
 * drafts of this file assumed agy had no native structured-output
 * enforcement, based on third-party spike notes written against `agy
 * 1.0.1`. That was wrong for the version actually available today. Current
 * `agy` has a real `--json-schema <path>` flag combined with `--output-format
 * json`, which makes the model itself produce schema-conformant output and
 * hands it back pre-parsed as `structured_output` in a single JSON envelope
 * on stdout — closer to Codex's `outputSchema` than the prompt-and-hope
 * fallback this file used to rely on. `runAgyStructured` below uses that
 * native path, and still runs one local schema-validation pass as
 * defense-in-depth in case enforcement is ever soft. If `--json-schema` is
 * rejected by an older `agy` (flag unrecognized), that's surfaced as a clear
 * `AgyUnsupportedFeatureError` telling the user to run `agy update`, rather
 * than silently degrading to fragile prompt-based JSON extraction.
 *
 * Also corrected: agy's JSON envelope includes a real `conversation_id`, so
 * `--conversation <id>` can target a specific past run, not just
 * `--continue` (agy's most-recently-used conversation) as earlier notes
 * assumed.
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

export class AgyUnsupportedFeatureError extends Error {
  constructor(flag, stderr) {
    super(
      `This install of agy does not recognize \`${flag}\`. agy-companion requires a recent agy build ` +
        `(tested against 1.1.11). Run \`agy update\`, then retry.`
    );
    this.name = "AgyUnsupportedFeatureError";
    this.flag = flag;
    this.stderr = stderr ?? "";
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
  if (options.conversationId) {
    args.push("--conversation", options.conversationId);
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
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.effort) {
    args.push("--effort", options.effort);
  }
  if (options.outputFormat) {
    args.push("--output-format", options.outputFormat);
  }
  if (options.jsonSchemaPath) {
    args.push("--json-schema", options.jsonSchemaPath);
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
      const cleanStderr = cleanAgyStderr(stderr);
      if (options.jsonSchemaPath && /flag provided but not defined/i.test(cleanStderr) && /json-schema/i.test(cleanStderr)) {
        reject(new AgyUnsupportedFeatureError("--json-schema", cleanStderr));
        return;
      }
      resolve({
        status: code ?? (signal ? 1 : 0),
        signal: signal ?? null,
        stdout,
        stderr: cleanStderr
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

const REVIEW_VERDICT_VALUES = ["approve", "needs-attention"];

/**
 * Repairs the near-miss review payloads Gemini emits in practice before
 * strict schema validation rejects them (observed against a real agy 1.1.11
 * run): a top-level `status` field where the schema wants `verdict`, a
 * missing `next_steps` array, and findings without a `severity`. Only
 * unambiguous repairs are made — a `status` value that isn't a valid verdict
 * is left alone so validation still reports the real mismatch.
 */
export function normalizeReviewPayload(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return data;
  }
  const normalized = { ...data };
  if (normalized.verdict === undefined && REVIEW_VERDICT_VALUES.includes(normalized.status)) {
    normalized.verdict = normalized.status;
    delete normalized.status;
  }
  if (normalized.next_steps === undefined) {
    normalized.next_steps = [];
  }
  if (Array.isArray(normalized.findings)) {
    normalized.findings = normalized.findings.map((finding) => {
      if (finding === null || typeof finding !== "object" || Array.isArray(finding)) {
        return finding;
      }
      return finding.severity === undefined ? { ...finding, severity: "medium" } : finding;
    });
  }
  return normalized;
}

/**
 * Parses `rawOutput` as JSON and validates it against `schema`.
 * Returns `{ ok, data, error }`. Kept as a standalone helper — used both for
 * the top-level agy JSON envelope and, defensively, as a fallback if that
 * envelope's own parse fails for some unanticipated reason.
 */
export function parseAndValidateStructuredOutput(rawOutput, schema) {
  const candidate = extractJsonCandidate(rawOutput);
  if (!candidate) {
    return { ok: false, data: null, error: "agy did not return any output." };
  }

  let data;
  try {
    data = normalizeReviewPayload(JSON.parse(candidate));
  } catch (error) {
    return { ok: false, data: null, error: `Response is not valid JSON: ${error.message}` };
  }

  const { valid, errors } = validateAgainstSchema(data, schema);
  if (!valid) {
    return { ok: false, data: null, error: `JSON did not match the review schema: ${errors[0]}` };
  }

  return { ok: true, data, error: null };
}

/**
 * Parses agy's `--output-format json` envelope, e.g.:
 *   {"conversation_id":"...","status":"SUCCESS","response":"...",
 *    "structured_output":{...},"json_schema":{...},"usage":{...}}
 * Returns `{ ok, envelope, error }`. `envelope` is the raw parsed object
 * (not yet the caller's payload) so callers can inspect `status` and
 * `conversation_id` even on failure.
 */
export function parseAgyEnvelope(rawOutput) {
  const candidate = extractJsonCandidate(rawOutput);
  if (!candidate) {
    return { ok: false, envelope: null, error: "agy did not return any output." };
  }
  let envelope;
  try {
    envelope = JSON.parse(candidate);
  } catch (error) {
    return { ok: false, envelope: null, error: `agy's output envelope is not valid JSON: ${error.message}` };
  }
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    return { ok: false, envelope: null, error: "agy's output envelope was not a JSON object." };
  }
  return { ok: true, envelope, error: null };
}

/**
 * Runs `agy --print <prompt> --output-format json --json-schema <path>` and
 * returns the model's schema-conformant answer.
 *
 * `agy` enforces the schema itself (verified against a real 1.1.11 install —
 * see the file-level comment above), handing back a single JSON envelope on
 * stdout with a `structured_output` field already matching it. This still
 * runs one local validation pass against `options.schema` as defense in
 * depth, but does not need Codex-companion's retry-on-malformed-JSON dance;
 * a genuine mismatch here means something is actually wrong (agy reported a
 * non-SUCCESS status, or its enforcement produced something the schema
 * still rejects), not that the model needs another attempt at formatting.
 *
 * `options.schemaPath` is required — it's the file path passed to
 * `--json-schema`; `options.schema` is the same schema already parsed into
 * an object, used only for the local double-check.
 */
export async function runAgyStructured(cwd, options = {}) {
  if (!options.schemaPath) {
    throw new Error("runAgyStructured requires options.schemaPath (a file path passed to agy's --json-schema flag).");
  }

  const result = await runAgyPrompt(cwd, {
    ...options,
    outputFormat: "json",
    jsonSchemaPath: options.schemaPath
  });

  const parsedEnvelope = parseAgyEnvelope(result.stdout);
  if (!parsedEnvelope.ok) {
    const stderrHint = result.stderr ? ` stderr: ${result.stderr.split(/\r?\n/)[0]}` : "";
    return {
      status: 1,
      stdout: result.stdout,
      stderr: result.stderr,
      parsed: null,
      conversationId: null,
      parseError: `${parsedEnvelope.error}${stderrHint}`,
      retried: false
    };
  }

  const { envelope } = parsedEnvelope;
  const conversationId = envelope.conversation_id ?? null;

  if (envelope.status !== "SUCCESS") {
    // Some runs skip the envelope entirely and put the review payload at the
    // top level of stdout, where its own "status"/"verdict" field collides
    // with the envelope's SUCCESS status. If the top-level object itself
    // validates as a review, accept it instead of failing on the envelope.
    const bare = normalizeReviewPayload(envelope);
    if (validateAgainstSchema(bare, options.schema).valid) {
      return {
        status: 0,
        stdout: result.stdout,
        stderr: result.stderr,
        parsed: bare,
        conversationId,
        parseError: null,
        retried: false
      };
    }
    return {
      status: 1,
      stdout: result.stdout,
      stderr: result.stderr,
      parsed: null,
      conversationId,
      parseError: `agy reported status "${envelope.status ?? "unknown"}" instead of SUCCESS.`,
      retried: false
    };
  }

  if (envelope.structured_output === undefined || envelope.structured_output === null) {
    return {
      status: 1,
      stdout: result.stdout,
      stderr: result.stderr,
      parsed: null,
      conversationId,
      parseError: "agy reported SUCCESS but returned no structured_output.",
      retried: false
    };
  }

  const structuredOutput = normalizeReviewPayload(envelope.structured_output);
  const { valid, errors } = validateAgainstSchema(structuredOutput, options.schema);
  if (!valid) {
    return {
      status: 1,
      stdout: result.stdout,
      stderr: result.stderr,
      parsed: null,
      conversationId,
      parseError: `agy's structured_output did not match the schema on local re-validation: ${errors[0]}`,
      retried: false
    };
  }

  return {
    status: 0,
    stdout: result.stdout,
    stderr: result.stderr,
    parsed: structuredOutput,
    conversationId,
    parseError: null,
    retried: false
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
