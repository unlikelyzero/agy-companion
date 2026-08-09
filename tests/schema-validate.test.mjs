import assert from "node:assert/strict";
import { test } from "node:test";

import { readOutputSchema } from "../scripts/lib/agy.mjs";
import { validateAgainstSchema } from "../scripts/lib/schema-validate.mjs";

const SCHEMA_PATH = new URL("../schemas/review-output.schema.json", import.meta.url);

test("validateAgainstSchema: accepts a well-formed review result", () => {
  const schema = readOutputSchema(SCHEMA_PATH);
  const data = {
    verdict: "approve",
    summary: "Looks fine.",
    findings: [],
    next_steps: []
  };
  const { valid, errors } = validateAgainstSchema(data, schema);
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test("validateAgainstSchema: rejects a missing required top-level property", () => {
  const schema = readOutputSchema(SCHEMA_PATH);
  const { valid, errors } = validateAgainstSchema({ verdict: "approve", summary: "ok", findings: [] }, schema);
  assert.equal(valid, false);
  assert.match(errors[0], /missing required property "next_steps"/);
});

test("validateAgainstSchema: rejects a verdict outside the enum", () => {
  const schema = readOutputSchema(SCHEMA_PATH);
  const { valid, errors } = validateAgainstSchema(
    { verdict: "maybe", summary: "ok", findings: [], next_steps: [] },
    schema
  );
  assert.equal(valid, false);
  assert.match(errors[0], /not one of/);
});

test("validateAgainstSchema: validates nested finding objects", () => {
  const schema = readOutputSchema(SCHEMA_PATH);
  const { valid, errors } = validateAgainstSchema(
    {
      verdict: "needs-attention",
      summary: "ok",
      findings: [{ severity: "high", title: "t", body: "b", file: "f", line_start: 1, line_end: 2, confidence: 0.5 }],
      next_steps: []
    },
    schema
  );
  assert.equal(valid, false);
  assert.match(errors[0], /missing required property "recommendation"/);
});

test("validateAgainstSchema: rejects out-of-range confidence", () => {
  const schema = readOutputSchema(SCHEMA_PATH);
  const { valid, errors } = validateAgainstSchema(
    {
      verdict: "needs-attention",
      summary: "ok",
      findings: [
        {
          severity: "high",
          title: "t",
          body: "b",
          file: "f",
          line_start: 1,
          line_end: 2,
          confidence: 1.5,
          recommendation: "r"
        }
      ],
      next_steps: []
    },
    schema
  );
  assert.equal(valid, false);
  assert.match(errors[0], /above maximum 1/);
});

test("validateAgainstSchema: rejects a non-object top level", () => {
  const schema = readOutputSchema(SCHEMA_PATH);
  const { valid, errors } = validateAgainstSchema("not an object", schema);
  assert.equal(valid, false);
  assert.match(errors[0], /expected type "object"/);
});
