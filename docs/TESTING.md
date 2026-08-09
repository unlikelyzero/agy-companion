# Testing

## What's covered by `npm test`

`npm test` runs Node's built-in test runner (`node --test tests/*.test.mjs`) against everything that does not require a live `agy` binary or a real Google OAuth session:

- **Argument parsing** (`tests/args.test.mjs`): flag/positional parsing, `--key=value`, aliasing, `--` passthrough, quoted raw-argument splitting.
- **State persistence** (`tests/state.test.mjs`): the on-disk job/config store — defaults, config round-trips, job upsert/prune, job file read/write.
- **Job control** (`tests/job-control.test.mjs`): status snapshots (running/latest-finished/recent), job-reference resolution (exact id, unambiguous prefix, ambiguous prefix), cancel/result eligibility rules.
- **Rendering** (`tests/render.test.mjs`): Markdown output for setup, status, review results (well-formed, malformed JSON, schema-mismatched), task results, cancel reports.
- **Process helpers** (`tests/process.test.mjs`): binary-availability detection, command failure formatting, process-tree termination (with an injected `kill` implementation, so no real processes are touched).
- **JSON Schema validation** (`tests/schema-validate.test.mjs`): the local validator against `schemas/review-output.schema.json` — required fields, enums, nested finding objects, numeric ranges.
- **agy transport layer** (`tests/agy.test.mjs`): `runAgyPrompt`'s argument building, stdout/stderr capture, OAuth-prompt detection (`AgyAuthRequiredError`), missing-binary handling, timeout handling, tail-file writing — all with `child_process.spawn` replaced by an injected fake (`spawnImpl`), never a real `agy` process. Also covers the retry-once-on-malformed-JSON logic in `runAgyStructured` and the best-effort git-status-diff touched-files helper.

Run it with:

```bash
npm test
```

## What is NOT tested here, and needs a human with a real `agy` install

This plugin was built and verified in an environment where `agy` is not installed and no Google account was available to complete OAuth. The following have only been sanity-checked at the "does it fail gracefully" level (e.g. `/agy:setup` correctly reporting "agy CLI is not installed or is not on PATH" rather than crashing) and still need a live smoke test once you have `agy` installed and authenticated:

- **A real `/agy:review` and `/agy:adversarial-review` run** end-to-end: does `agy --print` actually return JSON that matches `schemas/review-output.schema.json` when asked to, or does it need prompt tuning beyond what's in `prompts/review.md` / `prompts/adversarial-review.md`? The retry-once-on-malformed-output path is unit-tested with fake output, but never against agy's actual JSON-following behavior.
- **The OAuth-prompt detection regex** (`AUTH_REQUIRED_PATTERN` / `URL_PATTERN` in `scripts/lib/agy.mjs`) against agy's actual login-prompt text and URL formatting. It's modeled on the exact strings captured in a real spike against `agy` 1.0.1 (see the README), but agy's copy could change between versions.
- **`/agy:rescue`** end-to-end, including the `--write` / `--dangerously-skip-permissions` path and the best-effort touched-files detection (`captureGitStatusSnapshot` / `diffGitStatusSnapshots` in `scripts/lib/agy.mjs`) against real file edits agy makes.
- **`--resume` / `--continue`** actually resuming agy's most-recent conversation the way this plugin assumes, including across `agy --print` invocations spawned from different working directories or Claude sessions.
- **The stop-time review gate** (`/agy:setup --enable-review-gate`) end-to-end, since it depends on a live `/agy:review`-equivalent run inside the `Stop` hook.
- **Background job execution** (`--background` on `review`, `adversarial-review`, and `task`): the detached-worker spawn/poll/tail-file mechanics are exercised by the unit tests for their pieces, but not as a full background run against a real `agy` process.

If you're picking this up with a working `agy` install: run through `/agy:setup`, `/agy:review --wait`, `/agy:adversarial-review --wait`, and `/agy:rescue --wait "say hi"` first, then try the background variants and `--resume`.
