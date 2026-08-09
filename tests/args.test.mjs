import assert from "node:assert/strict";
import { test } from "node:test";

import { parseArgs, splitRawArgumentString } from "../scripts/lib/args.mjs";

test("parseArgs: parses boolean and value options with positionals", () => {
  const { options, positionals } = parseArgs(["--wait", "--base", "main", "fix", "the", "bug"], {
    booleanOptions: ["wait"],
    valueOptions: ["base"]
  });
  assert.equal(options.wait, true);
  assert.equal(options.base, "main");
  assert.deepEqual(positionals, ["fix", "the", "bug"]);
});

test("parseArgs: supports --key=value inline syntax", () => {
  const { options } = parseArgs(["--base=main"], { valueOptions: ["base"] });
  assert.equal(options.base, "main");
});

test("parseArgs: applies alias map to short and long flags", () => {
  const { options } = parseArgs(["-C", "/tmp/repo"], { valueOptions: ["cwd"], aliasMap: { C: "cwd" } });
  assert.equal(options.cwd, "/tmp/repo");
});

test("parseArgs: treats unknown -- as passthrough positionals", () => {
  const { positionals } = parseArgs(["--", "--not-a-flag", "text"], {});
  assert.deepEqual(positionals, ["--not-a-flag", "text"]);
});

test("parseArgs: throws on missing value for a value option", () => {
  assert.throws(() => parseArgs(["--base"], { valueOptions: ["base"] }), /Missing value for --base/);
});

test("parseArgs: unknown flags fall through as positionals", () => {
  const { positionals } = parseArgs(["--unknown"], {});
  assert.deepEqual(positionals, ["--unknown"]);
});

test("splitRawArgumentString: splits on whitespace and respects quotes", () => {
  const tokens = splitRawArgumentString(`--base main "fix the bug" 'and this'`);
  assert.deepEqual(tokens, ["--base", "main", "fix the bug", "and this"]);
});

test("splitRawArgumentString: handles backslash escapes", () => {
  const tokens = splitRawArgumentString(`a\\ b c`);
  assert.deepEqual(tokens, ["a b", "c"]);
});

test("splitRawArgumentString: returns empty array for blank input", () => {
  assert.deepEqual(splitRawArgumentString("   "), []);
});
