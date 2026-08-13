#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  AgyAuthRequiredError,
  captureGitStatusSnapshot,
  describeHeadlessToolDenial,
  detectHeadlessToolDenial,
  diffGitStatusSnapshots,
  findUnknownEntryId,
  getAgyAuthStatus,
  getAgyAvailability,
  getSessionRuntimeStatus,
  listAgyAgents,
  listAgyModels,
  probeHeadlessToolPermission,
  readOutputSchema,
  runAgyPrompt,
  runAgyStructured
} from "./lib/agy.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { generateJobId, getConfig, listJobs, setConfig, upsertJob, writeJobFile } from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA_PATH = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const REVIEW_SCHEMA = readOutputSchema(REVIEW_SCHEMA_PATH);
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current conversation state. Pick the next highest-value step and follow through until the task is resolved.";
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/agy-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--skip-tool-probe] [--json]",
      "  node scripts/agy-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/agy-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/agy-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--model <model>] [--effort <low|medium|high>] [--agent <agent>] [--mode <accept-edits|plan>] [prompt]",
      "  node scripts/agy-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/agy-companion.mjs result [job-id] [--json]",
      "  node scripts/agy-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

function ensureAgyAvailable(cwd) {
  const availability = getAgyAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      "agy CLI is not installed or is not on PATH. Install the Antigravity CLI, then rerun `/agy:setup`."
    );
  }
}

async function buildSetupReport(cwd, actionsTaken = [], options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const agyStatus = getAgyAvailability(cwd);
  const authStatus = await getAgyAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  // Only probe once agy is known to be signed in: the probe starts a real
  // agent turn, so running it against a signed-out install just reports the
  // auth failure a second time.
  const shouldProbe = options.probeToolPermission !== false && agyStatus.available && authStatus.loggedIn === true;
  const toolPermission = shouldProbe
    ? await probeHeadlessToolPermission(cwd, { availability: agyStatus })
    : {
        probed: false,
        ok: null,
        permission: null,
        detail: agyStatus.available
          ? "Not probed (skipped, or agy is not confirmed signed in)."
          : "agy is not installed."
      };

  const nextSteps = [];
  if (!agyStatus.available) {
    nextSteps.push("Install the Antigravity CLI (`agy`), then rerun `/agy:setup`.");
  } else if (authStatus.loggedIn === false) {
    nextSteps.push(`agy is not signed in. Visit this URL to authenticate, then rerun /agy:setup: ${authStatus.authUrl ?? "(no URL captured — rerun a real command to get one)"}`);
  } else if (authStatus.loggedIn === null) {
    nextSteps.push(`Could not confirm agy's login state (${authStatus.detail}). Run a real command such as /agy:review — it will report the OAuth URL if login is required.`);
  }
  if (toolPermission.ok === false) {
    nextSteps.push(
      "Headless tool calls are soft-denied by this agy install even with " +
        "`--dangerously-skip-permissions`, so `/agy:review` and `/agy:adversarial-review` cannot return " +
        "findings. Confirm `agy --version` is recent enough to honor the flag; related upstream reports: " +
        "google-antigravity/antigravity-cli#548."
    );
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/agy:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    // `ready` deliberately requires the tool-permission probe to have passed.
    // Reporting ready on availability alone is what let a completely broken
    // review path look healthy.
    ready: nodeStatus.available && agyStatus.available && toolPermission.ok === true,
    node: nodeStatus,
    npm: npmStatus,
    agy: agyStatus,
    auth: authStatus,
    toolPermission,
    sessionRuntime: getSessionRuntimeStatus(),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate", "skip-tool-probe"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken, {
    probeToolPermission: !options["skip-tool-probe"]
  });
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildReviewPrompt(templateName, context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, templateName);
  return interpolateTemplate(template, {
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function validatePlainReviewRequest(focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/agy:review\` does not support custom focus text. Retry with \`/agy:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return jobs.find((job) => job.jobClass === "task" && job.status !== "queued" && job.status !== "running") ?? null;
}

function ensureNoActiveTaskJob(workspaceRoot, excludeJobId) {
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && isActiveJobStatus(job.status));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /agy:status before continuing it.`);
  }
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function executeReviewRun(request) {
  ensureAgyAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    validatePlainReviewRequest(focusText);
  }

  const context = collectReviewContext(request.cwd, target);
  const templateName = reviewName === "Review" ? "review" : "adversarial-review";
  const prompt = buildReviewPrompt(templateName, context, focusText);

  // A review is read-only by intent, but `--dangerously-skip-permissions` is the only
  // thing that gets a headless tool call past agy 1.1.3+'s soft-deny, and it approves
  // writes too. Snapshot the worktree either side of the run so a review that edits
  // anything is reported loudly rather than passing silently.
  const beforeSnapshot = captureGitStatusSnapshot(context.repoRoot);

  const result = await runAgyStructured(context.repoRoot, {
    prompt,
    schema: REVIEW_SCHEMA,
    schemaPath: REVIEW_SCHEMA_PATH,
    write: false,
    skipPermissions: true,
    onProgress: request.onProgress,
    tailFile: request.tailFile
  });

  const unexpectedWrites = diffGitStatusSnapshots(beforeSnapshot, captureGitStatusSnapshot(context.repoRoot));

  const parsed = {
    parsed: result.parsed,
    parseError: result.parseError,
    toolDenial: result.toolDenial ?? null,
    rawOutput: result.stdout
  };
  const payload = {
    review: reviewName,
    target,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    agy: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    toolDenial: parsed.toolDenial,
    unexpectedWrites,
    conversationId: result.conversationId ?? null,
    retried: result.retried
  };

  return {
    exitStatus: result.status,
    conversationResumable: true,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      unexpectedWrites
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.stdout, `${reviewName} finished.`),
    jobTitle: `agy ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "agy Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "agy Resume" : "agy Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureAgyAvailable(request.cwd);

  if (request.resumeLast) {
    ensureNoActiveTaskJob(workspaceRoot, request.jobId);
  }

  const taskMetadata = buildTaskRunMetadata({ prompt: request.prompt, resumeLast: request.resumeLast });
  const prompt = request.prompt?.trim() || (request.resumeLast ? DEFAULT_CONTINUE_PROMPT : "");
  if (!prompt) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  // Snapshot unconditionally. A read-only run still needs
  // `--dangerously-skip-permissions` to make any tool call at all (agy 1.1.3+
  // soft-denies otherwise), and that flag approves writes as well — so
  // "read-only" is an intent, not an enforced guarantee, and the only way to
  // know it held is to diff the worktree either side of the run.
  const beforeSnapshot = captureGitStatusSnapshot(workspaceRoot);

  const result = await runAgyPrompt(workspaceRoot, {
    prompt,
    continueLatest: Boolean(request.resumeLast),
    write: Boolean(request.write),
    // Read-only runs need the flag too: without it a diagnostic task soft-denies
    // on its first tool call and returns nothing. That is what silently broke the
    // stop-time review gate, which shells out to `task` with no `--write`.
    skipPermissions: true,
    model: request.model || undefined,
    effort: request.effort || undefined,
    agent: request.agent || undefined,
    mode: request.mode || undefined,
    onProgress: request.onProgress,
    tailFile: request.tailFile
  });

  const touchedFiles = diffGitStatusSnapshots(beforeSnapshot, captureGitStatusSnapshot(workspaceRoot));
  // Files changed by a run that was never meant to edit anything.
  const unexpectedWrites = request.write ? [] : touchedFiles;

  const rawOutput = typeof result.stdout === "string" ? result.stdout : "";
  const toolDenial = detectHeadlessToolDenial(result.stderr);
  const failureMessage = toolDenial ? describeHeadlessToolDenial(toolDenial) : result.stderr ?? "";
  const rendered = renderTaskResult(
    { rawOutput, failureMessage },
    { title: taskMetadata.title, jobId: request.jobId ?? null, write: Boolean(request.write), unexpectedWrites }
  );
  const payload = {
    status: result.status,
    rawOutput,
    touchedFiles,
    unexpectedWrites
  };

  return {
    exitStatus: result.status,
    conversationResumable: true,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "agy Review" : `agy ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, prompt, write, resumeLast, jobId, model, effort, agent, mode }) {
  return { cwd, prompt, write, resumeLast, jobId, model, effort, agent, mode };
}

const VALID_TASK_MODES = ["accept-edits", "plan"];

/**
 * Best-effort validation against agy's real model/agent lists (`agy
 * --output-format json models|agent`, confirmed live 2026-08 — see
 * `.github/agy-tested-version` for the version checked). Never blocks the
 * run if the listing itself fails (offline, older agy,
 * transient error) — it only rejects a choice it can positively confirm is
 * unknown.
 */
async function ensureKnownModelChoice(cwd, model) {
  if (!model) {
    return;
  }
  let models;
  try {
    models = await listAgyModels(cwd);
  } catch {
    return;
  }
  const knownIds = findUnknownEntryId(models, model);
  if (knownIds) {
    throw new Error(`Unknown agy model "${model}". Available models: ${knownIds.join(", ")}`);
  }
}

async function ensureKnownAgentChoice(cwd, agent) {
  if (!agent) {
    return;
  }
  let agents;
  try {
    agents = await listAgyAgents(cwd);
  } catch {
    return;
  }
  const knownIds = findUnknownEntryId(agents, agent);
  if (knownIds) {
    throw new Error(`Unknown agy agent "${agent}". Available agents: ${knownIds.join(", ")}`);
  }
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }
  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

function describeExecutionError(error) {
  if (error instanceof AgyAuthRequiredError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  try {
    const execution = await runTrackedJob(job, () => runner(progress, logFile), { logFile });
    outputResult(options.json ? execution.payload : execution.rendered, options.json);
    if (execution.exitStatus !== 0) {
      process.exitCode = execution.exitStatus;
    }
    return execution;
  } catch (error) {
    throw new Error(describeExecutionError(error));
  }
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "agy-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: { jobId: job.id, status: "queued", title: job.title, summary: job.summary, logFile },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "cwd"],
    booleanOptions: ["json", "background", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });

  config.validateRequest?.(focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress, logFile) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress,
        tailFile: logFile
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validatePlainReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "prompt-file", "model", "effort", "agent", "mode"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const model = options.model || undefined;
  const effort = options.effort || undefined;
  const agent = options.agent || undefined;
  const mode = options.mode || undefined;
  if (effort && !["low", "medium", "high"].includes(effort)) {
    throw new Error(`Invalid --effort "${effort}". agy accepts: low, medium, high.`);
  }
  if (mode && !VALID_TASK_MODES.includes(mode)) {
    throw new Error(`Invalid --mode "${mode}". agy accepts: ${VALID_TASK_MODES.join(", ")}.`);
  }
  await ensureKnownModelChoice(cwd, model);
  await ensureKnownAgentChoice(cwd, agent);
  const taskMetadata = buildTaskRunMetadata({ prompt, resumeLast });

  if (options.background) {
    ensureAgyAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({ cwd, prompt, write, resumeLast, jobId: job.id, model, effort, agent, mode });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, `${payload.title} started in the background as ${payload.jobId}. Check /agy:status ${payload.jobId} for progress.\n`, options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress, logFile) =>
      executeTaskRun({ cwd, prompt, write, resumeLast, model, effort, agent, mode, jobId: job.id, onProgress: progress, tailFile: logFile }),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    { ...storedJob, workspaceRoot },
    { logFile: storedJob.logFile ?? null }
  );
  await runTrackedJob(
    { ...storedJob, workspaceRoot, logFile },
    () => executeTaskRun({ ...request, onProgress: progress, tailFile: logFile }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(options.json ? report : renderStatusReport(report), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = { job, storedJob };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, { ...existing, ...nextJob, cancelledAt: completedAt });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = { jobId: job.id, status: "cancelled", title: job.title };
  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, { reviewName: "Adversarial Review" });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
