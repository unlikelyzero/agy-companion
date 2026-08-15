import assert from "node:assert/strict";
import { test } from "node:test";

import { buildProvenance, hashText, PROVENANCE_SCHEMA_VERSION } from "../scripts/lib/provenance.mjs";

test("provenance: buildProvenance defaults every field to null when nothing is supplied", () => {
  const provenance = buildProvenance();
  assert.equal(provenance.schemaVersion, PROVENANCE_SCHEMA_VERSION);
  assert.equal(provenance.agyVersion, null);
  assert.equal(provenance.model, null);
  assert.equal(provenance.effort, null);
  assert.equal(provenance.agent, null);
  assert.equal(provenance.mode, null);
  assert.equal(provenance.conversationId, null);
  assert.equal(provenance.gitHead, null);
  assert.equal(provenance.scope, null);
  assert.equal(provenance.inputHash, null);
  assert.equal(provenance.reviewedPaths, null);
});

test("provenance: buildProvenance passes through every supplied field", () => {
  const provenance = buildProvenance({
    agyVersion: "1.1.13",
    model: "gemini-3.1-pro-high",
    effort: "high",
    agent: "reviewer",
    mode: "plan",
    conversationId: "conv-1",
    gitHead: "abc123",
    scope: "working-tree",
    inputHash: "deadbeef",
    reviewedPaths: 7
  });
  assert.deepEqual(provenance, {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    agyVersion: "1.1.13",
    model: "gemini-3.1-pro-high",
    effort: "high",
    agent: "reviewer",
    mode: "plan",
    conversationId: "conv-1",
    gitHead: "abc123",
    scope: "working-tree",
    inputHash: "deadbeef",
    reviewedPaths: 7
  });
});

test("provenance: hashText is stable for identical text and changes when text changes", () => {
  assert.equal(hashText("hello"), hashText("hello"));
  assert.notEqual(hashText("hello"), hashText("hello!"));
});

test("provenance: hashText tolerates null/undefined input", () => {
  assert.equal(hashText(null), hashText(undefined));
  assert.equal(hashText(undefined), hashText(""));
});
