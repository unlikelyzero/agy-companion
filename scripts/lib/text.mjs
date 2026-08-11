export function truncateForDisplay(text, max = 80) {
  if (typeof text !== "string") {
    return "";
  }
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}…`;
}
