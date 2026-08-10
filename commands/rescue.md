---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the agy rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model>] [--effort <low|medium|high>] [what agy should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `agy:agy-rescue` subagent via the `Agent` tool (`subagent_type: "agy:agy-rescue"`), forwarding the raw user request as the prompt.
`agy:agy-rescue` is a subagent, not a skill — do not call `Skill(agy:agy-rescue)` (no such skill) or `Skill(agy:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be agy's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `agy:agy-rescue` subagent in the background.
- If the request includes `--wait`, run the `agy:agy-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model <model>` and `--effort <low|medium|high>` are runtime-selection flags agy genuinely supports (verified against a real `agy 1.1.11` install — `--effort` accepts exactly `low`, `medium`, or `high`). Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text. Leave both unset unless the user explicitly asks for a specific model or reasoning effort.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting agy, check for a resumable rescue conversation from this repo by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue agy's most-recent conversation or start a new one.
- The two choices must be:
  - `Continue current agy conversation`
  - `Start a new agy conversation`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current agy conversation (Recommended)` first.
- Otherwise put `Start a new agy conversation (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new conversation, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.
- Unlike Codex's `codex resume <session-id>`, agy gives no way to capture or target a specific past conversation id — `--resume` here always means "continue agy's own most-recently-used conversation" (agy's `--continue` flag), not this specific job's thread. Tell the user this if they ask to resume a job other than the most recent one.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task ...` and return that command's stdout as-is.
- Return the agy companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/agy:status`, fetch `/agy:result`, call `/agy:cancel`, summarize output, or do follow-up work of its own.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that agy is missing, stop and tell the user to run `/agy:setup`.
- If the helper's output shows agy is blocked on Google OAuth login, tell the user to visit the printed URL and try again — this plugin cannot complete an interactive login on your behalf.
- If the user did not supply a request, ask what agy should investigate or fix.
