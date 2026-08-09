# Installing agy-companion

## Requirements

- Node.js 18.18 or later (agy-companion's own scripts).
- The [Antigravity CLI](https://antigravity.google/) (`agy`) installed and on `PATH`. agy-companion does not bundle or install it for you.
- A Google account able to complete the OAuth login flow `agy` requires. There is no headless / API-key auth path in `agy` 1.0.1 (tracked upstream: [`google-antigravity/antigravity-cli#78`](https://github.com/google-antigravity/antigravity-cli/issues/78)).

## Add the marketplace and install the plugin

In Claude Code:

```bash
/plugin marketplace add unlikelyzero/agy-companion
/plugin install agy@agy-companion
/reload-plugins
```

Then run:

```bash
/agy:setup
```

`/agy:setup` checks whether the `agy` binary is on `PATH`. It cannot check login state without invoking a real command — see the README's "Differences from codex-plugin-cc" section for why. If `agy` is missing, install it from [antigravity.google](https://antigravity.google/) and rerun `/agy:setup`.

## First run

The very first `/agy:review`, `/agy:adversarial-review`, or `/agy:rescue` call may trigger `agy`'s Google OAuth login flow. `agy` prints a login URL to stdout and waits; agy-companion detects that prompt and fails the job immediately with the URL instead of hanging, so:

1. Run any `/agy:*` command that invokes `agy` (e.g. `/agy:review --wait`).
2. If it reports that Google OAuth login is required, open the printed URL in a browser and complete the sign-in.
3. Rerun the command.

agy-companion cannot complete this interactive login step on your behalf — there is no non-interactive path in `agy` 1.0.1.

## Uninstall

```bash
/plugin uninstall agy@agy-companion
```

This does not uninstall the `agy` CLI itself or revoke its Google OAuth grant.
