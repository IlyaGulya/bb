import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  claudeMcpConfigSchema,
  claudeSelectedMcpSchema,
  ompMcpConfigSchema,
  ompSelectedMcpSchema,
  MCP_INSPECTION_MAX_FILE_BYTES,
  MCP_INSPECTION_MAX_SERVERS,
  inspectMcpRequestSchema,
  type McpConfigurationFileInspection,
  type McpServerInspection,
} from "@bb/domain";
import type { HostDaemonOnlineRpcResult } from "@bb/host-daemon-contract";
import type { CommandOf } from "../command-dispatch-support.js";

async function inspectFile(providerId: string, configPath: string): Promise<McpConfigurationFileInspection> {
  const result: McpConfigurationFileInspection = { configPath, status: "invalid", issue: null, servers: [] };
  if (providerId !== "claude-code" && providerId !== "acp-omp") {
    result.issue = "Unsupported provider";
    return result;
  }
  if (!isAbsolute(configPath)) {
    result.issue = "Configuration unavailable";
    return result;
  }
  let source: string;
  try {
    const file = await open(configPath, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) {
        result.issue = "Configuration must be a regular file";
        return result;
      }
      if (stat.size > MCP_INSPECTION_MAX_FILE_BYTES) {
        result.issue = "Configuration exceeds size limit";
        return result;
      }
      const buffer = Buffer.allocUnsafe(MCP_INSPECTION_MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MCP_INSPECTION_MAX_FILE_BYTES) {
        result.issue = "Configuration exceeds size limit";
        return result;
      }
      source = buffer.toString("utf8", 0, length);
    } finally {
      await file.close();
    }
  } catch {
    result.status = "unavailable";
    result.issue = "Configuration unavailable";
    return result;
  }
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    result.issue = "Invalid JSON configuration";
    return result;
  }
  const config = (providerId === "claude-code" ? claudeMcpConfigSchema : ompMcpConfigSchema).safeParse(json);
  if (!config.success) {
    result.issue = "Unsupported configuration structure";
    return result;
  }
  const entries = Object.entries(config.data.mcpServers);
  if (entries.length > MCP_INSPECTION_MAX_SERVERS) {
    result.issue = "Configuration exceeds server limit";
    return result;
  }
  const schema = providerId === "claude-code" ? claudeSelectedMcpSchema : ompSelectedMcpSchema;
  for (const [name, descriptor] of entries) {
    const selected = schema.safeParse(descriptor);
    const server: McpServerInspection = {
      name,
      transport: "unsupported",
      supported: selected.success && name !== "bb-bridge",
      issue: name === "bb-bridge" ? "Reserved server name" : selected.success ? null : "Unsupported server descriptor",
      authStatus: "not_checked",
    };
    if (selected.success) server.transport = selected.data.type ?? "stdio";
    result.servers.push(server);
  }
  result.status = "ok";
  return result;
}

export async function inspectHostMcpSources(
  command: CommandOf<"host.inspect_mcp_sources">,
): Promise<HostDaemonOnlineRpcResult<"host.inspect_mcp_sources">> {
  const input = inspectMcpRequestSchema.omit({ hostId: true }).parse({
    providerId: command.providerId,
    configPaths: command.configPaths,
  });
  const files: McpConfigurationFileInspection[] = [];
  for (const configPath of input.configPaths) files.push(await inspectFile(input.providerId, configPath));
  return { files };
}
