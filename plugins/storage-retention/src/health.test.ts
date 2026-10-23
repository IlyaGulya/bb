import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
} from "@get-bb/plugin-sdk/testing";
import { z } from "zod";
import plugin from "./server.js";
import { hostStorageContract } from "./host-contract.js";
import { measureMachineHealth } from "./host-health.js";
import {
  CRITICAL_FREE_BYTES,
  CRITICAL_FREE_RATIO,
  STALE_AFTER_MS,
  criticalFilesystems,
  fleetHealthSchema,
  healthState,
  transitionWarning,
  type MachineSample,
} from "./health-types.js";

afterEach(() => vi.restoreAllMocks());
const GiB = 1024 ** 3;
function sample(freeBytes = 20 * GiB): MachineSample {
  return {
    measuredAt: Date.now(),
    platform: "linux",
    scope: "host",
    cpu: { logicalCores: 4, loadAverage1m: 0 },
    memory: { totalBytes: 8 * GiB, availableBytes: 3 * GiB, basis: "os-free" },
    filesystems: [
      {
        path: "/fixture/data",
        kind: "data",
        resolvedPath: "/fixture/data",
        filesystemId: "device-1",
        totalBytes: 100 * GiB,
        freeBytes,
        error: null,
      },
    ],
  };
}

it("uses inclusive byte/ratio and stale boundaries without treating unknown or zero capacity as critical", () => {
  expect(criticalFilesystems(sample(CRITICAL_FREE_BYTES))).toHaveLength(1);
  expect(criticalFilesystems(sample(CRITICAL_FREE_BYTES + 1))).toHaveLength(0);
  const ratio = sample(10 * GiB);
  ratio.filesystems[0]!.totalBytes = (10 * GiB) / CRITICAL_FREE_RATIO;
  expect(criticalFilesystems(ratio)).toHaveLength(1);
  ratio.filesystems[0]!.freeBytes = 10 * GiB + 1;
  expect(criticalFilesystems(ratio)).toHaveLength(0);
  ratio.filesystems[0]!.freeBytes = null;
  expect(criticalFilesystems(ratio)).toHaveLength(0);
  ratio.filesystems[0]!.freeBytes = 0;
  ratio.filesystems[0]!.totalBytes = 0;
  expect(criticalFilesystems(ratio)).toHaveLength(0);
  const observed = sample();
  expect(
    healthState(
      "connected",
      observed.measuredAt,
      observed.measuredAt + STALE_AFTER_MS - 1,
    ),
  ).toBe("connected");
  expect(
    healthState(
      "connected",
      observed.measuredAt,
      observed.measuredAt + STALE_AFTER_MS,
    ),
  ).toBe("stale");
  expect(healthState("connected", null, 0)).toBe("unknown");
  expect(
    healthState("disconnected", observed.measuredAt, observed.measuredAt),
  ).toBe("offline");
  const first = transitionWarning(
    { active: false, signature: "", generation: 0 },
    "disk1",
  );
  expect(transitionWarning(first, "disk1")).toEqual(first);
  expect(
    transitionWarning(transitionWarning(first, ""), "disk1").generation,
  ).toBe(2);
});

it("measures real filesystem capacity for existing paths and reports missing paths as unavailable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-health-"));
  try {
    const report = await measureMachineHealth(
      [
        { path: root, kind: "code" },
        { path: path.join(root, "missing"), kind: "data" },
      ],
      new AbortController().signal,
    );
    const actual = await fs.statfs(root);
    expect(report.filesystems[0]).toMatchObject({
      totalBytes: actual.blocks * actual.bsize,
      error: null,
    });
    expect(report.filesystems[0]!.freeBytes).toBeGreaterThanOrEqual(0);
    expect(report.filesystems[1]).toMatchObject({
      totalBytes: null,
      freeBytes: null,
      filesystemId: null,
    });
    expect(report.filesystems[1]!.error).not.toBeNull();
    if (report.scope !== "host") expect(report.cpu).toBeNull();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("persists observations, warning identity and incident generations over reload, unavailable reads and recovery", async () => {
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let online = true;
  let unavailable = false;
  let free = 2 * GiB;
  let inboxAvailable = false;
  const deliveries: { sourceKey: string; revision: string; active: boolean }[] =
    [];
  const source = z.object({
    sourceKey: z.string(),
    revision: z.string(),
    active: z.boolean(),
  });
  const machine = () =>
    makeHostResponse({
      id: "host_fixture",
      name: "Fixture",
      status: online ? "connected" : "disconnected",
      lastSeenAt: now,
    });
  let host = createFakePluginHost({
    pluginId: "bb--storage-retention",
    experimental_hostEntry: true,
    experimental_callHostRpc: async (call) => {
      expect(call.method).toBe("health");
      hostStorageContract.health.input.parse(call.input);
      if (unavailable) throw new Error("worker unavailable");
      return sample(free);
    },
    sdk: {
      hosts: {
        list: async () => [machine()],
        get: async () => ({
          ...machine(),
          threadStorageRootPath: "/fixture/data",
          connectMachineId: null,
        }),
      },
      projects: { list: async () => [] },
      environments: { list: async () => [] },
      threads: { listRunning: async () => [] },
      plugins: {
        callRpc: async (input) => {
          if (!inboxAvailable) throw new Error("Tasks disabled");
          deliveries.push(source.parse(input.input));
          return input.outputSchema.parse({
            item: { id: "inbox_fixture", state: "open" },
            changed: true,
          });
        },
      },
    },
  });
  const scan = async () =>
    fleetHealthSchema.parse(await host.harness.callRpc("scanHealth", null))
      .hosts[0]!;
  try {
    plugin(host.bb);
    const initial = await scan();
    expect(initial.disk.generation).toBe(1);
    expect(initial.inboxError).toContain("Tasks disabled");
    expect(initial.activeWork?.count).toBe(0);
    expect(initial.capacity).toBeNull();
    inboxAvailable = true;
    await scan();
    const first = deliveries[0]!;
    expect(first).toEqual({
      sourceKey: "host_fixture:disk",
      revision: "1:device-1",
      active: true,
    });
    host = await host.harness.lifecycle.reload(plugin);
    now += 60_000;
    free = 1 * GiB;
    await scan();
    expect(deliveries.at(-1)).toEqual(first);
    unavailable = true;
    now += STALE_AFTER_MS;
    const stale = await scan();
    expect(stale.state).toBe("stale");
    expect(stale.disk.active).toBe(true);
    expect(stale.error).toContain("worker unavailable");
    online = false;
    const lost = await scan();
    expect(lost.state).toBe("offline");
    expect(lost.loss).toMatchObject({ active: true, generation: 1 });
    expect(deliveries.at(-1)).toEqual({
      sourceKey: "host_fixture:connection",
      revision: "1:disconnected",
      active: true,
    });
    online = true;
    unavailable = false;
    free = 20 * GiB;
    const recovered = await scan();
    expect(recovered.disk.active).toBe(false);
    expect(recovered.loss.active).toBe(false);
    free = 2 * GiB;
    const next = await scan();
    expect(next.disk.generation).toBe(2);
    expect(
      deliveries.filter((entry) => entry.sourceKey.endsWith(":disk")).at(-1)
        ?.revision,
    ).toBe("2:device-1");
  } finally {
    await host.harness.dispose();
  }
});

it("lists a never-observed offline host without inventing metrics, work counts or a loss incident", async () => {
  const host = createFakePluginHost({
    pluginId: "bb--storage-retention",
    experimental_hostEntry: true,
    sdk: {
      hosts: {
        list: async () => [
          makeHostResponse({ id: "host_unobserved", status: "disconnected" }),
        ],
      },
      projects: { list: async () => [] },
      threads: {
        listRunning: async () => {
          throw new Error("Work state unavailable");
        },
      },
    },
  });
  try {
    plugin(host.bb);
    const report = fleetHealthSchema.parse(
      await host.harness.callRpc("scanHealth", null),
    ).hosts[0]!;
    expect(report).toMatchObject({
      state: "offline",
      sample: null,
      activeWork: null,
      capacity: null,
      observedConnectedAt: null,
      loss: { active: false, generation: 0 },
    });
    expect(host.harness.sdk.callsTo("plugins.callRpc")).toHaveLength(0);
  } finally {
    await host.harness.dispose();
  }
});

it("counts canonical running work by its reported host and returns unknown for unresolved routing", async () => {
  let running: { id: string; hostId: string | null }[] = [
    { id: "thr_active", hostId: "host_fixture" },
    { id: "thr_hidden_starting", hostId: "host_fixture" },
    { id: "thr_other", hostId: "host_other" },
  ];
  const host = createFakePluginHost({
    pluginId: "bb--storage-retention",
    experimental_hostEntry: true,
    sdk: {
      hosts: {
        list: async () => [
          makeHostResponse({ id: "host_fixture" }),
          makeHostResponse({ id: "host_other" }),
        ],
      },
      threads: { listRunning: async () => running },
    },
  });
  try {
    plugin(host.bb);
    const fleet = fleetHealthSchema.parse(
      await host.harness.callRpc("health", null),
    );
    expect(fleet.hosts[0]!.activeWork).toMatchObject({
      count: 2,
      threadIds: ["thr_active", "thr_hidden_starting"],
    });
    expect(fleet.hosts[1]!.activeWork).toMatchObject({
      count: 1,
      threadIds: ["thr_other"],
    });
    running = [{ id: "thr_unresolved", hostId: null }];
    const unresolved = fleetHealthSchema.parse(
      await host.harness.callRpc("health", null),
    );
    expect(
      unresolved.hosts.every((machine) => machine.activeWork === null),
    ).toBe(true);
  } finally {
    await host.harness.dispose();
  }
});

it("defaults to health-only even with saved destructive policy and rejects all public cleanup paths", async () => {
  const host = createFakePluginHost({
    pluginId: "bb--storage-retention",
    experimental_hostEntry: true,
  });
  try {
    await host.bb.storage.kv.set("policy", {
      archiveAfterDays: 1,
      deleteAfterDays: 1,
      deleteStorageOnArchive: true,
      deleteDevDataOnCheckoutRemoval: true,
    });
    plugin(host.bb);
    expect(await host.harness.callRpc("state", null)).toMatchObject({
      readOnly: true,
      policy: {
        archiveAfterDays: null,
        deleteAfterDays: null,
        deleteStorageOnArchive: false,
        deleteDevDataOnCheckoutRemoval: false,
      },
    });
    for (const schedule of [
      "retention",
      "archive-storage-cleanup",
      "development-storage-cleanup",
    ])
      await host.harness.runSchedule(schedule);
    for (const [method, input] of [
      ["startCleanup", { hostId: "host_fixture", kind: "orphans" }],
      ["removeOrphans", { hostId: "host_fixture" }],
      ["retryWorktreeCleanup", { hostId: "host_fixture" }],
      ["clearLargeFiles", { hostId: null }],
      ["startClearLargeFiles", { hostId: null }],
      ["clearArchivedFiles", { hostId: "host_fixture" }],
      ["startClearArchivedFiles", { hostId: "host_fixture" }],
      ["clearThread", { threadId: "thr_fixture" }],
      ["removeDevInstances", { hostId: "host_fixture", names: null }],
    ] as const)
      await expect(host.harness.callRpc(method, input)).rejects.toThrow(
        "read-only",
      );
    const cli = await host.harness.runCli([
      "cleanup",
      "--machine",
      "host_fixture",
      "--kind",
      "development",
      "--yes",
    ]);
    expect(cli.exitCode).toBe(1);
    expect(cli.stderr).toContain("read-only");
    await expect(
      host.harness.callRpc("configure", {
        archiveAfterDays: 1,
        deleteAfterDays: null,
        deleteStorageOnArchive: false,
        deleteDevDataOnCheckoutRemoval: false,
      }),
    ).rejects.toThrow("Never/off");
    expect(host.harness.sdk.callsTo("threads.archive")).toHaveLength(0);
    expect(host.harness.sdk.callsTo("threads.delete")).toHaveLength(0);
  } finally {
    await host.harness.dispose();
  }
});
