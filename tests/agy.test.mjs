import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  AgyAuthRequiredError,
  AgyTimeoutError,
  diffGitStatusSnapshots,
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
  await assert.rejects(
    runAgyPrompt("/repo", { prompt: "hi", spawnImpl, timeoutMs: 5 }),
    (error) => error instanceof AgyTimeoutError
  );
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

test("runAgyStructured: succeeds on the first attempt without retrying", async () => {
  let calls = 0;
  const spawnImpl = () => {
    calls += 1;
    const child = createFakeChild();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from('{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}'));
      child.emit("close", 0, null);
    });
    return child;
  };
  const result = await runAgyStructured("/repo", { prompt: "review this", schema: SCHEMA, spawnImpl });
  assert.equal(result.retried, false);
  assert.equal(result.parsed.verdict, "approve");
  assert.equal(calls, 1);
});

test("runAgyStructured: retries once with --continue on malformed JSON, then succeeds", async () => {
  let calls = 0;
  let secondCallArgs = null;
  const spawnImpl = (command, args) => {
    calls += 1;
    if (calls === 1) {
      const child = createFakeChild();
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("not json"));
        child.emit("close", 0, null);
      });
      return child;
    }
    secondCallArgs = args;
    const child = createFakeChild();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from('{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}'));
      child.emit("close", 0, null);
    });
    return child;
  };
  const result = await runAgyStructured("/repo", { prompt: "review this", schema: SCHEMA, spawnImpl });
  assert.equal(calls, 2);
  assert.equal(result.retried, true);
  assert.equal(result.parsed.verdict, "approve");
  assert.ok(secondCallArgs.includes("--continue"));
});

test("runAgyStructured: gives up after one retry and surfaces the parse error", async () => {
  const spawnImpl = () => {
    const child = createFakeChild();
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from("still not json"));
      child.emit("close", 0, null);
    });
    return child;
  };
  const result = await runAgyStructured("/repo", { prompt: "review this", schema: SCHEMA, spawnImpl });
  assert.equal(result.status, 1);
  assert.equal(result.parsed, null);
  assert.match(result.parseError, /not valid JSON/);
});

test("diffGitStatusSnapshots: reports files that appear or disappear between snapshots", () => {
  const before = new Set([" M src/a.js"]);
  const after = new Set([" M src/a.js", "?? src/b.js"]);
  assert.deepEqual(diffGitStatusSnapshots(before, after), ["src/b.js"]);
});

test("diffGitStatusSnapshots: returns an empty list when either snapshot is missing", () => {
  assert.deepEqual(diffGitStatusSnapshots(null, new Set(["?? a"])), []);
});
