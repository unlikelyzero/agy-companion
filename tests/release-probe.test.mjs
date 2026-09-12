// The tracking-issue step of .github/workflows/agy-release-probe.yml is plain
// shell, so run it for real against a stub `gh` and check it keeps ONE rolling
// issue instead of filing a fresh one per release.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const WORKFLOW = new URL("../.github/workflows/agy-release-probe.yml", import.meta.url);

function stepScript() {
  const lines = fs.readFileSync(WORKFLOW, "utf8").split("\n");
  const start = lines.findIndex((l) => l.includes("name: Open tracking issue"));
  assert.ok(start > 0, "tracking-issue step not found");
  const runAt = lines.indexOf("        run: |", start);
  assert.ok(runAt > 0, "run block not found");
  const body = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

function run({ existing = "", existingBody = "", env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-probe-test-"));
  try {
    fs.writeFileSync(path.join(dir, "existing-body.txt"), existingBody);
    // Stub gh: record every invocation, answer the two queries the step makes.
    fs.writeFileSync(
      path.join(dir, "gh"),
      `#!/bin/sh
# One log line per call, newlines in arguments flattened so the test can grep.
printf '%s ' "$@" | tr '\\n' ' ' >> "$GH_LOG"
printf '\\n' >> "$GH_LOG"
sub="$1 $2"
while [ $# -gt 0 ]; do
  if [ "$1" = "--body" ]; then body="$2"; fi
  shift
done
case "$sub" in
  "issue list") printf '%s' "$GH_EXISTING" ;;
  "issue view") cat "$GH_BODY_FILE" ;;
  "issue create") printf '%s' "$body" > "$GH_CREATED_BODY" ;;
esac
exit 0
`,
      { mode: 0o755 },
    );
    const log = path.join(dir, "gh.log");
    execFileSync("bash", ["-e", "-c", stepScript()], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GH_LOG: log,
        GH_EXISTING: existing,
        GH_BODY_FILE: path.join(dir, "existing-body.txt"),
        GH_CREATED_BODY: path.join(dir, "created-body.txt"),
        LATEST: "1.2.2",
        TESTED: "1.1.17",
        NEW_RELEASE: "true",
        HAS_HELP_DIFF: "true",
        HELP_DIFF: "+  mic-serve",
        LABEL: "agy-compatibility",
        ...env,
      },
      stdio: "pipe",
    });
    return {
      calls: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [],
      createdBody: fs.existsSync(path.join(dir, "created-body.txt"))
        ? fs.readFileSync(path.join(dir, "created-body.txt"), "utf8")
        : "",
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("no open tracking issue: files a fresh labelled one", () => {
  const { calls, createdBody } = run();
  assert.ok(calls.some((c) => c.startsWith("issue create")), calls.join("\n"));
  assert.ok(calls.some((c) => c.includes("--label agy-compatibility")));
  assert.match(createdBody, /New agy release|last verified against `1\.1\.17`/);
  // Step 4 must name the version this run is about, not a stale one.
  assert.ok(createdBody.includes("Update `.github/agy-tested-version` to `1.2.2`"));
});

test("open tracking issue with stale content: retitles and comments, never creates", () => {
  const { calls } = run({ existing: "26", existingBody: "stale body from 1.1.18" });
  assert.ok(!calls.some((c) => c.startsWith("issue create")), calls.join("\n"));
  assert.ok(calls.some((c) => c.startsWith("issue edit 26") && c.includes("1.2.2")));
  assert.ok(calls.some((c) => c.startsWith("issue comment 26")));
});

test("open tracking issue already current: does nothing", () => {
  const current = run().createdBody;
  const { calls } = run({ existing: "26", existingBody: current });
  assert.deepEqual(
    calls.filter((c) => !c.startsWith("issue list") && !c.startsWith("issue view")),
    [],
  );
});

test("no version bump, --help changed: still files the no-bump variant", () => {
  const { calls, createdBody } = run({ env: { NEW_RELEASE: "false" } });
  assert.ok(calls.some((c) => c.includes("changed its --help output without a version bump")));
  assert.ok(createdBody.includes("with no version bump to signal it"));
});

test("unclassified surface entries: the issue body names them and the step-4 bump", () => {
  const { createdBody } = run({
    env: {
      HAS_UNCLASSIFIED: "true",
      SURFACE_REPORT: "- unclassified subcommand `mic-serve` — add it to .github/agy-surface.json with a status and a reason.",
    },
  });
  assert.match(createdBody, /unclassified subcommand `mic-serve`/);
  assert.match(createdBody, /cannot be skipped/);
  assert.ok(createdBody.includes(".github/agy-surface.json` with an entry for anything new"));
});

test("nothing unclassified: the issue body says the surface is accounted for", () => {
  const { createdBody } = run({ env: { HAS_UNCLASSIFIED: "false" } });
  assert.match(createdBody, /already has a recorded decision/);
});

test("surface entries unclassified with no version or help change: files the surface variant", () => {
  const { calls, createdBody } = run({
    env: { NEW_RELEASE: "false", HAS_HELP_DIFF: "false", HAS_UNCLASSIFIED: "true", SURFACE_REPORT: "- unclassified flag `--telepathy`" },
  });
  assert.ok(calls.some((c) => c.includes("has CLI surface entries with no recorded decision")), calls.join("\n"));
  assert.match(createdBody, /does not account for/);
});
