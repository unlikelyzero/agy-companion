/**
 * Display width for a job summary line. Historic default of the `shorten`
 * helper this module replaced; kept so job listings render as they always have.
 */
export const DEFAULT_SUMMARY_DISPLAY_LENGTH = 96;

/**
 * Display width for a finding title in a rendered review summary. Shorter than
 * a job summary because the title shares its line with a `(file:line)` suffix.
 */
export const DEFAULT_TITLE_DISPLAY_LENGTH = 80;

/**
 * Truncate `text` to at most `limit` characters for single-line display.
 *
 * Three properties callers depend on:
 * - Internal whitespace is collapsed, so the result is always a single line.
 *   Callers interpolate this into markdown list items and table cells, and a
 *   stray newline breaks the surrounding structure.
 * - The ellipsis is counted inside `limit`, so the result never exceeds it.
 * - The cut lands on a grapheme boundary, never inside a surrogate pair or
 *   between a base character and its combining mark. Slicing UTF-16 code units
 *   directly can emit a lone surrogate, which renders as U+FFFD and makes
 *   `encodeURIComponent` throw.
 */
export function truncateForDisplay(text, limit = DEFAULT_SUMMARY_DISPLAY_LENGTH) {
  const normalized = String(text ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!normalized || limit <= 0) {
    return "";
  }
  const segments = splitGraphemes(normalized);
  if (segments.length <= limit) {
    return normalized;
  }
  const ellipsis = "…";
  return `${segments.slice(0, limit - ellipsis.length).join("")}${ellipsis}`;
}

/**
 * `Intl.Segmenter` is available on the Node >= 18.18 floor this package
 * declares, but stays behind a guard so an exotic runtime degrades to
 * code-point splitting rather than throwing. Both paths keep surrogate pairs
 * intact; only combining marks and ZWJ sequences differ.
 */
function splitGraphemes(text) {
  if (typeof Intl?.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (entry) => entry.segment);
  }
  return Array.from(text);
}
