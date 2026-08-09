/**
 * Minimal, dependency-free JSON Schema validator.
 *
 * agy has no native structured-output enforcement (unlike Codex's app-server
 * `outputSchema`, which is validated server-side before it ever reaches this
 * plugin). Structured commands here ask the model to emit JSON in the prompt
 * and then validate it locally against schemas/review-output.schema.json.
 *
 * This only implements the subset of JSON Schema (draft 2020-12) that
 * review-output.schema.json actually uses: type, enum, minLength, minimum,
 * maximum, required, properties, additionalProperties, items. It is not a
 * general-purpose validator and should not be treated as one.
 */

function typeMatches(value, type) {
  switch (type) {
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function validateNode(value, schema, pathLabel, errors) {
  if (!schema || typeof schema !== "object") {
    return;
  }

  if (schema.type && !typeMatches(value, schema.type)) {
    errors.push(`${pathLabel}: expected type "${schema.type}", got ${value === null ? "null" : typeof value}`);
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${pathLabel}: value "${value}" is not one of ${JSON.stringify(schema.enum)}`);
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${pathLabel}: string shorter than minLength ${schema.minLength}`);
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${pathLabel}: ${value} is below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${pathLabel}: ${value} is above maximum ${schema.maximum}`);
    }
  }

  if (schema.type === "object" && value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${pathLabel}: missing required property "${key}"`);
      }
    }

    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          errors.push(`${pathLabel}: unexpected property "${key}"`);
        }
      }
    }

    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validateNode(value[key], propertySchema, `${pathLabel}.${key}`, errors);
      }
    }
  }

  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      validateNode(item, schema.items, `${pathLabel}[${index}]`, errors);
    });
  }
}

/**
 * @param {unknown} data
 * @param {object} schema
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateAgainstSchema(data, schema) {
  const errors = [];
  validateNode(data, schema, "$", errors);
  return { valid: errors.length === 0, errors };
}
