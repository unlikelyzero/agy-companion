---
description: Check whether the local agy CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate|--skip-tool-probe|--doctor]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" setup --json $ARGUMENTS
```

Output rules:
- Present the setup output to the user.
- If the report says agy is missing, tell the user to install the Antigravity CLI and rerun `/agy:setup`.
- If agy is installed, the report's `auth` field reflects a real, free login check (`agy -p "/quota" --output-format json`, a print-mode command that spends no quota and starts no agent turn — see `.github/agy-tested-version` for the version this was verified against). `auth.loggedIn: true` means signed in; `auth.loggedIn: false` means not signed in, and `auth.authUrl` has the OAuth URL to visit; `auth.loggedIn: null` means the check itself failed for an unrelated reason (offline, older agy, etc.) — in that case, fall back to telling the user that a real command like `/agy:review` will report a login URL if one is needed.
- Do not attempt to run `agy login` or any interactive login flow yourself.
- The report's `toolPermission` field comes from a live probe that asks agy to run one trivial shell command through `agy --print`. It is the only check here that starts a real agent turn (the `auth` check deliberately does not), so it is the only one that can see a headless tool-permission failure — and it costs a small amount of quota. `ok: true` means headless tool calls work; `ok: false` means agy soft-denied the call, so `/agy:review` and `/agy:adversarial-review` cannot return findings on this install while `/agy:rescue` and `/agy:task --write` still work (they pass `--dangerously-skip-permissions`); `ok: null` means the probe was skipped or could not complete. `ready` is only true when this probe passes.
- Pass `--skip-tool-probe` to skip the probe (and spend no quota); the report then shows `toolPermission.ok: null` and `ready: false`.
- Pass `--doctor` for a deeper diagnostic pass, useful when someone needs to paste a single report into a bug instead of running several commands by hand. Adds a `doctor` block: `agyVersion` vs. `testedVersion` (the version last verified against, from `.github/agy-tested-version` — a mismatch is informational, not necessarily a problem), `capabilities` (which flags this plugin depends on the installed `agy --help` actually recognizes — free, no agent turn), `models`/`agents` list results (also free), `stateDirectory` (path and whether it's writable — job tracking depends on this), `gitRepository`, and `activeJobs`. `--doctor` composes with everything above; it does not change what the tool-permission probe does or replace it.
