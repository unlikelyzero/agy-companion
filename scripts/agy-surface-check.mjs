#!/usr/bin/env node
/**
 * Compares an `agy --help` listing against `.github/agy-surface.json` and
 * prints one line per flag or subcommand that has no recorded decision (or
 * whose recorded decision has gone stale). Exits 1 when anything needs
 * attention, 0 when the surface is fully accounted for.
 *
 * Two callers: the nightly `agy-release-probe.yml`, which runs it against the
 * freshly installed agy so its tracking issue names exactly what a
 * compatibility pass has to decide about, and anyone who wants the same answer
 * by hand. `tests/agy-surface.test.mjs` enforces the same check against the
 * tracked snapshot in CI, where no agy binary exists.
 *
 * Usage: node scripts/agy-surface-check.mjs [path-to-help-output]
 * With no argument, reads the tracked snapshot.
 */

import fs from "node:fs";

import { checkAgySurface, describeAgySurfaceCheck, readAgySurfaceInventory } from "./lib/agy-surface.mjs";

const helpPath = process.argv[2]
  ? new URL(process.argv[2], `file://${process.cwd()}/`)
  : new URL("../.github/agy-help-snapshot.txt", import.meta.url);
const inventoryPath = new URL("../.github/agy-surface.json", import.meta.url);

const check = checkAgySurface(fs.readFileSync(helpPath, "utf8"), readAgySurfaceInventory(inventoryPath));

if (check.ok) {
  console.log(
    `Every one of agy's ${check.surface.flags.length} flags and ${check.surface.subcommands.length} subcommands has a recorded decision in .github/agy-surface.json.`
  );
  process.exit(0);
}

for (const line of describeAgySurfaceCheck(check)) {
  console.log(`- ${line}`);
}
process.exit(1);
