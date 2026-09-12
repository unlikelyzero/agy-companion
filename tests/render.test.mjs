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

test("renderReviewResult: notes a run-level error that the review survived", () => {
  const output = renderReviewResult(
    {
      parsed: { verdict: "approve", summary: "Looks fine.", findings: [], next_steps: [] },
      parseError: null,
      recoveredFromEnvelopeError: "context canceled"
    },
    { reviewLabel: "Review", targetLabel: "working tree diff" }
  );
  assert.match(output, /Verdict: approve/);
  assert.match(output, /agy reported a run-level error/);
  assert.match(output, /context canceled/);
  assert.match(output, /Looks fine\./);
});

test("renderReviewResult: adds no run-level note when the run was clean", () => {
  const output = renderReviewResult(
    { parsed: { verdict: "approve", summary: "Looks fine.", findings: [], next_steps: [] }, parseError: null },
    { reviewLabel: "Review", targetLabel: "working tree diff" }
  );
  assert.doesNotMatch(output, /run-level error/);
});

function reviewWithTitle(title) {
  return {
    parsed: {
      verdict: "needs-attention",
      summary: "One finding.",
      findings: [
        {
          severity: "high",
          title,
          body: "This can throw.",
          file: "src/index.js",
          line_start: 10,
          line_end: 12,
          confidence: 0.8,
          recommendation: "Add a guard."
        }
      ],
      next_steps: []
    },
    parseError: null
  };
}

function findingLine(output) {
  return output.split("\n").find((line) => line.startsWith("- [high]"));
}

test("renderReviewResult: truncates an over-long finding title", () => {
  const title = `Unbounded retry loop in ${"x".repeat(120)} blocks the gate`;
  const line = findingLine(renderReviewResult(reviewWithTitle(title), { reviewLabel: "Review", targetLabel: "t" }));
  assert.ok(line.includes("…"), "expected the title to be elided");
  assert.match(line, /\(src\/index\.js:10-12\)$/, "file:line suffix must survive truncation");
});

test("renderReviewResult: keeps a multi-line finding title on one line", () => {
  const output = renderReviewResult(
    reviewWithTitle("Race condition\nin job state writer"),
    { reviewLabel: "Review", targetLabel: "t" }
  );
  const line = findingLine(output);
  assert.equal(line, "- [high] Race condition in job state writer (src/index.js:10-12)");
});

test("renderReviewResult: does not emit a lone surrogate for an emoji title", () => {
  const line = findingLine(
    renderReviewResult(reviewWithTitle("\u{1F525}".repeat(90)), { reviewLabel: "Review", targetLabel: "t" })
  );
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(line), "lone high surrogate in rendered line");
  assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(line), "lone low surrogate in rendered line");
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

test("renderReviewResult: reports a soft-denied tool call as a permission failure, not bad JSON", () => {
  const output = renderReviewResult(
    {
      parsed: null,
      parseError: 'agy soft-denied a tool call that needed the "command" permission.',
      toolDenial: { permission: "command", stderr: "jetski: no output produced ..." },
      rawOutput: '{"status":"SUCCESS","response":""}'
    },
    { reviewLabel: "Review", targetLabel: "branch diff against main" }
  );
  assert.match(output, /a tool call was denied/);
  assert.match(output, /Permission requested: `command`/);
  assert.doesNotMatch(output, /did not return valid structured JSON/);
});

// Regression: the denial message alone isn't enough — renderReviewResult
// picks its branch on `toolDenial`, so a caller that forwards parseError but
// drops toolDenial still renders the misleading "did not return valid
// structured JSON" heading. That shipped briefly and only a live run caught it.
test("renderReviewResult: falls back to the parse-error branch when toolDenial is dropped", () => {
  const output = renderReviewResult(
    {
      parsed: null,
      parseError: 'agy soft-denied a tool call that needed the "command" permission.',
      rawOutput: '{"status":"SUCCESS","response":""}'
    },
    { reviewLabel: "Review", targetLabel: "branch diff against main" }
  );
  // Documents the coupling: without toolDenial the denial-specific heading is
  // unreachable, so callers must forward the field.
  assert.match(output, /did not return valid structured JSON/);
  assert.doesNotMatch(output, /a tool call was denied/);
});

test("renderTaskResult: warns when a read-only task run modified the worktree", () => {
  const output = renderTaskResult(
    { rawOutput: "diagnosis complete" },
    { title: "rescue", unexpectedWrites: ["src/oops.ts"] }
  );
  assert.match(output, /\[!WARNING\]/);
  assert.match(output, /src\/oops\.ts/);
  assert.ok(output.indexOf("[!WARNING]") < output.indexOf("diagnosis complete"));
});

test("renderTaskResult: stays quiet for a write run that legitimately edited files", () => {
  const output = renderTaskResult(
    { rawOutput: "done" },
    { title: "rescue", write: true, unexpectedWrites: [] }
  );
  assert.doesNotMatch(output, /WARNING/);
});

test("renderReviewResult: warns loudly when a read-only review wrote inside its snapshot", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine.",
        findings: [],
        next_steps: []
      }
    },
    {
      reviewLabel: "Review",
      targetLabel: "branch diff against main",
      unexpectedWrites: ["src/touched.ts", "README.md"]
    }
  );
  assert.match(output, /\[!WARNING\]/);
  assert.match(output, /disposable snapshot/);
  assert.match(output, /src\/touched\.ts/);
  assert.match(output, /README\.md/);
  // The banner has to lead, or it gets buried under findings.
  assert.ok(output.indexOf("[!WARNING]") < output.indexOf("Looks fine."));
});

test("renderReviewResult: stays quiet when the review touched nothing", () => {
  const parsed = {
    parsed: { verdict: "approve", summary: "Looks fine.", findings: [], next_steps: [] }
  };
  const meta = { reviewLabel: "Review", targetLabel: "branch diff against main" };
  assert.doesNotMatch(renderReviewResult(parsed, meta), /WARNING/);
  assert.doesNotMatch(renderReviewResult(parsed, { ...meta, unexpectedWrites: [] }), /WARNING/);
});

test("renderReviewResult: surfaces unexpected writes even when the review itself failed", () => {
  const output = renderReviewResult(
    { parsed: null, parseError: "agy reported status \"ERROR\" instead of SUCCESS.", rawOutput: "{}" },
    { reviewLabel: "Review", targetLabel: "t", unexpectedWrites: ["src/touched.ts"] }
  );
  assert.match(output, /\[!WARNING\]/);
  assert.match(output, /src\/touched\.ts/);
});

test("renderSetupReport: lists checks, actions taken, and next steps", () => {
  const output = renderSetupReport({
    ready: false,
    node: { detail: "v20.0.0" },
    npm: { detail: "10.0.0" },
    agy: { detail: "not found" },
    auth: { detail: "unknown" },
    toolPermission: { ok: null, detail: "agy is not installed." },
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

test("renderSetupReport: renders a Doctor section only when report.doctor is present", () => {
  const base = {
    ready: true,
    node: { detail: "v20.0.0" },
    npm: { detail: "10.0.0" },
    agy: { detail: "1.1.13" },
    auth: { detail: "signed in" },
    toolPermission: { ok: true, detail: "working" },
    sessionRuntime: { label: "direct invocation" },
    reviewGateEnabled: false,
    actionsTaken: [],
    nextSteps: []
  };

  assert.doesNotMatch(renderSetupReport(base), /Doctor:/);

  const withDoctor = renderSetupReport({
    ...base,
    doctor: {
      agyVersion: "1.1.13",
      testedVersion: "1.1.12",
      versionMatchesTested: false,
      capabilities: { jsonSchema: true, sandbox: true, conversation: false },
      models: { ok: true, count: 14, detail: null },
      agents: { ok: false, count: null, detail: "boom" },
      stateDirectory: { path: "/tmp/state", writable: false },
      gitRepository: true,
      activeJobs: 2
    }
  });
  assert.match(withDoctor, /Doctor:/);
  assert.match(withDoctor, /agy version: 1\.1\.13 \(last verified: 1\.1\.12 — differs\)/);
  assert.match(withDoctor, /jsonSchema: yes/);
  assert.match(withDoctor, /conversation: NO/);
  assert.match(withDoctor, /models list: ok \(14\)/);
  assert.match(withDoctor, /agents list: FAILED — boom/);
  assert.match(withDoctor, /NOT WRITABLE/);
  assert.match(withDoctor, /git repository: yes/);
  assert.match(withDoctor, /active jobs: 2/);
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
