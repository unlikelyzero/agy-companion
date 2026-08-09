import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

function withTempPluginData(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-companion-test-"));
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = tempDir;
  try {
    return fn(tempDir);
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("state: loadState returns defaults when no state file exists", async () => {
  await withTempPluginData(async () => {
    const { loadState } = await import(`../scripts/lib/state.mjs?t=${Date.now()}-a`);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-companion-repo-"));
    const state = loadState(cwd);
    assert.equal(state.version, 1);
    assert.equal(state.config.stopReviewGate, false);
    assert.deepEqual(state.jobs, []);
  });
});

test("state: setConfig/getConfig round-trip", async () => {
  await withTempPluginData(async () => {
    const { setConfig, getConfig } = await import(`../scripts/lib/state.mjs?t=${Date.now()}-b`);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-companion-repo-"));
    setConfig(cwd, "stopReviewGate", true);
    assert.equal(getConfig(cwd).stopReviewGate, true);
  });
});

test("state: upsertJob inserts new jobs and updates existing ones", async () => {
  await withTempPluginData(async () => {
    const { upsertJob, listJobs } = await import(`../scripts/lib/state.mjs?t=${Date.now()}-c`);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-companion-repo-"));
    upsertJob(cwd, { id: "job-1", status: "running" });
    upsertJob(cwd, { id: "job-1", status: "completed" });
    const jobs = listJobs(cwd);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "completed");
  });
});

test("state: writeJobFile/readJobFile round-trip", async () => {
  await withTempPluginData(async () => {
    const { writeJobFile, readJobFile, resolveJobFile } = await import(`../scripts/lib/state.mjs?t=${Date.now()}-d`);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-companion-repo-"));
    writeJobFile(cwd, "job-2", { id: "job-2", status: "queued" });
    const jobFile = resolveJobFile(cwd, "job-2");
    assert.ok(fs.existsSync(jobFile));
    assert.deepEqual(readJobFile(jobFile), { id: "job-2", status: "queued" });
  });
});

test("state: generateJobId produces a prefixed unique id", async () => {
  const { generateJobId } = await import(`../scripts/lib/state.mjs?t=${Date.now()}-e`);
  const id = generateJobId("task");
  assert.match(id, /^task-[0-9a-z]+-[0-9a-z]+$/);
});
