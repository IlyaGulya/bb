import type { z } from "zod";
import type { NativeChunk, NativeDiscovery } from "@bb/host-daemon-contract";
import type {
  nativeImportDiscoverSchema, nativeImportPreviewSchema,
  NativeImportBatch, NativeImportBytes, NativeImportContinue, NativeImportHandoff, NativeImportManifest,
  NativeImportPage, NativeImportPageResponse, NativeImportStart,
} from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

type Signal = { signal?: AbortSignal };
export interface ExperimentalNativeSessionImportsArea {
  discover(input: z.infer<typeof nativeImportDiscoverSchema> & Signal): Promise<NativeDiscovery>;
  preview(input: z.infer<typeof nativeImportPreviewSchema> & Signal): Promise<NativeChunk>;
  start(input: NativeImportStart & Signal): Promise<NativeImportBatch>;
  get(input: { importId: string } & Signal): Promise<NativeImportManifest>;
  forThread(input: { threadId: string } & Signal): Promise<NativeImportManifest | null>;
  resume(input: { importId: string } & Signal): Promise<NativeImportManifest>;
  cancel(input: { importId: string } & Signal): Promise<NativeImportManifest>;
  records(input: NativeImportPage & Signal): Promise<NativeImportPageResponse>;
  bytes(input: NativeImportBytes & Signal): Promise<{ content: string; offset: number; sizeBytes: number; sha256: string }>;
  download(input: { importId: string; file: string } & Signal): Promise<Response>;
  admit(input: NativeImportContinue & Signal): Promise<NativeImportManifest>;
  handoff(input: NativeImportHandoff & Signal): Promise<NativeImportManifest>;
}
export function createNativeSessionImportsArea({ transport }: CreateSdkAreaArgs): ExperimentalNativeSessionImportsArea {
  const api = transport.api.v1["native-session-imports"];
  return {
    discover: ({ signal, ...json }) => transport.readJson(api.discover.$post({ json }, ...signalRequestArgs(signal))),
    preview: ({ signal, ...json }) => transport.readJson(api.preview.$post({ json }, ...signalRequestArgs(signal))),
    start: ({ signal, ...json }) => transport.readJson(api.start.$post({ json }, ...signalRequestArgs(signal))),
    get: ({ signal, ...json }) => transport.readJson(api.get.$post({ json }, ...signalRequestArgs(signal))),
    forThread: ({ signal, ...json }) => transport.readJson(api["for-thread"].$post({ json }, ...signalRequestArgs(signal))),
    resume: ({ signal, ...json }) => transport.readJson(api.resume.$post({ json }, ...signalRequestArgs(signal))),
    cancel: ({ signal, ...json }) => transport.readJson(api.cancel.$post({ json }, ...signalRequestArgs(signal))),
    records: ({ signal, ...json }) => transport.readJson(api.records.$post({ json }, ...signalRequestArgs(signal))),
    bytes: ({ signal, ...json }) => transport.readJson(api.bytes.$post({ json }, ...signalRequestArgs(signal))),
    download: ({ signal, ...query }) => transport.resolve(api.file.$get({ query }, ...signalRequestArgs(signal))),
    admit: ({ signal, ...json }) => transport.readJson(api.admit.$post({ json }, ...signalRequestArgs(signal))),
    handoff: ({ signal, ...json }) => transport.readJson(api.handoff.$post({ json }, ...signalRequestArgs(signal))),
  };
}
