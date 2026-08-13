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
- If the report says agy is missing, tell the user to install the Antigravity CLI and rerun `/agy:setup`.
- If agy is installed, the report's `auth` field reflects a real, free login check (`agy -p "/quota" --output-format json`, a print-mode command that spends no quota and starts no agent turn — see `.github/agy-tested-version` for the version this was verified against). `auth.loggedIn: true` means signed in; `auth.loggedIn: false` means not signed in, and `auth.authUrl` has the OAuth URL to visit; `auth.loggedIn: null` means the check itself failed for an unrelated reason (offline, older agy, etc.) — in that case, fall back to telling the user that a real command like `/agy:review` will report a login URL if one is needed.
- Do not attempt to run `agy login` or any interactive login flow yourself.
