import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "agy-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const JOB_FILE_NAME = "job.json";
const JOB_LOG_FILE_NAME = "log.log";
const LOCK_DIR_NAME = ".state.lock";
const MAX_JOBS = 50;

// A lock older than this is assumed to belong to a process that crashed
// while holding it, and is stolen rather than waited on forever.
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 20_000;

// A job that just moved to queued/running gets this long before an unreachable
// pid is treated as evidence it died, rather than as a worker that hasn't
// recorded its pid yet.
const LOST_JOB_GRACE_MS = 15_000;

export const ACTIVE_STATUSES = Object.freeze(["queued", "running"]);
export const TERMINAL_STATUSES = Object.freeze(["completed", "failed", "cancelled", "lost"]);

export function isActiveJobStatus(status) {
  return ACTIVE_STATUSES.includes(status);
}

export function isTerminalJobStatus(status) {
  return TERMINAL_STATUSES.includes(status);
}

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function resolveJobDir(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), jobId);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

function ensureJobDir(cwd, jobId) {
  const jobDir = resolveJobDir(cwd, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  return jobDir;
}

export function resolveJobFile(cwd, jobId) {
  return path.join(ensureJobDir(cwd, jobId), JOB_FILE_NAME);
}

export function resolveJobLogFile(cwd, jobId) {
  return path.join(ensureJobDir(cwd, jobId), JOB_LOG_FILE_NAME);
}

function removeJobDir(cwd, jobId) {
  try {
    fs.rmSync(resolveJobDir(cwd, jobId), { recursive: true, force: true });
  } catch {
    // Best effort — a job directory that resists cleanup just gets pruned again later.
  }
}

/**
 * Writes via a temp file + fsync + rename in the same directory, so a
 * process killed mid-write leaves either the old file or the new one intact
 * on disk, never a truncated/partial one that the next reader has to guess
 * about.
 */
function atomicWriteFileSync(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpFile = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  const fd = fs.openSync(tmpFile, "w");
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpFile, filePath);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function staleLockAgeMs(lockDir) {
  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * mkdir is atomic on every platform this plugin runs on, so an exclusive
 * "directory as lock" is a dependency-free stand-in for flock. This is what
 * makes the load/mutate/persist cycle in `updateState` safe against two
 * background jobs finishing at the same moment and clobbering each other's
 * registry entry (the read-modify-write race this replaces).
 */
function acquireStateLock(cwd) {
  ensureStateDir(cwd);
  const lockDir = path.join(resolveStateDir(cwd), LOCK_DIR_NAME);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      return lockDir;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }

    const age = staleLockAgeMs(lockDir);
    if (age !== null && age > LOCK_STALE_MS) {
      try {
        fs.rmdirSync(lockDir);
      } catch {
        // Another waiter already stole it first — loop and try to mkdir again.
      }
      continue;
    }

    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for the agy-companion state lock at ${lockDir}.`);
    }
    sleepSync(LOCK_RETRY_MS);
  }
}

function releaseStateLock(lockDir) {
  try {
    fs.rmdirSync(lockDir);
  } catch {
    // Already gone (e.g. stolen after going stale) — nothing left to release.
  }
}

function withStateLock(cwd, fn) {
  const lockDir = acquireStateLock(cwd);
  try {
    return fn();
  } finally {
    releaseStateLock(lockDir);
  }
}

function scanJobsDirForIndex(cwd) {
  const jobsDir = resolveJobsDir(cwd);
  if (!fs.existsSync(jobsDir)) {
    return [];
  }

  const jobs = [];
  for (const entry of fs.readdirSync(jobsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const jobFile = path.join(jobsDir, entry.name, JOB_FILE_NAME);
    if (!fs.existsSync(jobFile)) {
      continue;
    }
    try {
      jobs.push(readJobFile(jobFile));
    } catch {
      // A single unreadable job record shouldn't blank out the whole recovered registry.
    }
  }
  return jobs;
}

function quarantineCorruptStateFile(stateFile) {
  try {
    fs.renameSync(stateFile, `${stateFile}.corrupt-${Date.now()}`);
  } catch {
    // Best effort — if even the rename fails, the next write will just overwrite it.
  }
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    // state.json is corrupt (e.g. a crash mid-write before atomic writes
    // existed, or external tampering). The per-job jobs/<id>/job.json files
    // are the durable record, so rebuild the registry from them instead of
    // reporting an empty job list and quietly losing every job's history.
    quarantineCorruptStateFile(stateFile);
    return {
      ...defaultState(),
      jobs: scanJobsDirForIndex(cwd)
    };
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function persistState(cwd, state) {
  ensureStateDir(cwd);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: pruneJobs(state.jobs ?? [])
  };
  atomicWriteFileSync(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

function cleanupPrunedJobDirs(cwd, previousJobs, nextJobs) {
  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (!retainedIds.has(job.id)) {
      removeJobDir(cwd, job.id);
    }
  }
}

/**
 * The sole read-modify-write entry point for state.json: load, let the
 * caller mutate the draft in place, then persist — all under the same lock,
 * so two processes updating different jobs at the same moment can no longer
 * overwrite each other's change with a stale copy.
 */
export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    const previousJobs = state.jobs;
    mutate(state);
    const nextState = persistState(cwd, state);
    cleanupPrunedJobDirs(cwd, previousJobs, nextState.jobs);
    return nextState;
  });
}

export function saveState(cwd, state) {
  return updateState(cwd, (draft) => {
    draft.config = state.config;
    draft.jobs = state.jobs;
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but is owned by someone else — still alive.
    return error.code === "EPERM";
  }
}

function isJobPotentiallyLost(job) {
  if (!isActiveJobStatus(job.status)) {
    return false;
  }
  const referenceTime = Date.parse(job.updatedAt ?? job.createdAt ?? "");
  if (Number.isFinite(referenceTime) && Date.now() - referenceTime < LOST_JOB_GRACE_MS) {
    return false;
  }
  return !isPidAlive(job.pid);
}

function markJobLost(cwd, job, timestamp) {
  job.status = "lost";
  job.phase = "lost";
  job.pid = null;
  job.updatedAt = timestamp;
  job.completedAt = job.completedAt ?? timestamp;
  job.errorMessage =
    job.errorMessage ?? "The process running this job is gone and it never recorded a terminal result, so its outcome is unknown (lost).";

  const jobFile = resolveJobFile(cwd, job.id);
  if (!fs.existsSync(jobFile)) {
    return;
  }
  try {
    writeJobFile(cwd, job.id, { ...readJobFile(jobFile), ...job });
  } catch {
    // The index record above still reflects "lost" even if the per-job file write fails.
  }
}

/**
 * `queued`/`running` jobs whose recorded pid is no longer alive are not
 * inferred to have completed or failed — there is no durable evidence either
 * way, only a dead process. They're marked `lost` instead, so a caller like
 * `/agy:status` never reports stale "running" for a job the runtime already
 * knows is gone.
 */
export function reconcileJobs(cwd) {
  const state = loadState(cwd);
  if (!state.jobs.some((job) => isJobPotentiallyLost(job))) {
    return state;
  }

  return updateState(cwd, (draft) => {
    const timestamp = nowIso();
    for (const job of draft.jobs) {
      // Re-checked under the lock: another process may have already reconciled
      // (or completed) this job between the fast-path check above and here.
      if (isJobPotentiallyLost(job)) {
        markJobLost(cwd, job, timestamp);
      }
    }
  });
}

export function listJobs(cwd) {
  return reconcileJobs(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  const jobFile = resolveJobFile(cwd, jobId);
  atomicWriteFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

/** Round-trips a throwaway probe file through the state directory — for `/agy:setup --doctor`. */
export function isStateDirectoryWritable(cwd) {
  try {
    ensureStateDir(cwd);
    const probeFile = path.join(resolveStateDir(cwd), `.write-probe-${process.pid}-${Date.now().toString(36)}`);
    fs.writeFileSync(probeFile, "");
    fs.unlinkSync(probeFile);
    return true;
  } catch {
    return false;
  }
}
