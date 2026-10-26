import { describe, expect, it } from "vitest";
import { executionContextSchema, modelConnectionSchema } from "@bb/domain";
import { executionContextUnavailableReason, modelConnectionUnavailableReason } from "./execution-binding-selection";

const context = executionContextSchema.parse({ id: "context", name: "Work", projectIds: ["project"], createdAt: 0, updatedAt: 0 });
const connection = modelConnectionSchema.parse({ id: "connection", name: "Personal account", provider: "claude-code", hostId: "host", createdAt: 0, updatedAt: 0 });

describe("execution binding choices", () => {
  it("permits independent context/account names and never treats empty membership as global", () => {
    expect(executionContextUnavailableReason(context, "project")).toBeNull();
    expect(modelConnectionUnavailableReason(connection, "claude-code", "host")).toBeNull();
    expect(executionContextUnavailableReason({ ...context, projectIds: [] }, "project")).toBe("Execution context does not include this project.");
    expect(executionContextUnavailableReason(context, "other-project")).toBe("Execution context does not include this project.");
  });

  it("keeps unavailable or incompatible explicit choices actionable rather than falling back", () => {
    expect(executionContextUnavailableReason(undefined, "project")).toBe("Execution context is unavailable.");
    expect(executionContextUnavailableReason({ ...context, enabled: false }, "project")).toBe("Execution context is disabled.");
    expect(modelConnectionUnavailableReason(undefined, "claude-code", "host")).toBe("Model connection is unavailable.");
    expect(modelConnectionUnavailableReason({ ...connection, revoked: true }, "claude-code", "host")).toBe("Model connection is revoked.");
    expect(modelConnectionUnavailableReason({ ...connection, enabled: false }, "claude-code", "host")).toBe("Model connection is disabled.");
    expect(modelConnectionUnavailableReason(connection, "omp", "host")).toBe("Requires provider claude-code.");
    expect(modelConnectionUnavailableReason(connection, "claude-code", "other-host")).toBe("Model connection belongs to a different machine.");
    expect(modelConnectionUnavailableReason(connection, "claude-code", null)).toBe("Select a machine to use this model connection.");
  });
});
