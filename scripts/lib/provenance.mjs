import { createHash } from "node:crypto";

/**
 * Bumped when the shape of the object `buildProvenance` returns changes in
 * a way a consumer parsing stored job records would need to know about
 * (a field renamed or removed — adding a new field is not a breaking change
 * and does not need a bump).
 */
export const PROVENANCE_SCHEMA_VERSION = 1;

/**
 * Small, stable "what actually ran" fingerprint attached to every review
 * and task job, independent of the job's own result payload. Exists to
 * answer the two questions a bug report about agy output almost always
 * turns into: "what agy version/model/scope actually produced this," and
 * "is this the same input as last time, or did something about the repo
 * change." Every field is best-effort and `null` when not known or not
 * applicable to this job's kind — never fabricated to fill the shape.
 */
export function buildProvenance({
  agyVersion = null,
  model = null,
  effort = null,
  agent = null,
  mode = null,
  conversationId = null,
  gitHead = null,
  scope = null,
  inputHash = null,
  reviewedPaths = null
} = {}) {
  return {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    agyVersion,
    model,
    effort,
    agent,
    mode,
    conversationId,
    gitHead,
    scope,
    inputHash,
    reviewedPaths
  };
}

/** A stable fingerprint for free-form input (e.g. a task/rescue prompt) that has no snapshot hash of its own. */
export function hashText(text) {
  return createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 16);
}
