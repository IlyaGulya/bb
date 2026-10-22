import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseEnv } from "node:util";
import { z } from "zod";
import { idSchema } from "../shared/contract.js";
import type { JiraConnection } from "../shared/jira-contract.js";

const connectionSchema = z
  .object({
    id: z.string().trim().min(1),
    label: z.string().trim().min(1),
    siteUrl: z.string().refine((value) => {
      try {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          /^[a-z0-9-]+\.atlassian\.net$/.test(url.hostname) &&
          !url.port &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname === "/"
        );
      } catch {
        return false;
      }
    }, "Jira site must be a canonical HTTPS atlassian.net origin"),
    cloudId: z.uuid(),
    credentialFile: z
      .string()
      .refine(isAbsolute, "Credential path must be absolute"),
    projectIds: z.array(idSchema).min(1),
  })
  .strict();
const configSchema = z
  .object({ connections: z.array(connectionSchema) })
  .strict();
export type JiraConnectionConfig = z.infer<typeof connectionSchema>;
export interface JiraConfiguration {
  connections: JiraConnectionConfig[];
  error: string | null;
}

export function loadJiraConfiguration(
  path = process.env.BB_TASKS_JIRA_CONNECTIONS_FILE,
): JiraConfiguration {
  if (!path)
    return {
      connections: [],
      error: "Jira is unconfigured: set BB_TASKS_JIRA_CONNECTIONS_FILE",
    };
  if (!isAbsolute(path))
    return {
      connections: [],
      error: "Jira configuration path must be absolute",
    };
  try {
    const config = configSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    if (
      new Set(config.connections.map((connection) => connection.id)).size !==
      config.connections.length
    ) {
      throw new Error("Duplicate connection IDs");
    }
    return { connections: config.connections, error: null };
  } catch {
    return {
      connections: [],
      error:
        "Jira configuration is unreadable or invalid; ask the operator to check the connections file",
    };
  }
}

export function jiraAuthorization(connection: JiraConnectionConfig): string {
  try {
    const values = parseEnv(readFileSync(connection.credentialFile, "utf8"));
    const email = values.JIRA_ACCOUNT_EMAIL?.trim();
    const token = values.JIRA_API_TOKEN?.trim();
    if (!email || !token || /[\r\n:]/.test(email) || /[\r\n]/.test(token))
      throw new Error("Invalid credentials");
    return `Basic ${Buffer.from(`${email}:${token}`, "utf8").toString("base64")}`;
  } catch {
    throw new Error(
      "Jira credentials are missing or unreadable; ask the operator to configure JIRA_ACCOUNT_EMAIL and JIRA_API_TOKEN",
    );
  }
}

export function publicConnection(
  connection: JiraConnectionConfig,
): JiraConnection {
  let error: string | null = null;
  try {
    jiraAuthorization(connection);
  } catch (cause) {
    error =
      cause instanceof Error ? cause.message : "Jira credentials unavailable";
  }
  return {
    id: connection.id,
    label: connection.label,
    siteUrl: new URL(connection.siteUrl).origin,
    projectIds: connection.projectIds,
    ready: error === null,
    error,
  };
}
