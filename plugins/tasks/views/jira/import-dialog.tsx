import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type {
  JiraRpcContract,
  JiraSource,
} from "../../shared/jira-contract.js";
import { errorMessage } from "../../shared/errors.js";
import { useProjects, useTasksQuery } from "../../shell/data.js";
import { useTasksNavigation } from "../../shell/routes.js";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

export const JIRA_INPUT =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

export function JiraImportDialog({
  open,
  onOpenChange,
  projectId,
  taskId = null,
  onLinked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
  taskId?: string | null;
  onLinked?: (source: JiraSource) => void;
}) {
  const rpc = useRpc<JiraRpcContract>();
  const navigation = useTasksNavigation();
  const projects = useProjects();
  const connections = useTasksQuery(
    async () =>
      open ? (await rpc.call("jiraConnections", {})).connections : [],
    [],
    [open],
  );
  const [connectionId, setConnectionId] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState(projectId ?? "");
  const [issue, setIssue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connection = connections.data?.find((item) => item.id === connectionId);
  const allowedProjects = (projects.data ?? []).filter(
    (project) =>
      connection?.projectIds.includes(project.id) &&
      (taskId === null || project.id === projectId),
  );
  const targetProjectId = allowedProjects.some(
    (project) => project.id === selectedProjectId,
  )
    ? selectedProjectId
    : (allowedProjects[0]?.id ?? "");
  const submit = async () => {
    if (busy || !connection?.ready || !targetProjectId || !issue.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("jiraImport", {
        connectionId: connection.id,
        issue: issue.trim(),
        projectId: targetProjectId,
        taskId,
      });
      onLinked?.(result.source);
      onOpenChange(false);
      setIssue("");
      if (taskId === null)
        navigation.go({ kind: "task", taskKey: result.source.taskKey });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogContent className="sm:max-w-lg">
        <DialogTitle>
          {taskId === null ? "Import Jira task" : "Link Jira issue"}
        </DialogTitle>
        <DialogDescription>
          {taskId === null
            ? "Selectively import an issue into native Tasks. Re-importing opens the existing linked task."
            : "Attach a source without replacing this task’s local planning fields or conversations."}{" "}
          This does not dispatch an agent or enable automatic synchronization.
        </DialogDescription>
        {connections.isLoading ? (
          <p className="text-sm text-muted-foreground">
            Loading configured connections…
          </p>
        ) : null}
        {connections.data?.length === 0 && !connections.isLoading ? (
          <p role="status" className="text-sm text-muted-foreground">
            Jira is not configured. Ask your operator to configure a Tasks Jira
            connection and its permitted tracker projects on the server. No
            credentials are entered here.
          </p>
        ) : null}
        <label className="space-y-1 text-sm">
          Connection
          <select
            className={JIRA_INPUT}
            value={connectionId}
            onChange={(event) => setConnectionId(event.target.value)}
            disabled={busy}
          >
            <option value="">Choose a configured connection</option>
            {connections.data?.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
                {item.ready ? "" : " — unavailable"}
              </option>
            ))}
          </select>
        </label>
        {connection ? (
          <p className="break-words text-xs text-muted-foreground">
            {connection.siteUrl}
            {connection.error ? ` — ${connection.error}` : ""}
          </p>
        ) : null}
        <label className="space-y-1 text-sm">
          Tracker project
          <select
            className={JIRA_INPUT}
            value={targetProjectId}
            onChange={(event) => setSelectedProjectId(event.target.value)}
            disabled={busy || taskId !== null}
          >
            <option value="">Choose a permitted project</option>
            {allowedProjects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        {connection && allowedProjects.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            This connection does not permit any available tracker project
            {taskId ? " for this task" : ""}. Ask your operator to update its
            project configuration.
          </p>
        ) : null}
        <label className="space-y-1 text-sm">
          Jira issue key, ID or URL
          <input
            className={JIRA_INPUT}
            value={issue}
            onChange={(event) => setIssue(event.target.value)}
            placeholder="PROJECT-123 or https://your-site.atlassian.net/browse/PROJECT-123"
            disabled={busy}
          />
        </label>
        {error || connections.error || projects.error ? (
          <p role="alert" className="text-sm text-destructive">
            {error ?? connections.error ?? projects.error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => connections.refresh()}
            disabled={busy}
          >
            Refresh connections
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={
              busy || !connection?.ready || !targetProjectId || !issue.trim()
            }
          >
            {busy
              ? "Reading Jira…"
              : taskId === null
                ? "Import task"
                : "Link issue"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
