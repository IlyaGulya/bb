import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { sdk } from "@/lib/sdk";

export function NativeHistoryLink({ threadId }: { threadId: string }) {
  const history = useQuery({
    queryKey: ["native-session-import", "thread", threadId],
    queryFn: ({ signal }) => sdk.experimental_nativeSessionImports.forThread({ threadId, signal }),
    staleTime: 30_000,
    refetchInterval: (query) => query.state.data?.status === "importing" ? 1000 : false,
  });
  if (history.isError) return <Link className="inline-flex min-h-11 items-center break-words text-xs text-destructive underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" to="/native-session-imports">History provenance unavailable · open saved imports</Link>;
  if (!history.data) return null;
  const manifest = history.data;
  const label = manifest.mode === "native-admitted" ? "Imported native history" : manifest.mode === "new-handoff" ? "Handoff source archive" : "Imported archive only";
  return <Link
    className="inline-flex min-h-11 min-w-0 items-center rounded-md px-2 text-xs text-muted-foreground underline underline-offset-4 hover:bg-state-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
    to={`/native-session-imports?${new URLSearchParams({ importId: manifest.id })}`}
    title={`${label}: ${manifest.source.title}. Open this archive to refresh new messages. ${manifest.reason}`}
    aria-label={`${label}: ${manifest.source.title}. Open saved archive and refresh new messages.`}
  ><span className="hidden sm:inline">{label}{manifest.mode !== "native-admitted" ? " · refresh" : ""}</span><span className="sm:hidden">{manifest.mode === "native-admitted" ? "Native history" : "Archive · refresh"}</span></Link>;
}
