import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { slackInboxRpc, Status } from "./src/contract.js";
import { SETUP } from "./src/setup.js";

export function SlackInboxPanel() {
  const rpc = useRpc<typeof slackInboxRpc>();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setStatus(await rpc.call("status", null));
      setError(false);
    } catch {
      setError(true);
    }
  }, [rpc]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 15000);
    return () => clearInterval(timer);
  }, [refresh]);
  useRealtime("status-changed", refresh);
  async function action(method: "retry" | "checkCoverage") {
    setBusy(true);
    try {
      setStatus(await rpc.call(method, null));
      setError(false);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Slack Inbox"
      className="mx-auto w-full max-w-3xl space-y-4 p-4 text-sm"
    >
      <h1 className="text-base font-semibold">Slack Inbox</h1>
      <p>
        Received Slack sources are not accepted work. Human review, linking and
        conversion happen in Inbox; intake never dispatches tasks or sends
        replies.
      </p>
      <div className="flex flex-wrap gap-4">
        <a className="underline" href="/settings/plugins/bb--slack-inbox">
          Configure approved scope and secret tokens
        </a>
        <a className="underline" href="/plugins/tasks/tasks/inbox">
          Review and link in Inbox
        </a>
        <button
          type="button"
          className="underline"
          disabled={busy}
          onClick={() => void action("checkCoverage")}
        >
          Recheck conversation access
        </button>
        <button
          type="button"
          className="underline"
          disabled={busy}
          onClick={() => void action("retry")}
        >
          Retry connection / delivery
        </button>
      </div>
      {error && (
        <p role="alert">
          Slack Inbox status unavailable. No complete coverage can be assumed.
        </p>
      )}
      {!status && !error && <p role="status">Loading connection status…</p>}
      {status && (
        <>
          <dl className="grid grid-cols-2 gap-2">
            <dt>Connection</dt>
            <dd>{status.connection}</dd>
            <dt>Approval</dt>
            <dd>
              {status.configuration.approved
                ? "Recorded for configured scope"
                : "Not recorded; intake blocked"}
            </dd>
            <dt>Dedicated secrets</dt>
            <dd>
              App: {status.credentials.appToken ? "set" : "missing"}; bot:{" "}
              {status.credentials.botToken ? "set" : "missing"}
            </dd>
            <dt>Workspace / permitted human</dt>
            <dd>
              {status.configuration.teamId || "Not configured"} /{" "}
              {status.configuration.userId || "Not configured"}
            </dd>
            <dt>Source context</dt>
            <dd>{status.configuration.context}</dd>
            <dt>Received discussions (not accepted tasks)</dt>
            <dd>{status.receivedDiscussions}</dd>
            <dt>Durable pending deliveries</dt>
            <dd>{status.pending}</dd>
            <dt>Last selected message event</dt>
            <dd>
              {status.lastEventAt === null
                ? "Not observed"
                : new Date(status.lastEventAt).toISOString()}
            </dd>
          </dl>
          {status.error && <p role="alert">Connection/setup: {status.error}</p>}
          {status.deliveryError && <p role="alert">{status.deliveryError}</p>}
          <h2 className="font-semibold">Selected coverage, not all mentions</h2>
          <p>
            Accessible means bot conversation access only. Verify each
            configured Slack event subscription with an approved real human
            mention. Missing history scopes or subscriptions can silently
            prevent events.
          </p>
          {!status.coverage.length && <p>No conversations configured.</p>}
          <ul className="space-y-3">
            {status.coverage.map((row) => (
              <li key={row.id} className="rounded border border-border p-3">
                <strong>{row.id}</strong> · {row.kind} · {row.state}
                {row.error ? ` · ${row.error}` : ""}
                <div>
                  Access checked:{" "}
                  {row.checkedAt === null
                    ? "never"
                    : new Date(row.checkedAt).toISOString()}
                </div>
                <div>
                  Message event observed:{" "}
                  {row.lastEventAt === null
                    ? "never; subscription unverified"
                    : new Date(row.lastEventAt).toISOString()}
                </div>
              </li>
            ))}
          </ul>
          <h2 className="font-semibold">Known gaps (latest 100)</h2>
          {!status.gaps.length && (
            <p>No recorded gaps; this is not proof of complete coverage.</p>
          )}
          <ul className="space-y-2">
            {status.gaps.map((gap, index) => (
              <li key={`${gap.startedAt}:${index}`}>
                {new Date(gap.startedAt).toISOString()} —{" "}
                {gap.endedAt === null
                  ? "ongoing / unverified"
                  : new Date(gap.endedAt).toISOString()}
                : {gap.reason}
              </li>
            ))}
          </ul>
          <ul className="list-disc space-y-2 pl-5">
            {status.limitations.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      )}
      <details className="space-y-3">
        <summary className="cursor-pointer font-semibold">
          App setup and minimum scopes
        </summary>
        <p>{SETUP.approval}</p>
        <p>{SETUP.tokens}</p>
        <p>{SETUP.scope}</p>
        <ul>
          {Object.entries(SETUP.permissions).map(([kind, permission]) => (
            <li key={kind}>
              {kind}: {permission.scopes.join(", ")}; subscribe to{" "}
              {permission.event}
            </li>
          ))}
        </ul>
        <p>{SETUP.limits}</p>
        <p>
          CLI: <code>bb slack-inbox setup</code>, <code>status</code>,{" "}
          <code>coverage</code>, <code>retry</code>,{" "}
          <code>configure --data … --yes</code>. SDK: the same
          status/configure/checkCoverage/retry RPC contract on plugin{" "}
          <code>bb--slack-inbox</code>; secret settings use the core settings
          API.
        </p>
      </details>
    </section>
  );
}
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "slack-inbox",
    title: "Slack Inbox",
    icon: "Inbox",
    path: "slack-inbox",
    component: SlackInboxPanel,
  });
});
