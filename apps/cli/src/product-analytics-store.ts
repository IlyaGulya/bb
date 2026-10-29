import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { productAnalyticsEventSchema } from "@bb/server-contract";
import { experimental_productAnalyticsQueueKey, type ExperimentalAnalyticsQueueEntry, type ExperimentalAnalyticsQueueHealth, type ExperimentalAnalyticsQueueStore } from "@bb/sdk/node";

function missing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
function occupied(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "EEXIST"; }

export class LocalProductAnalyticsStore implements ExperimentalAnalyticsQueueStore {
  constructor(private readonly directory: string) {}
  private diagnostic(code: "g" | "e"): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, "diagnostics");
    let size = 0;
    try { size = statSync(path).size; } catch (error) { if (!missing(error)) throw error; }
    if (size < 1_048_576) appendFileSync(path, `${code}\n`, { mode: 0o600 });
  }
  private entries(): { entry: ExperimentalAnalyticsQueueEntry; directory: string; path: string; retry: boolean }[] {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const entries: { entry: ExperimentalAnalyticsQueueEntry; directory: string; path: string; retry: boolean }[] = [];
    for (const name of readdirSync(this.directory)) {
      if (!/^q(?:[0-9]|[1-9][0-9]|[1-4][0-9]{2})$/.test(name)) continue;
      const directory = join(this.directory, name);
      let names: string[];
      try { names = readdirSync(directory); } catch (error) { if (missing(error)) continue; throw error; }
      const file = names.find((value) => /^[a-f0-9]{64}\.json$/.test(value));
      if (file === undefined) {
        try { if (Date.now() - statSync(directory).mtimeMs > 60_000) { rmdirSync(directory); this.diagnostic("g"); } } catch (error) { if (!missing(error)) throw error; }
        continue;
      }
      const path = join(directory, file);
      try {
        const size = statSync(path).size;
        if (size > 4096) throw new Error("invalid_analytics_entry");
        const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
        const event = productAnalyticsEventSchema.parse(raw);
        const entry = { id: experimental_productAnalyticsQueueKey(event), event };
        if (createHash("sha256").update(entry.id).digest("hex") + ".json" !== file) throw new Error("invalid_analytics_identity");
        if (event.timestamp < Date.now() - 7 * 86_400_000) {
          this.remove(directory, path);
          this.diagnostic("e");
          continue;
        }
        entries.push({ entry, directory, path, retry: names.includes("retry") });
      } catch (error) {
        if (missing(error)) continue;
        if (Date.now() - statSync(path).mtimeMs < 60_000) continue;
        this.remove(directory, path);
        this.diagnostic("g");
      }
    }
    return entries;
  }
  private remove(directory: string, path: string): void {
    try { unlinkSync(path); } catch (error) { if (missing(error)) return; throw error; }
    try { unlinkSync(join(directory, "retry")); } catch (error) { if (!missing(error)) throw error; }
    try { rmdirSync(directory); } catch (error) { if (!missing(error)) throw error; }
  }
  enqueue(entry: ExperimentalAnalyticsQueueEntry): Promise<boolean> {
    if (this.entries().some((value) => value.entry.id === entry.id)) return Promise.resolve(true);
    const hash = createHash("sha256").update(entry.id).digest("hex");
    const start = Number.parseInt(hash.slice(0, 8), 16) % 500;
    for (let offset = 0; offset < 500; offset++) {
      const directory = join(this.directory, `q${(start + offset) % 500}`);
      try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (occupied(error)) continue; throw error; }
      writeFileSync(join(directory, `${hash}.json`), JSON.stringify(entry.event), { flag: "wx", mode: 0o600 });
      return Promise.resolve(true);
    }
    this.diagnostic("g");
    return Promise.resolve(false);
  }
  batch(): Promise<ExperimentalAnalyticsQueueEntry[]> {
    return Promise.resolve(this.entries().sort((a, b) => a.entry.event.timestamp - b.entry.event.timestamp).slice(0, 50).map(({ entry }) => entry));
  }
  settle(settlements: { id: string; status: "accepted" | "duplicate" | "retry" | "rejected" }[]): Promise<void> {
    for (const value of this.entries()) {
      const settlement = settlements.find(({ id }) => id === value.entry.id);
      if (settlement === undefined) continue;
      if (settlement.status === "retry") {
        try { writeFileSync(join(value.directory, "retry"), "", { flag: "wx", mode: 0o600 }); } catch (error) { if (!occupied(error) && !missing(error)) throw error; }
      } else {
        this.remove(value.directory, value.path);
        if (settlement.status === "rejected") this.diagnostic("g");
      }
    }
    return Promise.resolve();
  }
  health(): Promise<ExperimentalAnalyticsQueueHealth> {
    const entries = this.entries();
    let diagnostics = "";
    try { if (statSync(join(this.directory, "diagnostics")).size <= 1_048_576) diagnostics = readFileSync(join(this.directory, "diagnostics"), "utf8"); else diagnostics = "g"; } catch (error) { if (!missing(error)) throw error; }
    let gaps = 0;
    let expired = 0;
    for (const code of diagnostics) { if (code === "g") gaps++; if (code === "e") { expired++; gaps++; } }
    return Promise.resolve({ pending: entries.length, failed: entries.filter(({ retry }) => retry).length, gaps, expired, storage: "healthy" });
  }
}
