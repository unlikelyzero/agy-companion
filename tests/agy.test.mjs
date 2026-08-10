import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  AgyAuthRequiredError,
  AgyTimeoutError,
  AgyUnsupportedFeatureError,
  diffGitStatusSnapshots,
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
