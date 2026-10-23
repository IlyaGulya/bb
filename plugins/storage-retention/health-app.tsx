import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { storageRpc } from "./src/contract.js";
import type { FleetHealth } from "./src/health-types.js";
import { Button } from "@/components/ui/button";

function bytes(value: number | null) {
  if (value === null) return "unavailable";
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}
function timestamp(value: number | null) {
  return value === null ? "not observed" : new Date(value).toISOString();
}
export function FleetHealthPanel({
  hostId,
  readOnly,
}: {
  hostId: string | null;
  readOnly: boolean;
}) {
  const rpc = useRpc<typeof storageRpc>();
  const [fleet, setFleet] = useState<FleetHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestRevision = useRef(0);
  const refresh = useCallback(() => {
    const request = ++requestRevision.current;
    return rpc.call("health", null).then(
      (next) => {
        if (request !== requestRevision.current) return;
        setFleet(next);
        setError(null);
      },
      (failure: unknown) => {
        if (request === requestRevision.current)
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      },
    );
  }, [rpc]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);
  useRealtime("health-changed", refresh);
  async function scan() {
    setBusy(true);
    const request = ++requestRevision.current;
    try {
      const next = await rpc.call("scanHealth", null);
      if (request !== requestRevision.current) return;
      setFleet(next);
      setError(null);
    } catch (failure) {
      if (request === requestRevision.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Fleet health"
      className="mx-auto w-full max-w-3xl space-y-4 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-base font-semibold">Fleet health</h1>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void scan()}
        >
          {busy ? "Measuring…" : "Refresh measurements"}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        {readOnly
          ? "Read-only mode. Retention: Never. All plugin deletion and process-stop actions are disabled."
          : "Health measurements are read-only. Storage maintenance is separately enabled."}{" "}
        Core orphan maintenance is unchanged.
      </p>
      <p className="text-xs text-muted-foreground">
        One-minute samples; stale after three minutes. Critical disk: at most 5
        GiB or 5% available. CPU is one-minute load, not utilization. Host RAM
        is OS free memory, not cache-adjusted available memory; container RAM is
        limit minus usage. Active work counts canonical starting/active BB
        threads. Unavailable values are never zero-filled.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {fleet === null && !error && <p role="status">Loading fleet health…</p>}
      {fleet?.hosts
        .filter((host) => hostId === null || host.hostId === hostId)
        .map((host) => (
          <article
            key={host.hostId}
            className="space-y-2 rounded-lg border border-border p-3"
          >
            <h2 className="text-sm font-semibold">
              {host.name} · {host.state}
            </h2>
            <p className="break-all text-xs text-muted-foreground">
              {host.hostId} · {host.hostType} · {host.connection} ·{" "}
              {host.sample?.platform ?? "platform unknown"} · scope:{" "}
              {host.sample?.scope ?? "unknown"}
            </p>
            <dl className="grid gap-1 text-xs">
              <div>
                <dt className="inline font-medium">Sample: </dt>
                <dd className="inline">
                  {timestamp(host.sample?.measuredAt ?? null)}
                </dd>
              </div>
              <div>
                <dt className="inline font-medium">Last seen by server: </dt>
                <dd className="inline">{timestamp(host.lastSeenAt)}</dd>
              </div>
              <div>
                <dt className="inline font-medium">
                  Connection observed changing:{" "}
                </dt>
                <dd className="inline">
                  {timestamp(host.connectionChangedAt)}
                </dd>
              </div>
              <div>
                <dt className="inline font-medium">Measurement attempted: </dt>
                <dd className="inline">{timestamp(host.attemptedAt)}</dd>
              </div>
              <div>
                <dt className="inline font-medium">CPU: </dt>
                <dd className="inline">
                  {host.sample?.cpu
                    ? `${host.sample.cpu.logicalCores} logical cores; load ${host.sample.cpu.loadAverage1m.toFixed(2)}`
                    : "unavailable in this scope"}
                </dd>
              </div>
              <div>
                <dt className="inline font-medium">RAM: </dt>
                <dd className="inline">
                  {host.sample?.memory
                    ? `${bytes(host.sample.memory.availableBytes)} ${host.sample.memory.basis === "os-free" ? "OS free (not cache-adjusted)" : "remaining under container limit"} / ${bytes(host.sample.memory.totalBytes)} total`
                    : "unavailable in this scope"}
                </dd>
              </div>
              <div>
                <dt className="inline font-medium">Active BB threads: </dt>
                <dd className="inline">
                  {host.activeWork?.count ?? "unknown"}; worker capacity:
                  unavailable
                </dd>
              </div>
            </dl>
            {host.error && (
              <p className="text-xs text-destructive">
                Measurement unavailable: {host.error}
              </p>
            )}
            {host.inboxError && (
              <p className="text-xs text-destructive">
                Inbox delivery pending: {host.inboxError}
              </p>
            )}
            {(host.disk.active || host.loss.active) && (
              <p role="status" className="text-sm text-destructive">
                {host.disk.active ? "Critical disk warning. " : ""}
                {host.loss.active
                  ? "Previously observed worker is offline."
                  : ""}
              </p>
            )}
            {host.sample?.filesystems.map((fs) => (
              <div
                key={`${fs.kind}:${fs.path}`}
                className="break-all border-t border-border pt-2 text-xs"
              >
                <p>
                  {fs.kind}: {fs.path}
                </p>
                <p>
                  {fs.error
                    ? `Unavailable: ${fs.error}`
                    : `${bytes(fs.freeBytes)} available / ${bytes(fs.totalBytes)}; filesystem ${fs.filesystemId}`}
                </p>
                {fs.resolvedPath !== null && fs.resolvedPath !== fs.path && (
                  <p>Resolved: {fs.resolvedPath}</p>
                )}
              </div>
            ))}
            {host.sample?.filesystems.length === 0 && (
              <p className="text-xs">No code/data paths reported.</p>
            )}
          </article>
        ))}
    </section>
  );
}
