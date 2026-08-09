# agy-companion

Use Google's [Antigravity CLI](https://antigravity.google/) (`agy`) from inside Claude Code for code reviews or to delegate tasks — the same idea as Anthropic's `codex` plugin, but driving `agy` instead of Codex.

This plugin is a from-scratch port of the structure of the [`codex` Claude Code plugin](https://github.com/openai/codex-plugin-cc), adapted to `agy`'s much smaller and simpler CLI surface. It is **not** a drop-in behavioral clone — see [Differences from codex-plugin-cc](#differences-from-codex-plugin-cc) below before you rely on it for anything Codex's plugin does that this one doesn't.

Two earlier attempts at this same idea exist and are both dead ends: [`sakibsadmanshajib/gemini-plugin-cc`](https://github.com/sakibsadmanshajib/gemini-plugin-cc) is archived/deprecated, and [`sakibsadmanshajib/antigravity-plugin`](https://github.com/sakibsadmanshajib/antigravity-plugin) has open bug reports that its Claude Code slash commands are silent no-ops and that its documented install command doesn't match its actual marketplace name. This README tries hard not to repeat that pattern — every claim below about what works was either verified against `agy` 1.0.1's real CLI surface (see [Differences from codex-plugin-cc](#differences-from-codex-plugin-cc)) or is explicitly marked as unverified in [docs/TESTING.md](docs/TESTING.md).

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

Unlike `codex-plugin-cc`, there is no `--model` or `--effort` flag — `agy` 1.0.1 exposes neither a model-selection nor a reasoning-effort flag, so there's nothing for this plugin to forward. See [Differences from codex-plugin-cc](#differences-from-codex-plugin-cc).

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

`agy` (Antigravity CLI 1.0.1) has a fundamentally smaller CLI surface than Codex's app-server. This section is deliberately explicit about what that means in practice, so this plugin doesn't repeat the overpromising that sank the two prior attempts at this idea.

**Confirmed firsthand**: the facts below about `agy`'s actual flags, subcommands, and auth behavior come from a hands-on spike against a real `agy` 1.0.1 install (recorded in the now-archived `antigravity-plugin` project's `docs/SPIKE-findings.md`), not from documentation or assumption.

- **No native structured-output enforcement.** Codex's app-server accepts an `outputSchema` parameter and validates the model's JSON response against it server-side before this plugin ever sees the output. `agy --print` has no equivalent — it just prints whatever the model returns. `/agy:review` and `/agy:adversarial-review` instead ask for JSON in the prompt (`prompts/review.md`, `prompts/adversarial-review.md`) and validate the response locally against `schemas/review-output.schema.json` (a dependency-free validator in `scripts/lib/schema-validate.mjs`). If the first response doesn't parse or doesn't match the schema, agy-companion retries **exactly once** with a corrective `agy --continue` prompt before giving up and showing you the parse error. This is strictly weaker than Codex's guarantee — a well-behaved model usually follows the instruction, but nothing forces it to.
- **OAuth-only auth, no headless path.** `agy --print` blocks on first use with a Google OAuth URL printed to stdout and waits for either a browser completion or a pasted authorization code — there is no API-key or non-interactive login in `agy` 1.0.1 (tracked upstream: [`google-antigravity/antigravity-cli#78`](https://github.com/google-antigravity/antigravity-cli/issues/78)). Because agy-companion always runs `agy` non-interactively, it cannot complete that prompt. Instead, `scripts/lib/agy.mjs` watches stdout for the "Authentication required" string, extracts the login URL, and immediately kills the process and surfaces the URL through `/agy:status` / `/agy:result` rather than letting the job hang. You still have to open that URL yourself and rerun the command afterward. `/agy:setup` therefore cannot report real login state either — it can only confirm the `agy` binary is on `PATH`.
- **No `/agy:transfer`.** Codex's `/codex:transfer` uses a Codex-specific external-agent session importer to turn a Claude Code transcript into a resumable Codex thread. `agy` has no documented equivalent, and this plugin does not invent one.
- **No per-job resume, only "continue the last conversation."** Codex's app-server returns a real thread id for every run, so `codex resume <session-id>` can target one specific past job precisely. `agy --print` returns no such id — the only resume primitive `agy` exposes is `--continue` ("resume the most recent conversation") and `--conversation <id>` (but nothing in `agy`'s own output tells you what id a given `--print` run used). So `/agy:rescue --resume` here always means "continue agy's own most-recently-used conversation," not "resume this specific earlier job." If you run two rescue jobs back to back and then `--resume`, you get agy's latest conversation, which may not be the job you meant.
- **No `--model` / `--effort`.** `agy` 1.0.1 has no model-selection or reasoning-effort flag at all (Codex has both, plus a `spark` alias this plugin does not need to replicate). `/agy:rescue` therefore has no `--model` or `--effort` option; asking for one gets a message saying agy-companion can't honor it, not a silently ignored flag.
- **No live progress stream.** Codex's app-server emits structured `item/started` / `item/completed` events (commands running, files being edited, reasoning summaries) that the Codex plugin turns into a live phase indicator. `agy --print` gives no equivalent — it's silent until it prints the final answer. `/agy:status` on a running job can only show a raw tail of stdout/stderr as it arrives, not a phase like "editing" or "verifying".
- **Best-effort touched-files detection, not a guarantee.** For `--write` task runs, this plugin snapshots `git status --porcelain` before and after the run and diffs them (`captureGitStatusSnapshot` / `diffGitStatusSnapshots` in `scripts/lib/agy.mjs`) to approximate which files agy touched. Codex's app-server reports this as a structured, authoritative list of file-change items; this plugin's version can miss changes outside a git repository or to gitignored files, and can't distinguish agy's edits from unrelated concurrent changes.
- **Single host: Claude Code only**, matching the scope of the reference `codex` plugin. No Codex-CLI hosting, no native `agy` plugin-host support, no standalone `npx` mode — just `.claude-plugin/plugin.json`.
- **Live end-to-end testing against a real `agy` process has not been done.** This plugin was built and unit-tested in an environment with no `agy` binary and no Google account to complete OAuth. Everything that talks to a real `agy` process — the review prompts actually producing valid schema-matching JSON, the OAuth-prompt-detection regex against agy's real output, `--resume`/`--continue` behavior, and `--write` task execution — is unit-tested against a mocked `child_process.spawn`, not a live binary. See [docs/TESTING.md](docs/TESTING.md) for exactly what is and isn't covered, and what to smoke-test once you have a working `agy` install.

### Judgment calls made during the port

A few decisions weren't fully specified by "port `codex` to drive `agy`" and needed a call:

- **`/agy:review` needed its own prompt file.** Codex's `/codex:review` doesn't use a prompt template at all — it calls the app-server's built-in `review/start` RPC, which has no `agy` equivalent. Since `agy` has no native reviewer, `/agy:review` needed a prompt (`prompts/review.md`) the same way `/agy:adversarial-review` does; it just wasn't in the original list of files this project's brief said to port over. It's a plain, non-adversarial review-JSON prompt, separate from the adversarial one.
- **`--add-dir` isn't exposed at the command layer.** `agy --add-dir <path>` (repeatable) is real and supported in `scripts/lib/agy.mjs`, but no `/agy:*` command surfaces it yet — every run is scoped to the resolved workspace root. Add it to a command's argument-hint if you need multi-directory context.
- **Job records track `conversationResumable: true/false` instead of a thread id**, since there's no id to store (see "No per-job resume" above). `render.mjs` and the status/result commands were adjusted accordingly.

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
