/**
 * Keeps track of agy's CLI surface so a new agy release can't add a flag or
 * subcommand that nobody ever looked at.
 *
 * The nightly `agy-release-probe.yml` already diffs `agy --help` and files an
 * issue, but closing that issue only required bumping the snapshot — the
 * additions themselves could go unexamined, and twice did: `--input-format`
 * arrived in 1.1.17 and `mic-serve`/`remote-control` in 1.2.x, all three
 * absorbed into a snapshot refresh with no recorded decision either way.
 *
 * `.github/agy-surface.json` now carries one entry per flag and subcommand,
 * each marked `used` (agy-companion passes it) or `considered` (deliberately
 * not used, with the reason). `tests/agy-surface.test.mjs` compares that file
 * against the tracked help snapshot and fails on any disagreement, so
 * refreshing the snapshot for a new release forces a decision on whatever the
 * release added — and forces notice when something the plugin depends on
 * disappears.
 */

import fs from "node:fs";

const FLAGS_HEADING = /^Usage of agy:/m;
const SUBCOMMANDS_HEADING = /^Available subcommands:/m;

export const SURFACE_STATUSES = ["used", "considered"];

/**
 * Reads the flag and subcommand names out of `agy --help` output.
 *
 * The listing is two labelled sections of `  <name>  <description>` lines, so
 * the first whitespace-delimited token of each indented line is the name. Only
 * the name is tracked: descriptions get reworded upstream (1.2.2 rewrote
 * `--project`'s) and a wording change is not a new capability.
 */
export function parseAgySurface(helpText) {
  const text = String(helpText ?? "");
  const flagsAt = text.search(FLAGS_HEADING);
  const subcommandsAt = text.search(SUBCOMMANDS_HEADING);

  const section = (from, to) => {
    if (from === -1) {
      return [];
    }
    const body = to === -1 ? text.slice(from) : text.slice(from, to);
    return body
      .split(/\r?\n/)
      .slice(1)
      .map((line) => (/^\s+\S/.test(line) ? line.trim().split(/\s+/)[0] : ""))
      .filter(Boolean);
  };

  const flags = section(flagsAt, subcommandsAt).filter((name) => name.startsWith("-"));
  const subcommands = section(subcommandsAt, -1).filter((name) => !name.startsWith("-"));

  return {
    flags: [...new Set(flags)].sort(),
    subcommands: [...new Set(subcommands)].sort()
  };
}

export function readAgySurfaceInventory(inventoryPath) {
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
  return {
    reviewedAgainstVersion: inventory.reviewedAgainstVersion ?? null,
    flags: inventory.flags ?? {},
    subcommands: inventory.subcommands ?? {}
  };
}

/**
 * Compares one `agy --help` listing against the inventory.
 *
 * `unclassified` is the actionable half: something agy offers that has no
 * recorded decision. `stale` is the other direction — an entry the inventory
 * still describes that agy no longer lists, which for a `used` entry means a
 * capability this plugin depends on has been removed. `badStatus` catches a
 * typo'd status value, since a status nobody recognizes is the same as no
 * decision at all.
 */
export function checkAgySurface(helpText, inventory) {
  const surface = parseAgySurface(helpText);
  const unclassified = [];
  const stale = [];
  const badStatus = [];

  for (const kind of ["flags", "subcommands"]) {
    const recorded = inventory[kind] ?? {};
    for (const name of surface[kind]) {
      if (!Object.prototype.hasOwnProperty.call(recorded, name)) {
        unclassified.push({ kind, name });
      }
    }
    for (const [name, entry] of Object.entries(recorded)) {
      if (!surface[kind].includes(name)) {
        stale.push({ kind, name, status: entry?.status ?? null });
      } else if (!SURFACE_STATUSES.includes(entry?.status)) {
        badStatus.push({ kind, name, status: entry?.status ?? null });
      }
    }
  }

  return {
    ok: unclassified.length === 0 && stale.length === 0 && badStatus.length === 0,
    surface,
    unclassified,
    stale,
    badStatus
  };
}

/** One-line-per-problem rendering, shared by the test failure and the probe issue. */
export function describeAgySurfaceCheck(check) {
  const lines = [];
  for (const { kind, name } of check.unclassified) {
    lines.push(`unclassified ${singular(kind)} \`${name}\` — add it to .github/agy-surface.json with a status and a reason.`);
  }
  for (const { kind, name, status } of check.stale) {
    const consequence =
      status === "used"
        ? "this plugin passes it, so something it depends on is gone"
        : "agy no longer lists it";
    lines.push(`stale ${singular(kind)} \`${name}\` — ${consequence}; drop or update the entry.`);
  }
  for (const { kind, name, status } of check.badStatus) {
    lines.push(
      `${singular(kind)} \`${name}\` has status \`${status}\`, which is not one of ${SURFACE_STATUSES.join(", ")}.`
    );
  }
  return lines;
}

function singular(kind) {
  return kind === "flags" ? "flag" : "subcommand";
}
