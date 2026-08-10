# Changelog

## 0.1.0

- Initial release: `/agy:review`, `/agy:adversarial-review`, `/agy:rescue`, `/agy:status`, `/agy:result`, `/agy:cancel`, `/agy:setup`, the `agy-rescue` subagent, and the optional stop-time review gate.
- Ported from the structure of the `codex` Claude Code plugin, adapted to drive Google's Antigravity CLI (`agy`) instead of OpenAI's Codex CLI. See the README's "Differences from codex-plugin-cc" section for what changed and why.
- Corrected before first publish, after testing against a real, authenticated `agy 1.1.11` install (the plugin was originally built against third-party notes for `agy 1.0.1`, which were stale by the time a live install was available): `agy` does have native structured-output enforcement (`--output-format json --json-schema <path>`), and does have real `--model` / `--effort` flags. `/agy:review` and `/agy:adversarial-review` now use native schema enforcement instead of a prompt-and-retry fallback, and `/agy:rescue` forwards `--model` / `--effort`. A live `/agy:review --scope working-tree` run against a real diff confirmed the whole pipeline end to end. See `docs/TESTING.md` for what's still only unit-tested.
