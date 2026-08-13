# Releasing

Releases are cut from `main` by pushing a `v*` tag. A GitHub Actions workflow
([`.github/workflows/release.yml`](../.github/workflows/release.yml)) runs the
tests, verifies the tag matches the plugin manifests, builds the release notes
from `CHANGELOG.md`, and publishes the GitHub release.

## The version lives in four places

The plugin states its version in four fields across three files:

| File | Field |
| --- | --- |
| `package.json` | `version` |
| `.claude-plugin/plugin.json` | `version` |
| `.claude-plugin/marketplace.json` | `metadata.version` |
| `.claude-plugin/marketplace.json` | `plugins[0].version` |

**These must always agree.** Claude Code decides whether an installed plugin is
out of date by reading the manifests, not by looking at git tags — so a bump
that misses one field fails quietly: the release exists, but some or all users
are never offered it.

Nothing here relies on remembering that. `npm run version:set` writes all four
at once, CI runs `npm run version:check` on every pull request, and the release
workflow refuses to publish a tag that disagrees with the manifests.

## Cutting a release

**1. Make sure `## Unreleased` in `CHANGELOG.md` describes the release.**

Its entries become the release notes verbatim, so write them for someone
deciding whether to upgrade. The release fails rather than publishing empty
notes if the section is empty.

**2. Bump the version on a branch.**

```bash
npm run version:set -- 0.2.0
```

This rewrites all four manifest fields and promotes `## Unreleased` to
`## 0.2.0 — <today>`, leaving a fresh empty `## Unreleased` behind. Review the
diff, then open a PR and merge it.

**3. Tag the merged commit.**

```bash
git checkout main && git pull
git tag v0.2.0
git push origin v0.2.0
```

Pushing the tag triggers the release. Watch it with `gh run watch`, or check
`gh release view v0.2.0` once it finishes.

## Versioning

Standard semver, judged from the user's side of the plugin:

- **patch** — bug fixes, docs, internal changes that don't alter behaviour.
- **minor** — new commands or flags, new capabilities, or a compatibility pass
  against a newer `agy`.
- **major** — a command is removed or renamed, or existing behaviour changes in
  a way that would surprise someone who upgraded without reading the notes.

## If something goes wrong

**The workflow failed after the tag was pushed.** Fix the cause on `main`, then
re-run for the existing tag from the Actions tab via *Run workflow* (the
`workflow_dispatch` input takes the tag name). Publishing is idempotent — if the
release already exists, its notes are updated rather than duplicated.

**The tag was pushed with the wrong version.** Delete it locally and remotely,
then tag again:

```bash
git tag -d v0.2.0
git push origin :refs/tags/v0.2.0
```

Only do this if nobody has fetched the tag yet. If the release was already
published and consumed, release a new patch version instead — a tag that
consumers have already resolved should be treated as permanent.

**Version check failed in CI.** Run `npm run version:check` locally; it names
every field and what each one says. `npm run version:set -- <version>` fixes a
drift by rewriting all of them.
