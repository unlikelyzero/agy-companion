# Changelog

## Unreleased

- Compatibility pass against agy `1.1.12` (bumped from `1.1.11`): live `/agy:review --scope working-tree` and `/agy:adversarial-review --scope working-tree` runs both produced correctly rendered, schema-conformant results end to end. `.github/agy-tested-version` is now `1.1.12`.
- Stopped hardcoding the exact tested agy version as a literal string across README/docs/agent prompts, since that already drifted out of sync after the first version bump. Present-tense compatibility claims now point at `.github/agy-tested-version` instead of repeating the number; `AgyUnsupportedFeatureError`'s message reads that file at runtime so it can't go stale independently of it.
- Resolved the `agy` binary via `PATH` with a fallback to common install directories (`~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`) when a non-login shell's `PATH` doesn't include it, and surfaced the resolved path through `/agy:setup`.
- Tolerated near-miss structured-output payloads from `agy`'s Gemini backend (a top-level `status` field instead of `verdict`, a missing `next_steps` array, findings missing `severity`) instead of rejecting them outright, and tightened the review/adversarial-review prompt templates to spell out the exact field-name contract.

## 0.1.0

- Initial release: `/agy:review`, `/agy:adversarial-review`, `/agy:rescue`, `/agy:status`, `/agy:result`, `/agy:cancel`, `/agy:setup`, the `agy-rescue` subagent, and the optional stop-time review gate.
- Ported from the structure of the `codex` Claude Code plugin, adapted to drive Google's Antigravity CLI (`agy`) instead of OpenAI's Codex CLI. See the README's "Differences from codex-plugin-cc" section for what changed and why.
- Corrected before first publish, after testing against a real, authenticated `agy 1.1.11` install (the plugin was originally built against third-party notes for `agy 1.0.1`, which were stale by the time a live install was available): `agy` does have native structured-output enforcement (`--output-format json --json-schema <path>`), and does have real `--model` / `--effort` flags. `/agy:review` and `/agy:adversarial-review` now use native schema enforcement instead of a prompt-and-retry fallback, and `/agy:rescue` forwards `--model` / `--effort`. A live `/agy:review --scope working-tree` run against a real diff confirmed the whole pipeline end to end. See `docs/TESTING.md` for what's still only unit-tested.
