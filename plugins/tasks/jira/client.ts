import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  JiraProposal,
  JiraSearchInput,
  JiraSearchResult,
  JiraSnapshot,
  JiraTransition,
  JiraTransitionField,
} from "../shared/jira-contract.js";
import {
  jiraSearchInputSchema,
  jiraSearchResultSchema,
  jiraTransitionFieldsSchema,
} from "../shared/jira-contract.js";
import { jiraAuthorization, type JiraConnectionConfig } from "./config.js";

const named = z.object({ id: z.string(), name: z.string() });
const user = z
  .object({ displayName: z.string() })
  .catchall(z.json())
  .nullable();
const commentSchema = z.object({
  id: z.string(),
  body: z.unknown(),
  author: user.optional(),
  updated: z.string(),
  properties: z
    .array(z.object({ key: z.string(), value: z.unknown() }))
    .optional(),
});
const commentsSchema = z.object({
  total: z.number().int().nonnegative(),
  comments: z.array(commentSchema),
});
const issueSchema = z.object({
  id: z.string(),
  key: z.string(),
  fields: z
    .object({
      summary: z.string(),
      description: z.unknown(),
      status: named,
      priority: z
        .object({ name: z.string() })
        .catchall(z.json())
        .nullable()
        .optional(),
      assignee: user.optional(),
      updated: z.string(),
    })
    .catchall(z.json()),
});
const searchIssueSchema = z.object({
  id: z.string().regex(/^[0-9]+$/),
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*-[0-9]+$/),
  fields: z.object({
    summary: z.string(),
    status: named.extend({
      statusCategory: z.object({ key: z.string().min(1) }),
    }),
    priority: z.object({ name: z.string() }).nullable().optional(),
    assignee: user.optional(),
    updated: z.string().min(1),
  }),
});
const searchPageSchema = z.object({
  issues: z.array(searchIssueSchema).max(100),
  isLast: z.boolean(),
  nextPageToken: z.string().min(1).max(4096).optional(),
});
const issueReferencePattern = /^(?:[0-9]+|[A-Za-z][A-Za-z0-9_]*-[0-9]+)$/;
const issueKeyPattern = /^[A-Za-z][A-Za-z0-9_]*-[0-9]+$/;

export function normalizeIssueReference(
  input: string,
  siteUrl: string,
): string {
  const issue = input.trim();
  if (issueReferencePattern.test(issue)) return issue;
  const invalid = () =>
    new Error(
      "Use a Jira issue key, numeric ID, or HTTPS issue URL from the selected connection's site",
    );
  if (issue.length > 4096 || /[\s\\]/.test(issue)) throw invalid();
  const authority = /^https:\/\/([^/?#]+)/i.exec(issue)?.[1];
  if (!authority || /[@:%]/.test(authority)) throw invalid();
  let url: URL;
  try {
    url = new URL(issue);
  } catch {
    throw invalid();
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== new URL(siteUrl).origin ||
    url.username ||
    url.password ||
    url.port
  )
    throw invalid();
  const browse = /^\/browse\/([A-Za-z][A-Za-z0-9_]*-[0-9]+)\/?$/.exec(
    url.pathname,
  );
  if (browse) return browse[1]!;
  const board =
    /^\/jira\/(?:software|core)\/(?:c\/)?projects\/[A-Za-z][A-Za-z0-9_]*\/boards\/[0-9]+(?:\/(?:backlog|timeline))?\/?$/.test(
      url.pathname,
    ) || url.pathname === "/secure/RapidBoard.jspa";
  const selected = url.searchParams.getAll("selectedIssue");
  if (!board || selected.length !== 1 || !issueKeyPattern.test(selected[0]!))
    throw invalid();
  return selected[0]!;
}
const transitionFieldSchema = z.object({
  required: z.boolean(),
  name: z.string(),
  schema: z.object({ type: z.string(), items: z.string().optional() }),
  operations: z.array(z.string()),
  allowedValues: z.array(z.json()).optional(),
  defaultValue: z.json().optional(),
});
const transitionsSchema = z.object({
  transitions: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      to: named,
      fields: z.record(z.string().min(1), transitionFieldSchema),
    }),
  ),
});
const COMMENT_PROPERTY = "bb.tasks.operation";
const operationPropertySchema = z.object({ operationId: z.string() });
const REFERENCE_KEYS = ["accountId", "id", "value"];

type FieldValue = z.infer<typeof jiraTransitionFieldsSchema>[string];

function wireValue(value: FieldValue): FieldValue {
  if (Array.isArray(value)) return value.map(wireValue);
  if (value !== null && typeof value === "object") {
    for (const key of REFERENCE_KEYS) {
      const identifier = value[key];
      if (typeof identifier === "string" || typeof identifier === "number")
        return { [key]: identifier };
    }
  }
  return value;
}

function allowedValue(
  value: FieldValue,
): JiraTransitionField["allowedValues"][number] | null {
  if (Array.isArray(value)) return null;
  const normalized = wireValue(value);
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    normalized === value
  )
    return null;
  const label =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value.name ??
        value.displayName ??
        value.value ??
        value.id ??
        value.accountId ??
        JSON.stringify(value))
      : value;
  return {
    label: typeof label === "string" ? label : JSON.stringify(label),
    value: normalized,
  };
}

function commentHasOperation(
  comment: z.infer<typeof commentSchema>,
  operationId: string,
): boolean {
  return (
    comment.properties?.some((property) => {
      if (property.key !== COMMENT_PROPERTY) return false;
      const value = operationPropertySchema.safeParse(property.value);
      return value.success && value.data.operationId === operationId;
    }) ?? false
  );
}

export class JiraRequestError extends Error {
  constructor(
    message: string,
    readonly rejected: boolean,
  ) {
    super(message);
  }
}

const adfNodeSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  attrs: z.record(z.string(), z.unknown()).optional(),
  content: z.array(z.unknown()).optional(),
  marks: z
    .array(
      z.object({
        type: z.string(),
        attrs: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional(),
});
const adfNodeSeparators: Record<string, string> = {
  paragraph: "\n",
  heading: "\n",
  listItem: "\n",
  blockquote: "\n",
  codeBlock: "\n",
  panel: "\n",
  tableRow: "\n",
  taskItem: "\n",
  decisionItem: "\n",
  expand: "\n",
  nestedExpand: "\n",
  tableCell: "\t",
  tableHeader: "\t",
  doc: "",
  bulletList: "",
  orderedList: "",
  table: "",
  taskList: "",
  decisionList: "",
};
const plainDocumentSchema = z
  .object({
    type: z.literal("doc"),
    version: z.literal(1),
    content: z.array(
      z
        .object({
          type: z.literal("paragraph"),
          content: z
            .array(
              z
                .object({
                  type: z.literal("text"),
                  text: z.string(),
                  marks: z.array(z.never()).optional(),
                })
                .strict(),
            )
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();

export function adfText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  const node = adfNodeSchema.parse(value);
  if (node.type === "hardBreak") return "\n";
  if (node.type === "rule") return "\n---\n";
  if (node.text !== undefined) {
    const href = node.marks?.find((mark) => mark.type === "link")?.attrs?.href;
    return typeof href === "string" && href !== node.text
      ? `${node.text} (${href})`
      : node.text;
  }
  const attrs = node.attrs;
  const label = attrs?.text ?? attrs?.shortName;
  if (typeof label === "string") return label;
  if (typeof attrs?.url === "string") return attrs.url;
  if (node.type === "mention" && typeof attrs?.id === "string")
    return `@${attrs.id}`;
  if (node.type === "date" && typeof attrs?.timestamp === "string") {
    const date = new Date(Number(attrs.timestamp));
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }
  const text = (node.content ?? []).map(adfText).join("");
  const separator = adfNodeSeparators[node.type];
  if (typeof separator === "string")
    return `${separator === "\t" ? text.replace(/\n$/, "") : text}${separator}`;
  return `${text}[Jira ${node.type}${attrs ? `: ${JSON.stringify(attrs)}` : ""}]`;
}

export function textDocument(text: string) {
  return {
    type: "doc",
    version: 1,
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  };
}

export function plainDescriptionMatches(
  snapshot: JiraSnapshot,
  text: string,
): boolean {
  if (snapshot.description !== text) return false;
  if (snapshot.descriptionDocument === null) return text === "";
  const document: unknown = JSON.parse(snapshot.descriptionDocument);
  return plainDocumentSchema.safeParse(document).success;
}

export function snapshotFingerprint(snapshot: JiraSnapshot): string {
  const { fetchedAt: _fetchedAt, ...remote } = snapshot;
  return createHash("sha256").update(JSON.stringify(remote)).digest("hex");
}

export class JiraClient {
  private readonly base: string;
  constructor(
    private readonly connection: JiraConnectionConfig,
    private readonly http: typeof fetch = fetch,
  ) {
    this.base = `https://api.atlassian.com/ex/jira/${connection.cloudId}/rest/api/3`;
  }

  private async request(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<unknown> {
    const authorization = jiraAuthorization(this.connection);
    let response: Response;
    try {
      response = await this.http(`${this.base}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: authorization,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new JiraRequestError(
        "Jira request did not complete; check connectivity and reconcile any uncertain write",
        false,
      );
    }
    if (!response.ok) {
      const help =
        response.status === 401
          ? "check the account and scoped token"
          : response.status === 403
            ? "check Jira permissions and token scopes"
            : response.status === 404
              ? "issue missing or inaccessible"
              : response.status === 429
                ? "rate limited; wait before another explicit action"
                : "request rejected or service unavailable";
      throw new JiraRequestError(
        `Jira HTTP ${response.status}: ${help}`,
        response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408,
      );
    }
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      throw new JiraRequestError(
        "Jira returned an unreadable response; reconcile any uncertain write",
        false,
      );
    }
  }

  async search(input: JiraSearchInput): Promise<JiraSearchResult> {
    const { jql, nextPageToken, limit } = jiraSearchInputSchema.parse(input);
    const query = new URLSearchParams({
      jql,
      maxResults: String(limit),
      fields: "summary,status,priority,assignee,updated",
    });
    if (nextPageToken !== null) query.set("nextPageToken", nextPageToken);
    const page = searchPageSchema.safeParse(
      await this.request(`/search/jql?${query}`),
    );
    if (
      !page.success ||
      page.data.issues.length > limit ||
      (!page.data.isLast &&
        (!page.data.nextPageToken || page.data.nextPageToken === nextPageToken))
    )
      throw new JiraRequestError(
        "Jira returned data that does not match the supported search API format",
        true,
      );
    return jiraSearchResultSchema.parse({
      issues: page.data.issues.map((issue) => ({
        id: issue.id,
        key: issue.key,
        url: `${new URL(this.connection.siteUrl).origin}/browse/${encodeURIComponent(issue.key)}`,
        summary: issue.fields.summary,
        statusId: issue.fields.status.id,
        statusName: issue.fields.status.name,
        statusCategory: issue.fields.status.statusCategory.key,
        priority: issue.fields.priority?.name ?? null,
        assignee: issue.fields.assignee?.displayName ?? null,
        updatedAt: issue.fields.updated,
      })),
      nextPageToken: page.data.isLast ? null : page.data.nextPageToken,
    });
  }

  async snapshot(
    issue: string,
    selectedFields: string[] = [],
  ): Promise<JiraSnapshot> {
    issue = normalizeIssueReference(issue, this.connection.siteUrl);
    const transitions = await this.transitions(issue);
    const requested = [
      ...new Set([
        ...transitions.flatMap((transition) =>
          transition.fields.map((field) => field.id),
        ),
        ...selectedFields,
      ]),
    ].sort();
    const fields = [
      ...new Set([
        "summary",
        "description",
        "status",
        "priority",
        "assignee",
        "updated",
        ...requested,
      ]),
    ].join(",");
    const result = issueSchema.parse(
      await this.request(
        `/issue/${encodeURIComponent(issue)}?${new URLSearchParams({ fields })}`,
      ),
    );
    const page = commentsSchema.parse(
      await this.request(
        `/issue/${encodeURIComponent(result.id)}/comment?maxResults=50&orderBy=-created`,
      ),
    );
    return {
      id: result.id,
      key: result.key,
      url: `${new URL(this.connection.siteUrl).origin}/browse/${encodeURIComponent(result.key)}`,
      summary: result.fields.summary,
      description: adfText(result.fields.description).replace(/\n$/, ""),
      descriptionDocument:
        result.fields.description == null
          ? null
          : JSON.stringify(result.fields.description),
      statusId: result.fields.status.id,
      statusName: result.fields.status.name,
      priority: result.fields.priority?.name ?? null,
      assignee: result.fields.assignee?.displayName ?? null,
      updatedAt: result.fields.updated,
      fetchedAt: new Date().toISOString(),
      commentCount: page.total,
      comments: page.comments.slice(0, 50).map((comment) => ({
        id: comment.id,
        body: adfText(comment.body).replace(/\n$/, ""),
        author: comment.author?.displayName ?? null,
        updatedAt: comment.updated,
      })),
      commentsTruncated: page.total > Math.min(page.comments.length, 50),
      transitionFields: Object.fromEntries(
        requested
          .filter((field) => Object.hasOwn(result.fields, field))
          .map((field) => [field, z.json().parse(result.fields[field])]),
      ),
    };
  }

  async transitions(issueId: string): Promise<JiraTransition[]> {
    const result = transitionsSchema.parse(
      await this.request(
        `/issue/${encodeURIComponent(issueId)}/transitions?expand=transitions.fields`,
      ),
    );
    return result.transitions.map((transition) => ({
      id: transition.id,
      name: transition.name,
      toStatusId: transition.to.id,
      toStatusName: transition.to.name,
      fields: Object.entries(transition.fields)
        .filter(([, field]) => field.required)
        .map(([id, field]) => {
          const choices = (field.allowedValues ?? []).map(allowedValue);
          return {
            id,
            name: field.name,
            type: field.schema.type,
            items: field.schema.items ?? null,
            operations: field.operations,
            allowedValues: choices.filter((choice) => choice !== null),
            defaultValue:
              field.defaultValue === undefined
                ? null
                : wireValue(field.defaultValue),
            unsupportedReason: choices.some((choice) => choice === null)
              ? `Jira field ${field.name} (${id}) uses unsupported option values; complete this transition in Jira, then pull`
              : null,
          };
        }),
    }));
  }

  async write(
    issueId: string,
    proposal: JiraProposal,
    operationId: string,
  ): Promise<string | null> {
    const path = `/issue/${encodeURIComponent(issueId)}`;
    if (proposal.kind === "fields") {
      const fields = {
        ...(proposal.summary === null ? {} : { summary: proposal.summary }),
        ...(proposal.description === null
          ? {}
          : { description: textDocument(proposal.description) }),
      };
      await this.request(path, "PUT", { fields });
      return null;
    }
    if (proposal.kind === "transition") {
      await this.request(`${path}/transitions`, "POST", {
        transition: { id: proposal.transitionId },
        fields: proposal.fields,
      });
      return null;
    }
    const result = z.object({ id: z.string() }).parse(
      await this.request(`${path}/comment`, "POST", {
        body: textDocument(proposal.body),
        properties: [{ key: COMMENT_PROPERTY, value: { operationId } }],
      }),
    );
    return result.id;
  }

  async findComment(
    issueId: string,
    operationId: string,
    knownId: string | null,
  ): Promise<string | null> {
    const path = `/issue/${encodeURIComponent(issueId)}/comment`;
    if (knownId) {
      const comment = commentSchema.parse(
        await this.request(
          `${path}/${encodeURIComponent(knownId)}?expand=properties`,
        ),
      );
      if (commentHasOperation(comment, operationId)) return comment.id;
    }
    for (let start = 0; start < 500; start += 100) {
      const page = commentsSchema.parse(
        await this.request(
          `${path}?maxResults=100&startAt=${start}&orderBy=-created&expand=properties`,
        ),
      );
      const found = page.comments.find((comment) =>
        commentHasOperation(comment, operationId),
      );
      if (found) return found.id;
      if (
        start + page.comments.length >= page.total ||
        page.comments.length === 0
      )
        break;
    }
    return null;
  }
}
