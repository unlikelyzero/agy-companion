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
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readJsonFile } from "./fs.mjs";
import { binaryAvailable, runCommand } from "./process.mjs";
import { validateAgainstSchema } from "./schema-validate.mjs";

const AUTH_REQUIRED_PATTERN = /authentication required/i;
const URL_PATTERN = /(https?:\/\/\S+)/;
const DEFAULT_RUN_TIMEOUT_MS = 15 * 60 * 1000;
const UPSTREAM_HEADLESS_AUTH_ISSUE = "https://github.com/google-antigravity/antigravity-cli/issues/78";
const AUTH_CHECK_TIMEOUT_MS = 20 * 1000;
const TOOL_PROBE_TIMEOUT_MS = 90 * 1000;
const SELECTABLE_LIST_TIMEOUT_MS = 20 * 1000;
const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TESTED_VERSION_PATH = path.join(PACKAGE_ROOT, ".github", "agy-tested-version");

/**
 * `.github/agy-tested-version` is the single source of truth for "last agy
 * version a human actually verified this plugin against" (see
 * `docs/TESTING.md` and the nightly `agy-release-probe.yml` workflow that
 * keeps it current). Reading it here, instead of hardcoding the version
 * number in this error message, is what keeps the message accurate across
 * version bumps — a hardcoded literal here previously went stale the moment
 * `.github/agy-tested-version` was updated without a matching source edit.
 */
export function readTestedAgyVersion() {
  try {
    return fs.readFileSync(TESTED_VERSION_PATH, "utf8").trim() || null;
  } catch {
    return null;
  }
}

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
    const testedVersion = readTestedAgyVersion();
    const testedClause = testedVersion
      ? `tested against ${testedVersion}`
      : "see .github/agy-tested-version for the last version tested";
    super(
      `This install of agy does not recognize \`${flag}\`. agy-companion requires a recent agy build ` +
        `(${testedClause}). Run \`agy update\`, then retry.`
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
 * The flags this plugin actually depends on (or could use), as they appear
 * in `agy --help`'s usage listing. Detected by plain substring match against
 * the flag name — `agy --help` documents each with a leading `--`, so this
 * doesn't need real flag parsing, just enough to answer "does this install
 * of agy even recognize this flag" the way `AgyUnsupportedFeatureError`
 * already does reactively, but as a proactive `/agy:setup --doctor` check.
 */
const AGY_CAPABILITY_FLAGS = {
  jsonSchema: "--json-schema",
  outputFormat: "--output-format",
  conversation: "--conversation",
  sandbox: "--sandbox",
  agent: "--agent",
  mode: "--mode",
  skipPermissions: "--dangerously-skip-permissions",
  addDir: "--add-dir"
};

/** Runs `agy --help` — a plain usage listing, no agent turn and no quota spent. */
export function getAgyHelpText(cwd, options = {}) {
  const result = runCommand("agy", ["--help"], { cwd, ...options });
  if (result.error) {
    throw result.error;
  }
  return `${result.stdout}\n${result.stderr}`.trim();
}

/** Pure: which of `AGY_CAPABILITY_FLAGS` appear in a given `agy --help` output. */
export function detectAgyCapabilities(helpText) {
  const text = String(helpText ?? "");
  const capabilities = {};
  for (const [key, flag] of Object.entries(AGY_CAPABILITY_FLAGS)) {
    capabilities[key] = text.includes(flag);
  }
  return capabilities;
}

/**
 * agy 1.0.1 had no `whoami` / `account status` equivalent, and probing auth
 * by actually running a prompt would have consumed the user's quota and
 * could have blocked on an interactive OAuth screen. That's no longer true:
 * current `agy` answers read-only slash commands like `/quota` in print mode
 * without starting an agent turn or spending quota (confirmed live — see
 * `.github/agy-tested-version` for the version checked — `agy -p "/quota"
 * --output-format json` returns a `{"status":"SUCCESS",...}` envelope
 * instantly when signed in). This reuses that command as a free login
 * probe: a `SUCCESS` envelope means
 * `agy` is authenticated, an `AgyAuthRequiredError` means it isn't (and
 * carries the OAuth URL to visit), and any other failure falls back to
 * "unknown" the same way the old binary-only check did.
 */
export async function getAgyAuthStatus(cwd, options = {}) {
  const availability = options.availability ?? getAgyAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: null,
      detail: availability.detail,
      source: "availability"
    };
  }

  try {
    const result = await runAgyPrompt(cwd, {
      prompt: "/quota",
      outputFormat: "json",
      timeoutMs: options.timeoutMs ?? AUTH_CHECK_TIMEOUT_MS,
      spawnImpl: options.spawnImpl,
      env: options.env
    });
    const parsedEnvelope = parseAgyEnvelope(result.stdout);
    if (parsedEnvelope.ok && parsedEnvelope.envelope.status === "SUCCESS") {
      return {
        available: true,
        loggedIn: true,
        detail: 'Signed in (confirmed via the free `agy -p "/quota"` print-mode check, which spends no quota).',
        source: "quota-check",
        authUrl: null
      };
    }
    return {
      available: true,
      loggedIn: null,
      detail: `agy answered the quota check but not with a recognizable result${
        parsedEnvelope.error ? `: ${parsedEnvelope.error}` : "."
      }`,
      source: "quota-check",
      authUrl: null
    };
  } catch (error) {
    if (error instanceof AgyAuthRequiredError) {
      return {
        available: true,
        loggedIn: false,
        detail: error.message,
        source: "quota-check",
        authUrl: error.authUrl
      };
    }
    return {
      available: true,
      loggedIn: null,
      detail: `Could not confirm login state: ${error instanceof Error ? error.message : String(error)} ` +
        `(tracked upstream for any remaining headless-auth gaps: ${UPSTREAM_HEADLESS_AUTH_ISSUE}).`,
      source: "quota-check",
      authUrl: null
    };
  }
}

/**
 * Probes whether headless tool calls actually work, by asking agy to run one
 * trivial shell command in `--print` mode and checking whether the attempt is
 * soft-denied.
 *
 * This exists because `getAgyAuthStatus` structurally cannot detect the
 * problem: it probes with `/quota`, which agy answers as a print-mode slash
 * command "without starting an agent turn" (its changelog's words). No agent
 * turn means no tool call, which means no permission check — so a readiness
 * report built only on that check happily said `ready: true` on an install
 * where every `/agy:review` failed. This probe does start a turn, and is the
 * only check here that exercises the path reviews actually depend on.
 *
 * It deliberately mirrors how commands actually run, passing
 * `--dangerously-skip-permissions` exactly as the review and rescue paths do.
 * Probing without the flag would answer a question nothing asks any more —
 * bare headless tool calls have been soft-denied since agy 1.1.3, so that
 * check would report a permanent failure on a perfectly working install.
 *
 * Costs one very short agent turn's quota, unlike the other setup checks.
 */
export async function probeHeadlessToolPermission(cwd, options = {}) {
  const availability = options.availability ?? getAgyAvailability(cwd);
  if (!availability.available) {
    return { probed: false, ok: null, permission: null, detail: "agy is not installed." };
  }

  try {
    const result = await runAgyPrompt(cwd, {
      prompt:
        "Use your terminal tool to run exactly `echo agy-permission-probe`, then reply with only the word OK.",
      outputFormat: "json",
      skipPermissions: true,
      timeoutMs: options.timeoutMs ?? TOOL_PROBE_TIMEOUT_MS,
      spawnImpl: options.spawnImpl,
      env: options.env
    });

    const denial = detectHeadlessToolDenial(result.stderr);
    if (denial) {
      return {
        probed: true,
        ok: false,
        permission: denial.permission,
        detail:
          `Headless tool calls are blocked: agy soft-denied the "${denial.permission}" permission even with ` +
          "`--dangerously-skip-permissions`, which agy-companion passes on every review and rescue run. " +
          "`/agy:review` and `/agy:adversarial-review` cannot return findings in this state."
      };
    }

    return {
      probed: true,
      ok: true,
      permission: null,
      detail:
        "Headless tool calls succeeded (probe ran one shell command through `agy --print` with " +
        "`--dangerously-skip-permissions`, matching how reviews run)."
    };
  } catch (error) {
    return {
      probed: true,
      ok: null,
      permission: null,
      detail: `Could not complete the headless tool-permission probe: ${
        error instanceof Error ? error.message : String(error)
      }`
    };
  }
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

/**
 * Since agy 1.1.3, a headless (`--print`) run "soft-denies" any tool call
 * that would need an interactive confirmation: the run exits 0, the JSON
 * envelope reports `"status":"SUCCESS"` with an empty `response` and no
 * `structured_output`, and the only explanation is a one-line stderr
 * notice. Read literally, that looks identical to "the model returned
 * nothing useful" — which is how this surfaced before: `/agy:review`
 * reported a bare parse failure and sent people looking for a schema bug
 * that was never there.
 *
 * agy's changelog dates the behaviour precisely ("Fixed headless (`-p`)
 * runs hanging or silently auto-approving tools that require a permission
 * confirmation, so the CLI now soft-denies such tools" — 1.1.3). Before
 * that, headless runs silently auto-approved, which is the behaviour this
 * plugin was originally written against.
 *
 * The denial names the permission it wanted (`command`, `read_file`,
 * `unsandboxed`, ...), which is worth surfacing: it says whether the model
 * tried to shell out, read a file, or escape the sandbox.
 */
const HEADLESS_TOOL_DENIAL_PATTERN =
  /a tool required the "([^"]+)" permission that headless mode cannot prompt for/i;

export function detectHeadlessToolDenial(stderr) {
  const text = String(stderr ?? "");
  const match = text.match(HEADLESS_TOOL_DENIAL_PATTERN);
  if (!match) {
    return null;
  }
  return { permission: match[1], stderr: text.trim() };
}

/**
 * The user-facing explanation for a soft-denial. Deliberately does NOT
 * repeat agy's own "add an allow-rule under permissions.allow" advice as if
 * it were a fix: in print mode that advice is unreliable. `permissions.allow`
 * is reported upstream as ignored entirely by `--print`
 * (google-antigravity/antigravity-cli#548, which also found `toolPermission:
 * always-proceed` had no effect there), and where command rules do apply they
 * match the full command string rather than an executable
 * (google-antigravity/antigravity-cli#627), so no practical allow-list covers
 * the varied commands a review runs.
 */
export function describeHeadlessToolDenial(denial) {
  if (!denial) {
    return null;
  }
  return (
    `agy soft-denied a tool call that needed the "${denial.permission}" permission. ` +
    "Headless `agy --print` runs cannot prompt for confirmation, so agy ended the turn with an " +
    "empty response and exit 0 — this is agy 1.1.3+ behaviour, not a schema or parsing problem. " +
    "agy-companion already passes `--dangerously-skip-permissions` on the review and rescue paths " +
    "precisely to avoid this, so seeing it here means the flag did not take effect — check that " +
    "`agy --version` is recent enough to support it."
  );
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
  if (options.agent) {
    args.push("--agent", options.agent);
  }
  // `write` implies the flag (a rescue run has to be able to edit); `skipPermissions`
  // requests it on its own, for read-only work that still needs tool calls to run at
  // all. Since agy 1.1.3 this flag is the only reliable way to get *any* tool call
  // through a headless run — see `describeHeadlessToolDenial` for why the documented
  // `permissions.allow` alternative isn't one.
  if (options.write || options.skipPermissions) {
    args.push("--dangerously-skip-permissions");
  }
  if (options.mode) {
    args.push("--mode", options.mode);
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

  const toolDenial = detectHeadlessToolDenial(result.stderr);

  const parsedEnvelope = parseAgyEnvelope(result.stdout);
  if (!parsedEnvelope.ok) {
    const stderrHint = result.stderr ? ` stderr: ${result.stderr.split(/\r?\n/)[0]}` : "";
    return {
      status: 1,
      stdout: result.stdout,
      stderr: result.stderr,
      parsed: null,
      conversationId: null,
      toolDenial,
      parseError: toolDenial
        ? describeHeadlessToolDenial(toolDenial)
        : `${parsedEnvelope.error}${stderrHint}`,
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
    // agy puts the real reason in the envelope's `error` field — quota
    // exhaustion ("RESOURCE_EXHAUSTED (code 429)"), backend failures, and so
    // on. Reporting only the status and dumping the raw envelope buries a
    // perfectly clear message under a "parse error" heading that sends people
    // looking for a malformed-output bug instead of, say, topping up quota.
    const envelopeError = typeof envelope.error === "string" ? envelope.error.trim() : "";
    return {
      status: 1,
      stdout: result.stdout,
      stderr: result.stderr,
      parsed: null,
      conversationId,
      parseError: envelopeError
        ? `agy failed to run this request: ${envelopeError}`
        : `agy reported status "${envelope.status ?? "unknown"}" instead of SUCCESS.`,
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
      toolDenial,
      parseError: toolDenial
        ? describeHeadlessToolDenial(toolDenial)
        : "agy reported SUCCESS but returned no structured_output.",
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
 * Runs `agy --print <prompt> --output-format json` for free-form (non-schema)
 * text responses, same envelope `runAgyStructured` uses, minus
 * `--json-schema`. This is what gives a `task`/rescue run a real
 * `conversation_id` to resume by later — `--resume`/`--resume-last` on the
 * plain-text path had no envelope to read one from, so it could only ever
 * fall back to `agy --continue` ("whatever agy's most-recently-used
 * conversation is"), which drifts to the wrong thread the moment anything
 * else (a review, another task) runs an agy process in between.
 *
 * Deliberately more forgiving than `runAgyStructured`: task/rescue prompts
 * are free-form, so a response that doesn't fit the envelope shape it
 * expects is not treated as a hard failure — the raw stdout is returned as
 * `response` and `conversationId` is `null`, same as before this function
 * existed, rather than failing a run that would previously have succeeded.
 */
export async function runAgyText(cwd, options = {}) {
  const result = await runAgyPrompt(cwd, { ...options, outputFormat: "json" });
  const toolDenial = detectHeadlessToolDenial(result.stderr);

  const parsedEnvelope = parseAgyEnvelope(result.stdout);
  if (!parsedEnvelope.ok) {
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      response: result.stdout,
      conversationId: null,
      toolDenial,
      envelopeError: parsedEnvelope.error
    };
  }

  const { envelope } = parsedEnvelope;
  const conversationId = envelope.conversation_id ?? null;
  const response = typeof envelope.response === "string" ? envelope.response : "";

  if (envelope.status !== "SUCCESS") {
    const envelopeError = typeof envelope.error === "string" ? envelope.error.trim() : "";
    return {
      status: result.status === 0 ? 1 : result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      response,
      conversationId,
      toolDenial,
      envelopeError: envelopeError || `agy reported status "${envelope.status ?? "unknown"}" instead of SUCCESS.`
    };
  }

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    response,
    conversationId,
    toolDenial,
    envelopeError: null
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

/**
 * Runs `agy --output-format json <subcommandArgs>` (a plain listing
 * subcommand, not `--print`) and returns raw stdout. Progress noise (e.g.
 * "Fetching available models...") goes to stderr (confirmed 2026-08 against
 * a real agy install — see `.github/agy-tested-version` for the version
 * checked), so stdout is clean JSON on success; `parseAgyEnvelope`'s
 * brace-extraction is kept as defense in depth regardless.
 */
function runAgyListingSubcommand(cwd, subcommandArgs, options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || SELECTABLE_LIST_TIMEOUT_MS);

  return new Promise((resolve, reject) => {
    let stdout = "";
    let settled = false;

    const child = spawnImpl("agy", subcommandArgs, {
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

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", () => {
      // Progress/status noise only; the listing itself is on stdout.
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

    child.on("close", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(stdout);
    });
  });
}

/**
 * Lists agy's real available models (confirmed 2026-08 against a live agy
 * install — see `.github/agy-tested-version` for the version checked —
 * `agy --output-format json models` returns IDs like `gemini-3.1-pro-high`
 * and `claude-sonnet-4-6`, not the hyphenated shorthand a user might guess).
 * Used to validate a `--model` choice before spawning a real run instead of
 * letting agy reject it after the fact.
 */
export async function listAgyModels(cwd, options = {}) {
  const stdout = await runAgyListingSubcommand(cwd, ["--output-format", "json", "models"], options);
  const parsedEnvelope = parseAgyEnvelope(stdout);
  if (!parsedEnvelope.ok) {
    throw new Error(`Could not parse agy's model list: ${parsedEnvelope.error}`);
  }
  const models = parsedEnvelope.envelope.command?.data?.models;
  return Array.isArray(models) ? models : [];
}

/**
 * Lists agy's real available custom agents (`agy --output-format json
 * agent`), each `{id, ...}`. Used the same way as `listAgyModels`, to
 * validate a `--agent` choice up front.
 */
export async function listAgyAgents(cwd, options = {}) {
  const stdout = await runAgyListingSubcommand(cwd, ["--output-format", "json", "agent"], options);
  const parsedEnvelope = parseAgyEnvelope(stdout);
  if (!parsedEnvelope.ok) {
    throw new Error(`Could not parse agy's agent list: ${parsedEnvelope.error}`);
  }
  const agents = parsedEnvelope.envelope.command?.data?.agents;
  return Array.isArray(agents) ? agents : [];
}

/**
 * Returns `null` if `id` is unset, or `entries` is empty/unavailable (can't
 * validate, so don't block), or `id` matches one of `entries`. Otherwise
 * returns the list of known ids, for building a helpful error message.
 */
export function findUnknownEntryId(entries, id) {
  if (!id || !Array.isArray(entries) || entries.length === 0) {
    return null;
  }
  if (entries.some((entry) => entry?.id === id)) {
    return null;
  }
  return entries.map((entry) => entry?.id).filter(Boolean);
}

export { UPSTREAM_HEADLESS_AUTH_ISSUE };
