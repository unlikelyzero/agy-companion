---
name: agy-result-handling
description: Internal guidance for presenting agy helper output back to the user
user-invocable: false
---

# agy Result Handling

When the helper returns agy output:
- Preserve the helper's verdict, summary, findings, and next steps structure.
- For review output, present findings first and keep them ordered by severity.
- Use the file paths and line numbers exactly as the helper reports them.
- If there are no findings, say that explicitly and keep the residual-risk note brief.
- If agy made edits, say so explicitly and list the touched files when the helper provides them (best-effort — agy-companion detects touched files via a `git status` diff before/after the run, not a structured file-change protocol, so this list can be incomplete outside a git repository or for changes agy makes to ignored files).
- If `/agy:rescue` sent agy a normalized implementation contract (see `commands/rescue.md`) rather than a raw request, check the result against that contract's own "Acceptance Criteria" and "How to Verify" sections before calling the run done. Say plainly which criteria the result appears to satisfy and which it doesn't or can't be confirmed from the output alone — this is a check against what was asked for, not a second implementation attempt, and it does not replace recommending `/agy:review` the way any `--write` run already does below.
- For `agy:agy-rescue`, do not turn a failed or incomplete agy run into a Claude-side implementation attempt. Report the failure and stop.
- For `agy:agy-rescue`, if agy was never successfully invoked, do not generate a substitute answer at all.
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Do not fix any issues. You MUST explicitly ask the user which issues, if any, they want fixed before touching a single file. Auto-applying fixes from a review is strictly forbidden, even if the fix is obvious.
- If the helper reports malformed JSON output from a review command, say so and include the parse error — agy-companion already retried once internally with a corrective prompt before giving up, so do not retry a third time yourself.
- If the helper reports that a tool call was denied (a `toolDenial` field, or output naming a soft-denied permission), do not describe it as malformed output or a schema problem — it is neither. agy 1.1.3+ soft-denies tool calls it cannot get confirmation for in headless mode, ending the run with an empty response and exit 0. Report the denied permission, tell the user `/agy:review` cannot work on this install while `/agy:rescue` and `/agy:task --write` still can, and point them at `/agy:setup` to confirm. Do not retry the review, and do not edit `~/.gemini/antigravity-cli/settings.json` to try to fix it — `permissions.allow` is reported upstream as ignored in print mode (google-antigravity/antigravity-cli#548).
- If the helper reports that agy needs Google OAuth login (its output or error will mention a login URL), surface that URL prominently and stop. Do not attempt to complete the login yourself; there is no non-interactive way to do so with agy 1.0.1.
- If the helper reports that agy is missing entirely, direct the user to `/agy:setup` and do not improvise alternate install or auth flows.
