---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the agy rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model>] [--effort <low|medium|high>] [--agent <agent>] [--mode <accept-edits|plan>] [what agy should investigate, solve, or continue]"
allowed-tools: Read, Glob, Grep, Bash(node:*), AskUserQuestion, Agent
---

Invoke the `agy:agy-rescue` subagent via the `Agent` tool (`subagent_type: "agy:agy-rescue"`), forwarding either the raw user request or a normalized implementation contract (see below) as the prompt.
`agy:agy-rescue` is a subagent, not a skill — do not call `Skill(agy:agy-rescue)` (no such skill) or `Skill(agy:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be agy's output verbatim.

Raw user request:
$ARGUMENTS

Normalizing substantial implementation requests:

- The subagent only has `Bash` — it cannot read the repository itself. This command runs inline with real tool access, so it is the right place to do this, not the subagent.
- Decide whether the request needs normalizing before forwarding it:
  - Skip normalizing for pure diagnosis/investigation/research ("investigate the failed tests", "why is X happening", "look into Y") — forward the raw request as-is, same as today. `--resume`/`--fresh` follow-ups (see below) also skip normalizing; they continue an existing conversation, not start a new contract.
  - Skip normalizing for a request that is already small and unambiguous (a one-line, single-file fix with an obvious scope).
  - Normalize a request that describes actual code changes with enough scope that agy's interpretation of "done" could plausibly diverge from the user's — spans more than one file, follows a plan the user or Claude just worked out (including a plan Claude produced via `ExitPlanMode` earlier in this session), or the user's own phrasing is underspecified about scope, verification, or what not to touch.
  - When genuinely unsure, prefer normalizing — a contract costs a little more upfront setup and meaningfully reduces the odds of agy solving a different problem than the one asked, or quietly touching more than intended.
- To normalize, build this contract using what you already know from the conversation and (only if needed to fill a section) light `Read`/`Glob`/`Grep` — do not launch a broad exploration pass; this is a light context primer, not a full plan review:

```
## Goal
<one or two sentences: what should be true when this is done>

## Repository Context
<the relevant existing code/pattern to follow, in a sentence or two — omit if nothing beyond the request itself is relevant>

## Acceptance Criteria
- <concrete, checkable outcomes — what a reviewer would check for>

## Files Likely Involved
- <path> — <why, if known>
(state plainly if this isn't known yet and agy should locate the right files itself)

## How to Verify
<the commands this repo actually uses — tests, build, lint — if known; otherwise say to use whatever the repo's own conventions call for>

## Guardrails
- Only change what's needed for the stated goal — no unrelated cleanup, refactors, or scope creep.
- Follow this repository's existing conventions and any CLAUDE.md/AGENTS.md instructions already in scope.
- <any other constraint this specific request implies — files or areas explicitly out of scope, behavior that must not change, etc.>

## Original Request
<the user's request, verbatim>
```

- Every section must be genuinely populated or explicitly marked unknown ("not known — agy should determine this") — never fabricate acceptance criteria, files, or verification steps that don't fit the actual request just to fill the shape.
- Pass the complete contract text as the forwarded request in place of the raw one-liner. Everything below that talks about "the request" applies to whichever of the two was actually forwarded.
- This adds one normalization pass, not a review cycle — do not iterate on the contract with the user or ask them to approve it before sending it to agy, except through the existing `--resume`/`--fresh` question below.

Execution mode:

- If the request includes `--background`, run the `agy:agy-rescue` subagent in the background.
- If the request includes `--wait`, run the `agy:agy-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model <model>` and `--effort <low|medium|high>` are runtime-selection flags agy genuinely supports (verified against a real `agy` install, `--effort` accepts exactly `low`, `medium`, or `high` — see `.github/agy-tested-version` for the version last checked). Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text. Leave both unset unless the user explicitly asks for a specific model or reasoning effort. `--model` is checked against agy's real model list (`agy --output-format json models`) before agy is spawned, so a typo or a guessed-wrong id fails fast with the list of real ids instead of agy rejecting it after the fact.
- `--agent <agent>` selects one of agy's custom agents (`agy --agent <agent>`) and `--mode <accept-edits|plan>` selects agy's execution mode (`agy --mode <mode>`) — both real flags, both forwarded the same way as `--model`/`--effort`. `--agent` is checked against agy's real agent list (`agy --output-format json agent`) the same way `--model` is. Leave both unset unless the user explicitly asks for a specific agent or mode.
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
- `--resume` targets this session's specific most-recent rescue job by its captured `conversation_id` (`agy --conversation <id>`), not agy's own "most-recently-used conversation" — so it stays correct even if a review or another task ran an agy process in between. A rescue job from before this capture existed has no `conversation_id` on record; `--resume` falls back to agy's `--continue` for that one job only.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task ...` and return that command's stdout as-is.
- Return the agy companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/agy:status`, fetch `/agy:result`, call `/agy:cancel`, summarize output, or do follow-up work of its own.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that agy is missing, stop and tell the user to run `/agy:setup`.
- If the helper's output shows agy is blocked on Google OAuth login, tell the user to visit the printed URL and try again — this plugin cannot complete an interactive login on your behalf.
- If the user did not supply a request, ask what agy should investigate or fix.

After a normalized, write-capable run finishes:

- Check the result against the contract's own "Acceptance Criteria" and "How to Verify" sections before treating the run as done — a check against what was asked for, not a second implementation attempt. See the `agy-result-handling` skill for how to present that check, or an incomplete/failed run.
- This check does not replace `/agy:review` — recommend it the same way the result-handling skill already does for any `--write` run, contract or not.
