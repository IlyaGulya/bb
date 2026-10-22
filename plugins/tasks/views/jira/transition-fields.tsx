import { jiraTransitionFieldsSchema } from "../../shared/jira-contract.js";
import type {
  JiraProposal,
  JiraTransition,
  JiraTransitionField,
} from "../../shared/jira-contract.js";
import {
  fieldValuesEqual,
  fieldValuesMatch,
  hasRequiredFieldValue,
} from "../../shared/jira-fields.js";
import { JIRA_INPUT } from "./import-dialog.js";

type TransitionFields = Extract<JiraProposal, { kind: "transition" }>["fields"];
type FieldValue = TransitionFields[string];

const SCALAR_FIELD_TYPES: Record<string, boolean> = {
  string: true,
  date: true,
  datetime: true,
  boolean: true,
  number: true,
  integer: true,
};

export function seedTransitionFields(
  transition: JiraTransition,
  captured: TransitionFields,
): TransitionFields {
  const fields: TransitionFields = {};
  for (const field of transition.fields) {
    const value = Object.hasOwn(captured, field.id)
      ? captured[field.id]
      : field.defaultValue;
    if (value === undefined || value === null) continue;
    fields[field.id] =
      field.type === "array" && Array.isArray(value)
        ? value.map(
            (item) =>
              field.allowedValues.find((option) =>
                fieldValuesMatch(item, option.value),
              )?.value ?? item,
          )
        : (field.allowedValues.find((option) =>
            fieldValuesMatch(value, option.value),
          )?.value ?? value);
  }
  return fields;
}

export function transitionFieldError(
  field: JiraTransitionField,
  value: FieldValue | undefined,
): string | null {
  if (field.unsupportedReason) return field.unsupportedReason;
  if (!field.operations.includes("set"))
    return `Jira requires ${field.name}, but supports only ${field.operations.join(", ") || "no operations"}. This connector sends set values only. Ask a Jira administrator to enable set or complete this transition in Jira, then pull.`;
  if (!hasRequiredFieldValue(value)) return `${field.name} is required.`;
  if (field.allowedValues.length) {
    const values =
      field.type === "array" && Array.isArray(value) ? value : [value];
    if (
      !values.every((item) =>
        field.allowedValues.some((option) =>
          fieldValuesEqual(item, option.value),
        ),
      )
    )
      return `Choose allowed values for ${field.name}.`;
  }
  if (
    (field.type === "string" ||
      field.type === "date" ||
      field.type === "datetime") &&
    typeof value !== "string"
  )
    return `${field.name} requires text.`;
  if (
    (field.type === "number" || field.type === "integer") &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      (field.type === "integer" && !Number.isInteger(value)))
  )
    return `${field.name} requires ${field.type === "integer" ? "an integer" : "a number"}.`;
  if (field.type === "boolean" && typeof value !== "boolean")
    return `${field.name} requires true or false.`;
  if (field.type === "array" && !Array.isArray(value))
    return `${field.name} requires a JSON array.`;
  if (
    field.type === "object" &&
    (typeof value !== "object" || Array.isArray(value))
  )
    return `${field.name} requires a JSON object.`;
  return null;
}

export function TransitionFieldEditor({
  field,
  value,
  raw,
  parseError,
  disabled,
  onChange,
}: {
  field: JiraTransitionField;
  value: FieldValue | undefined;
  raw: string | undefined;
  parseError: string | undefined;
  disabled: boolean;
  onChange: (
    value: FieldValue | undefined,
    raw?: string,
    error?: string,
  ) => void;
}) {
  const error = parseError ?? transitionFieldError(field, value);
  const label = `${field.name} (${field.id}) — required`;
  const selected = field.allowedValues.findIndex(
    (option) => value !== undefined && fieldValuesEqual(value, option.value),
  );
  const parseJson = (text: string) => {
    if (!text.trim()) {
      onChange(undefined, text);
      return;
    }
    try {
      const parsed = jiraTransitionFieldsSchema.safeParse({
        [field.id]: JSON.parse(text),
      });
      if (!parsed.success) {
        onChange(undefined, text, "Enter a valid JSON value.");
        return;
      }
      onChange(parsed.data[field.id], text);
    } catch {
      onChange(
        undefined,
        text,
        "Invalid JSON. Use double-quoted property names and strings; correct the value before saving.",
      );
    }
  };
  return (
    <div className="space-y-1">
      <label className="block space-y-1 text-sm">
        <span>{label}</span>
        {field.allowedValues.length && field.type !== "array" ? (
          <select
            className={JIRA_INPUT}
            value={selected < 0 ? "" : String(selected)}
            disabled={disabled}
            onChange={(event) =>
              onChange(
                event.target.value === ""
                  ? undefined
                  : field.allowedValues[Number(event.target.value)]?.value,
              )
            }
          >
            <option value="">Choose a required value</option>
            {field.allowedValues.map((option, index) => (
              <option key={index} value={String(index)}>
                {option.label}
              </option>
            ))}
          </select>
        ) : field.type === "string" ||
          field.type === "date" ||
          field.type === "datetime" ? (
          <input
            className={JIRA_INPUT}
            type={field.type === "date" ? "date" : "text"}
            value={typeof value === "string" ? value : ""}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
        ) : field.type === "boolean" ? (
          <select
            className={JIRA_INPUT}
            value={value === true ? "true" : value === false ? "false" : ""}
            disabled={disabled}
            onChange={(event) =>
              onChange(
                event.target.value === ""
                  ? undefined
                  : event.target.value === "true",
              )
            }
          >
            <option value="">Choose a required value</option>
            <option value="true">True</option>
            <option value="false">False</option>
          </select>
        ) : field.type === "number" || field.type === "integer" ? (
          <input
            className={JIRA_INPUT}
            type="text"
            inputMode="decimal"
            value={raw ?? (value === undefined ? "" : JSON.stringify(value))}
            disabled={disabled}
            onChange={(event) => parseJson(event.target.value)}
          />
        ) : (
          <textarea
            className={`${JIRA_INPUT} min-h-28 font-mono`}
            aria-label={`${label} (JSON)`}
            value={
              raw ?? (value === undefined ? "" : JSON.stringify(value, null, 2))
            }
            disabled={disabled}
            onChange={(event) => parseJson(event.target.value)}
          />
        )}
      </label>
      <p className="text-xs text-muted-foreground">
        Type: {field.type}
        {field.items ? ` of ${field.items}` : ""} · Operations:{" "}
        {field.operations.join(", ") || "none"}.{" "}
        {field.type === "array" ||
        (!SCALAR_FIELD_TYPES[field.type] && !field.allowedValues.length)
          ? "Enter the exact Jira JSON value; no value is inferred."
          : null}
      </p>
      {field.type === "array" && field.allowedValues.length ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Allowed array values</summary>
          {field.allowedValues.map((option, index) => (
            <p key={index} className="break-words">
              {option.label}: {JSON.stringify(option.value)}
            </p>
          ))}
        </details>
      ) : null}
      {field.defaultValue !== null ? (
        <p className="break-words text-xs text-muted-foreground">
          Jira default: {JSON.stringify(field.defaultValue)}. Used for a newly
          selected transition only when no captured value is available.
        </p>
      ) : null}
      {selected < 0 &&
      value !== undefined &&
      field.allowedValues.length &&
      field.type !== "array" ? (
        <p className="break-words text-xs text-muted-foreground">
          Retained value: {JSON.stringify(value)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
