# Testing

## Continuous integration

Two GitHub Actions workflows run automatically:

- **`ci.yml`** — runs `npm test` on every push to `main` and every pull request, across Node 18.18/20/22/24 on Ubuntu and Node 18.18/24 on macOS (matching the floor `package.json`'s `engines.node` claims plus the latest). This covers everything mocked (see the next section) and needs no `agy` binary.
- **`agy-release-probe.yml`** — nightly (and on manual dispatch), installs the latest `agy` via the official install script on a hosted runner, confirms the binary runs, and compares `agy --version` against `.github/agy-tested-version` (the last version verified by hand). It also diffs `agy --help` against `.github/agy-help-snapshot.txt`, since a version bump alone doesn't say what actually changed — new/removed flags or subcommands are a more direct signal of what a compatibility pass needs to look at. When either the version or the `--help` output changed, it opens a tracking issue with the diff inline and prompts a manual compatibility pass.

Live integration testing cannot run on hosted CI: agy's only auth is interactive Google OAuth (no API key or service-account path — tracked upstream in google-antigravity/antigravity-cli#78, where Google has said API-key auth is unsupported and points CI users at the separate Antigravity SDK). When the probe files a new-release issue, run the manual checklist below against the new version, then bump `.github/agy-tested-version`.

## What's covered by `npm test`

`npm test` runs Node's built-in test runner (`node --test tests/*.test.mjs`) against everything that does not require a live `agy` binary or a real Google OAuth session:

- **Argument parsing** (`tests/args.test.mjs`): flag/positional parsing, `--key=value`, aliasing, `--` passthrough, quoted raw-argument splitting.
- **State persistence** (`tests/state.test.mjs`): the on-disk job/config store — defaults, config round-trips, job upsert/prune, job file read/write.
- **Job control** (`tests/job-control.test.mjs`): status snapshots (running/latest-finished/recent), job-reference resolution (exact id, unambiguous prefix, ambiguous prefix), cancel/result eligibility rules.
- **Rendering** (`tests/render.test.mjs`): Markdown output for setup, status, review results (well-formed, malformed JSON, schema-mismatched), task results, cancel reports.
- **Process helpers** (`tests/process.test.mjs`): binary-availability detection, command failure formatting, process-tree termination (with an injected `kill` implementation, so no real processes are touched).
- **JSON Schema validation** (`tests/schema-validate.test.mjs`): the local validator against `schemas/review-output.schema.json` — required fields, enums, nested finding objects, numeric ranges.
- **agy transport layer** (`tests/agy.test.mjs`): `runAgyPrompt`'s argument building (including `--model`, `--effort`, `--conversation`, `--output-format`, `--json-schema`), stdout/stderr capture, OAuth-prompt detection (`AgyAuthRequiredError`), missing-binary handling, unsupported-flag handling (`AgyUnsupportedFeatureError`), timeout handling, tail-file writing — all with `child_process.spawn` replaced by an injected fake (`spawnImpl`), never a real `agy` process. Also covers `runAgyStructured`'s parsing of agy's real `--output-format json` envelope shape (`parseAgyEnvelope`), `runAgyText`'s free-form envelope handling (including its raw-stdout fallback when the envelope doesn't parse), and the best-effort git-status-diff touched-files helper.
- **Review snapshotting** (`tests/review-snapshot.test.mjs`): the disposable working-tree copy `/agy:review` and `/agy:adversarial-review` run against — `.git` exclusion, gitignore handling, untracked/staged/unstaged content, agent-instruction file/directory stripping at depth and mixed casing, symlink-escape prevention, snapshot-hash stability, and cleanup. All against a real local git repo (`git init` in a temp dir), not mocked.
- **Provenance** (`tests/provenance.test.mjs`): `buildProvenance`'s field pass-through and all-`null` default shape, and `hashText`'s stability/null-handling. Pure functions, nothing to mock.

Run it with:

```bash
npm test
```

## What's now confirmed against a real, authenticated `agy` install

This plugin was originally built and unit-tested in an environment with no `agy` binary and no Google account available. That gap has been partially closed with a real, authenticated `agy` install (see [`.github/agy-tested-version`](../.github/agy-tested-version) for the exact version last checked), authenticated via the browser/paste-code OAuth flow:

- **`/agy:review`** and **`/agy:adversarial-review`**, foreground, via `--scope working-tree` against a real diff — both produced correctly rendered, schema-conformant results end to end, confirming `--output-format json --json-schema <path>` genuinely works as documented in the README, not just against mocked `spawn` output. Also confirmed against the disposable-snapshot review path (see below): a diff that planted a prompt-injection instruction in `AGENTS.md` was correctly reported as a finding rather than followed, and the large-diff (>256KB) self-collect fallback correctly read the full diff from a file inside the snapshot with no tool-call denials.
- **`/agy:rescue`** (the `task` command), foreground (`--wait`) and background (`--background`) — both produced correct results; `/agy:status` correctly reported a running job's live phase/progress-tail while it was in flight, and `/agy:result` correctly returned the stored output of a completed one.
- **`/agy:cancel`** — confirmed it doesn't just flip a status flag: the underlying `agy` process was actually gone (checked via `ps`) immediately after cancelling.
- **`--conversation <id>`, targeting one specific past job's conversation** — `/agy:rescue` now runs through `agy --output-format json` (`runAgyText`), so it captures a real `conversation_id` like review jobs already did. Confirmed live: ran a task, then a deliberately interleaved unrelated `/agy:review` (to try to hijack agy's own "most recently used conversation" pointer), then `--resume-last` — the resumed job's `conversation_id` matched the *original task's*, not the review's, and its response correctly recalled content only the original task conversation had been given. This replaces the `--resume-last` → `agy --continue` caveat below for any job with a captured `conversation_id`; `--continue` is now only the fallback for a job that predates this capture.
- **`/agy:rescue --write`** — confirmed the `--dangerously-skip-permissions` path runs and returns success for a file-creating prompt, but live testing surfaced an unconfirmed, unrelated oddity worth flagging separately: the file agy reported creating did not appear in the target repo — it landed under `~/.gemini/antigravity-cli/scratch/<name>` instead, reproduced independent of agy-companion by calling `agy --print ... --dangerously-skip-permissions` directly from the same repo. Not yet root-caused; `--model`/`--effort` actually changing agy's behavior and the best-effort touched-files detection (`captureGitStatusSnapshot` / `diffGitStatusSnapshots` in `scripts/lib/agy.mjs`) against a real *repo-local* edit remain unconfirmed as a result.
- **Provenance metadata** (`scripts/lib/provenance.mjs`) — confirmed live for both a review (`agyVersion`, `conversationId`, `gitHead`, and `scope`/`inputHash`/`reviewedPaths` sourced from the real snapshot all populated correctly) and a task run (`effort: "low"` correctly reflecting an explicit `--effort low` flag, `scope: "read-only"` correctly reflecting no `--write`), and confirmed `/agy:result --json` surfaces the same block back off the stored job record.

None of this covers everything. The rest of this list is still open:

- **The OAuth-prompt detection regex** (`AUTH_REQUIRED_PATTERN` / `URL_PATTERN` in `scripts/lib/agy.mjs`), against a real "Authentication required" prompt. All live tests so far have used an account that was already authenticated, so this path still hasn't fired against real agy output — only against fixtures in the unit tests. (Deliberately not tested by logging out, since that would be disruptive to whoever's running the check.)
- **The `~/.gemini/antigravity-cli/scratch/` file-creation redirect** noted above — whether it's specific to creating new files (vs. editing existing tracked ones), and whether it's an agy bug worth reporting upstream or a sandboxing behavior agy-companion needs to detect and warn on the way it already does for `unexpectedWrites`.
- **The stop-time review gate** (`/agy:setup --enable-review-gate`) end-to-end, since it depends on a live `/agy:review`-equivalent run inside the `Stop` hook. (Deliberately not tested in-session, since it can create a long-running loop against whatever session enables it.)

If you're picking this up with a working `agy` install and want to extend this list: the scratch-dir redirect and the OAuth-prompt path are the two most useful gaps to close next.
