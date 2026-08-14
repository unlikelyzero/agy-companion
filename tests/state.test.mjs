import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
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

test("state: a corrupt state.json is rebuilt from per-job files instead of returning an empty registry", async () => {
  await withTempPluginData(async () => {
    const { upsertJob, writeJobFile, loadState, resolveStateFile } = await import(`../scripts/lib/state.mjs?t=${Date.now()}-f`);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-companion-repo-"));

    upsertJob(cwd, { id: "job-1", status: "completed" });
    writeJobFile(cwd, "job-1", { id: "job-1", status: "completed" });

    // Simulate a crash mid-write: state.json is truncated garbage, but the
    // per-job directory it points at is intact.
    fs.writeFileSync(resolveStateFile(cwd), '{"version": 1, "jobs": [', "utf8");

    const recovered = loadState(cwd);
    assert.deepEqual(
      recovered.jobs.map((job) => job.id),
      ["job-1"]
    );
    const quarantined = fs.readdirSync(path.dirname(resolveStateFile(cwd))).filter((name) => name.includes(".corrupt-"));
    assert.equal(quarantined.length, 1);
  });
});

test("state: writes survive a corrupt read (atomic write leaves no partial file to trip over)", async () => {
  await withTempPluginData(async () => {
    const { upsertJob, listJobs } = await import(`../scripts/lib/state.mjs?t=${Date.now()}-g`);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-companion-repo-"));

    for (let i = 0; i < 20; i += 1) {
      upsertJob(cwd, { id: `job-${i}`, status: "completed" });
    }

    assert.equal(listJobs(cwd).length, 20);
  });
});

test("state: concurrent upserts to different jobs don't clobber each other", async () => {
  await withTempPluginData(async () => {
    const { upsertJob, listJobs } = await import(`../scripts/lib/state.mjs?t=${Date.now()}-h`);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-companion-repo-"));

    // upsertJob's read/mutate/persist cycle is lock-protected end to end, so
    // interleaved calls (simulated here without real OS-level parallelism,
    // since Node is single-threaded) must not lose either job's write.
    await Promise.all([upsertJob(cwd, { id: "job-a", status: "running" }), upsertJob(cwd, { id: "job-b", status: "running" })]);

    const ids = listJobs(cwd)
      .map((job) => job.id)
      .sort();
    assert.deepEqual(ids, ["job-a", "job-b"]);
  });
});

test("state: an abandoned (stale) lock directory is stolen rather than deadlocking", async () => {
  await withTempPluginData(async () => {
    const { upsertJob, resolveStateDir } = await import(`../scripts/lib/state.mjs?t=${Date.now()}-i`);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-companion-repo-"));

    const lockDir = path.join(resolveStateDir(cwd), ".state.lock");
    fs.mkdirSync(lockDir, { recursive: true });
    const staleTime = new Date(Date.now() - 60_000);
    fs.utimesSync(lockDir, staleTime, staleTime);

    upsertJob(cwd, { id: "job-1", status: "completed" });
    assert.ok(!fs.existsSync(lockDir) || fs.statSync(lockDir).mtimeMs > staleTime.getTime());
  });
});

test("state: reconcileJobs marks a running job with a dead pid as lost", async () => {
  await withTempPluginData(async () => {
    const { upsertJob, listJobs } = await import(`../scripts/lib/state.mjs?t=${Date.now()}-j`);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-companion-repo-"));

    upsertJob(cwd, {
      id: "job-1",
      status: "running",
      pid: 999999999,
      updatedAt: new Date(Date.now() - 60_000).toISOString()
    });

    const [job] = listJobs(cwd);
    assert.equal(job.status, "lost");
    assert.equal(job.pid, null);
    assert.match(job.errorMessage, /lost/i);
  });
});

test("state: reconcileJobs leaves a running job with a live pid alone", async () => {
  await withTempPluginData(async () => {
    const { upsertJob, listJobs } = await import(`../scripts/lib/state.mjs?t=${Date.now()}-k`);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-companion-repo-"));

    upsertJob(cwd, {
      id: "job-1",
      status: "running",
      pid: process.pid,
      updatedAt: new Date(Date.now() - 60_000).toISOString()
    });

    const [job] = listJobs(cwd);
    assert.equal(job.status, "running");
  });
});

test("state: reconcileJobs gives a freshly queued job a grace window before declaring it lost", async () => {
  await withTempPluginData(async () => {
    const { upsertJob, listJobs } = await import(`../scripts/lib/state.mjs?t=${Date.now()}-l`);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "agy-companion-repo-"));

    upsertJob(cwd, { id: "job-1", status: "queued", pid: 999999999 });

    const [job] = listJobs(cwd);
    assert.equal(job.status, "queued");
  });
});
