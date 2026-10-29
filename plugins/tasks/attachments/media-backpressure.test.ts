import type { ReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachmentMediaResponse } from "./media.js";

const observation = vi.hoisted(() => ({ onStream: null as ((stream: ReadStream) => void) | null }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      const file = await actual.open(...args);
      const createReadStream = file.createReadStream.bind(file);
      file.createReadStream = options => {
        const stream = createReadStream(options);
        observation.onStream?.(stream);
        return stream;
      };
      return file;
    },
  };
});
afterEach(() => { observation.onStream = null; });

const fixtureUrl = new URL("../../../apps/web/public/blog/tweets/tiling.mp4", import.meta.url);

describe("task media backpressure", () => {
  it.each(["full", "range"] as const)("does not read an entire %s representation while its Web body consumer is stalled", async kind => {
    const expected = await readFile(fixtureUrl);
    const length = kind === "range" ? Math.floor(expected.length / 2) : expected.length;
    const producer: { stream: ReadStream | null } = { stream: null };
    const pausedOrEnded = new Promise<number>((resolve, reject) => {
      observation.onStream = stream => {
        producer.stream = stream;
        stream.on("pause", () => { if (stream.bytesRead > 0) resolve(stream.bytesRead); });
        stream.once("end", () => resolve(stream.bytesRead));
        stream.once("error", reject);
      };
    });
    const response = await attachmentMediaResponse(
      new Request("http://owned.test/fixture.mp4", { headers: kind === "range" ? { range: `bytes=0-${length - 1}` } : {} }),
      fileURLToPath(fixtureUrl), "video/mp4", new Headers({ "Content-Type": "video/mp4" }), true,
    );
    if (!response.body) throw new Error("Expected a streaming media response");
    const reader = response.body.getReader();
    try {
      const first = await reader.read();
      if (first.done) throw new Error("Media ended before the consumer received its first chunk");
      const readAheadWhileStalled = await pausedOrEnded;
      const chunks = [first.value];
      for (let next = await reader.read(); !next.done; next = await reader.read()) chunks.push(next.value);
      expect(response.status).toBe(kind === "range" ? 206 : 200);
      expect(Buffer.concat(chunks)).toEqual(expected.subarray(0, length));
      expect(readAheadWhileStalled).toBeLessThan(length);
    } finally {
      await reader.cancel();
      reader.releaseLock();
      producer.stream?.destroy();
    }
  });
});
