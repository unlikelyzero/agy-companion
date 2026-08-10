# Testing

## What's covered by `npm test`

`npm test` runs Node's built-in test runner (`node --test tests/*.test.mjs`) against everything that does not require a live `agy` binary or a real Google OAuth session:

- **Argument parsing** (`tests/args.test.mjs`): flag/positional parsing, `--key=value`, aliasing, `--` passthrough, quoted raw-argument splitting.
- **State persistence** (`tests/state.test.mjs`): the on-disk job/config store — defaults, config round-trips, job upsert/prune, job file read/write.
- **Job control** (`tests/job-control.test.mjs`): status snapshots (running/latest-finished/recent), job-reference resolution (exact id, unambiguous prefix, ambiguous prefix), cancel/result eligibility rules.
- **Rendering** (`tests/render.test.mjs`): Markdown output for setup, status, review results (well-formed, malformed JSON, schema-mismatched), task results, cancel reports.
- **Process helpers** (`tests/process.test.mjs`): binary-availability detection, command failure formatting, process-tree termination (with an injected `kill` implementation, so no real processes are touched).
- **JSON Schema validation** (`tests/schema-validate.test.mjs`): the local validator against `schemas/review-output.schema.json` — required fields, enums, nested finding objects, numeric ranges.
- **agy transport layer** (`tests/agy.test.mjs`): `runAgyPrompt`'s argument building (including `--model`, `--effort`, `--conversation`, `--output-format`, `--json-schema`), stdout/stderr capture, OAuth-prompt detection (`AgyAuthRequiredError`), missing-binary handling, unsupported-flag handling (`AgyUnsupportedFeatureError`), timeout handling, tail-file writing — all with `child_process.spawn` replaced by an injected fake (`spawnImpl`), never a real `agy` process. Also covers `runAgyStructured`'s parsing of agy's real `--output-format json` envelope shape (`parseAgyEnvelope`) and the best-effort git-status-diff touched-files helper.

Run it with:

```bash
npm test
```

## What's now confirmed against a real, authenticated `agy` install

This plugin was originally built and unit-tested in an environment with no `agy` binary and no Google account available. That gap has been partially closed: a real `agy 1.1.11` install, authenticated via the browser/paste-code OAuth flow, ran `node scripts/agy-companion.mjs review --wait --scope working-tree` against a real (small) working-tree diff and produced a correctly rendered, schema-conformant result end to end — confirming `--output-format json --json-schema <path>` genuinely works as documented in the README, not just against mocked `spawn` output.

That single run does not cover everything, though — it exercised one command, in the foreground, against an account that was already logged in. The rest of this list is still open:

- **`/agy:adversarial-review`** — not run live yet, only `/agy:review`. It shares the same `runAgyStructured` code path, so it's lower-risk than it was, but the adversarial prompt template itself (`prompts/adversarial-review.md`) hasn't been checked against a real response.
- **The OAuth-prompt detection regex** (`AUTH_REQUIRED_PATTERN` / `URL_PATTERN` in `scripts/lib/agy.mjs`), against a real "Authentication required" prompt. The account used for the live test above was already authenticated, so this path still hasn't fired against real agy output — only against fixtures in the unit tests.
- **`/agy:rescue`** end-to-end, including the `--write` / `--dangerously-skip-permissions` path, `--model` / `--effort` actually changing agy's behavior, and the best-effort touched-files detection (`captureGitStatusSnapshot` / `diffGitStatusSnapshots` in `scripts/lib/agy.mjs`) against real file edits agy makes.
- **`--resume` / `--continue` / `--conversation`** — review jobs now capture a real `conversation_id` from the live envelope, but nothing has yet exercised actually resuming a specific one via `--conversation <id>`, or confirmed `--continue` picks up where a prior run left off across separate `agy --print` invocations.
- **The stop-time review gate** (`/agy:setup --enable-review-gate`) end-to-end, since it depends on a live `/agy:review`-equivalent run inside the `Stop` hook.
- **Background job execution** (`--background` on `review`, `adversarial-review`, and `task`): the detached-worker spawn/poll/tail-file mechanics are exercised by the unit tests for their pieces, and the one live test above ran in the foreground, so the background path hasn't been proven against a real `agy` process yet.

If you're picking this up with a working `agy` install: run through `/agy:setup`, `/agy:adversarial-review --wait`, and `/agy:rescue --wait "say hi"` next (review's foreground path is now confirmed), then try the background variants and `--resume`/`--conversation`.
