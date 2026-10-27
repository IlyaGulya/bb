import type { z } from "zod";

type ZodDef = z.core.$ZodTypeDef;

function defOf(schema: z.ZodType): ZodDef {
  return schema._zod.def;
}

function isZodType(value: unknown): value is z.ZodType {
  return (
    typeof value === "object" &&
    value !== null &&
    "_zod" in value &&
    typeof (value as { _zod?: unknown })._zod === "object"
  );
}

function zodChild(def: ZodDef, key: string): z.ZodType | undefined {
  const value = Reflect.get(def, key);
  return isZodType(value) ? value : undefined;
}

function zodChildren(def: ZodDef, key: string): z.ZodType[] {
  const value = Reflect.get(def, key);
  if (!Array.isArray(value)) return [];
  return value.filter(isZodType);
}

function zodShape(def: ZodDef): Record<string, z.ZodType> | undefined {
  const shape = Reflect.get(def, "shape");
  if (typeof shape !== "object" || shape === null) return undefined;
  const entries = Object.entries(shape).filter(
    (entry): entry is [string, z.ZodType] => isZodType(entry[1]),
  );
  return Object.fromEntries(entries);
}

export function zodObjectShape(schema: z.ZodType): Record<string, z.ZodType> {
  const def = defOf(schema);
  return def.type === "object" ? (zodShape(def) ?? {}) : {};
}

export type ZodFieldPresence = "required" | "optional" | "default";

export function zodFieldPresence(schema: z.ZodType): ZodFieldPresence {
  const type = defOf(schema).type;
  if (type === "default") return "default";
  if (type === "optional") return "optional";
  if (type === "nullable") {
    const inner = zodChild(defOf(schema), "innerType");
    return inner ? zodFieldPresence(inner) : "required";
  }
  return "required";
}

export function zodObjectFields(
  schema: z.ZodType,
): Record<string, ZodFieldPresence> {
  const def = defOf(schema);
  switch (def.type) {
    case "object": {
      const shape = zodShape(def) ?? {};
      return Object.fromEntries(
        Object.entries(shape).map(([key, field]) => [
          key,
          zodFieldPresence(field),
        ]),
      );
    }
    case "optional":
    case "nullable":
    case "default":
    case "readonly": {
      const inner = zodChild(def, "innerType");
      return inner ? zodObjectFields(inner) : {};
    }
    case "pipe": {
      const out = zodChild(def, "out");
      return out ? zodObjectFields(out) : {};
    }
    case "lazy": {
      const getter = Reflect.get(def, "getter");
      const inner = typeof getter === "function" ? getter() : undefined;
      return isZodType(inner) ? zodObjectFields(inner) : {};
    }
    default:
      return {};
  }
}

export function zodUnionOptions(schema: z.ZodType): z.ZodType[] {
  const def = defOf(schema);
  if (def.type === "union") return zodChildren(def, "options");
  return [schema];
}

export function zodLiteralValue(schema: z.ZodType): unknown {
  const def = defOf(schema);
  if (def.type !== "literal") return undefined;
  const values = Reflect.get(def, "values");
  return Array.isArray(values) ? values[0] : undefined;
}
