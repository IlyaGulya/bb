import { describe, expect, it } from "vitest";
import {
  mcpConfigurationInspectionSchema,
  validateSelectedMcpServers,
  type McpConfigurationInspection,
} from "./execution-contexts.js";

function inventory(): McpConfigurationInspection {
  return {
    hostId: "host-a",
    providerId: "claude-code",
    files: [
      {
        configPath: "/configs/project.json",
        status: "ok",
        issue: null,
        servers: [
          {
            name: "selected",
            transport: "stdio",
            supported: true,
            issue: null,
            authStatus: "not_checked",
          },
          {
            name: "unsupported",
            transport: "unsupported",
            supported: false,
            issue: "Unsupported server descriptor",
            authStatus: "not_checked",
          },
        ],
      },
    ],
  };
}
const selected = { name: "selected", configPath: "/configs/project.json" };

describe("selected MCP validation", () => {
  it("accepts selected valid metadata without interpreting configuration as authenticated readiness", () => {
    const inspection = inventory();
    expect(validateSelectedMcpServers([selected], inspection)).toBeNull();
    expect(inspection.files[0]?.servers[0]?.authStatus).toBe("not_checked");
    expect(
      validateSelectedMcpServers([], {
        hostId: "offline",
        providerId: "legacy",
        files: [],
      }),
    ).toBeNull();
  });

  it("matches both source and name, never a same-name server from another source", () => {
    const inspection = inventory();
    expect(
      validateSelectedMcpServers(
        [{ ...selected, configPath: "/configs/other.json" }],
        inspection,
      ),
    ).toBe("Selected MCP configuration is invalid or unavailable");
    expect(
      validateSelectedMcpServers(
        [{ ...selected, name: "missing" }],
        inspection,
      ),
    ).toBe("Selected MCP server is missing");
    expect(
      validateSelectedMcpServers(
        [{ ...selected, name: "unsupported" }],
        inspection,
      ),
    ).toBe("Selected MCP server descriptor is unsupported");
  });

  it("rejects collisions across sources and reserved bridge names", () => {
    const inspection = inventory();
    expect(validateSelectedMcpServers([selected, selected], inspection)).toBe(
      "Selected MCP server names must be unique",
    );
    inspection.files.push({
      ...inspection.files[0]!,
      configPath: "/configs/other.json",
    });
    expect(
      validateSelectedMcpServers(
        [selected, { ...selected, configPath: "/configs/other.json" }],
        inspection,
      ),
    ).toBe("Selected MCP server names must be unique");
    expect(
      validateSelectedMcpServers(
        [{ ...selected, name: "bb-bridge" }],
        inspection,
      ),
    ).toBe("Selected MCP server name is reserved");
  });

  it.each(["invalid", "unavailable"] as const)(
    "refuses %s files even when stale metadata contains the name",
    (status) => {
      const inspection = inventory();
      inspection.files[0]!.status = status;
      expect(validateSelectedMcpServers([selected], inspection)).toBe(
        "Selected MCP configuration is invalid or unavailable",
      );
    },
  );

  it("refuses unsupported providers, relative references and ambiguous inventories", () => {
    const inspection = inventory();
    expect(
      validateSelectedMcpServers(
        [{ ...selected, configPath: "relative.json" }],
        inspection,
      ),
    ).toBe("Selected MCP configuration path must be absolute");
    expect(
      validateSelectedMcpServers([selected], {
        ...inspection,
        providerId: "unsupported",
      }),
    ).toBe("Selected MCP provider is unsupported");
    inspection.files.push(inspection.files[0]!);
    expect(validateSelectedMcpServers([selected], inspection)).toBe(
      "Selected MCP configuration is invalid or unavailable",
    );
  });

  it("refuses duplicate candidate metadata rather than picking the first matching server", () => {
    const inspection = inventory();
    const file = inspection.files[0]!;
    file.servers.push(file.servers[0]!);
    expect(validateSelectedMcpServers([selected], inspection)).toBe(
      "Selected MCP server is missing",
    );
  });

  it("prevents raw descriptor and arbitrary native diagnostic fields from entering the public DTO", () => {
    const inspection = inventory();
    expect(mcpConfigurationInspectionSchema.safeParse(inspection).success).toBe(
      true,
    );
    const file = inspection.files[0]!;
    expect(
      mcpConfigurationInspectionSchema.safeParse({
        ...inspection,
        files: [{ ...file, content: "private" }],
      }).success,
    ).toBe(false);
    expect(
      mcpConfigurationInspectionSchema.safeParse({
        ...inspection,
        files: [{ ...file, issue: "native error includes private" }],
      }).success,
    ).toBe(false);
    expect(
      mcpConfigurationInspectionSchema.safeParse({
        ...inspection,
        files: [
          { ...file, servers: [{ ...file.servers[0], command: "private" }] },
        ],
      }).success,
    ).toBe(false);
  });
});
