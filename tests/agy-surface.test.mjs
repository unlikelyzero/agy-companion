import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  checkAgySurface,
  describeAgySurfaceCheck,
  parseAgySurface,
  readAgySurfaceInventory
} from "../scripts/lib/agy-surface.mjs";
import { AGY_CAPABILITY_FLAGS } from "../scripts/lib/agy.mjs";

const SNAPSHOT_PATH = new URL("../.github/agy-help-snapshot.txt", import.meta.url);
const INVENTORY_PATH = new URL("../.github/agy-surface.json", import.meta.url);
const TESTED_VERSION_PATH = new URL("../.github/agy-tested-version", import.meta.url);

const snapshot = fs.readFileSync(SNAPSHOT_PATH, "utf8");
const inventory = readAgySurfaceInventory(INVENTORY_PATH);

test("parseAgySurface: reads both sections of a real agy --help listing", () => {
  const surface = parseAgySurface(snapshot);
  assert.ok(surface.flags.includes("--json-schema"));
  assert.ok(surface.flags.includes("-p"), "short aliases count as part of the surface");
  assert.ok(surface.subcommands.includes("models"));
  assert.ok(!surface.subcommands.some((name) => name.startsWith("-")), "flags must not leak into subcommands");
});

test("parseAgySurface: tolerates output with neither section", () => {
  assert.deepEqual(parseAgySurface("agy: command not found"), { flags: [], subcommands: [] });
  assert.deepEqual(parseAgySurface(null), { flags: [], subcommands: [] });
});

// The gate. A new agy release that adds a flag or subcommand cannot be
// absorbed by refreshing .github/agy-help-snapshot.txt alone — whoever
// refreshes it has to record what the addition means for this plugin.
test("every flag and subcommand agy offers has a recorded decision", () => {
  const check = checkAgySurface(snapshot, inventory);
  assert.ok(check.ok, ["agy's CLI surface and .github/agy-surface.json disagree:", ...describeAgySurfaceCheck(check)].join("\n  "));
});

test("the inventory was reviewed against the version the plugin is pinned to", () => {
  const tested = fs.readFileSync(TESTED_VERSION_PATH, "utf8").trim();
  assert.equal(
    inventory.reviewedAgainstVersion,
    tested,
    "bump reviewedAgainstVersion in .github/agy-surface.json as part of a compatibility pass"
  );
});

test("every capability the doctor probes for is recorded as used", () => {
  for (const flag of Object.values(AGY_CAPABILITY_FLAGS)) {
    assert.equal(
      inventory.flags[flag]?.status,
      "used",
      `${flag} is probed by /agy:setup --doctor, so the inventory must mark it used`
    );
  }
});

test("checkAgySurface: reports an addition agy made that nobody classified", () => {
  const withNewEntries = `${snapshot}\n`.replace(
    "  --sandbox ",
    "  --telepathy                     Read the user's mind\n  --sandbox "
  );
  const check = checkAgySurface(withNewEntries, inventory);
  assert.equal(check.ok, false);
  assert.deepEqual(check.unclassified, [{ kind: "flags", name: "--telepathy" }]);
  assert.match(describeAgySurfaceCheck(check)[0], /unclassified flag `--telepathy`/);
});

test("checkAgySurface: reports a depended-on flag agy has removed", () => {
  const withoutJsonSchema = snapshot
    .split(/\r?\n/)
    .filter((line) => !line.includes("--json-schema"))
    .join("\n");
  const check = checkAgySurface(withoutJsonSchema, inventory);
  assert.equal(check.ok, false);
  assert.deepEqual(check.stale, [{ kind: "flags", name: "--json-schema", status: "used" }]);
  assert.match(describeAgySurfaceCheck(check)[0], /something it depends on is gone/);
});

test("checkAgySurface: rejects a status value that is not a real decision", () => {
  const check = checkAgySurface(snapshot, {
    flags: { ...inventory.flags, "--sandbox": { status: "maybe" } },
    subcommands: inventory.subcommands
  });
  assert.equal(check.ok, false);
  assert.deepEqual(check.badStatus, [{ kind: "flags", name: "--sandbox", status: "maybe" }]);
});

test("every inventory entry carries a reason, not just a status", () => {
  for (const kind of ["flags", "subcommands"]) {
    for (const [name, entry] of Object.entries(inventory[kind])) {
      assert.ok(
        typeof entry.note === "string" && entry.note.trim().length > 0,
        `${name} needs a note explaining the decision`
      );
    }
  }
});
