Start a thread, pick Codex, and let it write and review code in your repository from bb. The plugin drives the Codex CLI on the host machine. It streams the agent's work into the bb timeline.

## What you get

- Permission modes `accept-edits`, `auto`, and `full`, plus plan and goal actions in the composer.
- Reasoning levels from Low to Ultra. Ultra adds automatic task delegation.
- A service tier picker that offers the tiers Codex reports for the selected model (Fast, and Ultrafast where the account has it).
- A Daybreak switch in the model picker for accounts that have Daybreak, usable with any model that supports it.
- Checkpoint forks, manual compaction, thread rename, and thread archive.
- Question cards for the questions Codex asks while it keeps working. Your answer reaches Codex as a message.
- Codex skills from your home directory and project, listed next to bb skills.
- Health, usage, and install status on each host, with an install or update action.
- A Codex AI service for inference and voice that other bb features can use.

## Settings

- `Codex memory`: let Codex recall and create memories from bb threads.
- `Disable provider subagents`: stop native subagents so the agent delegates through bb.

## Requirements

- Install the Codex CLI (`codex`) on the host machine, version 0.136.0 or newer. The plugin can run the npm install for you.
- For native model authentication, sign in with `codex login` on that machine. A ChatGPT account or an OpenAI API key both work. CPA model connections instead use a worker-local model-client key.
- Usage limits show only for ChatGPT accounts.

## CPA model connections and context boundary

A CPA model connection keeps the native Codex CLI, session IDs and history but
routes model HTTP through `openai-responses` only. It uses `hostId: null`,
default-null `nativeAuth`, explicit `gateway.allowedHostIds` and account prefix,
and a private credential FILE or ENV reference resolved on the actual worker.
Choose an exact `bb-cpa/<prefix>/<id>` model; invalid credentials, models,
protocols or workers refuse without borrowing native auth or another account.

Model payer selection is independent of Work/Personal naming and MCP
authorization. Native Codex currently refuses **any explicit execution context**,
including `nativeMcpProfile`; gateway support does not add scoped context/MCP
support. Existing native instructions, discovery and direct-MCP policies remain
unchanged. Use a compatible installed native CLI/SDK, not vendor hotpatches.

Secret-free receipts pin the gateway endpoint/protocol/model and credential
reference for continuation/reopen. Changing the account requires a new thread;
no live session or global/default migration occurs. CPA support is not a claim
of production rollout or real-account qualification for every native engine.
See [configuration](../../docs/configuration.md#cpa-gateway-model-connections)
for the shared UI/CLI/SDK contract.
