import assert from "node:assert/strict";
import { test } from "node:test";

import { binaryAvailable, formatCommandFailure, runCommand, terminateProcessTree } from "../scripts/lib/process.mjs";

test("binaryAvailable: reports unavailable for a nonexistent binary", () => {
  const status = binaryAvailable("definitely-not-a-real-binary-xyz");
  assert.equal(status.available, false);
  assert.equal(status.detail, "not found");
});

test("binaryAvailable: reports available for a real binary", () => {
  const status = binaryAvailable("node", ["--version"]);
  assert.equal(status.available, true);
  assert.match(status.detail, /^v\d+\./);
});

test("runCommand: captures stdout, stderr, and exit status", () => {
  const result = runCommand("node", ["-e", "process.stdout.write('hi'); process.exitCode = 3;"]);
  assert.equal(result.stdout, "hi");
  assert.equal(result.status, 3);
});

test("formatCommandFailure: includes command, exit code, and stderr", () => {
  const message = formatCommandFailure({ command: "git", args: ["status"], status: 1, signal: null, stderr: "boom", stdout: "" });
  assert.match(message, /git status/);
  assert.match(message, /exit=1/);
  assert.match(message, /boom/);
});

test("terminateProcessTree: returns attempted:false for a non-finite pid", () => {
  const result = terminateProcessTree(Number.NaN);
  assert.deepEqual(result, { attempted: false, delivered: false, method: null });
});

test("terminateProcessTree: uses the injected kill implementation on posix", () => {
  const calls = [];
  const result = terminateProcessTree(4242, {
    platform: "linux",
    killImpl: (pid, signal) => {
      calls.push([pid, signal]);
    }
  });
  assert.equal(result.delivered, true);
  assert.equal(result.method, "process-group");
  assert.deepEqual(calls, [[-4242, "SIGTERM"]]);
});

test("terminateProcessTree: reports not-delivered when the process group is already gone (ESRCH)", () => {
  const result = terminateProcessTree(99, {
    platform: "linux",
    killImpl: () => {
      const error = new Error("no such process");
      error.code = "ESRCH";
      throw error;
    }
  });
  assert.equal(result.delivered, false);
  assert.equal(result.method, "process-group");
});

test("terminateProcessTree: falls back to a direct kill when the process-group kill fails for another reason", () => {
  let call = 0;
  const result = terminateProcessTree(99, {
    platform: "linux",
    killImpl: (pid) => {
      call += 1;
      if (call === 1) {
        throw new Error("permission denied");
      }
    }
  });
  assert.equal(result.delivered, true);
  assert.equal(result.method, "process");
  assert.equal(call, 2);
});
