# Security Policy

## Reporting a vulnerability

Please report security issues privately via [GitHub Security Advisories](https://github.com/unlikelyzero/agy-companion/security/advisories/new) rather than opening a public issue. Include reproduction steps and the `agy` and plugin versions involved. Expect an initial response within a few days.

## Scope and what to know before using this plugin

`agy-companion` is a thin wrapper: every `/agy:*` command spawns your local `agy` (Antigravity CLI) binary directly (`agy --print ...`). It does not run its own server, does not proxy your credentials, and does not transmit anything beyond what `agy` itself sends as part of your existing Google-authenticated session.

Because of that, this plugin inherits `agy`'s own execution model, and a few things are worth understanding before you enable the more autonomous features:

- **`/agy:rescue --mode accept-edits`** lets `agy` write to your working tree without per-change confirmation. Only use it in a repository and branch where you're comfortable with unreviewed automated edits, and review the diff before committing.
- **The stop-time review gate (`/agy:setup --enable-review-gate`)** can create a long-running Claude/agy loop. Only enable it when you plan to actively monitor the session — see the warning in [README.md](README.md#agysetup).
- **`agy`'s own sandbox and permission flags** (e.g. `--sandbox`, `--dangerously-skip-permissions`) are `agy`'s responsibility, not this plugin's, and have had surprising interactions reported upstream (see [google-antigravity/antigravity-cli#36](https://github.com/google-antigravity/antigravity-cli/issues/36)). If you pass elevated permission flags through to `agy`, understand what they do at the `agy` level first.
- **Job records and cached output** are stored locally under this plugin's state directory and are not encrypted at rest. Don't run background jobs against a repository or prompt containing secrets you wouldn't want written to local disk in plain text.

If you find a way for this plugin's own code (not `agy` itself) to escalate privileges, bypass the review gate's intent, or leak local job data, that's in scope for a report here. Vulnerabilities in `agy` itself should be reported upstream to the [Antigravity CLI project](https://github.com/google-antigravity/antigravity-cli).
