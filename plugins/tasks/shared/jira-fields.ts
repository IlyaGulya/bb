import type { JiraProposal } from "./jira-contract.js";

type FieldValue = Extract<
  JiraProposal,
  { kind: "transition" }
>["fields"][string];
const REFERENCE_KEYS = ["accountId", "id", "value"];

function compareValues(
  actual: FieldValue | undefined,
  expected: FieldValue | undefined,
  allowReferenceMetadata: boolean,
): boolean {
  if (actual === undefined || expected === undefined) return false;
  if (actual === expected) return true;
  if (actual === null || expected === null) return false;
  if (Array.isArray(actual) || Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      Array.isArray(expected) &&
      actual.length === expected.length &&
      actual.every((value, index) =>
        compareValues(value, expected[index], allowReferenceMetadata),
      )
    );
  if (typeof actual !== "object" || typeof expected !== "object") return false;
  const reference =
    allowReferenceMetadata &&
    REFERENCE_KEYS.some(
      (key) =>
        Object.hasOwn(expected, key) &&
        (typeof expected[key] === "string" ||
          typeof expected[key] === "number"),
    );
  const keys = Object.keys(expected);
  return (
    (reference || Object.keys(actual).length === keys.length) &&
    keys.every(
      (key) =>
        Object.hasOwn(actual, key) &&
        compareValues(actual[key], expected[key], allowReferenceMetadata),
    )
  );
}

export function fieldValuesMatch(
  actual: FieldValue | undefined,
  expected: FieldValue | undefined,
): boolean {
  return compareValues(actual, expected, true);
}

export function fieldValuesEqual(
  actual: FieldValue | undefined,
  expected: FieldValue | undefined,
): boolean {
  return compareValues(actual, expected, false);
}

export function hasRequiredFieldValue(
  value: FieldValue | undefined,
): value is Exclude<FieldValue, null> {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value !== "object" || Object.keys(value).length > 0;
}
