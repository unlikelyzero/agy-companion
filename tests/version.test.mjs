import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  checkVersions,
  extractSection,
  normalizeVersion,
  promoteChangelog,
  readVersionFields,
  setVersion
} from "../scripts/version.mjs";

/**
 * Builds a throwaway repo with the same manifest layout as the real one, so
 * these tests can exercise the writing paths without touching the checkout.
 */
function withFakeRepo(fn, { version = "0.1.0", changelog } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-version-test-"));
  fs.mkdirSync(path.join(rootDir, ".claude-plugin"));

  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    `${JSON.stringify({ name: "agy-companion", version, private: true }, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(rootDir, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: "agy", version, description: "d" }, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(rootDir, ".claude-plugin", "marketplace.json"),
    `${JSON.stringify(
      {
        name: "agy-companion",
        metadata: { description: "d", version },
        plugins: [{ name: "agy", version, source: "./" }]
      },
      null,
      2
    )}\n`
  );

  const changelogPath = path.join(rootDir, "CHANGELOG.md");
  fs.writeFileSync(
    changelogPath,
    changelog ?? "# Changelog\n\n## Unreleased\n\n- Did a thing.\n\n## 0.1.0\n\n- Initial release.\n"
  );

  try {
    return fn({ rootDir, changelogPath });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

test("version: reads every manifest field the plugin declares", () => {
  withFakeRepo(({ rootDir }) => {
    const fields = readVersionFields(rootDir);
    // package.json, plugin.json, and marketplace.json's metadata + plugins entry.
    assert.equal(fields.length, 4);
    assert.ok(fields.every((field) => field.version === "0.1.0"));
  });
});

test("version: check passes when every field agrees", () => {
  withFakeRepo(({ rootDir }) => {
    const result = checkVersions(rootDir);
    assert.equal(result.ok, true);
    assert.equal(result.version, "0.1.0");
  });
});

test("version: check fails when a single field drifts", () => {
  withFakeRepo(({ rootDir }) => {
    // The realistic mistake: bump plugin.json, forget marketplace.json.
    const pluginPath = path.join(rootDir, ".claude-plugin", "plugin.json");
    const plugin = JSON.parse(fs.readFileSync(pluginPath, "utf8"));
    plugin.version = "0.2.0";
    fs.writeFileSync(pluginPath, `${JSON.stringify(plugin, null, 2)}\n`);

    const result = checkVersions(rootDir);
    assert.equal(result.ok, false);
    assert.equal(result.version, null);
    assert.match(result.problems.join("\n"), /disagree/);
    // The report must name the offending fields, or it isn't actionable.
    assert.match(result.problems.join("\n"), /plugin\.json/);
    assert.match(result.problems.join("\n"), /marketplace\.json/);
  });
});

test("version: check rejects a tag that disagrees with the manifests", () => {
  withFakeRepo(({ rootDir }) => {
    const result = checkVersions(rootDir, "v0.9.0");
    assert.equal(result.ok, false);
    assert.match(result.problems.join("\n"), /Tag\/version mismatch/);
  });
});

test("version: check accepts a matching tag with or without the v prefix", () => {
  withFakeRepo(({ rootDir }) => {
    assert.equal(checkVersions(rootDir, "v0.1.0").ok, true);
    assert.equal(checkVersions(rootDir, "0.1.0").ok, true);
  });
});

test("version: set rewrites every field at once", () => {
  withFakeRepo(({ rootDir }) => {
    const { version, changed } = setVersion("0.2.0", rootDir);
    assert.equal(version, "0.2.0");
    assert.equal(changed.length, 3);

    const after = checkVersions(rootDir);
    assert.equal(after.ok, true);
    assert.equal(after.version, "0.2.0");
  });
});

test("version: set accepts a v-prefixed input and stores it bare", () => {
  withFakeRepo(({ rootDir }) => {
    setVersion("v1.2.3", rootDir);
    assert.equal(checkVersions(rootDir).version, "1.2.3");
  });
});

test("version: set rejects a non-semver version", () => {
  withFakeRepo(({ rootDir }) => {
    assert.throws(() => setVersion("not-a-version", rootDir), /not a valid semantic version/);
    // The manifests must be left untouched by a rejected bump.
    assert.equal(checkVersions(rootDir).version, "0.1.0");
  });
});

test("version: promoting the changelog moves Unreleased entries under the new version", () => {
  withFakeRepo(({ changelogPath }) => {
    const result = promoteChangelog("0.2.0", { date: "2026-08-13", changelogPath });
    assert.equal(result.changed, true);

    const updated = fs.readFileSync(changelogPath, "utf8");
    assert.match(updated, /## Unreleased/);
    assert.match(updated, /## 0\.2\.0 — 2026-08-13/);
    // The entry moved into the release section, and Unreleased is now empty.
    assert.equal(extractSection(updated, "0.2.0"), "- Did a thing.");
    assert.equal(extractSection(updated, "Unreleased"), "");
    // Exactly one blank line under the new heading — this file is read by
    // humans in the repo and republished verbatim as the release notes.
    assert.match(updated, /## 0\.2\.0 — 2026-08-13\n\n- Did a thing\./);
    assert.doesNotMatch(updated, /\n\n\n/);
  });
});

test("version: promoting refuses when there is nothing unreleased", () => {
  withFakeRepo(
    ({ changelogPath }) => {
      const result = promoteChangelog("0.2.0", { changelogPath });
      assert.equal(result.changed, false);
      assert.match(result.reason, /empty/);
    },
    { changelog: "# Changelog\n\n## Unreleased\n\n## 0.1.0\n\n- Initial release.\n" }
  );
});

test("version: promoting is a no-op when the version section already exists", () => {
  withFakeRepo(
    ({ changelogPath }) => {
      const result = promoteChangelog("0.2.0", { changelogPath });
      assert.equal(result.changed, false);
      assert.match(result.reason, /already has/);
    },
    { changelog: "# Changelog\n\n## Unreleased\n\n- New.\n\n## 0.2.0\n\n- Older.\n" }
  );
});

test("version: extractSection reads a dated heading and stops at the next section", () => {
  const markdown = "# Changelog\n\n## 0.2.0 — 2026-08-13\n\n- One.\n- Two.\n\n## 0.1.0\n\n- Old.\n";
  assert.equal(extractSection(markdown, "0.2.0"), "- One.\n- Two.");
  assert.equal(extractSection(markdown, "0.1.0"), "- Old.");
  assert.equal(extractSection(markdown, "9.9.9"), "");
});

test("version: normalizeVersion strips a leading v and surrounding space", () => {
  assert.equal(normalizeVersion(" v1.2.3 "), "1.2.3");
  assert.equal(normalizeVersion("1.2.3"), "1.2.3");
});

test("version: the real repo's manifests are consistent", () => {
  // Guards the checked-in state, so a drifted manifest fails locally too and
  // not only in CI.
  const result = checkVersions();
  assert.equal(result.ok, true, result.problems.join("\n"));
});
