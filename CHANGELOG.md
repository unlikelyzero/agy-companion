# Changelog

## 0.1.0

- Initial release: `/agy:review`, `/agy:adversarial-review`, `/agy:rescue`, `/agy:status`, `/agy:result`, `/agy:cancel`, `/agy:setup`, the `agy-rescue` subagent, and the optional stop-time review gate.
- Ported from the structure of the `codex` Claude Code plugin, adapted to drive Google's Antigravity CLI (`agy`) instead of OpenAI's Codex CLI. See the README's "Differences from codex-plugin-cc" section for what changed and why.
- Live end-to-end testing against a real `agy` process has not been done yet — see `docs/TESTING.md`.
