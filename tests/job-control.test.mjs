import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

async function withIsolatedWorkspace(fn) {
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "agy-companion-test-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-companion-repo-"));
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  try {
    const suffix = `?t=${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const state = await import(`../scripts/lib/state.mjs${suffix}`);
    const jobControl = await import(`../scripts/lib/job-control.mjs${suffix}`);
    return await fn({ cwd, state, jobControl });
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
    fs.rmSync(pluginData, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test("job-control: buildStatusSnapshot separates running, latest finished, and recent jobs", async () => {
  await withIsolatedWorkspace(async ({ cwd, state, jobControl }) => {
    state.upsertJob(cwd, { id: "task-1", status: "running", jobClass: "task", updatedAt: "2026-01-01T00:00:00.000Z" });
    state.upsertJob(cwd, { id: "review-1", status: "completed", jobClass: "review", updatedAt: "2026-01-02T00:00:00.000Z" });
    state.upsertJob(cwd, { id: "review-0", status: "failed", jobClass: "review", updatedAt: "2026-01-01T12:00:00.000Z" });

    const snapshot = jobControl.buildStatusSnapshot(cwd);
    assert.equal(snapshot.running.length, 1);
    assert.equal(snapshot.running[0].id, "task-1");
    assert.equal(snapshot.latestFinished.id, "review-1");
    assert.equal(snapshot.recent.length, 1);
    assert.equal(snapshot.recent[0].id, "review-0");
  });
});

test("job-control: buildSingleJobSnapshot matches by unambiguous id prefix", async () => {
  await withIsolatedWorkspace(async ({ cwd, state, jobControl }) => {
    state.upsertJob(cwd, { id: "task-abc123", status: "completed", jobClass: "task" });
    const snapshot = jobControl.buildSingleJobSnapshot(cwd, "task-abc");
    assert.equal(snapshot.job.id, "task-abc123");
  });
});

test("job-control: buildSingleJobSnapshot throws on an ambiguous prefix", async () => {
  await withIsolatedWorkspace(async ({ cwd, state, jobControl }) => {
    state.upsertJob(cwd, { id: "task-abc111", status: "completed", jobClass: "task" });
    state.upsertJob(cwd, { id: "task-abc222", status: "completed", jobClass: "task" });
    assert.throws(() => jobControl.buildSingleJobSnapshot(cwd, "task-abc"), /ambiguous/);
  });
});

test("job-control: resolveCancelableJob requires a job id when more than one job is active", async () => {
  await withIsolatedWorkspace(async ({ cwd, state, jobControl }) => {
    state.upsertJob(cwd, { id: "task-1", status: "running", jobClass: "task" });
    state.upsertJob(cwd, { id: "task-2", status: "queued", jobClass: "task" });
    assert.throws(() => jobControl.resolveCancelableJob(cwd, ""), /Multiple agy jobs are active/);
  });
});

test("job-control: resolveCancelableJob resolves the sole active job with no reference", async () => {
  await withIsolatedWorkspace(async ({ cwd, state, jobControl }) => {
    state.upsertJob(cwd, { id: "task-1", status: "running", jobClass: "task" });
    const { job } = jobControl.resolveCancelableJob(cwd, "");
    assert.equal(job.id, "task-1");
  });
});

test("job-control: resolveResultJob rejects an explicit reference to a job that has no finished match", async () => {
  await withIsolatedWorkspace(async ({ cwd, state, jobControl }) => {
    state.upsertJob(cwd, { id: "task-1", status: "running", jobClass: "task" });
    // matchJobReference throws as soon as an explicit reference has no match within the
    // completed-jobs predicate, so a still-running job with an explicit reference surfaces
    // as "no job found" rather than reaching the "job is still running" branch below it.
    assert.throws(() => jobControl.resolveResultJob(cwd, "task-1"), /No job found/);
  });
});

test("job-control: resolveResultJob rejects with no finished jobs at all when called without a reference", async () => {
  await withIsolatedWorkspace(async ({ cwd, state, jobControl }) => {
    state.upsertJob(cwd, { id: "task-1", status: "running", jobClass: "task" });
    assert.throws(() => jobControl.resolveResultJob(cwd, ""), /still running/);
  });
});

test("job-control: enrichJob labels jobs by kind and jobClass", async () => {
  await withIsolatedWorkspace(async ({ jobControl }) => {
    const enriched = jobControl.enrichJob({ id: "x", status: "completed", jobClass: "task" });
    assert.equal(enriched.kindLabel, "rescue");
  });
});
