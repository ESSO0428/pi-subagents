/**
 * pi-agents — A pi extension providing Claude Code-style autonomous sub-agents.
 *
 * Tools:
 *   Agent             — LLM-callable: spawn a sub-agent
 *   get_subagent_result  — LLM-callable: check background agent status/result
 *   steer_subagent       — LLM-callable: send a steering message to a running agent
 *
 * Commands:
 *   /agents                 — Interactive agent management menu
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineTool, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, getAgentDir, getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, SelectList, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { abortable } from "./abortable.js";
import { readAgentHistory, readAgentHistoryResult } from "./agent-history.js";
import { buildAgentStatusMenuEntries, canOpenActiveAgent, canOpenAgentHistory, formatAgentHistoryOption, isAgentRecordInArtifactRoot, resolveAgentViewMode, splitAgentRecords } from "./agent-history-list.js";
import { AgentManager, AgentResumeError } from "./agent-manager.js";
import { type AgentResumeRuntimeDependencies, createAgentResumeRuntime, getAgentConversation, getDefaultMaxTurns, getGraceTurns, normalizeMaxTurns, SUBAGENT_TOOL_NAMES, setDefaultMaxTurns, setGraceTurns, steerAgent } from "./agent-runner.js";
import { canonicalArtifactRootCwd, sameArtifactRootCwd } from "./agent-session-storage.js";
import { applyNicoOverrides, BUILTIN_TOOL_NAMES, getAgentConfig, getAllTypes, getAvailableTypes, isDefaultsDisabled, registerAgents, resolveSpawnType, setDefaultsDisabled, setFallbackSubagent } from "./agent-types.js";
import { CompletionOutbox } from "./completion-outbox.js";
import { type RpcHandle, registerRpcHandlers } from "./cross-extension-rpc.js";
import { loadCustomAgents } from "./custom-agents.js";
import { isModelInScope, readEnabledModels, resolveEnabledModels } from "./enabled-models.js";
import { GroupJoinManager } from "./group-join.js";
import { resolveAgentInvocationConfig, resolveJoinMode } from "./invocation-config.js";
import { readLegacySessionRecords } from "./legacy-session-records.js";
import { type ModelRegistry, resolveModel } from "./model-resolver.js";
import { isScopeModelsEnabled, setScopeModelsEnabled } from "./model-scope.js";
import { getMaxSubagentDepth, setMaxSubagentDepth } from "./nested-tools.js";
import { createOutputFilePath, writeInitialEntry } from "./output-file.js";
import { SubagentScheduler } from "./schedule.js";
import { resolveStorePath, ScheduleStore } from "./schedule-store.js";
import { applyAndEmitLoaded, type SubagentsSettings, saveAndEmitChanged, type ToolDescriptionMode } from "./settings.js";
import { getStatusNote } from "./status-note.js";
import { type AgentConfig, type AgentInvocation, type AgentRecord, type JoinMode, type NotificationDetails, type SubagentType, type WidgetMode } from "./types.js";
import { createAgentTreeMenuState, showAgentTreeMenu } from "./ui/agent-tree-menu.js";
import {
  type AgentActivity,
  type AgentDetails,
  AgentWidget,
  buildInvocationTags,
  fgPreservingNestedStyles,
  formatDuration,
  formatMs,
  formatTokens,
  formatTurns,
  getDisplayName,
  getPromptModeLabel,
  SPINNER,
  type Theme,
  type UICtx,
} from "./ui/agent-widget.js";
import { ConversationViewer, createStaticConversationSource, VIEWPORT_HEIGHT_PCT } from "./ui/conversation-viewer.js";
import { showSchedulesMenu } from "./ui/schedule-menu.js";
import { renderWorkflowCard } from "./ui/workflow-card.js";
import { openWorkflowFromFleet, showWorkflowsMenu } from "./ui/workflow-menu.js";
import { addUsage, getLifetimeTotal, getSessionContextPercent, type LifetimeUsage } from "./usage.js";
import { decideWorkflowCollision } from "./workflow/collisions.js";
import {
  loadWorkflowHistorySnapshots,
  pruneWorkflowHistory,
  toWorkflowHistoryTreeRoot,
  type WorkflowHistorySnapshot,
  writeWorkflowHistorySnapshot,
} from "./workflow/history.js";
import { createWorkflowHost } from "./workflow/host.js";
import { appendJournal, readJournal, type WorkflowJournalEntry } from "./workflow/journal.js";
import { extractMeta, type WorkflowMeta, workflowCallName } from "./workflow/meta.js";
import { elapsedMs } from "./workflow/progress.js";
import { MAX_SCRIPT_LENGTH, runWorkflow } from "./workflow/runtime.js";
import { resolveWorkflowScript } from "./workflow/saved.js";
import { completeWorkflowTask, createWorkflowTask, failWorkflowTask, formatWorkflowNotification, resolveResumeTarget, toWorkflowTreeRoot, updateWorkflowProgressBatch, type WorkflowTask, workflowResultText, workflowRunId } from "./workflow/task.js";
import { fullWorkflowToolDescription } from "./workflow/tool-description.js";

// ---- Shared helpers ----

/** Tool execute return value for a text response. */
function textResult(msg: string, details?: AgentDetails) {
  return { content: [{ type: "text" as const, text: msg }], details: details as any };
}

export function renderRunningAgentStatus(
  frame: string,
  statsText: string,
  activity: string,
  theme: Pick<Theme, "fg">,
): Container {
  const container = new Container();
  container.addChild(new Text(theme.fg("accent", frame) + (statsText ? " " + statsText : ""), 0, 0));
  container.addChild(new Text(theme.fg("dim", `  ⎿  ${activity}`), 0, 0));
  return container;
}

/** Format an agent's lifetime token total, or "" when zero. */
function formatLifetimeTokens(o: { lifetimeUsage: LifetimeUsage }): string {
  const t = getLifetimeTotal(o.lifetimeUsage);
  return t > 0 ? formatTokens(t) : "";
}

/**
 * Create an AgentActivity state and spawn callbacks for tracking tool usage.
 * Used by the detached Agent path for activity and usage tracking.
 */
function createActivityTracker(maxTurns?: number, onStreamUpdate?: () => void) {
  const state: AgentActivity = {
    activeTools: new Map(),
    toolUses: 0,
    turnCount: 1,
    maxTurns,
    responseText: "",
    session: undefined,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
  };

  const callbacks = {
    onToolActivity: (activity: { type: "start" | "end"; toolName: string }) => {
      if (activity.type === "start") {
        state.activeTools.set(activity.toolName + "_" + Date.now(), activity.toolName);
      } else {
        for (const [key, name] of state.activeTools) {
          if (name === activity.toolName) { state.activeTools.delete(key); break; }
        }
        state.toolUses++;
      }
      onStreamUpdate?.();
    },
    onTextDelta: (_delta: string, fullText: string) => {
      state.responseText = fullText;
      onStreamUpdate?.();
    },
    onTurnEnd: (turnCount: number) => {
      state.turnCount = turnCount;
      onStreamUpdate?.();
    },
    onSessionCreated: (session: any) => {
      state.session = session;
    },
    onAssistantUsage: (usage: { input: number; output: number; cacheWrite: number }) => {
      addUsage(state.lifetimeUsage, usage);
      onStreamUpdate?.();
    },
  };

  return { state, callbacks };
}

/**
 * Advertised thinking levels, ordered to mirror pi-ai's EXTENDED_THINKING_LEVELS
 * (`off` + every `ThinkingLevel`). Single source for the Agent tool description,
 * the generated-agent template, and the `/agents` wizard so these lists can't
 * drift behind pi again (#147). Availability of any level still depends on the
 * host pi version and the selected model — pi clamps unsupported levels down.
 */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Salvaged partial output of a failed run, as a labeled suffix for the error
 * surfaces (or "" if the run produced nothing). `record.result` is bounded to
 * the run's own turns, so this is never a stale earlier answer (#144).
 */
function partialOutputSuffix(record: AgentRecord, fallback?: string): string {
  const partial = record.result?.trim() || fallback?.trim();
  return partial ? `\n\nPartial output before the failure:\n${partial}` : "";
}

/** Poll only while a queued record has not acquired its run promise. */
async function waitForTerminalRecord(record: AgentRecord, signal?: AbortSignal): Promise<void> {
  while (record.status === "queued" || (record.status === "running" && !record.promise)) {
    await abortable(new Promise<void>((resolve) => setTimeout(resolve, 25)), signal);
  }
  if (record.status === "running" && record.promise) {
    await abortable(record.promise, signal);
  }
}

/** Human-readable status label for agent completion. */
function getStatusLabel(status: string, error?: string): string {
  switch (status) {
    case "error": return `Error: ${error ?? "unknown"}`;
    case "aborted": return "Aborted (max turns exceeded)";
    case "steered": return "Wrapped up (turn limit)";
    case "stopped": return "Stopped";
    default: return "Done";
  }
}

/** Escape XML special characters to prevent injection in structured notifications. */
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Format a structured task notification matching Claude Code's <task-notification> XML. */
function formatTaskNotification(record: AgentRecord, resultMaxLen: number): string {
  const status = getStatusLabel(record.status, record.error);
  const durationMs = record.completedAt ? record.completedAt - record.startedAt : 0;
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);
  const contextPercent = getSessionContextPercent(record.session);
  const ctxXml = contextPercent !== null ? `<context_percent>${Math.round(contextPercent)}</context_percent>` : "";
  const compactXml = record.compactionCount ? `<compactions>${record.compactionCount}</compactions>` : "";

  const resultPreview = record.result
    ? record.result.length > resultMaxLen
      ? record.result.slice(0, resultMaxLen) + "\n...(truncated, use get_subagent_result for full output)"
      : record.result
    : "No output.";

  return [
    `<task-notification>`,
    `<task-id>${record.id}</task-id>`,
    record.toolCallId ? `<tool-use-id>${escapeXml(record.toolCallId)}</tool-use-id>` : null,
    record.outputFile ? `<output-file>${escapeXml(record.outputFile)}</output-file>` : null,
    `<status>${escapeXml(status)}</status>`,
    `<summary>Agent "${escapeXml(record.description)}" ${record.status}${getStatusNote(record.status)}</summary>`,
    `<result>${escapeXml(resultPreview)}</result>`,
    `<usage><total_tokens>${totalTokens}</total_tokens><tool_uses>${record.toolUses}</tool_uses>${ctxXml}${compactXml}<duration_ms>${durationMs}</duration_ms></usage>`,
    `</task-notification>`,
  ].filter(Boolean).join('\n');
}

/** Build notification details for the custom message renderer. */
function buildNotificationDetails(record: AgentRecord, resultMaxLen: number, activity?: AgentActivity): NotificationDetails {
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);

  return {
    id: record.id,
    description: record.description,
    status: record.status,
    toolUses: record.toolUses,
    turnCount: activity?.turnCount ?? 0,
    maxTurns: activity?.maxTurns,
    totalTokens,
    durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
    outputFile: record.outputFile,
    error: record.error,
    resultPreview: record.result
      ? record.result.length > resultMaxLen
        ? record.result.slice(0, resultMaxLen) + "…"
        : record.result
      : "No output.",
  };
}

function formatInlineAgentResult(record: AgentRecord): string {
  if (record.status === "error") {
    return `Error: ${record.error ?? "unknown error"}${partialOutputSuffix(record)}`;
  }
  return record.result?.trim() || "No output.";
}

function buildInlineAgentDetails(
  record: AgentRecord,
  base: Omit<AgentDetails, "toolUses" | "tokens" | "durationMs" | "status" | "turnCount" | "maxTurns" | "error" | "agentId">,
  activity?: AgentActivity,
): AgentDetails {
  return {
    ...base,
    agentId: record.id,
    toolUses: record.toolUses,
    tokens: formatLifetimeTokens(record),
    durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
    status: record.status,
    turnCount: activity?.turnCount ?? 0,
    maxTurns: activity?.maxTurns,
    error: record.error,
  };
}

export default function (pi: ExtensionAPI) {
  // ---- Register custom notification renderer ----
  pi.registerMessageRenderer<NotificationDetails>(
    "subagent-notification",
    (message, { expanded }, theme) => {
      const d = message.details;
      if (!d) return undefined;

      function renderOne(d: NotificationDetails): string {
        const isError = d.status === "error" || d.status === "stopped" || d.status === "aborted";
        const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const statusText = isError ? d.status
          : d.status === "steered" ? "completed (steered)"
          : "completed";

        // Line 1: icon + agent description + status
        let line = `${icon} ${theme.bold(d.description)} ${theme.fg("dim", statusText)}`;

        // Line 2: stats
        const parts: string[] = [];
        if (d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
        if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.totalTokens > 0) parts.push(formatTokens(d.totalTokens));
        if (d.durationMs > 0) parts.push(formatMs(d.durationMs));
        if (parts.length) {
          line += "\n  " + parts.map(p => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
        }

        // Line 3: result preview (collapsed) or full (expanded)
        if (expanded) {
          const lines = d.resultPreview.split("\n").slice(0, 30);
          for (const l of lines) line += "\n" + theme.fg("dim", `  ${l}`);
        } else {
          const preview = d.resultPreview.split("\n")[0]?.slice(0, 80) ?? "";
          line += "\n  " + theme.fg("dim", `⎿  ${preview}`);
        }

        // Line 4: optional `.output` mirror link (if present)
        if (d.outputFile) {
          line += "\n  " + theme.fg("muted", `optional .output mirror: ${d.outputFile}`);
        }

        return line;
      }

      const all = [d, ...(d.others ?? [])];
      return new Text(all.map(renderOne).join("\n"), 0, 0);
    }
  );

  /** Reload agents from project/global custom agent dirs and merge with defaults (called on init and each Agent invocation). */
  const reloadCustomAgents = () => {
    const userAgents = loadCustomAgents(process.cwd());
    registerAgents(userAgents);
    applyNicoOverrides();
  };

  // Initial load
  reloadCustomAgents();

  // ---- Agent activity tracking + widget ----
  const agentActivity = new Map<string, AgentActivity>();

  const resultRetrievalInstruction =
    "Next action: call get_subagent_result once for each <task-id> above, with wait omitted or false, " +
    "to render native expandable Get Subagent Result tool output. Do not pass wait:true.";

  // ---- Completion delivery ----
  // Every detached completion is queued until the parent's turn boundary or a
  // short idle hold. Reading the result cancels its pending notification.
  const outbox = new CompletionOutbox(
    (message) => pi.sendMessage<NotificationDetails>({
      customType: "subagent-notification",
      content: message.content,
      display: true,
      details: message.details,
    }, { deliverAs: "followUp", triggerTurn: true }),
    () => currentCtx?.signal !== undefined,
  );

  function sendIndividualNudge(record: AgentRecord) {
    agentActivity.delete(record.id);
    widget.markFinished(record.id);
    try {
      const notification = formatTaskNotification(record, 500);
      const footer = record.outputFile ? `\nOptional .output mirror available at: ${record.outputFile}` : '';
      const message = {
        content: `${notification + footer}\n\n${resultRetrievalInstruction}`,
        details: buildNotificationDetails(record, 500, agentActivity.get(record.id)),
      };
      outbox.add({ ids: [record.id], build: () => message });
    } catch { /* ignore stale completion side-effect errors */ }
    widget.update();
  }

  // ---- Group join manager ----
  const groupJoin = new GroupJoinManager(
    (records, partial) => {
      for (const r of records) { agentActivity.delete(r.id); widget.markFinished(r.id); }

      const members = records.filter(r => !r.resultConsumed).map(r => ({
        id: r.id,
        text: formatTaskNotification(r, 300),
        details: buildNotificationDetails(r, 300, agentActivity.get(r.id)),
      }));
      if (members.length > 0) {
        outbox.add({
          ids: members.map(m => m.id),
          build: (ids) => {
            const unread = members.filter(m => ids.includes(m.id));
            const notifications = unread.map(m => m.text).join('\n\n');
            const label = partial
              ? `${unread.length} agent(s) finished (partial — others still running)`
              : `${unread.length} agent(s) finished`;

            const [first, ...rest] = unread;
            const details = first.details;
            if (rest.length > 0) details.others = rest.map(m => m.details);
            return {
              content: `Background agent group completed: ${label}\n\n${notifications}\n\n${resultRetrievalInstruction}`,
              details,
            };
          },
        });
      }
      widget.update();
    },
    30_000,
  );
  /** Helper: build event data for lifecycle events from an AgentRecord. */
  function buildEventData(record: AgentRecord) {
    const durationMs = record.completedAt ? record.completedAt - record.startedAt : Date.now() - record.startedAt;
    // All three fields are lifetime-accumulated (Σ over every assistant message_end),
    // so they survive compaction together — input + output ≤ total always.
    // tokens is omitted when nothing was ever produced (e.g. agent errored before
    // any message_end fired), preserving prior payload shape.
    const u = record.lifetimeUsage;
    const total = getLifetimeTotal(u);
    const tokens = total > 0
      ? { input: u.input, output: u.output, total }
      : undefined;
    return {
      id: record.id,
      type: record.type,
      description: record.description,
      result: record.result,
      error: record.error,
      status: record.status,
      toolUses: record.toolUses,
      durationMs,
      tokens,
    };
  }

  // Background completion: route through group join or send individual nudge
  const manager = new AgentManager((record) => {
    // Nested children report through their owner: they remain visible in the
    // widget but never emit a second top-level event, history entry, or nudge.
    if (record.parentAgentId) {
      widget.markFinished(record.id);
      widget.update();
      return;
    }
    // Emit lifecycle event based on terminal status
    const isError = record.status === "error" || record.status === "stopped" || record.status === "aborted";
    const eventData = buildEventData(record);
    if (isError) {
      pi.events.emit("subagents:failed", eventData);
    } else {
      pi.events.emit("subagents:completed", eventData);
    }

    // Durable checkpoints replaced this entry: they survive reboot, carry the
    // owning session, and do not bloat the parent session branch. It is still
    // read for sessions recorded before that change, so history written by an
    // older build stays reachable.

    // Skip notification if result was already consumed via get_subagent_result
    if (record.resultConsumed) {
      agentActivity.delete(record.id);
      widget.markFinished(record.id);
      widget.update();
      return;
    }

    // A `group` spawn whose turn has not ended yet: its group is registered at
    // that turn's end, which picks this completion up retroactively.
    if (turnGroupSpawns.includes(record.id)) {
      widget.update();
      return;
    }

    const result = groupJoin.onAgentComplete(record);
    if (result === 'pass') {
      sendIndividualNudge(record);
    }
    // 'held' → do nothing, group will fire later
    // 'delivered' → group callback already fired
    widget.update();
  }, undefined, (record) => {
    // Nested children are already represented under their owner in the widget.
    if (record.parentAgentId) {
      widget.ensureTimer();
      widget.update();
      return;
    }
    // Emit started event when agent transitions to running (including from queue)
    pi.events.emit("subagents:started", {
      id: record.id,
      type: record.type,
      description: record.description,
    });
    widget.ensureTimer();
    widget.update();
  }, (record, info) => {
    if (record.parentAgentId) return;
    // Emit compacted event when agent's session compacts (preserves count on record).
    pi.events.emit("subagents:compacted", {
      id: record.id,
      type: record.type,
      description: record.description,
      reason: info.reason,
      tokensBefore: info.tokensBefore,
      compactionCount: record.compactionCount,
    });
  });

  // Expose manager via Symbol.for() global registry for cross-package access.
  // Standard Node.js pattern for cross-package singletons (used by OpenTelemetry, etc.).
  //
  // Claim the slot only if it's free: subagent sessions re-activate this
  // extension in the same process (session.bindExtensions in agent-runner.ts),
  // and unconditionally overwriting would point the registry at a short-lived
  // child manager — and the child's shutdown would then delete the root
  // session's entry. The first activation (the root session) wins; child
  // activations leave it alone.
  const MANAGER_KEY = Symbol.for("pi-subagents:manager");
  const registryEntry = {
    waitForAll: () => manager.waitForAll(),
    hasRunning: () => manager.hasRunning(),
    spawn: (piRef: any, ctx: any, type: string, prompt: string, options: any) =>
      manager.spawn(piRef, ctx, type, prompt, options),
    getRecord: (id: string) => manager.getRecord(id),
  };
  const ownsManagerRegistry = (globalThis as any)[MANAGER_KEY] === undefined;
  if (ownsManagerRegistry) {
    (globalThis as any)[MANAGER_KEY] = registryEntry;
  }

  // --- Cross-extension RPC via pi.events ---
  let currentCtx: ExtensionContext | undefined;
  // RPC handlers + the `subagents:ready` broadcast are wired on `session_start`
  // (a bound lifecycle event), not at factory time. pi runs every extension
  // factory before the `extensions:` filter and only fires lifecycle events for
  // survivors, so a child session that filtered pi-subagents out never reaches
  // session_start — and must not advertise or answer RPC it can't service
  // (currentCtx would stay undefined → spawn always "No active session"). Gating
  // here makes a filtered session behave like an absent one (#142).
  let rpcHandle: RpcHandle | undefined;

  // ---- Subagent scheduler ----
  // Session-scoped: store is constructed inside session_start once sessionId
  // is available. Mirrors pi-chonky-tasks's session-scoped task store —
  // schedules reset on /new, restore on /resume.
  const scheduler = new SubagentScheduler();

  function startScheduler(ctx: ExtensionContext) {
    try {
      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (!sessionId) return;  // sessionId not yet available — try again on next event
      const path = resolveStorePath(ctx.cwd, sessionId);
      const store = new ScheduleStore(path);
      scheduler.start(pi, ctx, manager, store);
      pi.events.emit("subagents:scheduler_ready", { sessionId, jobCount: store.list().length });
    } catch (err) {
      // Scheduling is non-essential — log and move on so the rest of the
      // extension keeps working if e.g. .pi/ is unwritable.
      console.warn("[pi-subagents] Failed to start scheduler:", err);
    }
  }

  type AgentMenuSelection = { id?: string; index: number };
  let agentTreeMenuState = createAgentTreeMenuState();
  let historyAgentSelection: AgentMenuSelection = { index: 0 };

  function resetAgentMenuSelections() {
    agentTreeMenuState = createAgentTreeMenuState();
    historyAgentSelection = { index: 0 };
  }

  // Capture ctx from session_start for RPC spawn handler + start the scheduler.
  // This also wires the RPC handlers and broadcasts readiness — on the first
  // bound session_start, so a filtered-out activation never advertises (#142).
  pi.on("session_start", async (_event, ctx) => {
    resetAgentMenuSelections();
    clearWorkflowTasks();
    workflowHistorySnapshots.clear();
    pruneWorkflowHistory(ctx.cwd);
    for (const snapshot of loadWorkflowHistorySnapshots(ctx.cwd)) {
      workflowHistorySnapshots.set(snapshot.workflowId, snapshot);
    }
    currentCtx = ctx;
    manager.clearCompleted(true);
    const sessionId = ctx.sessionManager?.getSessionId?.();
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    manager.restoreCompleted(branch
      .filter((entry: any) => entry?.type === "custom" && entry?.customType === "subagents:record")
      .map((entry: any) => entry.data), sessionId);
    // Checkpoint files cover agents whose parent session never got a terminal
    // branch entry (shutdown, session switch, or a process restart).
    manager.restoreRecovered(ctx.cwd, sessionId);
    // Attach the panel during TUI startup, after restored records are present,
    // so terminal agents from the session branch are immediately visible.
    if (ctx.mode === "tui") {
      widget.setUICtx(ctx.ui as UICtx);
      widget.update();
    }
    // Guard mirrors the `!scheduler.isActive()` pattern below: session_start
    // fires once per activation, but a double-bind must not leak listeners.
    if (!rpcHandle) {
      rpcHandle = registerRpcHandlers({
        events: pi.events,
        pi,
        getCtx: () => currentCtx,
        manager,
        getOutputTranscript: getOutputTranscriptDefault,
      });
      // Broadcast readiness so extensions loaded alongside us can discover us.
      // Emitting after all factories have run (rather than at factory time)
      // also avoids the race where a consumer loaded after us misses the event.
      pi.events.emit("subagents:ready", {});
    }
    if (isSchedulingEnabled() && !scheduler.isActive()) startScheduler(ctx);
    resolveWorkflowCollisions(ctx);
  });

  pi.on("session_before_switch", () => {
    resetAgentMenuSelections();
    clearWorkflowTasks();
    workflowHistorySnapshots.clear();
    // A switch is catchable. Stop and checkpoint live/queued agents before the
    // old session context is discarded, then retain their unread history.
    manager.abortAll();
    manager.clearCompleted(true);
    scheduler.stop();
  });

  // On shutdown, abort all agents immediately and clean up.
  // If the session is going down, there's nothing left to consume agent results.
  pi.on("session_shutdown", async () => {
    resetAgentMenuSelections();
    rpcHandle?.unsubSpawn();
    rpcHandle?.unsubStop();
    rpcHandle?.unsubPing();
    rpcHandle = undefined;
    currentCtx = undefined;
    // Only release the global slot if this activation claimed it — a child
    // session's shutdown must not delete the root session's registry entry.
    if (ownsManagerRegistry && (globalThis as any)[MANAGER_KEY] === registryEntry) {
      delete (globalThis as any)[MANAGER_KEY];
    }
    scheduler.stop();
    clearWorkflowTasks();
    workflowHistorySnapshots.clear();
    manager.abortAll();
    groupJoin.dispose();
    outbox.dispose();
    widget.dispose();
    manager.dispose();
  });

  // Live widget: show all agents above the editor. Read live at render time.
  let widgetMode: WidgetMode = "all";
  function getWidgetMode(): WidgetMode { return widgetMode; }
  function getWorkflowRoots() {
    const live = [...workflowTasks.values()].map(toWorkflowTreeRoot);
    const liveIds = new Set(live.map(root => root.id));
    return [
      ...live,
      ...[...getCurrentWorkflowHistory().values()]
        .filter(snapshot => !liveIds.has(snapshot.workflowId))
        .map(toWorkflowHistoryTreeRoot),
    ];
  }
  const widget = new AgentWidget(
    manager,
    agentActivity,
    getWidgetMode,
    {
      canOpenHistory: (record) => canOpenAgentHistory(record, currentCtx?.cwd),
      onOpen: (record, mode) => {
        const ctx = currentCtx;
        if (ctx) void viewAgentConversation(ctx as ExtensionCommandContext, record, mode);
      },
      getSessionId: () => currentCtx?.sessionManager?.getSessionId?.(),
      getArtifactRootCwd: () => currentCtx?.cwd,
      getWorkflowRoots,
      onOpenWorkflow: (id: string) => {
        void withModal(async () => {
          await openWorkflowFromFleet(id, workflowMenuDeps);
        });
      },
    },
  );

  /**
   * Run an AgentWidget-owned modal while the widget's global key listener
   * stands down. The listener runs before the focused component, so without
   * this it would consume ↑/↓/enter/escape from the modal itself.
   */
  async function withModal<T>(open: () => Promise<T>): Promise<T> {
    widget.setModalOpen(true);
    try {
      return await open();
    } finally {
      widget.setModalOpen(false);
    }
  }

  /**
   * Legacy `subagents:record` entries recovered from session files, per cwd.
   *
   * The scan is not cheap, and both the menu's counts and the history list need
   * it — reading it twice would double the cost on every `/agents` visit, and a
   * stale count in the menu is worse than a slow one.
   */
  const legacyHistoryCache = new Map<string, AgentRecord[]>();
  async function legacyHistoryFor(ctx: ExtensionCommandContext): Promise<AgentRecord[]> {
    const key = ctx.cwd;
    const cached = legacyHistoryCache.get(key);
    if (cached) return cached;
    const records = (await readLegacySessionRecords(key)).filter(record => canOpenAgentHistory(record, key));
    legacyHistoryCache.set(key, records);
    return records;
  }

  function setWidgetMode(m: WidgetMode): void {
    legacyHistoryCache.clear();
    widgetMode = m;
    widget.update();
  }

  // Project/global default for writing the optional temporary `.output` mirror.
  // Durable `.pi-subagents` history is always written by AgentManager. A custom
  // agent's `output_transcript` frontmatter overrides this mirror setting per
  // spawn; when the frontmatter is silent, this default applies. Read live at
  // spawn time.
  let outputTranscriptDefault = true;
  function getOutputTranscriptDefault(): boolean { return outputTranscriptDefault; }
  function setOutputTranscript(b: boolean): void { outputTranscriptDefault = b; }

  // ---- Join mode configuration ----
  let defaultJoinMode: JoinMode = 'smart';
  function getDefaultJoinMode(): JoinMode { return defaultJoinMode; }
  function setDefaultJoinMode(mode: JoinMode) { defaultJoinMode = mode; }

  // Master switch for the schedule subagent feature. Defaults to enabled.
  // Read once at extension init (before tool registration) so the Agent tool's
  // param schema reflects the persisted setting. Runtime toggles via /agents
  // → Settings short-circuit the menu entry + the execute-time addJob path
  // immediately, but the schema-level removal only takes effect on next
  // extension load (next pi session). Documented in CHANGELOG/README.
  let schedulingEnabled = true;
  function isSchedulingEnabled(): boolean { return schedulingEnabled; }
  function setSchedulingEnabled(b: boolean) { schedulingEnabled = b; }

  // ---- Scope models configuration ----
  // When enabled, subagent model choices are validated against `enabledModels`
  // from pi's settings — both global `<agentDir>/settings.json` and
  // project-local `<cwd>/.pi/settings.json` (project overrides global).
  // Off by default; opt-in via `/agents → Settings`. See docstring on
  // SubagentsSettings.scopeModels for the hard-error vs warn-and-proceed
  // policy and its rationale.

  // ---- Disable default agents configuration ----
  // When enabled, the three hardcoded default agents (general-purpose, Explore,
  // Plan) are not registered. User-defined agents from project/global custom
  // agent dirs are completely unaffected — only DEFAULT_AGENTS are suppressed.
  // Defaults to false; opt-in via `/agents → Settings` or subagents.json.
  // State lives in agent-types.ts (isDefaultsDisabled) because registerAgents
  // needs it; this wrapper just re-registers after flipping it.
  function setDisableDefaultAgents(b: boolean): void {
    setDefaultsDisabled(b);
    reloadCustomAgents(); // re-register with new setting
  }

  // ---- Agent tool description mode ----
  // "full" (default) keeps the rich Claude Code-style description; "compact"
  // swaps in a ~75% smaller one for small/local models (#91). Read once at
  // tool registration — flipping it applies on the next pi session.
  let toolDescriptionMode: ToolDescriptionMode = "full";
  function getToolDescriptionMode(): ToolDescriptionMode { return toolDescriptionMode; }
  function setToolDescriptionMode(mode: ToolDescriptionMode): void { toolDescriptionMode = mode; }

  // ---- Turn batches for `group` join mode ----
  // Background spawns made during one parent turn share that turn's boundary.
  // `smart`/`async` remain individual outbox items; only explicit `group` mode
  // registers a GroupJoinManager group here.
  let turnGroupSpawns: string[] = [];
  let turnGroupCounter = 0;

  function joinTurnGroup(id: string, joinMode: JoinMode | undefined): void {
    // Outside a parent turn no turn boundary is coming, so a group of one is
    // delivered like an ordinary completion.
    if (joinMode === "group" && currentCtx?.signal !== undefined) turnGroupSpawns.push(id);
  }

  function registerTurnGroup(): void {
    const ids = turnGroupSpawns;
    turnGroupSpawns = [];
    if (ids.length < 2) {
      const record = ids.length === 1 ? manager.getRecord(ids[0]) : undefined;
      if (record?.completedAt != null && !record.resultConsumed) sendIndividualNudge(record);
      return;
    }

    const groupId = `turn-${++turnGroupCounter}`;
    groupJoin.registerGroup(groupId, ids);
    for (const id of ids) {
      const record = manager.getRecord(id);
      if (!record) continue;
      record.groupId = groupId;
      if (record.completedAt != null && !record.resultConsumed) {
        groupJoin.onAgentComplete(record);
      }
    }
  }

  // Grab UI context from first tool execution + clear lingering widget on new turn
  pi.on("tool_execution_start", async (_event, ctx) => {
    widget.setUICtx(ctx.ui as UICtx);
    widget.onTurnStart();
  });

  // The parent's tool batch is done and its next model call not yet made: the
  // boundary where completions are delivered.
  pi.on("turn_end", (event) => {
    registerTurnGroup();
    outbox.onTurnEnd(event.message.role === "assistant" ? event.message.stopReason : undefined);
  });
  pi.on("agent_end", () => outbox.onAgentEnd());
  pi.on("agent_settled", () => outbox.onAgentEnd());

  /** Format an agent's tool scope: "*" when it has all built-ins, else a comma-separated list. */
  const formatToolsSuffix = (cfg: AgentConfig | undefined): string => {
    const tools = cfg?.builtinToolNames;
    if (!tools || tools.length === 0) return "*";
    const isFullSet =
      tools.length === BUILTIN_TOOL_NAMES.length
      && BUILTIN_TOOL_NAMES.every((t) => tools.includes(t));
    return isFullSet ? "*" : tools.join(", ");
  };

  /** Build the full type list text dynamically from available agents only. */
  const buildTypeListText = () => {
    const available = getAvailableTypes();

    return available.map((name) => {
      const cfg = getAgentConfig(name);
      const modelSuffix = cfg?.model ? ` (${getModelLabelFromConfig(cfg.model)})` : "";
      const toolsSuffix = ` (Tools: ${formatToolsSuffix(cfg)})`;
      return `- ${name}: ${cfg?.description ?? name}${modelSuffix}${toolsSuffix}`;
    }).join("\n");
  };

  /** First sentence of an agent description — for the compact type list. */
  const firstSentence = (text: string): string => {
    const match = text.match(/^.*?[.!?](?=\s|$)/s);
    return (match ? match[0] : text).replace(/\s+/g, " ").trim();
  };

  /** Compact type list: one line per agent, first sentence only. */
  const buildCompactTypeListText = () =>
    getAvailableTypes().map((name) => {
      const cfg = getAgentConfig(name);
      return `- ${name}: ${firstSentence(cfg?.description ?? name)} (Tools: ${formatToolsSuffix(cfg)})`;
    }).join("\n");

  /** Derive a short model label from a model string. */
  function getModelLabelFromConfig(model: string): string {
    // Strip provider prefix (e.g. "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6")
    const name = model.includes("/") ? model.split("/").pop()! : model;
    // Strip trailing date suffix (e.g. "claude-haiku-4-5-20251001" → "claude-haiku-4-5")
    return name.replace(/-\d{8}$/, "");
  }

  // Apply persisted settings on startup and emit `subagents:settings_loaded`.
  // Global + project merged; missing → defaults; corrupt file emits a warning
  // to stderr and falls back to defaults.
  applyAndEmitLoaded(
    {
      setMaxConcurrent: (n) => manager.setMaxConcurrent(n),
      setMaxSubagentDepth,
      setFallbackSubagent,
      setDefaultMaxTurns,
      setGraceTurns,
      setDefaultJoinMode,
      setSchedulingEnabled,
      setScopeModels: setScopeModelsEnabled,
      setDisableDefaultAgents: setDisableDefaultAgents,
      setToolDescriptionMode: setToolDescriptionMode,
      setWidgetMode: setWidgetMode,
      setOutputTranscript: setOutputTranscript,
    },
    (event, payload) => pi.events.emit(event, payload),
  );

  // ---- Agent tool ----

  // Schedule param + its guideline are gated on `schedulingEnabled` (read once
  // at registration; flipping the setting later requires next pi session for
  // the schema to update). Defining the shape once and spreading it via Partial
  // preserves Type.Object's inference when present and produces a
  // `schedule`-free schema when absent — zero LLM-context cost in disabled mode.
  const scheduleParamShape = {
    schedule: Type.Optional(
      Type.String({
        description:
          'Opt-in only — fire later instead of now. Omit to run immediately (the default, almost always correct). ' +
          'Formats: 6-field cron ("0 0 9 * * 1" = 9am Mon), interval ("5m"/"1h"), one-shot ("+10m" or ISO). ' +
          'Scheduled agents run detached; run_in_background has no effect. Incompatible with inherit_context and resume. Returns job ID.',
      }),
    ),
  };
  const scheduleParam: Partial<typeof scheduleParamShape> =
    isSchedulingEnabled() ? scheduleParamShape : {};

  const scheduleGuideline = isSchedulingEnabled()
    ? `\n- Use \`schedule\` only when the user explicitly asked for scheduled / recurring / delayed execution (e.g. "every Monday", "in an hour"). Don't auto-schedule from vague intent like "monitor X" — run once now or ask.`
    : "";

  // Compact Agent tool description (#91, `toolDescriptionMode: "compact"`) —
  // the same load-bearing facts as the full version at ~75% fewer tokens, for
  // small/local models. Per-option details live in the param descriptions.
  const compactAgentToolDescription = `Launch an autonomous agent for complex, multi-step tasks. Agent types:
${buildCompactTypeListText()}

Custom agents: .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global).

Notes:
- description: 3-5 words (shown in UI). Prompts must be self-contained — the agent has not seen this conversation.
- model, thinking, max_turns, inherit_context, isolated, and isolation only fill fields left unspecified by the selected agent's frontmatter or \`agentOverrides\`; an explicit \`run_in_background\` value overrides its configured default.
- Agent calls block by default and return the full result inline. Set run_in_background: true to return an agent ID immediately and receive a completion notification instead.
- Detached results arrive via the completion notification; then call get_subagent_result once per task ID with wait omitted or false to render the native expandable result. Verify an agent's claimed code changes before reporting work done.
- resume follows the same mode: it blocks by default, or is detached with run_in_background: true; steer_subagent messages a running one.
- isolation: "worktree" runs the agent in an isolated git worktree; changes land on a branch.`;

  const fullAgentToolDescription = `Launch a new agent to handle complex, multi-step tasks autonomously. Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
${buildTypeListText()}

Custom agents can be defined in .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global) — they are picked up automatically. Project-level agents override global ones. Creating a .md file with the same name as a default agent overrides it.

When using the Agent tool, specify a subagent_type parameter to select which agent type to use.

## When not to use

If the target is already known, use a direct tool — \`read\` for a known path, \`grep\`/\`find\` for a specific symbol or string. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.

## Usage notes

- Always include a short (3-5 word) description summarizing what the agent will do (shown in UI).
- Agent calls block by default and return the full result inline. Set run_in_background: true to return an agent ID immediately and receive a completion notification instead. When launching detached agents for independent work, send them in a single message with multiple tool uses so they run concurrently.
- Detached results arrive via the completion notification; call get_subagent_result once per completed task ID with wait omitted or false to render the native expandable result. Blocking results are already returned inline — never poll or sleep waiting for them.
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting work as done.
- Use resume with an agent ID to continue a previous agent's work; resume is detached and also returns immediately.
- Use steer_subagent to send mid-run messages to a running agent.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, etc.), since it is not aware of the user's intent.
- If an agent's description says it should be used proactively, try to use it without the user having to ask for it first.
- model, thinking, max_turns, inherit_context, isolated, and isolation only fill fields left unspecified by the selected agent's frontmatter or \`agentOverrides\`; \`run_in_background\` is the exception, and an explicit tool-call value overrides its configured default.
- Use inherit_context if the agent needs the parent conversation history.
- Use isolation: "worktree" to run the agent in an isolated git worktree (safe parallel file modifications). The worktree is automatically cleaned up if the agent makes no changes; otherwise the path and branch are returned in the result.${scheduleGuideline}

## Writing the prompt

Provide clear, detailed prompts so the agent can work autonomously. Brief it like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.`;

  // `toolDescriptionMode: "custom"` — user-authored description with live
  // dynamic parts. Project file wins over global; missing/empty falls back to
  // "full" (a stale fallback beats a blank tool description). Only the prose
  // is customizable — the parameter schema stays code-owned.
  const renderToolDescriptionTemplate = (template: string): string => {
    const vars: Record<string, () => string> = {
      typeList: buildTypeListText,
      compactTypeList: buildCompactTypeListText,
      agentDir: getAgentDir,
      scheduleGuideline: () => scheduleGuideline,
    };
    // Replacement callback (not a string) — agent descriptions may contain `$&` etc.
    return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
      if (vars[name]) return vars[name]();
      console.warn(`[pi-subagents] agent-tool-description.md: unknown placeholder ${raw} left as-is`);
      return raw;
    });
  };

  const loadCustomToolDescription = (): string | undefined => {
    for (const path of [
      join(process.cwd(), ".pi", "agent-tool-description.md"),
      join(getAgentDir(), "agent-tool-description.md"),
    ]) {
      try {
        if (!existsSync(path)) continue;
        const text = readFileSync(path, "utf-8").trim();
        if (text) return renderToolDescriptionTemplate(text);
        console.warn(`[pi-subagents] ${path} is empty — ignoring`);
      } catch (err) {
        console.warn(`[pi-subagents] failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return undefined;
  };

  const agentToolDescription = (() => {
    const mode = getToolDescriptionMode();
    if (mode === "compact") return compactAgentToolDescription;
    if (mode === "custom") {
      const custom = loadCustomToolDescription();
      if (custom) return custom;
      console.warn('[pi-subagents] toolDescriptionMode is "custom" but no agent-tool-description.md found — using "full"');
    }
    return fullAgentToolDescription;
  })();

  pi.registerTool(defineTool({
    name: SUBAGENT_TOOL_NAMES.AGENT,
    label: "Agent",
    description: agentToolDescription,
    promptSnippet: "Launch autonomous sub-agents for complex multi-step tasks",
    promptGuidelines: [
      "Use Agent with specialized agents when the task matches an agent type's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.",
      "For broad codebase exploration or research, spawn Agent with an appropriate subagent_type (e.g. Explore). Otherwise use direct tools (read, grep, find) when the target is already known.",
      "Agent calls block by default and return the full result inline; set run_in_background: true for detached execution with an ID-first response and completion notification.",
      "Detached results arrive via the completion notification. Then call get_subagent_result once per completed task ID with wait omitted or false before summarizing if needed; blocking results are already inline.",
      "Trust but verify: an agent's summary describes intent, not outcome. When an agent writes or edits code, check the actual changes before reporting work as done.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: "The task for the agent to perform.",
      }),
      description: Type.String({
        description: "A short (3-5 word) description of the task (shown in UI).",
      }),
      subagent_type: Type.String({
        description: `The type of specialized agent to use. Available types: ${getAvailableTypes().join(", ")}. Custom agents from .pi/agents/*.md (project) or ${getAgentDir()}/agents/*.md (global) are also available.`,
      }),
      model: Type.Optional(
        Type.String({
          description:
            'Optional model. Used only when the selected agent\'s frontmatter or agentOverrides leaves model unspecified. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet").',
        }),
      ),
      thinking: Type.Optional(
        Type.String({
          description: `Thinking level: ${THINKING_LEVELS.join(", ")}. Used only when the selected agent's frontmatter or agentOverrides leaves thinking unspecified.`,
        }),
      ),
      max_turns: Type.Optional(
        Type.Number({
          description: "Maximum number of agentic turns before stopping. Used only when the selected agent's frontmatter or agentOverrides leaves max_turns unspecified; omit for unlimited.",
          minimum: 1,
        }),
      ),
      run_in_background: Type.Optional(
        Type.Boolean({
          description: "Run detached and return an agent ID immediately. An explicit tool-call value overrides the selected agent's frontmatter or agentOverrides default; when omitted, that default applies.",
        }),
      ),
      resume: Type.Optional(
        Type.String({
          description: "Optional agent ID to resume from. Continues from previous context.",
        }),
      ),
      isolated: Type.Optional(
        Type.Boolean({
          description: "If true, agent gets no extension/MCP tools — only built-in tools. Used only when the selected agent's frontmatter or agentOverrides leaves isolated unspecified.",
        }),
      ),
      inherit_context: Type.Optional(
        Type.Boolean({
          description: "If true, fork parent conversation into the agent. Used only when the selected agent's frontmatter or agentOverrides leaves inherit_context unspecified.",
        }),
      ),
      isolation: Type.Optional(
        Type.Literal("worktree", {
          description: 'Set to "worktree" to run the agent in a temporary git worktree (isolated copy of the repo). Used only when the selected agent\'s frontmatter or agentOverrides leaves isolation unspecified; changes are saved to a branch on completion.',
        }),
      ),
      ...scheduleParam,
    }),

    // ---- Custom rendering: Claude Code style ----

    renderCall(args, theme) {
      const displayName = args.subagent_type ? getDisplayName(args.subagent_type) : "Agent";
      const desc = args.description ?? "";
      return new Text("▸ " + theme.fg("toolTitle", theme.bold(displayName)) + (desc ? "  " + theme.fg("muted", desc) : ""), 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as AgentDetails | undefined;
      if (!details) {
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        return new Text(text, 0, 0);
      }

      // Helper: build "haiku · thinking: high · ↻5≤30 · 3 tool uses · 33.8k tokens" stats string
      const stats = (d: AgentDetails) => {
        const parts: string[] = [];
        if (d.modelName) parts.push(d.modelName);
        if (d.tags) parts.push(...d.tags);
        if (d.turnCount != null && d.turnCount > 0) {
          parts.push(formatTurns(d.turnCount, d.maxTurns));
        }
        if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.tokens) parts.push(d.tokens);
        return parts.map(p => fgPreservingNestedStyles(theme, "dim", p)).join(" " + theme.fg("dim", "·") + " ");
      };

      // ---- While running (streaming) ----
      if (isPartial || details.status === "running") {
        const frame = SPINNER[details.spinnerFrame ?? 0];
        const s = stats(details);
        return renderRunningAgentStatus(frame, s, details.activity ?? "thinking…", theme);
      }

      // ---- Background agent launched ----
      if (details.status === "background") {
        return new Text(theme.fg("dim", `  ⎿  Running in background (ID: ${details.agentId})`), 0, 0);
      }

      // ---- Completed / Steered ----
      if (details.status === "completed" || details.status === "steered") {
        const duration = formatMs(details.durationMs);
        const isSteered = details.status === "steered";
        const icon = isSteered ? theme.fg("warning", "✓") : theme.fg("success", "✓");
        const s = stats(details);
        let line = icon + (s ? " " + s : "");
        line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", duration);

        if (expanded) {
          const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
          if (resultText) {
            const lines = resultText.split("\n").slice(0, 50);
            for (const l of lines) {
              line += "\n" + theme.fg("dim", `  ${l}`);
            }
            if (resultText.split("\n").length > 50) {
              line += "\n" + theme.fg("muted", "  ... (use get_subagent_result with verbose for full output)");
            }
          }
        } else {
          const doneText = isSteered ? "Wrapped up (turn limit)" : "Done";
          line += "\n" + theme.fg("dim", `  ⎿  ${doneText}`);
        }
        return new Text(line, 0, 0);
      }

      // ---- Stopped (user-initiated abort) ----
      if (details.status === "stopped") {
        const s = stats(details);
        let line = theme.fg("dim", "■") + (s ? " " + s : "");
        line += "\n" + theme.fg("dim", "  ⎿  Stopped");
        return new Text(line, 0, 0);
      }

      // ---- Error / Aborted (hard max_turns) ----
      const s = stats(details);
      let line = theme.fg("error", "✗") + (s ? " " + s : "");

      if (details.status === "error") {
        line += "\n" + theme.fg("error", `  ⎿  Error: ${details.error ?? "unknown"}`);
      } else {
        line += "\n" + theme.fg("warning", "  ⎿  Aborted (max turns exceeded)");
      }

      return new Text(line, 0, 0);
    },

    // ---- Execute ----

    execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
      // Ensure we have UI context for widget rendering
      widget.setUICtx(ctx.ui as UICtx);

      // Reload custom agents so new project/global .md files are picked up without restart
      reloadCustomAgents();

      // Resume is a distinct raw-parameter branch. Do not resolve the caller's
      // type/config/model first: stored record metadata is authoritative.
      if (params.resume) {
        const existing = manager.getRecord(params.resume);
        if (!existing) {
          return textResult(`Agent not found: "${params.resume}". It may have been cleaned up.`);
        }
        const invalid = [
          ["model", params.model],
          ["thinking", params.thinking],
          ["max_turns", params.max_turns],
          ["isolated", params.isolated],
          ["inherit_context", params.inherit_context],
          ["isolation", params.isolation],
          ["schedule", params.schedule],
        ].find(([, value]) => value !== undefined);
        if (invalid) {
          return textResult(
            `resume-invalid-options: resume cannot override spawn option "${invalid[0]}".`,
            undefined,
          );
        }
        const isBackground = params.run_in_background ?? false;
        const displayName = getDisplayName(existing.type);
        const detailBase = {
          displayName,
          description: existing.description,
          subagentType: existing.type,
        };
        const runtimeFactory = {
          create: (deps: AgentResumeRuntimeDependencies) => createAgentResumeRuntime(pi, ctx, deps),
        };
        try {
          const resumed = await manager.resume(
            params.resume,
            params.prompt,
            runtimeFactory,
            { kind: "top-level", artifactRootCwd: canonicalArtifactRootCwd(ctx.cwd) },
            { isBackground, ...(isBackground ? {} : { signal }), toolCallId },
          );
          if (!resumed) return textResult(`Failed to resume agent "${params.resume}".`);
          if (isBackground) {
            widget.ensureTimer();
            widget.update();
            return textResult(
              `Agent resumed in background.\n` +
              `Agent ID: ${resumed.id}\n` +
              `Type: ${existing.type}\n` +
              `Description: ${existing.description}\n\n` +
              `You will receive a completion notification when this agent finishes.\n` +
              `Results arrive via that notification; after it, call get_subagent_result with wait omitted or false to render native expandable results.\n` +
              `Do not duplicate this agent's work.`,
              { ...detailBase, toolUses: 0, tokens: "", durationMs: 0, status: "background" as const, agentId: resumed.id },
            );
          }
          return textResult(
            formatInlineAgentResult(resumed),
            buildInlineAgentDetails(resumed, detailBase),
          );
        } catch (error) {
          const message = error instanceof AgentResumeError
            ? error.message
            : error instanceof Error ? error.message : String(error);
          return textResult(message);
        }
      }

      const rawType = params.subagent_type as SubagentType;
      const resolution = resolveSpawnType(rawType);
      if (!resolution.ok) return textResult(resolution.message);
      const subagentType = resolution.type;

      const displayName = getDisplayName(subagentType);

      // Get agent config (if any)
      const customConfig = getAgentConfig(subagentType);

      const resolvedConfig = resolveAgentInvocationConfig(customConfig, params);

      // Resolve model from agent config first; tool-call params only fill gaps.
      let model = ctx.model;
      if (resolvedConfig.modelInput) {
        const resolved = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
        if (typeof resolved === "string") {
          if (resolvedConfig.modelFromParams) return textResult(resolved);
          // config-specified: silent fallback to parent
        } else {
          model = resolved;
        }
      }

      // Scope validation: the effective resolved model is checked against the
      // user's enabledModels list (read in `enabled-models.ts`).
      //
      // Design: scopeModels guards against *runtime* LLM choices, not user-level config.
      //   - Caller-supplied out-of-scope → hard error (the orchestrator made an explicit
      //     out-of-scope choice; surface it so it picks differently).
      //   - Frontmatter-pinned or parent-inherited out-of-scope → warn but proceed (the
      //     user authored/installed this agent or chose the parent's model; trust it).
      // See SubagentsSettings.scopeModels docstring for the full policy.
      if (isScopeModelsEnabled() && model) {
        const allowed = resolveEnabledModels(readEnabledModels(ctx.cwd), ctx.modelRegistry, ctx.cwd);
        if (allowed && !isModelInScope(model, allowed)) {
          if (resolvedConfig.modelFromParams) {
            const list = [...allowed].sort().map(m => `  ${m}`).join("\n");
            return textResult(
              `Model not in scope: "${resolvedConfig.modelInput}".\n\n` +
              `Allowed models (from enabledModels):\n${list}`,
            );
          }
          // Frontmatter-pinned or parent-inherited: warn + proceed.
          const agentLabel = customConfig?.displayName ?? subagentType;
          const modelLabel = resolvedConfig.modelInput ?? `${model.provider}/${model.id}`;
          ctx.ui.notify(
            `Agent "${agentLabel}" using out-of-scope model "${modelLabel}"`,
            "warning",
          );
        }
      }

      const thinking = resolvedConfig.thinking;
      const inheritContext = resolvedConfig.inheritContext;
      const isBackground = resolvedConfig.runInBackground;
      const isolated = resolvedConfig.isolated;
      const isolation = resolvedConfig.isolation;
      // Whether this spawn writes its optional temporary `.output` mirror.
      // Durable project-local history is attached by AgentManager for every spawn.
      const outputTranscript = customConfig?.outputTranscript ?? getOutputTranscriptDefault();
      const attachTranscript = (rec: AgentRecord | undefined, agentId: string): void => {
        if (!rec || !outputTranscript || rec.outputFile) return;
        rec.outputFile = createOutputFilePath(ctx.cwd, agentId, ctx.sessionManager.getSessionId());
        writeInitialEntry(rec.outputFile, agentId, params.prompt, ctx.cwd);
      };

      const parentModelId = ctx.model?.id;
      const effectiveModelId = model?.id;
      const modelName = effectiveModelId && effectiveModelId !== parentModelId
        ? (model?.name ?? effectiveModelId).replace(/^Claude\s+/i, "").toLowerCase()
        : undefined;
      const effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? getDefaultMaxTurns());
      const agentInvocation: AgentInvocation = {
        modelName,
        effectiveModelName: model?.name ?? model?.id ?? ctx.model?.name ?? ctx.model?.id,
        thinking,
        effectiveThinking: thinking,
        // Explicit value only — the default fallback would just add noise.
        // Normalize so `0` (unlimited) doesn't surface as a misleading "max turns: 0".
        maxTurns: normalizeMaxTurns(resolvedConfig.maxTurns),
        isolated,
        inheritContext,
        runInBackground: isBackground,
        isolation,
      };
      // Tool-result render shows the mode label too; viewer's header already does.
      const modeLabel = getPromptModeLabel(subagentType);
      const { tags: invocationTags } = buildInvocationTags(agentInvocation);
      const agentTags = modeLabel ? [modeLabel, ...invocationTags] : invocationTags;
      const detailBase = {
        displayName,
        description: params.description,
        subagentType,
        modelName,
        tags: agentTags.length > 0 ? agentTags : undefined,
      };

      // ---- Schedule: register a job, don't spawn now ----
      if (params.schedule) {
        if (!isSchedulingEnabled()) {
          return textResult("Scheduling is disabled in this project. Enable via /agents → Settings → Scheduling.");
        }
        if (params.resume) {
          return textResult("Cannot combine `schedule` with `resume` — schedules create fresh agents.");
        }
        if (params.inherit_context) {
          return textResult("Cannot combine `schedule` with `inherit_context` — there is no parent conversation at fire time.");
        }
        if (!scheduler.isActive()) {
          return textResult("Scheduler is not active in this session yet. Try again after the session has fully started.");
        }
        try {
          const job = scheduler.addJob({
            name: params.description as string,
            description: params.description as string,
            schedule: params.schedule as string,
            subagent_type: subagentType,
            prompt: params.prompt as string,
            model: params.model as string | undefined,
            thinking: thinking,
            max_turns: effectiveMaxTurns,
            isolated: isolated,
            isolation: isolation,
          });
          const next = scheduler.getNextRun(job.id);
          return textResult(
            `Scheduled "${job.name}" (id: ${job.id}, type: ${job.scheduleType}). ` +
            `Next run: ${next ?? "(unknown)"}. ` +
            `Manage via /agents → Scheduled jobs.`,
          );
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err));
        }
      }

      const { state: activityState, callbacks: activityCallbacks } = createActivityTracker(effectiveMaxTurns);

      if (!isBackground) {
        try {
          const { id, record } = await manager.spawnAndWait(
            pi,
            ctx,
            subagentType,
            params.prompt,
            {
              description: params.description,
              model,
              maxTurns: effectiveMaxTurns,
              isolated,
              inheritContext,
              thinkingLevel: thinking,
              isolation,
              invocation: agentInvocation,
              signal,
              ...activityCallbacks,
            },
            (spawnedId) => attachTranscript(manager.getRecord(spawnedId), spawnedId),
          );
          pi.events.emit("subagents:created", {
            id,
            type: subagentType,
            description: params.description,
            isBackground: false,
          });
          return textResult(
            formatInlineAgentResult(record),
            buildInlineAgentDetails(record, detailBase, activityState),
          );
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err));
        }
      }

      // Detached calls return their ID first; completion is delivered through
      // the existing individual/group notification path.
      const joinMode = resolveJoinMode(defaultJoinMode, true);
      let id = "";
      try {
        id = manager.spawn(pi, ctx, subagentType, params.prompt, {
          description: params.description,
          model,
          maxTurns: effectiveMaxTurns,
          isolated,
          inheritContext,
          thinkingLevel: thinking,
          isBackground: true,
          bypassQueue: true,
          isolation,
          invocation: agentInvocation,
          onSpawned: (spawnedId) => {
            id = spawnedId;
            attachTranscript(manager.getRecord(spawnedId), spawnedId);
          },
          ...activityCallbacks,
        });
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err));
      }

      const record = manager.getRecord(id);
      if (record && joinMode) {
        record.joinMode = joinMode;
        record.toolCallId = toolCallId;
      }
      joinTurnGroup(id, joinMode);

      agentActivity.set(id, activityState);
      widget.ensureTimer();
      widget.update();

      pi.events.emit("subagents:created", {
        id,
        type: subagentType,
        description: params.description,
        isBackground: true,
      });

      const isQueued = record?.status === "queued";
      return textResult(
        `Agent ${isQueued ? "queued" : "started"} in background.\n` +
        `Agent ID: ${id}\n` +
        `Type: ${displayName}\n` +
        `Description: ${params.description}\n` +
        (record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
        (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
        `\nYou will receive a completion notification when this agent completes.\n` +
        `Results arrive via the completion notification; after it, call get_subagent_result with wait omitted or false to render native expandable results.\n` +
        `Do not duplicate this agent's work.`,
        { ...detailBase, toolUses: 0, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
      );
    },
  }));


  // ---- get_subagent_result tool ----

  pi.registerTool(defineTool({
    name: SUBAGENT_TOOL_NAMES.GET_RESULT,
    label: "Get Agent Result",
    description:
      "Check status and retrieve results from a detached agent. Use the agent ID returned by Agent.",
    promptSnippet: "Check status and retrieve results from a background agent",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to check.",
      }),
      wait: Type.Optional(
        Type.Boolean({
          description: "If true, wait cancellably until the agent finishes and return its result. Omit or set false to check immediately.",
        }),
      ),
      verbose: Type.Optional(
        Type.Boolean({
          description: "If true, include the agent's full conversation (messages + tool calls). Default: false.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      const record = manager.getRecord(params.agent_id);
      if (!record) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }
      if (!isAgentRecordInArtifactRoot(record, _ctx?.cwd)) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }

      if (params.wait === true && (record.status === "queued" || record.status === "running")) {
        await waitForTerminalRecord(record, signal);
      }

      const durableResult = !record.result?.trim() && record.transcriptPath && currentCtx?.cwd
        ? readAgentHistoryResult(currentCtx.cwd, record.transcriptPath)
        : undefined;
      const displayName = getDisplayName(record.type);
      const duration = formatDuration(record.startedAt, record.completedAt);
      const tokens = formatLifetimeTokens(record);
      const contextPercent = getSessionContextPercent(record.session);
      const statsParts = [`Tool uses: ${record.toolUses}`];
      if (tokens) statsParts.push(tokens);
      if (contextPercent !== null) statsParts.push(`Context: ${Math.round(contextPercent)}%`);
      if (record.compactionCount) statsParts.push(`Compactions: ${record.compactionCount}`);
      statsParts.push(`Duration: ${duration}`);

      let output =
        `Agent: ${record.id}\n` +
        `Type: ${displayName} | Status: ${record.status}${getStatusNote(record.status)} | ${statsParts.join(" | ")}\n` +
        `Description: ${record.description}\n\n`;

      if (record.status === "running" || record.status === "queued") {
        output += `Agent is still ${record.status}. Wait for the background completion notification or check again later.`;
      } else if (record.status === "error") {
        output += `Error: ${record.error}${partialOutputSuffix(record, durableResult)}`;
      } else {
        output += durableResult || record.result?.trim() || "No output.";
      }

      // Mark result as consumed — suppresses the completion notification
      if (record.status !== "running" && record.status !== "queued") {
        record.resultConsumed = true;
        outbox.cancel(params.agent_id);
      }

      // Verbose: include full conversation
      if (params.verbose && record.session) {
        const conversation = getAgentConversation(record.session);
        if (conversation) {
          output += `\n\n--- Agent Conversation ---\n${conversation}`;
        }
      }

      return textResult(output);
    },
  }));

  // ---- steer_subagent tool ----

  pi.registerTool(defineTool({
    name: SUBAGENT_TOOL_NAMES.STEER,
    label: "Steer Agent",
    description:
      "Send a steering message to a running agent. The message will interrupt the agent after its current tool execution " +
      "and be injected into its conversation, allowing you to redirect its work mid-run. Only works on running agents.",
    promptSnippet: "Send a steering message to redirect a running background agent",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to steer (must be currently running).",
      }),
      message: Type.String({
        description: "The steering message to send. This will appear as a user message in the agent's conversation.",
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const record = manager.getRecord(params.agent_id);
      if (!record) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }
      if (record.status !== "running") {
        return textResult(`Agent "${params.agent_id}" is not running (status: ${record.status}). Cannot steer a non-running agent.`);
      }
      if (!record.session) {
        // Session not ready yet — queue the steer for delivery once initialized
        if (!record.pendingSteers) record.pendingSteers = [];
        record.pendingSteers.push(params.message);
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        return textResult(`Steering message queued for agent ${record.id}. It will be delivered once the session initializes.`);
      }

      try {
        await steerAgent(record.session, params.message);
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        const tokens = formatLifetimeTokens(record);
        const contextPercent = getSessionContextPercent(record.session);
        const stateParts: string[] = [];
        if (tokens) stateParts.push(tokens);
        stateParts.push(`${record.toolUses} tool ${record.toolUses === 1 ? "use" : "uses"}`);
        if (contextPercent !== null) stateParts.push(`context ${Math.round(contextPercent)}% full`);
        if (record.compactionCount) stateParts.push(`${record.compactionCount} compaction${record.compactionCount === 1 ? "" : "s"}`);
        return textResult(
          `Steering message sent to agent ${record.id}. The agent will process it after its current tool execution.\n` +
          `Current state: ${stateParts.join(" · ")}`,
        );
      } catch (err) {
        return textResult(`Failed to steer agent: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  }));

  // ---- SubagentWorkflow tool ----

  /**
   * Live workflow runs by id, shared by the tree roots, cards, and inspector.
   *
   * A workflow is session-owned state, not an AgentRecord; only its real child
   * agents enter AgentManager.
   */
  const workflowTasks = new Map<string, WorkflowTask>();
  const workflowHistorySnapshots = new Map<string, WorkflowHistorySnapshot>();

  function getCurrentWorkflowHistory(): ReadonlyMap<string, WorkflowHistorySnapshot> {
    const currentRoot = currentCtx?.cwd;
    if (currentRoot === undefined) return new Map();
    return new Map(
      [...workflowHistorySnapshots.entries()]
        .filter(([, snapshot]) => sameArtifactRootCwd(snapshot.artifactRootCwd, currentRoot)),
    );
  }

  const workflowMenuDeps = {
    tasks: workflowTasks,
    history: workflowHistorySnapshots,
    getHistory: getCurrentWorkflowHistory,
    getRecord: (id: string) => manager.getRecord(id),
    viewAgentConversation: (ctx: ExtensionCommandContext, record: AgentRecord) => viewAgentConversation(ctx, record, "live"),
    getCtx: () => currentCtx as ExtensionCommandContext | undefined,
  };

  function clearWorkflowTasks(): void {
    for (const task of workflowTasks.values()) task.abortController.abort();
    workflowTasks.clear();
  }

  // Workflows are enabled by default. Collision detection may stand this
  // feature down for the current session when another extension owns a
  // workflow tool; user settings can be layered onto these two accessors later.
  let workflowsEnabled = true;
  let workflowsPinned = false;
  function isWorkflowsEnabled(): boolean { return workflowsEnabled; }
  function isWorkflowsPinned(): boolean { return workflowsPinned; }

  /**
   * Execute a task without leaking a rejected detached promise. Every path
   * settles the task, so the menu never leaves a failed run stuck as running.
   */
  async function runWorkflowTask(ctx: ExtensionContext, task: WorkflowTask): Promise<void> {
    try {
      const result = await runWorkflow({
        script: task.script,
        args: task.args,
        signal: task.abortController.signal,
        host: createWorkflowHost({
          pi,
          ctx,
          manager,
          signal: task.abortController.signal,
          artifactRootCwd: ctx.cwd,
          // Real workflow children use the run id as their tree parent; the
          // grouping-only workflow root itself never enters AgentManager.
          workflowId: task.id,
          outputTranscript: getOutputTranscriptDefault(),
          ...(task.rootSessionId !== undefined ? { rootSessionId: task.rootSessionId } : {}),
        }),
        onProgress: entries => {
          updateWorkflowProgressBatch(task, entries);
          widget.update();
        },
        onControl: control => { task.control = control; },
        journal: {
          ...(task.replay !== undefined ? { entries: task.replay } : {}),
          ...(task.journalPath !== undefined
            ? { append: (entry: WorkflowJournalEntry) => appendJournal(task.journalPath!, entry) }
            : {}),
        },
      });
      completeWorkflowTask(task, result);
    } catch (err) {
      failWorkflowTask(task, err instanceof Error ? err.message : String(err));
    }
  }

  function notifyWorkflowFinished(task: WorkflowTask): void {
    const artifactRoot = task.artifactRootCwd ?? currentCtx?.cwd ?? process.cwd();
    const isCurrentArtifactRoot = currentCtx !== undefined && sameArtifactRootCwd(artifactRoot, currentCtx.cwd);
    try {
      const snapshot = writeWorkflowHistorySnapshot(task, artifactRoot);
      if (snapshot !== undefined && isCurrentArtifactRoot) {
        workflowHistorySnapshots.set(snapshot.workflowId, snapshot);
      }
    } catch (error) {
      console.warn(`[pi-subagents] could not persist workflow history: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isCurrentArtifactRoot) return;
    widget.update();
    const result = workflowResultText(task);
    const status: NotificationDetails["status"] = task.status === "completed"
      ? "completed"
      : task.status === "killed" ? "stopped" : "error";
    const message = {
      content: formatWorkflowNotification(task),
      details: {
        id: task.id,
        description: `Workflow ${task.workflowName ?? task.id}`,
        status,
        toolUses: task.totalToolCalls,
        turnCount: 0,
        totalTokens: task.totalTokens,
        durationMs: elapsedMs(task, Date.now()),
        error: task.error,
        resultPreview: result.length > 500 ? `${result.slice(0, 500)}…` : result,
      },
    };
    outbox.add({ ids: [task.id], build: () => message });
  }

  const workflowTool = defineTool({
    name: "SubagentWorkflow",
    label: "SubagentWorkflow",
    description: fullWorkflowToolDescription,
    promptSnippet: "Run a deterministic script that orchestrates many subagents",
    promptGuidelines: [
      "Use SubagentWorkflow when the number of agents depends on something discovered at runtime, when work flows through stages, or when findings should be independently verified. Use Agent for one delegated task or a handful you can name up front.",
      "Prefer `pipeline` over `parallel` — a barrier costs wall-clock whenever the stages are unevenly sized.",
      "A workflow runs in the background and notifies you when it finishes — do not poll or sleep waiting for it.",
    ],
    parameters: Type.Object({
      script: Type.Optional(Type.String({
        maxLength: MAX_SCRIPT_LENGTH,
        description: "Inline workflow source. Must begin with `export const meta = { name, description }`.",
      })),
      scriptPath: Type.Optional(Type.String({
        description: "Path to a workflow script file, absolute or relative to the project. Takes precedence over `script`.",
      })),
      name: Type.Optional(Type.String({
        description: "Name of a saved workflow in `.pi/workflows/`, `.agents/workflows/`, or the agent directory.",
      })),
      args: Type.Optional(Type.Any({
        description: "JSON-shaped value exposed to the script as the global `args`.",
      })),
      resumeFromRunId: Type.Optional(Type.String({
        pattern: "^wf_[a-z0-9-]{6,}$",
        description: "Run id of an earlier workflow in this session to resume from its journal.",
      })),
      title: Type.Optional(Type.String({ description: "Ignored — set the workflow title in the script's `meta` block." })),
      description: Type.Optional(Type.String({ description: "Ignored — set the workflow description in the script's `meta` block." })),
    }),

    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", "▸ ")}${theme.bold(theme.fg("toolTitle", "SubagentWorkflow"))}  ${theme.fg("muted", workflowCallName(args))}`,
        0,
        0,
      );
    },

    renderResult(result, _options, theme, renderContext) {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const taskId = (result.details as { taskId?: string } | undefined)?.taskId;
      const task = taskId !== undefined ? workflowTasks.get(taskId) : undefined;
      if (renderContext.isError || !task) return new Text(text, 0, 0);
      return renderWorkflowCard(
        {
          progress: task.workflowProgress,
          task: {
            status: task.status,
            workflowName: task.workflowName,
            startTime: task.startTime,
            endTime: task.endTime,
            totalPausedMs: task.totalPausedMs,
            ...(task.error !== undefined
              ? { errorPreview: task.error.slice(0, 4_000) }
              : { resultPreview: workflowResultText(task).slice(0, 4_000) }),
          },
          meta: task.meta,
          agentCount: task.agentCount,
          totalTokens: task.totalTokens,
        },
        theme,
      );
    },

    execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
      const resumeFrom = resolveResumeTarget(params.resumeFromRunId, workflowTasks);
      if (resumeFrom !== undefined && !resumeFrom.ok) return textResult(resumeFrom.message);

      const resolved = resolveWorkflowScript(
        params.script === undefined && params.scriptPath === undefined && params.name === undefined && resumeFrom !== undefined
          ? { scriptPath: resumeFrom.scriptPath }
          : params,
        ctx.cwd,
      );
      if (!resolved.ok) return textResult(resolved.message);

      let meta: WorkflowMeta;
      try {
        meta = extractMeta(resolved.script).meta;
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err));
      }

      const runId = workflowRunId();
      let savedPath: string | undefined;
      let journalPath: string | undefined;
      try {
        const sessionId = ctx.sessionManager?.getSessionId?.() ?? "session";
        const taskDir = dirname(createOutputFilePath(ctx.cwd, runId, sessionId));
        savedPath = join(taskDir, `${runId}.workflow.js`);
        writeFileSync(savedPath, resolved.script, "utf-8");
        journalPath = join(taskDir, `${runId}.workflow.jsonl`);
      } catch (err) {
        console.warn(`[pi-subagents] could not persist workflow script: ${err instanceof Error ? err.message : String(err)}`);
      }

      const replay = resumeFrom !== undefined ? readJournal(resumeFrom.journalPath) : undefined;
      const task = createWorkflowTask({
        id: runId,
        script: resolved.script,
        scriptPath: resolved.scriptPath ?? savedPath,
        args: params.args,
        meta,
        toolCallId,
        artifactRootCwd: ctx.cwd,
        rootSessionId: ctx.sessionManager?.getSessionId?.(),
        ...(journalPath !== undefined ? { journalPath } : {}),
        ...(replay !== undefined && replay.length > 0 ? { replay, resumedFrom: resumeFrom?.runId } : {}),
      });
      workflowTasks.set(runId, task);

      // Publish the grouping root before the run starts its first real agent.
      widget.update();
      void runWorkflowTask(ctx, task).then(() => notifyWorkflowFinished(task));

      return {
        content: [{
          type: "text" as const,
          text:
            `Workflow "${meta.name}" started in the background.\n` +
            `Task ID: ${runId}\n` +
            (task.scriptPath ? `Script: ${task.scriptPath}\n` : "") +
            (task.resumedFrom !== undefined
              ? `Resuming ${task.resumedFrom}: ${task.replay?.length ?? 0} recorded call(s) available to replay.\n`
              : params.resumeFromRunId !== undefined
                ? `Nothing to replay from ${params.resumeFromRunId} — every agent runs live.\n`
                : "") +
            "\nYou will be notified when it finishes — do NOT poll or sleep waiting for it.\n" +
            "To iterate, edit the script file and call SubagentWorkflow again with scriptPath.",
        }],
        details: { taskId: runId },
      };
    },
  });

  if (isWorkflowsEnabled()) pi.registerTool(workflowTool);

  let collisionsChecked = false;
  function resolveWorkflowCollisions(ctx: ExtensionContext): void {
    if (collisionsChecked) return;
    collisionsChecked = true;

    const warn = (message: string) => {
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      else console.warn(`[pi-subagents] ${message}`);
    };

    try {
      if (!isWorkflowsEnabled()) return;
      const verdict = decideWorkflowCollision({
        tools: pi.getAllTools(),
        ownDescription: workflowTool.description,
        pinned: isWorkflowsPinned(),
      });
      if (verdict.kind === "none") return;
      if (verdict.kind === "report") {
        warn(verdict.message);
        return;
      }

      workflowsEnabled = false;
      widget.update();
      warn(verdict.message);
      if (!verdict.withdraw) return;
      const active = pi.getActiveTools();
      if (active.includes("SubagentWorkflow")) {
        pi.setActiveTools(active.filter(name => name !== "SubagentWorkflow"));
      }
    } catch {
      // getAllTools/setActiveTools are unavailable in some hosts during startup.
    }
  }

  // ---- /agents interactive menu ----

  const projectAgentsDir = () => join(process.cwd(), ".pi", "agents");
  const workspaceAgentsDir = () => join(process.cwd(), ".agents", "agents");
  const personalAgentsDir = () => join(getAgentDir(), "agents");

  /** Find the file path of a custom agent by name, in discovery-precedence order (project, workspace, then global). */
  function findAgentFile(name: string): { path: string; location: "project" | "workspace" | "personal" } | undefined {
    const projectPath = join(projectAgentsDir(), `${name}.md`);
    if (existsSync(projectPath)) return { path: projectPath, location: "project" };
    const workspacePath = join(workspaceAgentsDir(), `${name}.md`);
    if (existsSync(workspacePath)) return { path: workspacePath, location: "workspace" };
    const personalPath = join(personalAgentsDir(), `${name}.md`);
    if (existsSync(personalPath)) return { path: personalPath, location: "personal" };
    return undefined;
  }

  function getModelLabel(type: string, registry?: ModelRegistry): string {
    const cfg = getAgentConfig(type);
    if (!cfg?.model) return "inherit"; // no model configured → really inherits parent
    const label = getModelLabelFromConfig(cfg.model);
    if (!registry) return label;
    const resolved = resolveModel(cfg.model, registry);
    // Configured but unresolvable: the runtime silently falls back to the parent
    // model, so flag it (and the fallback) rather than hiding the config.
    if (typeof resolved === "string") return `${label} (unavailable, fallback: inherit)`;
    // Surface what it actually resolved to when that differs from the config —
    // e.g. a provider fallback or a looser version pin. Cosmetic separator/date
    // differences are normalized away so an effectively-identical match stays quiet.
    const resolvedFull = `${resolved.provider}/${resolved.id}`;
    const norm = (s: string) => s.toLowerCase().replace(/\./g, "-").replace(/-\d{8}$/, "");
    if (norm(cfg.model) === norm(resolvedFull)) return label;
    return `${label} (→ ${resolvedFull.replace(/-\d{8}$/, "")})`;
  }

  async function showAgentsMenu(ctx: ExtensionCommandContext) {
    reloadCustomAgents();
    const allNames = getAllTypes();

    // Build select options
    const options: string[] = [];

    // The shared current-session tree is the primary conversation surface.
    const records = manager.listAgents();
    const { history } = splitAgentRecords(records, ctx.cwd);
    const legacy = await legacyHistoryFor(ctx);
    options.push(...buildAgentStatusMenuEntries(
      records,
      ctx.cwd,
      ctx.sessionManager?.getSessionId?.(),
      legacy,
      workflowTasks.size > 0,
    ));

    // Agent types list
    if (allNames.length > 0) {
      options.push(`Agent types (${allNames.length})`);
    }

    // Scheduled jobs entry (always present when scheduler is active)
    if (scheduler.isActive()) {
      const jobCount = scheduler.list().length;
      options.push(`Scheduled jobs (${jobCount})`);
    }

    if (isWorkflowsEnabled()) {
      options.push(`Workflows (${getWorkflowRoots().length})`);
    }

    // Actions
    options.push("Create new agent");
    options.push("Settings");

    const noAgentsMsg = allNames.length === 0 && records.length === 0 && history.length === 0
      ? "No agents found. Create specialized subagents that can be delegated to.\n\n" +
        "Each subagent has its own context window, custom system prompt, and specific tools.\n\n" +
        "Try creating: Code Reviewer, Security Auditor, Test Writer, or Documentation Writer.\n\n"
      : "";

    if (noAgentsMsg) {
      ctx.ui.notify(noAgentsMsg, "info");
    }

    const choice = await withModal(() => ctx.ui.select("Agents", options));
    if (!choice) return;

    if (choice.startsWith("Agent conversations this session (")) {
      await showAgentConversations(ctx);
      await showAgentsMenu(ctx);
    } else if (choice.startsWith("Agent history all sessions (")) {
      await showAgentHistory(ctx, "all-sessions");
      await showAgentsMenu(ctx);
    } else if (choice.startsWith("Agent types (")) {
      await showAllAgentsList(ctx);
      await showAgentsMenu(ctx);
    } else if (choice.startsWith("Scheduled jobs (")) {
      await withModal(() => showSchedulesMenu(ctx, scheduler));
      await showAgentsMenu(ctx);
    } else if (choice.startsWith("Workflows (")) {
      await withModal(() => showWorkflowsMenu(ctx, workflowMenuDeps));
      await showAgentsMenu(ctx);
    } else if (choice === "Create new agent") {
      await showCreateWizard(ctx);
    } else if (choice === "Settings") {
      await showSettings(ctx);
      await showAgentsMenu(ctx);
    }
  }

  async function showAllAgentsList(ctx: ExtensionCommandContext) {
    const allNames = getAllTypes();
    if (allNames.length === 0) {
      ctx.ui.notify("No agents.", "info");
      return;
    }

    // Source indicators: defaults unmarked, custom agents get • (project) or ◦ (global)
    // Disabled agents get ✕ prefix
    const sourceIndicator = (cfg: AgentConfig | undefined) => {
      const disabled = cfg?.enabled === false;
      if (cfg?.source === "project") return disabled ? "✕• " : "•  ";
      if (cfg?.source === "global") return disabled ? "✕◦ " : "◦  ";
      if (disabled) return "✕  ";
      return "   ";
    };

    // One row per agent (name in the left column, model on the right); the
    // full description renders below the highlighted row via SettingsList,
    // exactly like the Settings menu — so long descriptions never wrap the list.
    const items: SettingItem[] = allNames.map(name => {
      const cfg = getAgentConfig(name);
      const disabled = cfg?.enabled === false;
      const model = getModelLabel(name, ctx.modelRegistry);
      return {
        id: name,
        label: `${sourceIndicator(cfg)}${name}`,
        currentValue: model,
        description: disabled ? "(disabled)" : (cfg?.description ?? name),
        // Single-value list so Enter "activates" the row (fires onChange with the
        // agent's id) without offering anything to actually cycle.
        values: [model],
      };
    });

    const hasCustom = allNames.some(n => { const c = getAgentConfig(n); return c && !c.isDefault && c.enabled !== false; });
    const hasDisabled = allNames.some(n => getAgentConfig(n)?.enabled === false);
    const legendParts: string[] = [];
    if (hasCustom) legendParts.push("• = project  ◦ = global");
    if (hasDisabled) legendParts.push("✕ = disabled");

    const selected = await withModal(() => ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
      const slTheme = getSettingsListTheme();
      const list = new SettingsList(
        items,
        Math.min(items.length, 12),
        slTheme,
        id => done(id), // Enter/Space on a row → return that agent's name
        () => done(undefined), // Esc → cancel
      );
      const container = new Container();
      container.addChild(new Text("Agent types", 0, 0));
      if (legendParts.length) container.addChild(new Text(slTheme.hint(legendParts.join("  ")), 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(list);
      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => list.handleInput?.(data),
      };
    }));

    if (selected && getAgentConfig(selected)) {
      await showAgentDetail(ctx, selected);
      await showAllAgentsList(ctx);
    }
  }

  function makeUniqueAgentOptionLabels(pairs: Array<{ record: AgentRecord; label: string }>): string[] {
    const counts = new Map<string, number>();
    for (const pair of pairs) counts.set(pair.label, (counts.get(pair.label) ?? 0) + 1);
    const used = new Set<string>();
    return pairs.map((pair) => {
      const { record, label } = pair;
      if ((counts.get(label) ?? 0) === 1) {
        used.add(label);
        return label;
      }
      const suffix = ` · #${record.id.slice(-8)}`;
      let candidate = `${label}${suffix}`;
      let n = 2;
      while (used.has(candidate)) candidate = `${label}${suffix}-${n++}`;
      used.add(candidate);
      pair.label = candidate;
      return candidate;
    });
  }

  async function selectAgentFromReadOnlyList(
    ctx: ExtensionCommandContext,
    title: string,
    pairs: Array<{ record: AgentRecord; label: string }>,
    selection: AgentMenuSelection,
  ): Promise<AgentRecord | undefined> {
    const options = pairs.map(({ record, label }) => ({ value: record.id, label }));
    const rememberedIndex = selection.id
      ? pairs.findIndex(({ record }) => record.id === selection.id)
      : -1;
    const initialIndex = rememberedIndex >= 0
      ? rememberedIndex
      : Math.max(0, Math.min(selection.index, pairs.length - 1));

    const remember = (id: string) => {
      const index = pairs.findIndex(({ record }) => record.id === id);
      if (index >= 0) {
        selection.id = id;
        selection.index = index;
      }
    };

    const choice = await withModal(() => ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
      const list = new SelectList(
        options,
        Math.min(options.length, 10),
        getSelectListTheme(),
      );
      list.setSelectedIndex(initialIndex);
      const initialItem = options[initialIndex];
      if (initialItem) remember(initialItem.value);
      list.onSelectionChange = item => remember(item.value);
      list.onSelect = item => {
        remember(item.value);
        done(item.value);
      };
      list.onCancel = () => done(undefined);

      const container = new Container();
      container.addChild(new Text(title, 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(list);
      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => list.handleInput(data),
      };
    }));

    if (!choice) return undefined;
    return pairs.find(({ record }) => record.id === choice)?.record;
  }

  async function showAgentConversations(ctx: ExtensionCommandContext) {
    while (true) {
      const selection = await withModal(() => showAgentTreeMenu(
        ctx,
        () => ({
          agents: manager.listAgents(),
          workflowRoots: getWorkflowRoots(),
          sessionId: ctx.sessionManager?.getSessionId?.(),
          artifactRootCwd: ctx.cwd,
          resolveViewMode: record => resolveAgentViewMode(record, ctx.cwd),
        }),
        agentTreeMenuState,
      ));
      if (selection === undefined) return;

      if (selection.kind === "workflow") {
        await withModal(async () => {
          await openWorkflowFromFleet(selection.id, workflowMenuDeps);
        });
        continue;
      }

      const record = manager.getRecord(selection.id);
      const mode = record === undefined ? undefined : resolveAgentViewMode(record, ctx.cwd);
      if (record === undefined || mode === undefined) {
        ctx.ui.notify("No conversation available for that agent.", "info");
        continue;
      }
      if (mode === "unavailable") {
        ctx.ui.notify(
          `No display transcript is available for "${record.description}". Resume agent ${record.id} with the Agent tool.`,
          "info",
        );
        continue;
      }
      await viewAgentConversation(ctx, record, mode);
    }
  }

  async function showAgentHistory(ctx: ExtensionCommandContext, scope: "this-session" | "all-sessions" = "all-sessions") {
    const { history } = splitAgentRecords(manager.listAgents(), ctx.cwd);
    const sessionId = ctx.sessionManager?.getSessionId?.();
    const scoped = scope === "this-session" && sessionId
      ? history.filter((record) => record.sessionId === sessionId)
      : history;
    if (scoped.length === 0) {
      ctx.ui.notify(scope === "this-session" ? "No agent history in this session." : "No agent history.", "info");
      return;
    }

    // Sessions recorded before durable checkpoints only exist as
    // `subagents:record` entries in their session file. They are merged here for
    // the project-wide view; the this-session view never needs the scan.
    //
    // They must clear the same `canOpenAgentHistory` bar as everything else:
    // most carry no durable transcript, and listing an entry that can only ever
    // answer "No agent history." is a dead link, not history.
    const merged = scope === "this-session"
      ? scoped
      : mergeLegacyRecords(scoped, await legacyHistoryFor(ctx));
    const pairs = merged.map((record) => ({ record, label: formatAgentHistoryOption(record, Date.now()) }));
    makeUniqueAgentOptionLabels(pairs);
    const title = scope === "this-session" ? "Agent history — this session" : "Agent history — all sessions";
    const record = await selectAgentFromReadOnlyList(ctx, title, pairs, historyAgentSelection);
    if (!record) return;

    await viewAgentConversation(ctx, record, "history");
    // Back-navigation: re-show the list at the previously selected agent.
    await showAgentHistory(ctx, scope);
  }

  /** In-memory records win; legacy session entries only fill genuine gaps. */
  function mergeLegacyRecords(current: readonly AgentRecord[], legacy: readonly AgentRecord[]): AgentRecord[] {
    const known = new Set(current.map((record) => record.id));
    return [...current, ...legacy.filter((record) => !known.has(record.id))]
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  async function viewAgentConversation(
    ctx: ExtensionCommandContext,
    record: AgentRecord,
    mode: "live" | "history" | "unavailable",
  ) {
    if (mode === "unavailable") {
      ctx.ui.notify(
        `No display transcript is available for "${record.description}". Resume agent ${record.id} with the Agent tool.`,
        "info",
      );
      return;
    }
    if (mode === "live" && !canOpenActiveAgent(record, ctx.cwd)) {
      ctx.ui.notify(`Agent is ${record.status === "queued" ? "queued" : "expired"} — no history available.`, "info");
      return;
    }
    if (mode === "history" && !canOpenAgentHistory(record, ctx.cwd)) {
      ctx.ui.notify("No agent history.", "info");
      return;
    }

    const session = mode === "live"
      ? record.session
      : (() => {
          const messages = record.transcriptPath
            ? readAgentHistory(ctx.cwd, record.transcriptPath)
            : undefined;
          return messages
            ? createStaticConversationSource(messages)
            : record.session
              ? createStaticConversationSource(record.session.messages)
              : undefined;
        })();
    if (!session) {
      ctx.ui.notify("No agent history.", "info");
      return;
    }

    const activity = agentActivity.get(record.id);
    const isLive = mode === "live";
    await withModal(() => ctx.ui.custom<undefined>(
      (tui, theme, keybindings, done) => {
        return new ConversationViewer(tui, session, record, activity, theme, done,
          isLive ? () => {
            if (manager.abort(record.id)) {
              ctx.ui.notify(`Stopped "${record.description}".`, "info");
            }
          } : undefined,
          keybindings,
          isLive ? (message: string) => manager.steer(record.id, message) : undefined,
          mode === "history" ? { pi, ctx, readOnly: true } : { pi, ctx });
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
      },
    ));
  }

  async function showAgentDetail(ctx: ExtensionCommandContext, name: string) {
    const cfg = getAgentConfig(name);
    if (!cfg) {
      ctx.ui.notify(`Agent config not found for "${name}".`, "warning");
      return;
    }

    const file = findAgentFile(name);
    const isDefault = cfg.isDefault === true;
    const disabled = cfg.enabled === false;

    let menuOptions: string[];
    if (disabled && file) {
      // Disabled agent with a file — offer Enable
      menuOptions = isDefault
        ? ["Enable", "Edit", "Reset to default", "Delete", "Back"]
        : ["Enable", "Edit", "Delete", "Back"];
    } else if (isDefault && !file) {
      // Default agent with no .md override
      menuOptions = ["Eject (export as .md)", "Disable", "Back"];
    } else if (isDefault && file) {
      // Default agent with .md override (ejected)
      menuOptions = ["Edit", "Disable", "Reset to default", "Delete", "Back"];
    } else {
      // User-defined agent
      menuOptions = ["Edit", "Disable", "Delete", "Back"];
    }

    const choice = await withModal(() => ctx.ui.select(name, menuOptions));
    if (!choice || choice === "Back") return;

    if (choice === "Edit" && file) {
      const content = readFileSync(file.path, "utf-8");
      const edited = await withModal(() => ctx.ui.editor(`Edit ${name}`, content));
      if (edited !== undefined && edited !== content) {
        writeFileSync(file.path, edited, "utf-8");
        reloadCustomAgents();
        ctx.ui.notify(`Updated ${file.path}`, "info");
      }
    } else if (choice === "Delete") {
      if (file) {
        const confirmed = await withModal(() => ctx.ui.confirm("Delete agent", `Delete ${name} from ${file.location} (${file.path})?`));
        if (confirmed) {
          unlinkSync(file.path);
          reloadCustomAgents();
          ctx.ui.notify(`Deleted ${file.path}`, "info");
        }
      }
    } else if (choice === "Reset to default" && file) {
      const confirmed = await withModal(() => ctx.ui.confirm("Reset to default", `Delete override ${file.path} and restore embedded default?`));
      if (confirmed) {
        unlinkSync(file.path);
        reloadCustomAgents();
        ctx.ui.notify(`Restored default ${name}`, "info");
      }
    } else if (choice.startsWith("Eject")) {
      await ejectAgent(ctx, name, cfg);
    } else if (choice === "Disable") {
      await disableAgent(ctx, name);
    } else if (choice === "Enable") {
      await enableAgent(ctx, name);
    }
  }

  /** Eject a default agent: write its embedded config as a .md file. */
  async function ejectAgent(ctx: ExtensionCommandContext, name: string, cfg: AgentConfig) {
    const location = await withModal(() => ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]));
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    if (existsSync(targetPath)) {
      const overwrite = await withModal(() => ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`));
      if (!overwrite) return;
    }

    // Build the .md file content
    const fmFields: string[] = [];
    fmFields.push(`description: ${JSON.stringify(cfg.description)}`);
    if (cfg.displayName) fmFields.push(`display_name: ${cfg.displayName}`);
    fmFields.push(`tools: ${cfg.builtinToolNames?.join(", ") || "all"}`);
    if (cfg.model) fmFields.push(`model: ${cfg.model}`);
    if (cfg.thinking) fmFields.push(`thinking: ${cfg.thinking}`);
    if (cfg.maxTurns) fmFields.push(`max_turns: ${cfg.maxTurns}`);
    fmFields.push(`prompt_mode: ${cfg.promptMode}`);
    if (cfg.extensions === false) fmFields.push("extensions: false");
    else if (Array.isArray(cfg.extensions)) fmFields.push(`extensions: ${cfg.extensions.join(", ")}`);
    if (cfg.excludeExtensions?.length) fmFields.push(`exclude_extensions: ${cfg.excludeExtensions.join(", ")}`);
    if (cfg.skills === false) fmFields.push("skills: false");
    else if (Array.isArray(cfg.skills)) fmFields.push(`skills: ${cfg.skills.join(", ")}`);
    if (cfg.disallowedTools?.length) fmFields.push(`disallowed_tools: ${cfg.disallowedTools.join(", ")}`);
    if (cfg.inheritContext) fmFields.push("inherit_context: true");
    if (cfg.runInBackground) fmFields.push("run_in_background: true");
    if (cfg.outputTranscript === false) fmFields.push("output_transcript: false");
    if (cfg.isolated) fmFields.push("isolated: true");
    if (cfg.memory) fmFields.push(`memory: ${cfg.memory}`);
    if (cfg.isolation) fmFields.push(`isolation: ${cfg.isolation}`);

    const content = `---\n${fmFields.join("\n")}\n---\n\n${cfg.systemPrompt}\n`;

    writeFileSync(targetPath, content, "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Ejected ${name} to ${targetPath}`, "info");
  }

  /** Disable an agent: set enabled: false in its .md file, or create a stub for built-in defaults. */
  async function disableAgent(ctx: ExtensionCommandContext, name: string) {
    const file = findAgentFile(name);
    if (file) {
      // Existing file — set enabled: false in frontmatter (idempotent)
      const content = readFileSync(file.path, "utf-8");
      if (content.includes("\nenabled: false\n")) {
        ctx.ui.notify(`${name} is already disabled.`, "info");
        return;
      }
      const updated = content.replace(/^---\n/, "---\nenabled: false\n");
      writeFileSync(file.path, updated, "utf-8");
      reloadCustomAgents();
      ctx.ui.notify(`Disabled ${name} (${file.path})`, "info");
      return;
    }

    // No file (built-in default) — create a stub
    const location = await withModal(() => ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]));
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    writeFileSync(targetPath, "---\nenabled: false\n---\n", "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Disabled ${name} (${targetPath})`, "info");
  }

  /** Enable a disabled agent by removing enabled: false from its frontmatter. */
  async function enableAgent(ctx: ExtensionCommandContext, name: string) {
    const file = findAgentFile(name);
    if (!file) return;

    const content = readFileSync(file.path, "utf-8");
    const updated = content.replace(/^(---\n)enabled: false\n/, "$1");

    // If the file was just a stub ("---\n---\n"), delete it to restore the built-in default
    if (updated.trim() === "---\n---" || updated.trim() === "---\n---\n") {
      unlinkSync(file.path);
      reloadCustomAgents();
      ctx.ui.notify(`Enabled ${name} (removed ${file.path})`, "info");
    } else {
      writeFileSync(file.path, updated, "utf-8");
      reloadCustomAgents();
      ctx.ui.notify(`Enabled ${name} (${file.path})`, "info");
    }
  }

  async function showCreateWizard(ctx: ExtensionCommandContext) {
    const location = await withModal(() => ctx.ui.select("Choose location", [
      "Project (.pi/agents/)",
      `Personal (${personalAgentsDir()})`,
    ]));
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();

    const method = await withModal(() => ctx.ui.select("Creation method", [
      "Generate with Claude (recommended)",
      "Manual configuration",
    ]));
    if (!method) return;

    if (method.startsWith("Generate")) {
      await showGenerateWizard(ctx, targetDir);
    } else {
      await showManualWizard(ctx, targetDir);
    }
  }

  async function showGenerateWizard(ctx: ExtensionCommandContext, targetDir: string) {
    const description = await withModal(() => ctx.ui.input("Describe what this agent should do"));
    if (!description) return;

    const name = await withModal(() => ctx.ui.input("Agent name (filename, no spaces)"));
    if (!name) return;

    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    if (existsSync(targetPath)) {
      const overwrite = await withModal(() => ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`));
      if (!overwrite) return;
    }

    ctx.ui.notify("Generating agent definition...", "info");

    const generatePrompt = `Create a custom pi sub-agent definition file based on this description: "${description}"

Write a markdown file to: ${targetPath}

The file format is a markdown file with YAML frontmatter and a system prompt body:

\`\`\`markdown
---
description: <one-line description shown in UI>
tools: <comma-separated built-in tools: read, bash, edit, write, grep, find, ls. Use "none" for no tools. Omit for all tools>
model: <optional model as "provider/modelId", e.g. "anthropic/claude-haiku-4-5". Omit to inherit parent model>
thinking: <optional thinking level: ${THINKING_LEVELS.join(", ")}. Omit to inherit>
max_turns: <optional max agentic turns. 0 or omit for unlimited (default)>
prompt_mode: <"replace" (body IS the full system prompt) or "append" (body is appended to default prompt). Default: replace>
extensions: <true (inherit all MCP/extension tools), false (none), or comma-separated names. Default: true>
skills: <true (inherit all), false (none), or comma-separated skill names to preload into prompt. Default: true>
disallowed_tools: <comma-separated tool names to block, even if otherwise available. Omit for none>
inherit_context: <true to fork parent conversation into agent so it sees chat history. Default: false>
run_in_background: <optional default mode: true detaches and returns an ID; false blocks and returns the result inline. Omit for false/blocking. An explicit Agent tool-call value overrides this default>
output_transcript: <false to omit this agent's optional temporary .output mirror. Durable .pi-subagents history is always written. Default: true>
isolated: <true for no extension/MCP tools, only built-in tools. Default: false>
memory: <"user" (global), "project" (per-project), or "local" (gitignored per-project) for persistent memory. Omit for none>
isolation: <"worktree" to run in isolated git worktree. Omit for normal>
---

<system prompt body — instructions for the agent>
\`\`\`

Guidelines for choosing settings:
- For read-only tasks (review, analysis): tools: read, bash, grep, find, ls
- For code modification tasks: include edit, write
- Use prompt_mode: append if the agent should keep the default system prompt and add specialization on top
- Use prompt_mode: replace for fully custom agents with their own personality/instructions
- Set inherit_context: true if the agent needs to know what was discussed in the parent conversation
- Set isolated: true if the agent should NOT have access to MCP servers or other extensions
- Set output_transcript: false to skip only this agent's optional temporary .output mirror; durable .pi-subagents history still records the run. This alone doesn't keep the run off disk (persist_session, isolation: worktree commits, and memory still write) — set those too if that's the goal
- Only include frontmatter fields that differ from defaults — omit fields where the default is fine

Write the file using the write tool. Only write the file, nothing else.`;

    let id: string;
    try {
      id = manager.spawn(pi, ctx, "general-purpose", generatePrompt, {
        description: `Generate ${name} agent`,
        maxTurns: 5,
        isBackground: true,
        bypassQueue: true,
      });
    } catch (err) {
      ctx.ui.notify(`Generation failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
      return;
    }

    const record = manager.getRecord(id);
    void record?.promise?.then(() => {
      if (record.status === "error") {
        ctx.ui.notify(`Generation failed: ${record.error}`, "warning");
        return;
      }

      reloadCustomAgents();
      if (existsSync(targetPath)) {
        ctx.ui.notify(`Created ${targetPath}`, "info");
      } else {
        ctx.ui.notify("Agent generation completed but file was not created. Check the agent output.", "warning");
      }
    });
  }

  async function showManualWizard(ctx: ExtensionCommandContext, targetDir: string) {
    // 1. Name
    const name = await withModal(() => ctx.ui.input("Agent name (filename, no spaces)"));
    if (!name) return;

    // 2. Description
    const description = await withModal(() => ctx.ui.input("Description (one line)"));
    if (!description) return;

    // 3. Tools
    const toolChoice = await withModal(() => ctx.ui.select("Tools", ["all", "none", "read-only (read, bash, grep, find, ls)", "custom..."]));
    if (!toolChoice) return;

    let tools: string;
    if (toolChoice === "all") {
      tools = BUILTIN_TOOL_NAMES.join(", ");
    } else if (toolChoice === "none") {
      tools = "none";
    } else if (toolChoice.startsWith("read-only")) {
      tools = "read, bash, grep, find, ls";
    } else {
      const customTools = await withModal(() => ctx.ui.input("Tools (comma-separated)", BUILTIN_TOOL_NAMES.join(", ")));
      if (!customTools) return;
      tools = customTools;
    }

    // 4. Model
    const modelChoice = await withModal(() => ctx.ui.select("Model", [
      "inherit (parent model)",
      "haiku",
      "sonnet",
      "opus",
      "custom...",
    ]));
    if (!modelChoice) return;

    let modelLine = "";
    if (modelChoice === "haiku") modelLine = "\nmodel: anthropic/claude-haiku-4-5";
    else if (modelChoice === "sonnet") modelLine = "\nmodel: anthropic/claude-sonnet-4-6";
    else if (modelChoice === "opus") modelLine = "\nmodel: anthropic/claude-opus-4-6";
    else if (modelChoice === "custom...") {
      const customModel = await withModal(() => ctx.ui.input("Model (provider/modelId)"));
      if (customModel) modelLine = `\nmodel: ${customModel}`;
    }

    // 5. Thinking
    // "inherit" is a UI-only pseudo-choice (omit the field); the rest mirror pi.
    const thinkingChoice = await withModal(() => ctx.ui.select("Thinking level", ["inherit", ...THINKING_LEVELS]));
    if (!thinkingChoice) return;

    let thinkingLine = "";
    if (thinkingChoice !== "inherit") thinkingLine = `\nthinking: ${thinkingChoice}`;

    // 6. System prompt
    const systemPrompt = await withModal(() => ctx.ui.editor("System prompt", ""));
    if (systemPrompt === undefined) return;

    // Build the file
    const content = `---
description: ${description}
tools: ${tools}${modelLine}${thinkingLine}
prompt_mode: replace
---

${systemPrompt}
`;

    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, `${name}.md`);

    if (existsSync(targetPath)) {
      const overwrite = await withModal(() => ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`));
      if (!overwrite) return;
    }

    writeFileSync(targetPath, content, "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Created ${targetPath}`, "info");
  }

  function snapshotSettings(): SubagentsSettings {
    return {
      maxConcurrent: manager.getMaxConcurrent(),
      maxSubagentDepth: getMaxSubagentDepth(),
      // 0 = unlimited — per SubagentsSettings.defaultMaxTurns docstring and
      // normalizeMaxTurns() in agent-runner.ts (which maps 0 → undefined).
      defaultMaxTurns: getDefaultMaxTurns() ?? 0,
      graceTurns: getGraceTurns(),
      defaultJoinMode: getDefaultJoinMode(),
      schedulingEnabled: isSchedulingEnabled(),
      scopeModels: isScopeModelsEnabled(),
      disableDefaultAgents: isDefaultsDisabled(),
      toolDescriptionMode: getToolDescriptionMode(),
      widgetMode: getWidgetMode(),
      outputTranscript: getOutputTranscriptDefault(),
    };
  }

  const NUMERIC_IDS = new Set(["maxConcurrent", "maxSubagentDepth", "defaultMaxTurns", "graceTurns"]);

  async function showSettings(ctx: ExtensionCommandContext) {
    function buildItems(): SettingItem[] {
      const mc = manager.getMaxConcurrent();
      const depth = getMaxSubagentDepth();
      const dmt = getDefaultMaxTurns() ?? 0;
      const gt = getGraceTurns();

      return [
        {
          id: "maxConcurrent",
          label: "Max concurrency",
          description: "Max concurrent background agents (Enter to type)",
          currentValue: String(mc),
          values: [String(mc)],
        },
        {
          id: "maxSubagentDepth",
          label: "Max nested depth",
          description: "Maximum nested delegation depth (0 = disabled, Enter to type)",
          currentValue: String(depth),
          values: [String(depth)],
        },
        {
          id: "defaultMaxTurns",
          label: "Default max turns",
          description: "Default max turns before wrap-up (0 = unlimited, Enter to type)",
          currentValue: String(dmt),
          values: [String(dmt)],
        },
        {
          id: "graceTurns",
          label: "Grace turns",
          description: "Grace turns after wrap-up steer (Enter to type)",
          currentValue: String(gt),
          values: [String(gt)],
        },
        {
          id: "joinMode",
          label: "Join mode",
          description: "Default join mode for background agents",
          currentValue: getDefaultJoinMode(),
          values: ["smart", "async", "group"],
        },
        {
          id: "schedulingEnabled",
          label: "Scheduling",
          description: "Schedule subagent feature (off removes `schedule` param from Agent tool spec on next pi session)",
          currentValue: isSchedulingEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "scopeModels",
          label: "Scope models",
          description: "Validate subagent models against scoped models (/scoped-models)",
          currentValue: isScopeModelsEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "disableDefaultAgents",
          label: "Disable defaults",
          description: "Hide built-in agents (general-purpose, Explore, Plan) — custom agents are unaffected",
          currentValue: isDefaultsDisabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "outputTranscript",
          label: "Optional output mirror",
          description: "Write each subagent's temporary .output mirror by default. Durable .pi-subagents history is always written; output_transcript frontmatter overrides this mirror setting.",
          currentValue: getOutputTranscriptDefault() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "widgetMode",
          label: "Widget",
          description: "Above-editor agent widget: all = every agent; background = hide explicitly foreground programmatic runs; off = hide the widget.",
          currentValue: getWidgetMode(),
          values: ["all", "background", "off"],
        },
        {
          id: "toolDescriptionMode",
          label: "Tool description",
          description: "Agent tool description sent to the LLM: full (rich, default), compact (~75% fewer tokens, for small/local models), or custom (.pi/agent-tool-description.md with {{placeholders}})",
          currentValue: getToolDescriptionMode(),
          values: ["full", "compact", "custom"],
        },
      ];
    }

    function applyValue(id: string, value: string) {
      if (id === "maxConcurrent") {
        const n = parseInt(value, 10);
        if (n >= 1) {
          manager.setMaxConcurrent(n);
          notifyApplied(ctx, `Max concurrency set to ${n}`);
        }
      } else if (id === "maxSubagentDepth") {
        const n = parseInt(value, 10);
        if (n >= 0) {
          setMaxSubagentDepth(n);
          notifyApplied(ctx, `Max nested depth set to ${n}`);
        }
      } else if (id === "defaultMaxTurns") {
        const n = parseInt(value, 10);
        if (n === 0) {
          setDefaultMaxTurns(undefined);
          notifyApplied(ctx, "Default max turns set to unlimited");
        } else if (n >= 1) {
          setDefaultMaxTurns(n);
          notifyApplied(ctx, `Default max turns set to ${n}`);
        }
      } else if (id === "graceTurns") {
        const n = parseInt(value, 10);
        if (n >= 1) {
          setGraceTurns(n);
          notifyApplied(ctx, `Grace turns set to ${n}`);
        }
      } else if (id === "joinMode") {
        setDefaultJoinMode(value as JoinMode);
        notifyApplied(ctx, `Default join mode set to ${value}`);
      } else if (id === "schedulingEnabled") {
        const enabled = value === "on";
        if (enabled === isSchedulingEnabled()) {
          ctx.ui.notify(`Scheduling already ${enabled ? "enabled" : "disabled"}.`, "info");
        } else {
          setSchedulingEnabled(enabled);
          if (!enabled) scheduler.stop();  // immediate kill — outstanding fires stop ticking
          notifyApplied(
            ctx,
            `Scheduling ${enabled ? "enabled" : "disabled"}. Tool spec change takes effect on next pi session.`,
          );
        }
      } else if (id === "scopeModels") {
        const enabled = value === "on";
        setScopeModelsEnabled(enabled);
        notifyApplied(ctx, `Scope models ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "disableDefaultAgents") {
        const enabled = value === "on";
        setDisableDefaultAgents(enabled);
        notifyApplied(ctx, `Default agents ${enabled ? "disabled" : "enabled"}. Tool spec change takes effect on next pi session.`);
      } else if (id === "outputTranscript") {
        const enabled = value === "on";
        setOutputTranscript(enabled);
        notifyApplied(ctx, `Optional .output mirror ${enabled ? "enabled" : "disabled"} by default`);
      } else if (id === "toolDescriptionMode") {
        setToolDescriptionMode(value as ToolDescriptionMode);
        notifyApplied(ctx, `Tool description set to ${value}. Takes effect on next pi session.`);
      } else if (id === "widgetMode") {
        setWidgetMode(value as WidgetMode);
        notifyApplied(ctx, `Widget set to ${value}`);
      }
    }

    let list: SettingsList;
    // Track current selection index directly (SettingsList doesn't expose it).
    // Updated on arrow keys so Enter knows which field is selected immediately.
    let currentIndex = 0;

    const result = await withModal(() => ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
      const items = buildItems();

      list = new SettingsList(
        items,
        items.length + 2,
        getSettingsListTheme(),
        (id, newValue) => {
          applyValue(id, newValue);
        },
        () => done(undefined as undefined),
      );

      const container = new Container();
      container.addChild(new Text("⚙  Subagent Settings", 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(list);

      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          // Track navigation so Enter knows the current field
          if (matchesKey(data, "up")) {
            currentIndex = Math.max(0, currentIndex - 1);
          } else if (matchesKey(data, "down")) {
            currentIndex = Math.min(items.length - 1, currentIndex + 1);
          }

          // Enter on numeric field → close and prompt for typed input
          if (matchesKey(data, Key.enter) && NUMERIC_IDS.has(items[currentIndex].id)) {
            done(items[currentIndex].id);
            return;
          }
          list.handleInput?.(data);
        },
      };
    }));

    // If a numeric field ID was returned, prompt for typed input
    if (result && NUMERIC_IDS.has(result)) {
      const current = result === "maxConcurrent"
        ? String(manager.getMaxConcurrent())
        : result === "defaultMaxTurns"
          ? String(getDefaultMaxTurns() ?? 0)
          : String(getGraceTurns());

      const label = result === "maxConcurrent"
        ? "Max concurrency (1+)"
        : result === "defaultMaxTurns"
          ? "Default max turns (0 = unlimited)"
          : "Grace turns (1+)";

      // Loop until user enters a valid integer or cancels (Esc / null).
      // Silently trims whitespace; rejects non-numeric input by re-prompting.
      let input: string | undefined = await withModal(() => ctx.ui.input(label, current));
      while (input != null) {
        const trimmed = input.trim();
        const n = Number(trimmed);
        if (trimmed !== "" && Number.isInteger(n)) {
          applyValue(result, String(n));
          await showSettings(ctx);
          return;
        }
        // Invalid — re-prompt with the user's last entry so they can edit it
        input = await withModal(() => ctx.ui.input(label, trimmed));
      }
    }
  }

  // Persist the current snapshot, emit `subagents:settings_changed`, and surface
  // the right toast. Successful saves show info; persistence failures downgrade
  // to warning so users aren't silently reverted on restart. Event fires regardless
  // of outcome so listeners see the in-memory change.
  function notifyApplied(ctx: ExtensionCommandContext, successMsg: string) {
    const { message, level } = saveAndEmitChanged(
      snapshotSettings(),
      successMsg,
      (event, payload) => pi.events.emit(event, payload),
    );
    ctx.ui.notify(message, level);
  }

  pi.registerCommand("agents", {
    description: "Manage agents",
    handler: async (_args, ctx) => {
      await showAgentsMenu(ctx);
    },
  });
}
