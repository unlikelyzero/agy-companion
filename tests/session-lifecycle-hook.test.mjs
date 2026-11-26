import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const HOOK = new URL("../scripts/session-lifecycle-hook.mjs", import.meta.url).pathname;

test("SessionStart writes each env line once across repeated starts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-env-"));
  const envFile = path.join(dir, "env.sh");
  // Another plugin's line, with no trailing newline, must survive untouched.
  fs.writeFileSync(envFile, "export OTHER=1");
  const env = { ...process.env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: "/data/it's" };

  for (let i = 0; i < 3; i += 1) {
    const run = spawnSync(process.execPath, [HOOK, "SessionStart"], { input: '{"session_id":"s1"}', env });
    assert.equal(run.status, 0, String(run.stderr));
  }

  assert.equal(
    fs.readFileSync(envFile, "utf8"),
    "export OTHER=1\nexport AGY_COMPANION_SESSION_ID='s1'\nexport CLAUDE_PLUGIN_DATA='/data/it'\"'\"'s'\n"
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
