import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  AgyAuthRequiredError,
  normalizeReviewPayload,
  AgyTimeoutError,
  AgyUnsupportedFeatureError,
  describeHeadlessToolDenial,
  detectHeadlessToolDenial,
  diffGitStatusSnapshots,
  findUnknownEntryId,
  getAgyAuthStatus,
  listAgyAgents,
  listAgyModels,
  parseAgyEnvelope,
  parseAndValidateStructuredOutput,
  readOutputSchema,
  runAgyPrompt,
  runAgyStructured
} from "../scripts/lib/agy.mjs";

const SCHEMA_PATH = new URL("../schemas/review-output.schema.json", import.meta.url);
const SCHEMA = readOutputSchema(SCHEMA_PATH);

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

function fakeSpawnThatSucceeds(stdoutText, { exitCode = 0 } = {}) {
  return (command, args, options) => {
    const child = createFakeChild();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(stdoutText));
      child.emit("close", exitCode, null);
    });
    return child;
  };
}

// Verbatim stderr from a real agy 1.1.12 headless review run.
const REAL_SOFT_DENY_STDERR =
  'jetski: no output produced — a tool required the "command" permission that headless mode cannot ' +
  "prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json " +
  "(e.g. command(<target>)). Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.";

test("runAgyPrompt: skipPermissions emits the flag without implying a write run", async () => {
  let capturedArgs = null;
  const spawnImpl = (command, args) => {
    capturedArgs = args;
    const child = createFakeChild();
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  };
  await runAgyPrompt("/repo", { prompt: "review", skipPermissions: true, spawnImpl });
  assert.deepEqual(capturedArgs, ["--print", "review", "--dangerously-skip-permissions"]);
});

test("runAgyPrompt: write and skipPermissions together emit the flag only once", async () => {
  let capturedArgs = null;
  const spawnImpl = (command, args) => {
    capturedArgs = args;
    const child = createFakeChild();
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  };
  await runAgyPrompt("/repo", { prompt: "go", write: true, skipPermissions: true, spawnImpl });
  assert.equal(capturedArgs.filter((arg) => arg === "--dangerously-skip-permissions").length, 1);
});

test("detectHeadlessToolDenial: recognizes a real soft-deny and names the permission", () => {
  const denial = detectHeadlessToolDenial(REAL_SOFT_DENY_STDERR);
  assert.equal(denial?.permission, "command");
  assert.match(describeHeadlessToolDenial(denial), /soft-denied/);
});

test("detectHeadlessToolDenial: recognizes the read_file and unsandboxed variants", () => {
  for (const permission of ["read_file", "unsandboxed"]) {
    const stderr = `jetski: no output produced — a tool required the "${permission}" permission that headless mode cannot prompt for, so it was auto-denied.`;
    assert.equal(detectHeadlessToolDenial(stderr)?.permission, permission);
  }
});

test("detectHeadlessToolDenial: ignores unrelated stderr", () => {
  assert.equal(detectHeadlessToolDenial(""), null);
  assert.equal(detectHeadlessToolDenial("some unrelated warning"), null);
  assert.equal(detectHeadlessToolDenial(undefined), null);
});

test("runAgyStructured: surfaces agy's own error text instead of a bare status mismatch", async () => {
  // Verbatim envelope from a real quota-exhausted agy 1.1.12 run.
  const envelope = JSON.stringify({
    conversation_id: "",
    status: "ERROR",
    response: "",
    error: "Eligibility check failed: RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota)."
  });
  const spawnImpl = () => {
    const child = createFakeChild();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(envelope));
      child.emit("close", 0, null);
    });
    return child;
  };

  const result = await runAgyStructured("/repo", {
    prompt: "review this",
    schema: SCHEMA,
    schemaPath: SCHEMA_PATH,
    spawnImpl
  });

  assert.equal(result.parsed, null);
  assert.match(result.parseError, /RESOURCE_EXHAUSTED/);
  assert.doesNotMatch(result.parseError, /instead of SUCCESS/);
});

test("runAgyStructured: falls back to the status message when agy gives no error text", async () => {
  const envelope = JSON.stringify({ conversation_id: "x", status: "ERROR", response: "" });
  const spawnImpl = () => {
    const child = createFakeChild();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(envelope));
      child.emit("close", 0, null);
    });
    return child;
  };

  const result = await runAgyStructured("/repo", {
    prompt: "review this",
    schema: SCHEMA,
    schemaPath: SCHEMA_PATH,
    spawnImpl
  });

  assert.match(result.parseError, /instead of SUCCESS/);
});

test("runAgyStructured: reports a soft-denied tool call instead of a bare parse failure", async () => {
  // agy's real shape for this case: exit 0, SUCCESS envelope, empty response,
  // no structured_output — indistinguishable from "bad output" without stderr.
  const envelope = JSON.stringify({ conversation_id: "abc123", status: "SUCCESS", response: "" });
  const spawnImpl = () => {
    const child = createFakeChild();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(envelope));
      child.stderr.emit("data", Buffer.from(REAL_SOFT_DENY_STDERR));
      child.emit("close", 0, null);
    });
    return child;
  };

  const result = await runAgyStructured("/repo", {
    prompt: "review this",
    schema: SCHEMA,
    schemaPath: SCHEMA_PATH,
    spawnImpl
  });

  assert.equal(result.parsed, null);
  assert.equal(result.toolDenial?.permission, "command");
  assert.match(result.parseError, /soft-denied/);
  assert.doesNotMatch(result.parseError, /no structured_output/);
});

test("runAgyPrompt: resolves with captured stdout/stderr on a clean exit", async () => {
  const spawnImpl = fakeSpawnThatSucceeds("all done\n");
  const result = await runAgyPrompt("/repo", { prompt: "do the thing", spawnImpl });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "all done\n");
});

test("runAgyPrompt: builds --print, --continue, and --dangerously-skip-permissions from options", async () => {
  let capturedArgs = null;
  const spawnImpl = (command, args) => {
    capturedArgs = args;
    const child = createFakeChild();
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  };
  await runAgyPrompt("/repo", { prompt: "hello", continueLatest: true, write: true, spawnImpl });
  assert.deepEqual(capturedArgs, ["--print", "hello", "--continue", "--dangerously-skip-permissions"]);
});

test("runAgyPrompt: builds --conversation, --model, --effort, --output-format, and --json-schema from options", async () => {
  let capturedArgs = null;
  const spawnImpl = (command, args) => {
    capturedArgs = args;
    const child = createFakeChild();
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  };
  await runAgyPrompt("/repo", {
    prompt: "hello",
    conversationId: "abc-123",
    model: "gemini-3-pro",
    effort: "high",
    outputFormat: "json",
    jsonSchemaPath: "/tmp/schema.json",
    spawnImpl
  });
  assert.deepEqual(capturedArgs, [
    "--print",
    "hello",
    "--conversation",
    "abc-123",
    "--model",
    "gemini-3-pro",
    "--effort",
    "high",
    "--output-format",
    "json",
    "--json-schema",
    "/tmp/schema.json"
  ]);
});

test("runAgyPrompt: rejects with AgyUnsupportedFeatureError when --json-schema is rejected by an old agy", async () => {
  const spawnImpl = () => {
    const child = createFakeChild();
    queueMicrotask(() => {
      child.stderr.emit("data", Buffer.from("flag provided but not defined: -json-schema\n"));
      child.emit("close", 2, null);
    });
    return child;
  };
  await assert.rejects(
    runAgyPrompt("/repo", { prompt: "hi", jsonSchemaPath: "/tmp/schema.json", spawnImpl }),
    (error) => {
      assert.ok(error instanceof AgyUnsupportedFeatureError);
      assert.equal(error.flag, "--json-schema");
      return true;
    }
  );
});

test("AgyUnsupportedFeatureError: message reflects the current .github/agy-tested-version, not a hardcoded literal", () => {
  const testedVersion = fs
    .readFileSync(new URL("../.github/agy-tested-version", import.meta.url), "utf8")
    .trim();
  const error = new AgyUnsupportedFeatureError("--json-schema", "");
  assert.match(error.message, new RegExp(`tested against ${testedVersion.replace(/\./g, "\\.")}`));
});

test("runAgyPrompt: rejects with AgyAuthRequiredError and captures the login URL", async () => {
  const spawnImpl = () => {
    const child = createFakeChild();
    queueMicrotask(() => {
      child.stdout.emit(
        "data",
        Buffer.from("Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?x=1\n")
      );
    });
    return child;
  };
  await assert.rejects(
    runAgyPrompt("/repo", { prompt: "hi", spawnImpl }),
    (error) => {
      assert.ok(error instanceof AgyAuthRequiredError);
      assert.equal(error.authUrl, "https://accounts.google.com/o/oauth2/auth?x=1");
      return true;
    }
  );
});

test("runAgyPrompt: surfaces a clear message when the agy binary is missing", async () => {
  const spawnImpl = () => {
    const child = createFakeChild();
    queueMicrotask(() => {
      const error = new Error("spawn agy ENOENT");
      error.code = "ENOENT";
      child.emit("error", error);
    });
    return child;
  };
  await assert.rejects(runAgyPrompt("/repo", { prompt: "hi", spawnImpl }), /not installed or is not on PATH/);
});

test("runAgyPrompt: rejects with AgyTimeoutError past the configured timeout", async () => {
  const spawnImpl = () => createFakeChild(); // never closes
  // runAgyPrompt unrefs its timeout timer (a real child process keeps the
  // event loop alive in production, the fake EventEmitter here does not), so
  // hold a ref'd timer open or the loop drains before the timeout can fire.
  const keepAlive = setTimeout(() => {}, 10_000);
  try {
    await assert.rejects(
      runAgyPrompt("/repo", { prompt: "hi", spawnImpl, timeoutMs: 5 }),
      (error) => error instanceof AgyTimeoutError
    );
  } finally {
    clearTimeout(keepAlive);
  }
});

test("runAgyPrompt: tails raw stdout/stderr chunks to the given file", async () => {
  const tailFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-tail-")), "job.log");
  const spawnImpl = () => {
    const child = createFakeChild();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from("partial "));
      child.stdout.emit("data", Buffer.from("output"));
      child.emit("close", 0, null);
    });
    return child;
  };
  await runAgyPrompt("/repo", { prompt: "hi", spawnImpl, tailFile });
  assert.equal(fs.readFileSync(tailFile, "utf8"), "partial output");
});

test("parseAndValidateStructuredOutput: parses plain JSON", () => {
  const result = parseAndValidateStructuredOutput('{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}', SCHEMA);
  assert.equal(result.ok, true);
  assert.equal(result.data.verdict, "approve");
});

test("parseAndValidateStructuredOutput: extracts JSON from a fenced code block", () => {
  const raw = "Here is the result:\n```json\n{\"verdict\":\"approve\",\"summary\":\"ok\",\"findings\":[],\"next_steps\":[]}\n```\n";
  const result = parseAndValidateStructuredOutput(raw, SCHEMA);
  assert.equal(result.ok, true);
});

test("parseAndValidateStructuredOutput: reports a parse error for non-JSON", () => {
  const result = parseAndValidateStructuredOutput("not json at all", SCHEMA);
  assert.equal(result.ok, false);
  assert.match(result.error, /not valid JSON/);
});

test("parseAndValidateStructuredOutput: reports a schema validation error for malformed shape", () => {
  const result = parseAndValidateStructuredOutput('{"verdict":"approve"}', SCHEMA);
  assert.equal(result.ok, false);
  assert.match(result.error, /did not match the review schema/);
});

// The near-miss payload observed in a real agy 1.1.11 (Gemini) run: a
// top-level "status" instead of "verdict", no "next_steps", and a finding
// with no "severity".
function observedNearMissPayload() {
  return {
    status: "needs-attention",
    summary: "Risky change.",
    findings: [
      {
        title: "Unhandled failure path",
        body: "The retry loop can drop work.",
        file: "src/queue.js",
        line_start: 10,
        line_end: 20,
        confidence: 0.8,
        recommendation: "Persist the item before acking."
      }
    ]
  };
}

test("normalizeReviewPayload: repairs the observed near-miss (status->verdict, default next_steps and severity)", () => {
  const normalized = normalizeReviewPayload(observedNearMissPayload());
  assert.equal(normalized.verdict, "needs-attention");
  assert.equal(normalized.status, undefined);
  assert.deepEqual(normalized.next_steps, []);
  assert.equal(normalized.findings[0].severity, "medium");
});

test("normalizeReviewPayload: leaves a non-verdict status and an existing verdict alone", () => {
  const untouched = normalizeReviewPayload({ status: "SUCCESS", verdict: "approve", summary: "ok", findings: [], next_steps: ["x"] });
  assert.equal(untouched.status, "SUCCESS");
  assert.equal(untouched.verdict, "approve");
  assert.deepEqual(untouched.next_steps, ["x"]);
});

test("parseAndValidateStructuredOutput: accepts the observed near-miss payload after normalization", () => {
  const result = parseAndValidateStructuredOutput(JSON.stringify(observedNearMissPayload()), SCHEMA);
  assert.equal(result.ok, true);
  assert.equal(result.data.verdict, "needs-attention");
  assert.deepEqual(result.data.next_steps, []);
  assert.equal(result.data.findings[0].severity, "medium");
});

function fakeEnvelope(overrides = {}) {
  return JSON.stringify({
    conversation_id: "conv-1",
    status: "SUCCESS",
    response: "ignored, structured_output is what matters",
    structured_output: { verdict: "approve", summary: "ok", findings: [], next_steps: [] },
    json_schema: SCHEMA,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...overrides
  });
}

test("runAgyStructured: throws synchronously if schemaPath is missing", async () => {
  await assert.rejects(
    runAgyStructured("/repo", { prompt: "review this", schema: SCHEMA }),
    /requires options\.schemaPath/
  );
});

test("runAgyStructured: requests --output-format json and --json-schema, and returns the parsed envelope's structured_output on a single call", async () => {
  let calls = 0;
  let capturedArgs = null;
  const spawnImpl = (command, args) => {
    calls += 1;
    capturedArgs = args;
    const child = createFakeChild();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(fakeEnvelope()));
      child.emit("close", 0, null);
    });
    return child;
  };
  const result = await runAgyStructured("/repo", {
    prompt: "review this",
    schema: SCHEMA,
    schemaPath: "/tmp/review-schema.json",
    spawnImpl
  });
  assert.equal(calls, 1);
  assert.equal(result.retried, false);
  assert.equal(result.status, 0);
  assert.equal(result.parsed.verdict, "approve");
  assert.equal(result.conversationId, "conv-1");
  assert.ok(capturedArgs.includes("--output-format"));
  assert.ok(capturedArgs.includes("json"));
  assert.ok(capturedArgs.includes("--json-schema"));
  assert.ok(capturedArgs.includes("/tmp/review-schema.json"));
});

test("runAgyStructured: surfaces a clear error when agy's envelope reports a non-SUCCESS status", async () => {
  const spawnImpl = () => {
    const child = createFakeChild();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(fakeEnvelope({ status: "FAILURE", structured_output: null })));
      child.emit("close", 0, null);
    });
    return child;
  };
  const result = await runAgyStructured("/repo", {
    prompt: "review this",
    schema: SCHEMA,
    schemaPath: "/tmp/review-schema.json",
    spawnImpl
  });
  assert.equal(result.status, 1);
  assert.equal(result.parsed, null);
  assert.equal(result.conversationId, "conv-1");
  assert.match(result.parseError, /status "FAILURE"/);
});

test("runAgyStructured: fails local re-validation if structured_output doesn't actually match the schema", async () => {
  const spawnImpl = () => {
    const child = createFakeChild();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(fakeEnvelope({ structured_output: { verdict: "approve" } })));
      child.emit("close", 0, null);
    });
    return child;
  };
  const result = await runAgyStructured("/repo", {
    prompt: "review this",
    schema: SCHEMA,
    schemaPath: "/tmp/review-schema.json",
    spawnImpl
  });
  assert.equal(result.status, 1);
  assert.equal(result.parsed, null);
  assert.match(result.parseError, /did not match the schema on local re-validation/);
});

test("runAgyStructured: surfaces a parse error if agy's stdout isn't a JSON envelope at all", async () => {
  const spawnImpl = () => {
    const child = createFakeChild();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from("not json at all"));
      child.emit("close", 0, null);
    });
    return child;
  };
  const result = await runAgyStructured("/repo", {
    prompt: "review this",
    schema: SCHEMA,
    schemaPath: "/tmp/review-schema.json",
    spawnImpl
  });
  assert.equal(result.status, 1);
  assert.equal(result.parsed, null);
  assert.equal(result.conversationId, null);
});

test("runAgyStructured: normalizes a near-miss structured_output inside a SUCCESS envelope", async () => {
  const spawnImpl = () => {
    const child = createFakeChild();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(fakeEnvelope({ structured_output: observedNearMissPayload() })));
      child.emit("close", 0, null);
    });
    return child;
  };
  const result = await runAgyStructured("/repo", {
    prompt: "review this",
    schema: SCHEMA,
    schemaPath: "/tmp/review-schema.json",
    spawnImpl
  });
  assert.equal(result.status, 0);
  assert.equal(result.parsed.verdict, "needs-attention");
  assert.deepEqual(result.parsed.next_steps, []);
  assert.equal(result.parsed.findings[0].severity, "medium");
});

test("runAgyStructured: accepts a bare review payload emitted without the envelope wrapper", async () => {
  const spawnImpl = () => {
    const child = createFakeChild();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(JSON.stringify(observedNearMissPayload())));
      child.emit("close", 0, null);
    });
    return child;
  };
  const result = await runAgyStructured("/repo", {
    prompt: "review this",
    schema: SCHEMA,
    schemaPath: "/tmp/review-schema.json",
    spawnImpl
  });
  assert.equal(result.status, 0);
  assert.equal(result.parsed.verdict, "needs-attention");
});

test("runAgyStructured: includes stderr in the parse error when agy produced no stdout", async () => {
  const spawnImpl = () => {
    const child = createFakeChild();
    queueMicrotask(() => {
      child.stderr.emit("data", Buffer.from("model backend unavailable\n"));
      child.emit("close", 1, null);
    });
    return child;
  };
  const result = await runAgyStructured("/repo", {
    prompt: "review this",
    schema: SCHEMA,
    schemaPath: "/tmp/review-schema.json",
    spawnImpl
  });
  assert.equal(result.status, 1);
  assert.match(result.parseError, /did not return any output/);
  assert.match(result.parseError, /model backend unavailable/);
});

test("parseAgyEnvelope: parses a real agy --output-format json envelope shape", () => {
  const result = parseAgyEnvelope(fakeEnvelope());
  assert.equal(result.ok, true);
  assert.equal(result.envelope.status, "SUCCESS");
  assert.equal(result.envelope.conversation_id, "conv-1");
  assert.equal(result.envelope.structured_output.verdict, "approve");
});

test("diffGitStatusSnapshots: reports files that appear or disappear between snapshots", () => {
  const before = new Set([" M src/a.js"]);
  const after = new Set([" M src/a.js", "?? src/b.js"]);
  assert.deepEqual(diffGitStatusSnapshots(before, after), ["src/b.js"]);
});

test("diffGitStatusSnapshots: returns an empty list when either snapshot is missing", () => {
  assert.deepEqual(diffGitStatusSnapshots(null, new Set(["?? a"])), []);
});

// --- getAgyAuthStatus: free /quota-based login probe (verified live 2026-08 — see .github/agy-tested-version) ---

const FAKE_AVAILABILITY = { available: true, detail: "fake-agy" };

test("getAgyAuthStatus: reports available:false without probing when the binary itself is missing", async () => {
  const status = await getAgyAuthStatus("/repo", { availability: { available: false, detail: "not found" } });
  assert.equal(status.available, false);
  assert.equal(status.loggedIn, null);
  assert.equal(status.source, "availability");
});

test("getAgyAuthStatus: reports loggedIn:true on a SUCCESS /quota envelope, spending no other flags than --print and --output-format", async () => {
  let capturedArgs = null;
  const spawnImpl = (command, args) => {
    capturedArgs = args;
    const child = createFakeChild();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(fakeEnvelope({ structured_output: undefined, command: { name: "usage", data: {} } })));
      child.emit("close", 0, null);
    });
    return child;
  };
  const status = await getAgyAuthStatus("/repo", { availability: FAKE_AVAILABILITY, spawnImpl });
  assert.equal(status.available, true);
  assert.equal(status.loggedIn, true);
  assert.deepEqual(capturedArgs, ["--print", "/quota", "--output-format", "json"]);
});

test("getAgyAuthStatus: reports loggedIn:false and captures the OAuth URL when agy demands login", async () => {
  const spawnImpl = () => {
    const child = createFakeChild();
    queueMicrotask(() => {
      child.stdout.emit(
        "data",
        Buffer.from("Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?x=1\n")
      );
    });
    return child;
  };
  const status = await getAgyAuthStatus("/repo", { availability: FAKE_AVAILABILITY, spawnImpl });
  assert.equal(status.loggedIn, false);
  assert.equal(status.authUrl, "https://accounts.google.com/o/oauth2/auth?x=1");
});

test("getAgyAuthStatus: falls back to loggedIn:null when the quota check fails for an unrelated reason", async () => {
  const spawnImpl = () => {
    const child = createFakeChild();
    queueMicrotask(() => {
      child.stderr.emit("data", Buffer.from("boom\n"));
      child.emit("close", 1, null);
    });
    return child;
  };
  const status = await getAgyAuthStatus("/repo", { availability: FAKE_AVAILABILITY, spawnImpl });
  assert.equal(status.loggedIn, null);
  assert.equal(status.available, true);
});

// --- listAgyModels / listAgyAgents: real `agy --output-format json models|agent` shape ---

function fakeListingSpawn(stdoutText, { stderrText = "", exitCode = 0 } = {}) {
  return (command, args) => {
    const child = createFakeChild();
    queueMicrotask(() => {
      if (stderrText) {
        child.stderr.emit("data", Buffer.from(stderrText));
      }
      child.stdout.emit("data", Buffer.from(stdoutText));
      child.emit("close", exitCode, null);
    });
    return child;
  };
}

test("listAgyModels: parses the real agy --output-format json models envelope, ignoring stderr progress noise", async () => {
  const envelope = JSON.stringify({
    conversation_id: "",
    status: "SUCCESS",
    response: "",
    command: { name: "models", data: { models: [{ id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" }] } }
  });
  let capturedArgs = null;
  const spawnImpl = (command, args) => {
    capturedArgs = args;
    return fakeListingSpawn(envelope, { stderrText: "Fetching available models...\n" })(command, args);
  };
  const models = await listAgyModels("/repo", { spawnImpl });
  assert.deepEqual(capturedArgs, ["--output-format", "json", "models"]);
  assert.deepEqual(models, [{ id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" }]);
});

test("listAgyModels: throws a clear error when agy's output can't be parsed", async () => {
  const spawnImpl = fakeListingSpawn("not json at all");
  await assert.rejects(listAgyModels("/repo", { spawnImpl }), /Could not parse agy's model list/);
});

test("listAgyAgents: parses the real agy --output-format json agent envelope", async () => {
  const envelope = JSON.stringify({
    conversation_id: "",
    status: "SUCCESS",
    response: "",
    command: { name: "agents", data: { agents: [{ id: "reviewer", label: "Reviewer" }] } }
  });
  let capturedArgs = null;
  const spawnImpl = (command, args) => {
    capturedArgs = args;
    return fakeListingSpawn(envelope)(command, args);
  };
  const agents = await listAgyAgents("/repo", { spawnImpl });
  assert.deepEqual(capturedArgs, ["--output-format", "json", "agent"]);
  assert.deepEqual(agents, [{ id: "reviewer", label: "Reviewer" }]);
});

test("listAgyAgents: returns an empty list when agy reports no custom agents", async () => {
  const envelope = JSON.stringify({
    conversation_id: "",
    status: "SUCCESS",
    response: "",
    command: { name: "agents", data: { agents: [] } }
  });
  const spawnImpl = fakeListingSpawn(envelope);
  const agents = await listAgyAgents("/repo", { spawnImpl });
  assert.deepEqual(agents, []);
});

// --- findUnknownEntryId ---

test("findUnknownEntryId: returns null when the id is unset (nothing to validate)", () => {
  assert.equal(findUnknownEntryId([{ id: "a" }], undefined), null);
});

test("findUnknownEntryId: returns null when the entry list is empty (can't validate, don't block)", () => {
  assert.equal(findUnknownEntryId([], "gemini-3-pro"), null);
});

test("findUnknownEntryId: returns null when the id matches a known entry", () => {
  assert.equal(findUnknownEntryId([{ id: "gemini-3.1-pro-high" }, { id: "claude-sonnet-4-6" }], "claude-sonnet-4-6"), null);
});

test("findUnknownEntryId: returns the known ids when the id doesn't match any entry", () => {
  const knownIds = findUnknownEntryId([{ id: "gemini-3.1-pro-high" }, { id: "claude-sonnet-4-6" }], "gemini-3-pro");
  assert.deepEqual(knownIds, ["gemini-3.1-pro-high", "claude-sonnet-4-6"]);
});

// --- runAgyPrompt: --agent and --mode forwarding ---

test("runAgyPrompt: builds --agent and --mode from options", async () => {
  let capturedArgs = null;
  const spawnImpl = (command, args) => {
    capturedArgs = args;
    const child = createFakeChild();
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  };
  await runAgyPrompt("/repo", { prompt: "hello", agent: "reviewer", mode: "accept-edits", spawnImpl });
  assert.deepEqual(capturedArgs, ["--print", "hello", "--agent", "reviewer", "--mode", "accept-edits"]);
});
