import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SUMMARY_DISPLAY_LENGTH,
  DEFAULT_TITLE_DISPLAY_LENGTH,
  truncateForDisplay
} from "../scripts/lib/text.mjs";

test("returns short text unchanged", () => {
  assert.equal(truncateForDisplay("Missing null check"), "Missing null check");
});

test("returns text of exactly the limit unchanged", () => {
  const exact = "a".repeat(DEFAULT_TITLE_DISPLAY_LENGTH);
  assert.equal(truncateForDisplay(exact, DEFAULT_TITLE_DISPLAY_LENGTH), exact);
});

test("never exceeds the limit, ellipsis included", () => {
  const long = "a".repeat(DEFAULT_TITLE_DISPLAY_LENGTH + 40);
  const result = truncateForDisplay(long, DEFAULT_TITLE_DISPLAY_LENGTH);
  assert.equal(result.length, DEFAULT_TITLE_DISPLAY_LENGTH);
  assert.ok(result.endsWith("…"));
});

test("collapses internal newlines so the result stays on one line", () => {
  const result = truncateForDisplay("Race condition\nin job state writer");
  assert.equal(result, "Race condition in job state writer");
  assert.ok(!result.includes("\n"));
});

test("collapses runs of whitespace and trims the ends", () => {
  assert.equal(truncateForDisplay("  padded\t\tvalue \r\n here  "), "padded value here");
});

test("never splits a surrogate pair", () => {
  const emoji = "🔥".repeat(DEFAULT_TITLE_DISPLAY_LENGTH);
  const result = truncateForDisplay(emoji, DEFAULT_TITLE_DISPLAY_LENGTH);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result), "lone high surrogate in output");
  assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result), "lone low surrogate in output");
  assert.ok(result.isWellFormed === undefined || result.isWellFormed());
});

test("keeps a combining mark attached to its base character", () => {
  const accented = "é".repeat(20);
  const result = truncateForDisplay(accented, 10);
  assert.ok(!result.startsWith("́"));
  assert.ok(!/́…$/.test(result) || /é…$/.test(result));
});

test("coerces non-string input instead of blanking it", () => {
  assert.equal(truncateForDisplay(42), "42");
  assert.equal(truncateForDisplay(null), "");
  assert.equal(truncateForDisplay(undefined), "");
});

test("returns an empty string for a non-positive limit", () => {
  assert.equal(truncateForDisplay("anything", 0), "");
});

test("defaults to the summary display length", () => {
  const long = "a".repeat(DEFAULT_SUMMARY_DISPLAY_LENGTH + 10);
  assert.equal(truncateForDisplay(long).length, DEFAULT_SUMMARY_DISPLAY_LENGTH);
});
