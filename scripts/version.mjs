#!/usr/bin/env node
/**
 * Single source of truth for "what version is this plugin, and is that claim
 * consistent?".
 *
 * The version is stated in four places across three files, and Claude Code
 * uses the manifest values — not the git tag — to decide whether an installed
 * plugin is out of date. A bump that misses one of them therefore fails
 * silently: the release exists, but some or all users are never offered it.
 * That is the failure this file is here to make impossible.
 *
 *   node scripts/version.mjs check          # verify all four agree
 *   node scripts/version.mjs check v0.2.0   # ...and that they match a tag
 *   node scripts/version.mjs current        # print the current version
 *   node scripts/version.mjs set 0.2.0      # rewrite all four + CHANGELOG
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CHANGELOG_PATH = path.join(ROOT_DIR, "CHANGELOG.md");
const UNRELEASED_HEADING = "## Unreleased";

/**
 * Each entry is one version claim: the file it lives in, and the path to it
 * within that file's JSON. Adding a manifest means adding a line here — the
 * check, the setter and the tests all read from this one list.
 */
const VERSION_FIELDS = [
  { file: "package.json", keyPath: ["version"] },
  { file: ".claude-plugin/plugin.json", keyPath: ["version"] },
  { file: ".claude-plugin/marketplace.json", keyPath: ["metadata", "version"] },
  { file: ".claude-plugin/marketplace.json", keyPath: ["plugins", 0, "version"] }
];

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/;

export function normalizeVersion(value) {
  return String(value ?? "").trim().replace(/^v/, "");
}

export function assertValidVersion(version) {
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(`"${version}" is not a valid semantic version (expected e.g. 0.2.0 or 1.0.0-rc.1).`);
  }
  return version;
}

function readAtKeyPath(value, keyPath) {
  return keyPath.reduce((current, key) => (current == null ? current : current[key]), value);
}

function writeAtKeyPath(value, keyPath, nextValue) {
  const lastKey = keyPath[keyPath.length - 1];
  const parent = keyPath.slice(0, -1).reduce((current, key) => current[key], value);
  parent[lastKey] = nextValue;
}

export function readVersionFields(rootDir = ROOT_DIR) {
  return VERSION_FIELDS.map((field) => {
    const absolutePath = path.join(rootDir, field.file);
    const parsed = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
    const found = readAtKeyPath(parsed, field.keyPath);
    return {
      ...field,
      label: `${field.file}:${field.keyPath.join(".")}`,
      version: typeof found === "string" ? found : null
    };
  });
}

/**
 * Returns `{ ok, version, fields, problems }` rather than throwing, so callers
 * can report every disagreement at once instead of one per run.
 */
export function checkVersions(rootDir = ROOT_DIR, expectedVersion = null) {
  const fields = readVersionFields(rootDir);
  const problems = [];

  for (const field of fields) {
    if (field.version === null) {
      problems.push(`${field.label} is missing or is not a string.`);
    } else if (!SEMVER_PATTERN.test(field.version)) {
      problems.push(`${field.label} is "${field.version}", which is not a valid semantic version.`);
    }
  }

  const distinct = [...new Set(fields.map((field) => field.version).filter((value) => value !== null))];
  if (distinct.length > 1) {
    problems.push(
      `Version fields disagree (${distinct.map((value) => `"${value}"`).join(" vs ")}). ` +
        "Claude Code reads these manifests to detect updates, so a mismatch means some users are " +
        "never offered the release. Run `npm run version:set -- <version>` to set all of them at once.\n" +
        fields.map((field) => `    ${field.label} = ${field.version ?? "(missing)"}`).join("\n")
    );
  }

  const version = distinct.length === 1 ? distinct[0] : null;

  if (expectedVersion !== null) {
    const normalized = normalizeVersion(expectedVersion);
    if (version !== null && version !== normalized) {
      problems.push(
        `Tag/version mismatch: expected "${normalized}" but the manifests say "${version}". ` +
          "Bump the manifests on main before tagging the release."
      );
    }
  }

  return { ok: problems.length === 0, version, fields, problems };
}

export function setVersion(nextVersionInput, rootDir = ROOT_DIR) {
  const nextVersion = assertValidVersion(normalizeVersion(nextVersionInput));
  const changed = [];

  // Group by file so a file holding two version fields is read and written once.
  const byFile = new Map();
  for (const field of VERSION_FIELDS) {
    if (!byFile.has(field.file)) {
      byFile.set(field.file, []);
    }
    byFile.get(field.file).push(field);
  }

  for (const [file, fields] of byFile) {
    const absolutePath = path.join(rootDir, file);
    const original = fs.readFileSync(absolutePath, "utf8");
    const parsed = JSON.parse(original);
    for (const field of fields) {
      writeAtKeyPath(parsed, field.keyPath, nextVersion);
    }
    // Preserve the file's trailing-newline convention rather than imposing one.
    const serialized = `${JSON.stringify(parsed, null, 2)}${original.endsWith("\n") ? "\n" : ""}`;
    if (serialized !== original) {
      fs.writeFileSync(absolutePath, serialized, "utf8");
      changed.push(file);
    }
  }

  return { version: nextVersion, changed };
}

/**
 * Promotes the `## Unreleased` section to a released heading. Deliberately
 * refuses when that section has no entries: an empty release section is worse
 * than none, because it looks like a deliberate "nothing changed" claim.
 */
export function promoteChangelog(nextVersionInput, { date, changelogPath = CHANGELOG_PATH } = {}) {
  const nextVersion = assertValidVersion(normalizeVersion(nextVersionInput));
  const original = fs.readFileSync(changelogPath, "utf8");

  if (original.includes(`\n## ${nextVersion}\n`)) {
    return { changed: false, reason: `CHANGELOG.md already has a "## ${nextVersion}" section.` };
  }

  const headingIndex = original.indexOf(UNRELEASED_HEADING);
  if (headingIndex === -1) {
    return { changed: false, reason: `CHANGELOG.md has no "${UNRELEASED_HEADING}" section to promote.` };
  }

  const body = extractSection(original, UNRELEASED_HEADING);
  if (!body.trim()) {
    return { changed: false, reason: `The "${UNRELEASED_HEADING}" section is empty — nothing to release.` };
  }

  const releaseDate = date ?? new Date().toISOString().slice(0, 10);
  // No trailing newline here: whatever followed the old heading (normally a
  // blank line) still follows the new one, so adding one leaves a double gap.
  const updated =
    original.slice(0, headingIndex) +
    `${UNRELEASED_HEADING}\n\n## ${nextVersion} — ${releaseDate}` +
    original.slice(headingIndex + UNRELEASED_HEADING.length);

  fs.writeFileSync(changelogPath, updated, "utf8");
  return { changed: true, version: nextVersion, date: releaseDate };
}

/**
 * Pulls one section's body out of the changelog, for use as release notes.
 * Matches the heading exactly or as a `<version> — <date>` heading.
 */
export function extractSection(markdown, heading) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const normalizedHeading = heading.replace(/^##\s*/, "").trim();
  let startIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith("## ")) {
      continue;
    }
    const title = line.slice(3).trim();
    if (title === normalizedHeading || title.split("—")[0].trim() === normalizedHeading) {
      startIndex = index + 1;
      break;
    }
  }

  if (startIndex === -1) {
    return "";
  }

  const collected = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) {
      break;
    }
    collected.push(lines[index]);
  }

  return collected.join("\n").trim();
}

export function readChangelogSection(version, changelogPath = CHANGELOG_PATH) {
  return extractSection(fs.readFileSync(changelogPath, "utf8"), normalizeVersion(version));
}

function main(argv) {
  const [command, argument] = argv;

  if (command === "current") {
    const { version, problems } = checkVersions();
    if (version === null) {
      console.error(problems.join("\n"));
      process.exit(1);
    }
    console.log(version);
    return;
  }

  if (command === "check") {
    const { ok, version, problems } = checkVersions(ROOT_DIR, argument ?? null);
    if (!ok) {
      console.error("Version check failed:\n");
      for (const problem of problems) {
        console.error(`  - ${problem}`);
      }
      process.exit(1);
    }
    console.log(`Version ${version} is consistent across all ${VERSION_FIELDS.length} manifest fields.`);
    return;
  }

  if (command === "notes") {
    const version = normalizeVersion(argument || checkVersions().version || "");
    if (!version) {
      console.error("Usage: node scripts/version.mjs notes <version>");
      process.exit(1);
    }
    const body = readChangelogSection(version);
    if (!body) {
      console.error(
        `CHANGELOG.md has no entries for ${version}.\n` +
          "Add them under `## Unreleased` and run `npm run version:set -- <version>` to promote them."
      );
      process.exit(1);
    }
    console.log(body);
    return;
  }

  if (command === "set") {
    if (!argument) {
      console.error("Usage: node scripts/version.mjs set <version>");
      process.exit(1);
    }
    const { version, changed } = setVersion(argument);
    const changelog = promoteChangelog(version);
    console.log(`Set version ${version}.`);
    for (const file of changed) {
      console.log(`  updated ${file}`);
    }
    console.log(changelog.changed ? "  updated CHANGELOG.md" : `  CHANGELOG.md unchanged — ${changelog.reason}`);
    if (!changelog.changed) {
      console.log("\nAdd release notes under `## Unreleased` before tagging, or the release will have empty notes.");
    }
    return;
  }

  console.error("Usage: node scripts/version.mjs <current|check [version]|notes [version]|set <version>>");
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
