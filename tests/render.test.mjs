import assert from "node:assert/strict";
import { test } from "node:test";

import {
  renderCancelReport,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
} from "../scripts/lib/render.mjs";

test("renderReviewResult: renders a well-formed structured review", () => {
  const parsedResult = {
    parsed: {
      verdict: "needs-attention",
      summary: "Found one real issue.",
      findings: [
        {
          severity: "high",
          title: "Missing null check",
          body: "This can throw.",
          file: "src/index.js",
          line_start: 10,
          line_end: 12,
          confidence: 0.8,
          recommendation: "Add a guard."
        }
      ],
      next_steps: ["Add the guard and retest."]
    },
    parseError: null
  };
  const output = renderReviewResult(parsedResult, { reviewLabel: "Review", targetLabel: "working tree diff" });
  assert.match(output, /# agy Review/);
  assert.match(output, /Verdict: needs-attention/);
  assert.match(output, /\[high\] Missing null check \(src\/index\.js:10-12\)/);
  assert.match(output, /Recommendation: Add a guard\./);
  assert.match(output, /Add the guard and retest\./);
});

test("renderReviewResult: surfaces a parse error with raw output", () => {
  const output = renderReviewResult(
    { parsed: null, parseError: "Unexpected token", rawOutput: "not json" },
    { reviewLabel: "Adversarial Review", targetLabel: "branch diff against main" }
  );
  assert.match(output, /did not return valid structured JSON/);
  assert.match(output, /Unexpected token/);
  assert.match(output, /not json/);
});

test("renderReviewResult: reports an unexpected shape distinctly from a parse error", () => {
  const output = renderReviewResult(
    { parsed: { foo: "bar" }, parseError: null, rawOutput: '{"foo":"bar"}' },
    { reviewLabel: "Review", targetLabel: "working tree diff" }
  );
  assert.match(output, /unexpected review shape/);
  assert.match(output, /Missing string `verdict`\./);
});

test("renderTaskResult: prefers raw output, falls back to failure message", () => {
  assert.equal(renderTaskResult({ rawOutput: "done" }, {}), "done\n");
  assert.equal(renderTaskResult({ rawOutput: "", failureMessage: "boom" }, {}), "boom\n");
  assert.equal(renderTaskResult({}, {}), "agy did not return a final message.\n");
});

test("renderSetupReport: lists checks, actions taken, and next steps", () => {
  const output = renderSetupReport({
    ready: false,
    node: { detail: "v20.0.0" },
    npm: { detail: "10.0.0" },
    agy: { detail: "not found" },
    auth: { detail: "unknown" },
    sessionRuntime: { label: "direct invocation" },
    reviewGateEnabled: false,
    actionsTaken: ["Enabled the stop-time review gate for /repo."],
    nextSteps: ["Install the Antigravity CLI (`agy`), then rerun `/agy:setup`."]
  });
  assert.match(output, /# agy Setup/);
  assert.match(output, /Status: needs attention/);
  assert.match(output, /Actions taken:/);
  assert.match(output, /Next steps:/);
});

test("renderStatusReport: shows a table for running jobs and lists finished ones", () => {
  const output = renderStatusReport({
    sessionRuntime: { label: "direct invocation" },
    config: { stopReviewGate: false },
    running: [{ id: "task-1", kindLabel: "rescue", status: "running", phase: "running", elapsed: "5s", summary: "fix bug" }],
    latestFinished: null,
    recent: [],
    needsReview: false
  });
  assert.match(output, /# agy Status/);
  assert.match(output, /Active jobs:/);
  assert.match(output, /task-1/);
});

test("renderStatusReport: notes when the review gate is enabled", () => {
  const output = renderStatusReport({
    sessionRuntime: { label: "direct invocation" },
    config: { stopReviewGate: true },
    running: [],
    latestFinished: null,
    recent: [],
    needsReview: true
  });
  assert.match(output, /stop-time review gate is enabled/);
});

test("renderStoredJobResult: prefers stored rendered structured review output", () => {
  const job = { id: "review-1", title: "agy Review" };
  const storedJob = { result: { result: { verdict: "approve" }, parseError: null }, rendered: "# agy Review\n\nVerdict: approve\n" };
  const output = renderStoredJobResult(job, storedJob);
  assert.equal(output, "# agy Review\n\nVerdict: approve\n");
});

test("renderStoredJobResult: falls back to a minimal summary when nothing was stored", () => {
  const job = { id: "task-1", title: "agy Task", status: "failed", errorMessage: "agy requires interactive Google OAuth login." };
  const output = renderStoredJobResult(job, null);
  assert.match(output, /# agy Task/);
  assert.match(output, /Status: failed/);
  assert.match(output, /agy requires interactive Google OAuth login\./);
});

test("renderCancelReport: includes the job id and follow-up hint", () => {
  const output = renderCancelReport({ id: "task-9", title: "agy Task", summary: "investigate flake" });
  assert.match(output, /Cancelled task-9\./);
  assert.match(output, /\/agy:status/);
});
