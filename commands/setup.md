---
description: Check whether the local agy CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" setup --json $ARGUMENTS
```

Output rules:
- Present the setup output to the user.
- agy has no headless way to check login state (unlike Codex's `account/read`), so this command can only confirm the `agy` binary is installed. If the report says agy is missing, tell the user to install the Antigravity CLI and rerun `/agy:setup`.
- If agy is installed, tell the user that login is only confirmed by running a real command (`/agy:review`, `/agy:rescue`, etc.) — if agy needs Google OAuth login, it will report a login URL through `/agy:status` for that job instead of hanging.
- Do not attempt to run `agy login` or any interactive login flow yourself; agy 1.0.1 has no non-interactive login path.
