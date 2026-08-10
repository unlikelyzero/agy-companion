# agy-companion

Use Google's [Antigravity CLI](https://antigravity.google/) (`agy`) from inside Claude Code for code reviews or to delegate tasks — the same idea as Anthropic's `codex` plugin, but driving `agy` instead of Codex.

This plugin is a from-scratch port of the structure of the [`codex` Claude Code plugin](https://github.com/openai/codex-plugin-cc), adapted to `agy`'s much smaller and simpler CLI surface. It is **not** a drop-in behavioral clone — see [Differences from codex-plugin-cc](#differences-from-codex-plugin-cc) below before you rely on it for anything Codex's plugin does that this one doesn't.

Two earlier attempts at this same idea exist and are both dead ends: [`sakibsadmanshajib/gemini-plugin-cc`](https://github.com/sakibsadmanshajib/gemini-plugin-cc) is archived/deprecated, and [`sakibsadmanshajib/antigravity-plugin`](https://github.com/sakibsadmanshajib/antigravity-plugin) has open bug reports that its Claude Code slash commands are silent no-ops and that its documented install command doesn't match its actual marketplace name. This README tries hard not to repeat that pattern — every claim below about what works has now been verified against a real, authenticated `agy 1.1.11` install (including a live end-to-end `/agy:review` run), not just documentation or mocked tests. See [Differences from codex-plugin-cc](#differences-from-codex-plugin-cc) for what's still genuinely unverified.

## What You Get

- `/agy:review` for a code review of your current work
- `/agy:adversarial-review` for a steerable challenge review
- `/agy:rescue`, `/agy:status`, `/agy:result`, and `/agy:cancel` to delegate work and manage background jobs
- An optional stop-time review gate (`/agy:setup --enable-review-gate`)

## Requirements

- The [Antigravity CLI](https://antigravity.google/) (`agy`) installed and on `PATH`, signed in with a Google account. `agy` has no headless/API-key auth path (see below).
- Node.js 18.18 or later.

## Install

See [docs/INSTALL.md](docs/INSTALL.md) for the full walkthrough. Short version:

```bash
/plugin marketplace add unlikelyzero/agy-companion
/plugin install agy@agy-companion
/reload-plugins
/agy:setup
```

`/agy:setup` tells you whether the `agy` binary is on `PATH`. It cannot tell you whether you're logged in without running a real command — see [Differences from codex-plugin-cc](#differences-from-codex-plugin-cc).

One simple first run:

```bash
/agy:review --background
/agy:status
/agy:result
```

## Usage

### `/agy:review`

Runs an agy code review on your current work.

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/agy:adversarial-review`](#agyadversarial-review) when you want to challenge a specific decision or risk area.

```bash
/agy:review
/agy:review --base main
/agy:review --background
```

This command is read-only. When run in the background you can use [`/agy:status`](#agystatus) to check on progress and [`/agy:cancel`](#agycancel) to cancel it.

### `/agy:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design, the same way as `codex-plugin-cc`'s `/codex:adversarial-review`.

```bash
/agy:adversarial-review
/agy:adversarial-review --base main challenge whether this was the right caching and retry design
/agy:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/agy:rescue`

Hands a task to `agy` through the `agy-rescue` subagent.

```bash
/agy:rescue investigate why the tests started failing
/agy:rescue fix the failing test with the smallest safe patch
/agy:rescue --resume apply the top fix from the last run
/agy:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to agy:

```text
Ask agy to redesign the database connection to be more resilient.
```

Pass `--model <model>` or `--effort <low|medium|high>` to control which model agy uses and how hard it thinks:

```bash
/agy:rescue --model gemini-3-pro --effort high investigate why the build is failing in CI
```

### `/agy:status`

Shows running and recent agy jobs for the current repository.

```bash
/agy:status
/agy:status task-abc123
```

### `/agy:result`

Shows the final stored agy output for a finished job.

```bash
/agy:result
/agy:result task-abc123
```

### `/agy:cancel`

Cancels an active background agy job.

```bash
/agy:cancel
/agy:cancel task-abc123
```

### `/agy:setup`

Checks whether the `agy` binary is on `PATH`, and can toggle the stop-time review gate:

```bash
/agy:setup --enable-review-gate
/agy:setup --disable-review-gate
```

> [!WARNING]
> The review gate can create a long-running Claude/agy loop and may drain your `agy` usage quickly. Only enable it when you plan to actively monitor the session.

## Differences from codex-plugin-cc

`agy` (Antigravity CLI) has a smaller CLI surface than Codex's app-server, though a real one — not as thin as it first looked. This section is deliberately explicit about what's actually different, so this plugin doesn't repeat the overpromising that sank the two prior attempts at this idea.

**A cautionary tale worth stating up front**: this project was first built against third-party spike notes written for `agy 1.0.1`, which found no native structured-output flag, no `--model`, and no `--effort`. Once a real, authenticated `agy 1.1.11` was available to test against, all three turned out to exist. The CLI moved fast between those two versions and the earlier notes were simply stale by the time this plugin shipped. Every claim below has now been checked against a live `agy 1.1.11` process — including a real `/agy:review` run that produced valid, schema-conformant JSON end to end — but if you're reading this on a much newer `agy`, re-verify anything that seems suspicious rather than trusting either this document or the version pinned in it.

- **Native structured-output enforcement, via `--output-format json --json-schema <path>`.** This was the biggest correction. `agy --print --output-format json --json-schema schemas/review-output.schema.json` returns a single JSON envelope (`{conversation_id, status, response, structured_output, ...}`) where `structured_output` is already schema-conformant — confirmed with a live call that returned exactly the shape requested. `/agy:review` and `/agy:adversarial-review` (`scripts/lib/agy.mjs`'s `runAgyStructured`) use this directly and still run one local validation pass against `schemas/review-output.schema.json` as defense in depth, but no longer need a prompt-and-retry fallback the way earlier drafts assumed. If a future `agy` build ever rejects `--json-schema` as unrecognized, that surfaces as a clear `AgyUnsupportedFeatureError` pointing at `agy update`, not a silent fallback.
- **`--model` and `--effort` are real and forwarded.** `agy 1.1.11` accepts `--model <model>` and `--effort <low|medium|high>` for a single invocation. `/agy:rescue --model <model> --effort <low|medium|high> ...` forwards both through to `agy`.
- **OAuth-only auth, no headless path.** `agy --print` blocks on first use, prints a Google sign-in URL, and waits for you to complete the browser flow and (in the version tested) paste an authorization code back into the terminal — there is no API-key or non-interactive login yet (tracked upstream: [`google-antigravity/antigravity-cli#78`](https://github.com/google-antigravity/antigravity-cli/issues/78)). Because agy-companion always runs `agy` non-interactively, it cannot complete that prompt itself. `scripts/lib/agy.mjs` instead watches stdout for the "Authentication required" string, extracts the login URL, and immediately kills the process and surfaces the URL through `/agy:status` / `/agy:result` rather than letting the job hang. You still have to open that URL yourself and rerun the command afterward. `/agy:setup` cannot report real login state either — it can only confirm the `agy` binary is on `PATH`, since probing auth would mean spending a real request and possibly hitting this same interactive prompt. (Note: this detection logic is unit-tested but not yet exercised against a live OAuth-required prompt, since the account used for testing was already authenticated — see [docs/TESTING.md](docs/TESTING.md).)
- **No `/agy:transfer`.** Codex's `/codex:transfer` uses a Codex-specific external-agent session importer to turn a Claude Code transcript into a resumable Codex thread. `agy` has no documented equivalent, and this plugin does not invent one.
- **Partial per-job resume.** `agy`'s JSON envelope does include a real `conversation_id` — `/agy:review` and `/agy:adversarial-review` now capture and store it per job. But `/agy:rescue` (the `task` path) runs in plain-text mode, not `--output-format json`, so it has no envelope to read a `conversation_id` from; `--resume` there still only means `agy --continue` ("resume the most recent conversation"), not a specific earlier job. Wiring `task` through the JSON envelope too, so rescue jobs get precise resume, is a reasonable follow-up someone should pick up.
- **No live progress stream.** Codex's app-server emits structured `item/started` / `item/completed` events (commands running, files being edited, reasoning summaries) that the Codex plugin turns into a live phase indicator. `agy --print` gives no equivalent — it's silent until it prints the final answer. `/agy:status` on a running job can only show a raw tail of stdout/stderr as it arrives, not a phase like "editing" or "verifying".
- **Best-effort touched-files detection, not a guarantee.** For `--write` task runs, this plugin snapshots `git status --porcelain` before and after the run and diffs them (`captureGitStatusSnapshot` / `diffGitStatusSnapshots` in `scripts/lib/agy.mjs`) to approximate which files agy touched. Codex's app-server reports this as a structured, authoritative list of file-change items; this plugin's version can miss changes outside a git repository or to gitignored files, and can't distinguish agy's edits from unrelated concurrent changes.
- **Single host: Claude Code only**, matching the scope of the reference `codex` plugin. No Codex-CLI hosting, no native `agy` plugin-host support, no standalone `npx` mode — just `.claude-plugin/plugin.json`.
- **What's been live-tested vs. what's still mock-only.** Confirmed against a real, authenticated `agy 1.1.11`: binary/version detection, and a full `/agy:review --scope working-tree` run producing valid structured output end to end. Still only unit-tested against a mocked `child_process.spawn`, not a live process: the OAuth-required detection path (the test account was already logged in), `/agy:adversarial-review`, background job execution and `/agy:status` polling on a real running job, `--write` task execution and touched-files detection, and `--resume`/`--continue`/`--conversation` behavior. See [docs/TESTING.md](docs/TESTING.md) for the current split and what to smoke-test next.

### Judgment calls made during the port

A few decisions weren't fully specified by "port `codex` to drive `agy`" and needed a call:

- **`/agy:review` needed its own prompt file.** Codex's `/codex:review` doesn't use a prompt template at all — it calls the app-server's built-in `review/start` RPC, which has no `agy` equivalent. Since `agy` has no native reviewer, `/agy:review` needed a prompt (`prompts/review.md`) the same way `/agy:adversarial-review` does; it just wasn't in the original list of files this project's brief said to port over. It's a plain, non-adversarial review-JSON prompt, separate from the adversarial one.
- **`--add-dir` isn't exposed at the command layer.** `agy --add-dir <path>` (repeatable) is real and supported in `scripts/lib/agy.mjs`, but no `/agy:*` command surfaces it yet — every run is scoped to the resolved workspace root. Add it to a command's argument-hint if you need multi-directory context.
- **Job records still carry a blanket `conversationResumable: true/false` flag alongside the real `conversationId`** now captured in review payloads (see "Partial per-job resume" above). The flag predates that capture and nothing currently branches on `conversationId` to make `--resume` job-specific instead of "most recent" — that's the follow-up work referenced above, not yet done.

## Typical Flows

### Review Before Shipping

```bash
/agy:review
```

### Hand A Problem To agy

```bash
/agy:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/agy:adversarial-review --background
/agy:rescue --background investigate the flaky test
```

Then check in with:

```bash
/agy:status
/agy:result
```

## FAQ

### Do I need a separate agy account for this plugin?

If you're already signed into `agy` on this machine, that login is what this plugin uses — there's no separate agy-companion account or auth layer. If `agy` isn't signed in yet, the first real command you run will surface a Google OAuth URL through `/agy:status`; visit it, then rerun the command.

### Does the plugin use a separate agy runtime?

No. Every `/agy:*` command spawns your local `agy` CLI directly (`agy --print ...`). There is no shared background runtime or broker process — unlike Codex's app-server, which this plugin's model was built to be simpler than on purpose, since `agy` has nothing to connect a broker to.

### Can I use this without ever authenticating agy?

No. Every command that actually talks to `agy` requires you to complete `agy`'s Google OAuth flow at least once. `/agy:setup` will tell you if the binary itself is missing, but not whether you're logged in.

## Testing

See [docs/TESTING.md](docs/TESTING.md) for what `npm test` covers (arg parsing, state, job control, rendering, process helpers, schema validation, and the agy transport layer with a mocked `child_process.spawn`) versus what still needs a human with a real, authenticated `agy` install to verify.

## License

Apache-2.0. See [LICENSE](LICENSE).
