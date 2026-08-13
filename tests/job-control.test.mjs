import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const SESSION_ID_ENV = "AGY_COMPANION_SESSION_ID";

/**
 * `sessionId` is deliberately cleared here. job-control scopes "active" jobs
 * to the current session via `AGY_COMPANION_SESSION_ID`, and the fixtures
 * below create jobs with no `sessionId` — so whenever that variable happens
 * to be set in the ambient environment, every fixture job is filtered out and
 * the running/queued assertions fail. That is exactly what happens on a
 * machine with the agy-companion plugin installed (its session hook exports
 * the variable) while hosted CI, which never sets it, stays green. Tests must
 * not depend on which of those two environments they run in; session scoping
 * is covered explicitly instead, further down.
 */
async function withIsolatedWorkspace(fn, { sessionId = null } = {}) {
  const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), "agy-companion-test-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-companion-repo-"));
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  const previousSessionId = process.env[SESSION_ID_ENV];
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  if (sessionId === null) {
    delete process.env[SESSION_ID_ENV];
  } else {
    process.env[SESSION_ID_ENV] = sessionId;
  }
  try {
    const suffix = `?t=${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const state = await import(`../scripts/lib/state.mjs${suffix}`);
    const jobControl = await import(`../scripts/lib/job-control.mjs${suffix}`);
    return await fn({ cwd, state, jobControl });
  } finally {
    if (previousPluginData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    }
    if (previousSessionId === undefined) {
      delete process.env[SESSION_ID_ENV];
    } else {
      process.env[SESSION_ID_ENV] = previousSessionId;
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

test("job-control: active-job views are scoped to the current session", async () => {
  await withIsolatedWorkspace(
    async ({ cwd, state, jobControl }) => {
      state.upsertJob(cwd, { id: "task-mine", status: "running", jobClass: "task", sessionId: "session-a" });
      state.upsertJob(cwd, { id: "task-theirs", status: "running", jobClass: "task", sessionId: "session-b" });

      const snapshot = jobControl.buildStatusSnapshot(cwd);
      assert.deepEqual(
        snapshot.running.map((job) => job.id),
        ["task-mine"]
      );

      // Only one job belongs to this session, so no id is required to cancel it.
      assert.equal(jobControl.resolveCancelableJob(cwd, "").job.id, "task-mine");
    },
    { sessionId: "session-a" }
  );
});

test("job-control: an explicit reference reaches jobs from another session", async () => {
  await withIsolatedWorkspace(
    async ({ cwd, state, jobControl }) => {
      state.upsertJob(cwd, { id: "task-theirs", status: "completed", jobClass: "task", sessionId: "session-b" });
      // Session scoping applies to the no-reference views; naming a job explicitly still finds it.
      assert.equal(jobControl.buildSingleJobSnapshot(cwd, "task-theirs").job.id, "task-theirs");
    },
    { sessionId: "session-a" }
  );
});

test("job-control: enrichJob labels jobs by kind and jobClass", async () => {
  await withIsolatedWorkspace(async ({ jobControl }) => {
    const enriched = jobControl.enrichJob({ id: "x", status: "completed", jobClass: "task" });
    assert.equal(enriched.kindLabel, "rescue");
  });
});
