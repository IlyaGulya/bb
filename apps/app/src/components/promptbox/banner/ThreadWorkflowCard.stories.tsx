import { useMemo, useState } from "react";
import type {
  WorkflowAgentSnapshot,
  WorkflowAgentState,
  WorkflowPhaseSnapshot,
  WorkflowProgressSnapshot,
} from "@bb/domain";
import { ThreadWorkflowCard } from "./ThreadWorkflowCard";
import { ThreadWorkflowStack } from "./ThreadWorkflowStack";
import { workflowRow } from "@/test/fixtures/thread-timeline-rows";
import { StoryCard, StoryRow } from "../../../../.ladle/story-card";
import { FauxComposer, ResponsiveStage } from "./banner-story-stages";

export default {
  title: "promptbox/banner/Workflow Card",
};

const investigationSnapshot: WorkflowProgressSnapshot = {
  phases: [
    { index: 1, title: "Investigate" },
    { index: 2, title: "Synthesize" },
  ],
  agents: [
    ["data-model", 79_000, 37, 199_000],
    ["server-exec", 98_300, 34, 224_000],
    ["contract-sdk-cli", 93_800, 47, 256_000],
    ["app-ui", 79_000, 47, 265_000],
    ["goals-runtime", 121_800, 45, 254_000],
    ["templates-security", 90_300, 51, 226_000],
  ].map(([label, tokens, toolCalls, durationMs], i) => ({
    index: i + 1,
    label: label as string,
    state: "done" as const,
    model: "opus",
    attempt: 1,
    cached: false,
    lastProgressAt: 1780540129098,
    phaseIndex: 1,
    phaseTitle: "Investigate",
    queuedAt: 1780540127739,
    startedAt: 1780540127740,
    tokens: tokens as number,
    toolCalls: toolCalls as number,
    durationMs: durationMs as number,
  })),
};
investigationSnapshot.agents.push({
  index: 7,
  label: "synthesize-plan",
  state: "running",
  model: "opus",
  attempt: 1,
  cached: false,
  lastProgressAt: 1780540129378,
  phaseIndex: 2,
  phaseTitle: "Synthesize",
  queuedAt: 1780540127739,
  startedAt: 1780540127740,
  tokens: 71_200,
  toolCalls: 0,
});

const runningWorkflow = workflowRow({
  id: "thr_fixture:workflow:investigation:running",
  status: "pending",
  taskStatus: "running",
  workflowName: "bb-plugin-investigation",
  description: "Investigate the plugin subsystem",
  startedAt: Date.now() - 326_000,
  workflow: investigationSnapshot,
  usage: { totalTokens: 633_400, toolUses: 261, durationMs: 326_000 },
});

const PHASE_VERBS = [
  "Scan",
  "Map",
  "Audit",
  "Refactor",
  "Verify",
  "Synthesize",
  "Index",
  "Trace",
  "Validate",
  "Summarize",
];
const PHASE_TARGETS = [
  "data model",
  "server routes",
  "CLI surface",
  "UI components",
  "auth flow",
  "migrations",
  "telemetry",
  "fixtures",
  "docs",
  "tests",
];

function phaseTitle(i: number): string {
  const verb = PHASE_VERBS[i % PHASE_VERBS.length];
  const target = PHASE_TARGETS[(i * 3) % PHASE_TARGETS.length];
  return `${verb} ${target}`;
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function buildManyPhasesSnapshot(
  phaseCount: number,
  activePhase: number,
): WorkflowProgressSnapshot {
  const phases: WorkflowPhaseSnapshot[] = [];
  const agents: WorkflowAgentSnapshot[] = [];
  const progressAt = 1780540129098;
  let agentIndex = 1;
  for (let p = 1; p <= phaseCount; p++) {
    const title = phaseTitle(p - 1);
    phases.push({ index: p, title });
    const agentCount = ((p - 1) % 3) + 1;
    for (let a = 0; a < agentCount; a++) {
      const done = p < activePhase;
      const running = p === activePhase && a === 0;
      const state: WorkflowAgentState = done
        ? "done"
        : running
          ? "running"
          : "queued";
      const agent: WorkflowAgentSnapshot = {
        index: agentIndex++,
        label: `${slug(title)}-${a + 1}`,
        state,
        model: a % 2 === 0 ? "opus" : "haiku",
        attempt: 1,
        cached: false,
        lastProgressAt: progressAt,
        phaseIndex: p,
        phaseTitle: title,
        queuedAt: progressAt - 2_000,
      };
      if (state !== "queued") {
        agent.startedAt = progressAt - 1_000;
      }
      if (done) {
        agent.tokens = 42_000 + ((p * 7 + a * 13) % 90) * 1_000;
        agent.toolCalls = 18 + ((p * 5 + a * 7) % 40);
        agent.durationMs = 150_000 + ((p * 11 + a * 17) % 130) * 1_000;
      } else if (running) {
        agent.tokens = 28_400;
        agent.toolCalls = 9;
      }
      agents.push(agent);
    }
  }
  return { phases, agents };
}

const manyPhasesWorkflow = workflowRow({
  id: "thr_fixture:workflow:many-phases:running",
  status: "pending",
  taskStatus: "running",
  workflowName: "bb-repo-wide-audit",
  description: "Audit the entire repository across forty phases",
  startedAt: Date.now() - 1_472_000,
  workflow: buildManyPhasesSnapshot(40, 12),
  usage: { totalTokens: 4_210_000, toolUses: 1_284, durationMs: 1_472_000 },
});

const secondRunningWorkflow = workflowRow({
  id: "thr_fixture:workflow:balance:running",
  status: "pending",
  taskStatus: "running",
  workflowName: "bb-balance-pass",
  description: "Close the remaining balance defects",
  startedAt: Date.now() - 94_000,
  workflow: {
    phases: [
      { index: 1, title: "Diagnose" },
      { index: 2, title: "Fix" },
      { index: 3, title: "Verify" },
    ],
    agents: [
      {
        index: 1,
        label: "diag:aggression",
        state: "done",
        model: "opus",
        attempt: 1,
        cached: false,
        lastProgressAt: 1780540129098,
        phaseIndex: 1,
        phaseTitle: "Diagnose",
        queuedAt: 1780540127739,
        startedAt: 1780540127740,
        tokens: 88_100,
        toolCalls: 24,
        durationMs: 61_000,
      },
      {
        index: 2,
        label: "diag:weight",
        state: "running",
        model: "opus",
        attempt: 1,
        cached: false,
        lastProgressAt: 1780540129378,
        phaseIndex: 1,
        phaseTitle: "Diagnose",
        queuedAt: 1780540127739,
        startedAt: 1780540127740,
        tokens: 31_500,
        toolCalls: 7,
      },
    ],
  },
  usage: { totalTokens: 119_600, toolUses: 31, durationMs: 94_000 },
});

function ToggleableCard({
  workflow,
  initialExpanded = true,
}: {
  workflow: typeof runningWorkflow;
  initialExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(initialExpanded);
  return (
    <ThreadWorkflowCard
      workflow={workflow}
      isExpanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
    />
  );
}

function CollapsedWorkflowPreview() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <ThreadWorkflowCard
      workflow={runningWorkflow}
      isExpanded={collapsed}
      onToggle={() => setCollapsed((value) => !value)}
    />
  );
}

function AutoAdvancePreview() {
  const [activePhase, setActivePhase] = useState(3);
  const [expanded, setExpanded] = useState(true);
  const workflow = useMemo(
    () =>
      workflowRow({
        id: "thr_fixture:workflow:auto-advance:running",
        status: "pending",
        taskStatus: "running",
        workflowName: "bb-repo-wide-audit",
        description: "Audit the entire repository across forty phases",
        startedAt: Date.now() - 1_472_000,
        workflow: buildManyPhasesSnapshot(40, activePhase),
        usage: {
          totalTokens: 4_210_000,
          toolUses: 1_284,
          durationMs: 1_472_000,
        },
      }),
    [activePhase],
  );
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setActivePhase((p) => Math.min(40, p + 1))}
        className="self-start rounded-md border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-state-hover"
      >
        Advance to phase {Math.min(40, activePhase + 1)}
      </button>
      <ThreadWorkflowCard
        workflow={workflow}
        isExpanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
      />
      <FauxComposer />
    </div>
  );
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="prompt stack"
        hint="floats above the composer while the workflow runs (click to toggle)"
      >
        <ResponsiveStage>
          <div className="flex flex-col gap-2">
            <ToggleableCard workflow={runningWorkflow} />
            <FauxComposer />
          </div>
        </ResponsiveStage>
      </StoryRow>
      <StoryRow
        label="collapsed"
        hint="single-line glance: name, agent count, live time"
      >
        <ResponsiveStage>
          <CollapsedWorkflowPreview />
        </ResponsiveStage>
      </StoryRow>
    </StoryCard>
  );
}

function ToggleableStack({
  workflows,
}: {
  workflows: readonly (typeof runningWorkflow)[];
}) {
  const [isStackExpanded, setIsStackExpanded] = useState(false);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  return (
    <ThreadWorkflowStack
      workflows={workflows}
      isStackExpanded={isStackExpanded}
      onToggleStack={() => setIsStackExpanded((value) => !value)}
      expandedWorkflowIds={expandedIds}
      onToggleWorkflow={(id) =>
        setExpandedIds((current) => {
          const next = new Set(current);
          if (!next.delete(id)) next.add(id);
          return next;
        })
      }
    />
  );
}

const concurrentWorkflows = [
  secondRunningWorkflow,
  runningWorkflow,
  {
    ...secondRunningWorkflow,
    id: "thr_fixture:workflow:balance:running-2",
    workflowName: "bb-balance-pass-2",
  },
  {
    ...runningWorkflow,
    id: "thr_fixture:workflow:investigation:running-2",
    workflowName: "bb-plugin-investigation-2",
  },
];

export function ConcurrentWorkflows() {
  return (
    <StoryCard>
      <StoryRow
        label="two running"
        hint="two or more running workflows auto-collapse into a stack: the newest card in front with a +N count and peeking edges; tapping it fans out into individual cards with an up chevron below them to restack"
      >
        <ResponsiveStage>
          <div className="flex flex-col gap-2">
            <ToggleableStack workflows={concurrentWorkflows.slice(0, 2)} />
            <FauxComposer />
          </div>
        </ResponsiveStage>
      </StoryRow>
      <StoryRow
        label="four running"
        hint="at most two peeking edges, however many workflows are running"
      >
        <ResponsiveStage>
          <div className="flex flex-col gap-2">
            <ToggleableStack workflows={concurrentWorkflows} />
            <FauxComposer />
          </div>
        </ResponsiveStage>
      </StoryRow>
    </StoryCard>
  );
}

export function ManyPhases() {
  return (
    <StoryCard>
      <StoryRow
        label="40 phases"
        hint="caps at a max height and scrolls; each phase is its own toggle and only the active phase is expanded by default"
      >
        <ResponsiveStage>
          <div className="flex flex-col gap-2">
            <ToggleableCard workflow={manyPhasesWorkflow} />
            <FauxComposer />
          </div>
        </ResponsiveStage>
      </StoryRow>
    </StoryCard>
  );
}

export function AutoAdvance() {
  return (
    <StoryCard>
      <StoryRow
        label="auto-advance"
        hint="advancing the run moves the open phase forward and scrolls it into view; phases you toggle yourself stay as you left them"
      >
        <ResponsiveStage>
          <AutoAdvancePreview />
        </ResponsiveStage>
      </StoryRow>
    </StoryCard>
  );
}

const STATE_PROGRESS_AT = 1780540129098;

function stateAgent(
  index: number,
  label: string,
  state: WorkflowAgentState,
  phase: WorkflowPhaseSnapshot | null,
  extra: Partial<WorkflowAgentSnapshot> = {},
): WorkflowAgentSnapshot {
  const settled = state === "done" || state === "failed";
  return {
    index,
    label,
    state,
    model: "opus",
    attempt: 1,
    cached: false,
    lastProgressAt: STATE_PROGRESS_AT,
    ...(phase ? { phaseIndex: phase.index, phaseTitle: phase.title } : {}),
    queuedAt: STATE_PROGRESS_AT - 2_000,
    ...(state === "queued" || state === "skipped"
      ? {}
      : { startedAt: STATE_PROGRESS_AT - 1_000, tokens: 48_300, toolCalls: 14 }),
    ...(settled ? { durationMs: 132_000 } : {}),
    ...extra,
  };
}

function stateWorkflow(
  name: string,
  workflow: WorkflowProgressSnapshot | null,
  extra: { error?: string; summary?: string } = {},
) {
  return workflowRow({
    id: `thr_fixture:workflow:states:${name}`,
    status: "pending",
    taskStatus: "running",
    workflowName: name,
    description: name,
    startedAt: Date.now() - 214_000,
    workflow,
    error: extra.error ?? null,
    summary: extra.summary ?? null,
  });
}

const reviewPhase = { index: 1, title: "Review" };
const agentStatesWorkflow = stateWorkflow("agent-states", {
  phases: [reviewPhase],
  agents: [
    stateAgent(1, "running-agent", "running", reviewPhase),
    stateAgent(2, "done-agent", "done", reviewPhase),
    stateAgent(3, "failed-agent", "failed", reviewPhase, {
      error: "Tool call timed out",
    }),
    stateAgent(4, "retried-agent", "running", reviewPhase, { attempt: 2 }),
    stateAgent(5, "cached-agent", "done", reviewPhase, { cached: true }),
    stateAgent(6, "skipped-agent", "skipped", reviewPhase),
    stateAgent(7, "queued-agent", "queued", reviewPhase),
  ],
});

const donePhase = { index: 1, title: "Completed phase" };
const failedPhase = { index: 2, title: "Phase with a failure" };
const activePhase = { index: 3, title: "Active phase" };
const upcomingPhase = { index: 4, title: "Upcoming phase" };
const emptyPhase = { index: 5, title: "Not started phase" };
const phaseStatesWorkflow = stateWorkflow("phase-states", {
  phases: [donePhase, failedPhase, activePhase, upcomingPhase, emptyPhase],
  agents: [
    stateAgent(1, "collect-1", "done", donePhase),
    stateAgent(2, "collect-2", "done", donePhase),
    stateAgent(3, "check-1", "done", failedPhase),
    stateAgent(4, "check-2", "failed", failedPhase, {
      error: "Exited with code 1",
    }),
    stateAgent(5, "build-1", "running", activePhase),
    stateAgent(6, "build-2", "queued", activePhase),
    stateAgent(7, "ship-1", "queued", upcomingPhase),
  ],
});

const unphasedWorkflow = stateWorkflow("unphased-agents", {
  phases: [],
  agents: [
    stateAgent(1, "scout-1", "done", null),
    stateAgent(2, "scout-2", "running", null),
    stateAgent(3, "scout-3", "queued", null),
  ],
});

const workflowErrorWorkflow = stateWorkflow(
  "workflow-error",
  {
    phases: [reviewPhase],
    agents: [stateAgent(1, "running-agent", "running", reviewPhase)],
  },
  { error: "Workflow script threw: phase 2 schema mismatch" },
);

const noProgressWorkflow = stateWorkflow("no-progress-yet", null, {
  summary: "Starting workflow…",
});

const startingWorkflow = stateWorkflow("starting", {
  phases: [
    { index: 1, title: "Plan" },
    { index: 2, title: "Build" },
  ],
  agents: [],
});

export function States() {
  return (
    <StoryCard>
      <StoryRow
        label="agent states"
        hint="running, done, failed with error, retried, cached, skipped, queued — all in one phase"
      >
        <ResponsiveStage>
          <ToggleableCard workflow={agentStatesWorkflow} />
        </ResponsiveStage>
      </StoryRow>
      <StoryRow
        label="phase states"
        hint="completed (collapsed, check), failed (open), active (open, highlighted), upcoming (open, queued), not started (no agents, no chevron)"
      >
        <ResponsiveStage>
          <ToggleableCard workflow={phaseStatesWorkflow} />
        </ResponsiveStage>
      </StoryRow>
      <StoryRow
        label="unphased agents"
        hint="workflow without phases lists agents flat"
      >
        <ResponsiveStage>
          <ToggleableCard workflow={unphasedWorkflow} />
        </ResponsiveStage>
      </StoryRow>
      <StoryRow
        label="workflow error"
        hint="workflow-level error line below the phases"
      >
        <ResponsiveStage>
          <ToggleableCard workflow={workflowErrorWorkflow} />
        </ResponsiveStage>
      </StoryRow>
      <StoryRow
        label="starting"
        hint="phases declared, no agents spawned yet"
      >
        <ResponsiveStage>
          <ToggleableCard workflow={startingWorkflow} />
        </ResponsiveStage>
      </StoryRow>
      <StoryRow
        label="no progress yet"
        hint="no progress snapshot; shows the summary text only"
      >
        <ResponsiveStage>
          <ToggleableCard workflow={noProgressWorkflow} />
        </ResponsiveStage>
      </StoryRow>
    </StoryCard>
  );
}
