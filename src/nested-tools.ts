import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { abortable } from "./abortable.js";
import { agentHistoryLocator, createAgentHistoryPath } from "./agent-history.js";
import {
  buildAgentRegistry,
  getAgentConfig,
  getAgentConfigIn,
  getAvailableTypes,
  getAvailableTypesIn,
  resolveEnabledTypeIn,
  resolveTypeIn,
} from "./agent-types.js";
import { loadCustomAgents } from "./custom-agents.js";
import { resolveAgentInvocationConfig } from "./invocation-config.js";
import { resolveModel } from "./model-resolver.js";
import { checkModelScope } from "./model-scope.js";
import { applyNicoOverridesToMap, readNicoAgentOverrides } from "./nico-overrides.js";
import { createOutputFilePath, streamToOutputFile, writeInitialEntry } from "./output-file.js";
import { getStatusNote } from "./status-note.js";
import type { AgentConfig, AgentInvocation, AgentRecord, IsolationMode, ThinkingLevel } from "./types.js";
import { addUsage } from "./usage.js";

let maxSubagentDepth = 2;

export function getMaxSubagentDepth(): number { return maxSubagentDepth; }
export function setMaxSubagentDepth(n: number): void { maxSubagentDepth = Math.max(0, Math.floor(n)); }

const NESTED_TOOL_NAMES = ["Agent", "wait_for_nested_agent", "steer_subagent"] as const;

export interface NestedSpawnOptions {
  description: string;
  model?: Model<Api>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  isolation?: IsolationMode;
  invocation?: AgentInvocation;
  signal?: AbortSignal;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  onSessionCreated?: (session: AgentSession) => void;
  onSpawned?: (id: string) => void;
  depth: number;
  parentAgentId: string;
  maxSubagentDepth: number;
  configCwd?: string;
  rootSessionId?: string;
}

export interface NestedAgentManager {
  spawn(pi: ExtensionAPI, ctx: ExtensionContext, type: string, prompt: string, options: NestedSpawnOptions): string;
  spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: string,
    prompt: string,
    options: Omit<NestedSpawnOptions, "isBackground">,
    onSpawned?: (id: string) => void,
  ): Promise<{ id: string; record: AgentRecord }>;
  getRecord(id: string): AgentRecord | undefined;
  resume(id: string, prompt: string, signal?: AbortSignal): Promise<AgentRecord | undefined>;
  setTranscript?(id: string, historyFile: string, transcriptPath: string, cwd?: string): void;
  reportNestedIssue?(parentAgentId: string, issue: string): void;
}

export interface NestedToolContext {
  manager: NestedAgentManager;
  pi: ExtensionAPI;
  parentAgentId: string;
  depth: number;
  maxSubagentDepth: number;
  allowedSubagents: "all" | string[];
  configCwd: string;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError, details: {} };
}

function ownsRecord(record: AgentRecord | undefined, parentAgentId: string): record is AgentRecord {
  return record?.parentAgentId === parentAgentId;
}

function partialOutputSuffix(record: AgentRecord): string {
  const partial = record.result?.trim();
  return partial ? `\n\nPartial output before the failure:\n${partial}` : "";
}

function formatRecord(record: AgentRecord, fetched: boolean): string {
  if (record.status === "error") {
    return `Agent failed: ${record.error ?? "unknown error"}${partialOutputSuffix(record)}`;
  }
  if (record.status === "queued" || record.status === "running") return `Agent ${record.id} is ${record.status}.`;
  const text = record.result?.trim() || record.error?.trim() || "No output.";
  const note = getStatusNote(record.status);
  if (!note) return text;
  return fetched ? `Nested agent${note}.\n\n${text}` : `Nested agent${note}.\n\n${text}`;
}

/** Build orchestration tools bound to exactly one owning parent agent. */
export function createNestedSubagentTools(context: NestedToolContext): ToolDefinition[] {
  if (context.depth >= context.maxSubagentDepth) return [];
  const loadRegistry = () => {
    const registry = buildAgentRegistry(loadCustomAgents(context.configCwd));
    // Types registered at runtime — by pi or another extension — are reachable
    // from a top-level spawn but absent from the config-derived map, which would
    // make nested hard-reject a name the caller can already dispatch elsewhere.
    // configCwd still wins; this only fills genuine gaps.
    for (const name of getAvailableTypes()) {
      if (registry.has(name)) continue;
      const config = getAgentConfig(name);
      if (config) registry.set(name, config);
    }
    // `applyNicoOverrides()` runs against the global registry at load, so
    // `subagents.agentOverrides` in settings.json is not visible here. Apply the
    // same overrides to this map or a nested child would ignore configuration
    // that governs the very same agent type one level up.
    const { overrides, defaultModel } = readNicoAgentOverrides(context.configCwd);
    applyNicoOverridesToMap(registry, overrides, defaultModel);
    return registry;
  };
  const allowedTypesIn = (registry: Map<string, AgentConfig>): Set<string> | undefined =>
    context.allowedSubagents === "all"
      ? undefined
      : new Set(context.allowedSubagents.map(name => resolveTypeIn(registry, name) ?? name));
  const availableIn = (registry: Map<string, AgentConfig>): string[] => {
    const allowed = allowedTypesIn(registry);
    return getAvailableTypesIn(registry).filter(name => allowed === undefined || allowed.has(name));
  };
  const report = (message: string) => context.manager.reportNestedIssue?.(context.parentAgentId, message);

  const agentTool = defineTool({
    name: NESTED_TOOL_NAMES[0],
    label: "Agent",
    description:
      "Launch an ownership-scoped nested subagent. Only types in this agent's allowed_subagents may be used; "
      + "unknown, disabled, and out-of-list types are rejected rather than fallen back.\n\n"
      + "By default this BLOCKS until the child finishes and returns its result inline. Use that when you need the "
      + "answer to continue your own task. Set run_in_background: true to run the child detached instead — you get "
      + "the child id immediately and collect the outcome later with wait_for_nested_agent, which blocks on your "
      + "behalf. Run several detached children in parallel and wait for them when you are ready.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Self-contained task for the nested agent." }),
      description: Type.String({ description: "Short 3-5 word task description." }),
      subagent_type: Type.String({ description: `Allowed nested agent type. Available: ${availableIn(loadRegistry()).join(", ") || "none"}.` }),
      model: Type.Optional(Type.String({ description: "Optional provider/model override." })),
      thinking: Type.Optional(Type.String({ description: "Optional thinking level." })),
      max_turns: Type.Optional(Type.Number({ minimum: 1 })),
      run_in_background: Type.Optional(Type.Boolean({ description: "Run detached and collect it later with wait_for_nested_agent." })),
      resume: Type.Optional(Type.String({ description: "Resume a nested agent owned by this parent." })),
      isolated: Type.Optional(Type.Boolean()),
      inherit_context: Type.Optional(Type.Boolean()),
      isolation: Type.Optional(Type.Literal("worktree")),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      if (params.resume) {
        const existing = context.manager.getRecord(params.resume);
        if (!ownsRecord(existing, context.parentAgentId)) {
          const message = `Nested agent not found or not owned by this parent: "${params.resume}".`;
          report(`ownership violation: ${message}`);
          return textResult(message, true);
        }
        const resumed = await context.manager.resume(params.resume, params.prompt, signal);
        return resumed
          ? textResult(formatRecord(resumed, false), resumed.status === "error")
          : textResult(`Failed to resume nested agent "${params.resume}".`, true);
      }

      if (context.depth >= context.maxSubagentDepth) {
        const message = `Nested subagent call blocked (depth=${context.depth}, max=${context.maxSubagentDepth}). Complete the task directly.`;
        report(`depth cap: ${message}`);
        return textResult(message, true);
      }

      const registry = loadRegistry();
      const rawType = params.subagent_type;
      const resolvedType = resolveEnabledTypeIn(registry, rawType);
      if (resolvedType === undefined) {
        const message = `Unknown or disabled nested agent type: "${rawType}". Allowed: ${availableIn(registry).join(", ") || "none"}.`;
        report(`allowlist rejection: ${message}`);
        return textResult(message, true);
      }
      const allowed = allowedTypesIn(registry);
      if (allowed !== undefined && !allowed.has(resolvedType)) {
        const message = `Nested agent type "${resolvedType}" is not allowed for this parent. Allowed: ${[...allowed].join(", ") || "none"}.`;
        report(`allowlist rejection: ${message}`);
        return textResult(message, true);
      }

      const config = getAgentConfigIn(registry, resolvedType);
      const invocation = resolveAgentInvocationConfig(config, params);
      let model = ctx.model;
      if (invocation.modelInput) {
        const resolvedModel = resolveModel(invocation.modelInput, ctx.modelRegistry);
        if (typeof resolvedModel === "string") {
          if (invocation.modelFromParams) return textResult(resolvedModel, true);
        } else {
          model = resolvedModel;
        }
      }
      const scopeVerdict = checkModelScope({
        model,
        cwd: context.configCwd,
        modelRegistry: ctx.modelRegistry,
        callerSupplied: invocation.modelFromParams,
        agentLabel: config?.displayName ?? resolvedType,
        modelInput: invocation.modelInput,
      });
      if (scopeVerdict.kind === "error") return textResult(scopeVerdict.message, true);

      const childDepth = context.depth + 1;
      const rootSessionId = context.manager.getRecord(context.parentAgentId)?.rootSessionId
        ?? ctx.sessionManager?.getSessionId?.();
      const options: NestedSpawnOptions = {
        description: params.description,
        model,
        maxTurns: invocation.maxTurns,
        isolated: invocation.isolated,
        inheritContext: invocation.inheritContext,
        thinkingLevel: invocation.thinking,
        isolation: invocation.isolation,
        invocation: {
          thinking: invocation.thinking,
          maxTurns: invocation.maxTurns,
          isolated: invocation.isolated,
          inheritContext: invocation.inheritContext,
          runInBackground: invocation.runInBackground,
          isolation: invocation.isolation,
        },
        depth: childDepth,
        parentAgentId: context.parentAgentId,
        maxSubagentDepth: context.maxSubagentDepth,
        configCwd: context.configCwd,
        rootSessionId,
        onAssistantUsage: usage => {
          for (let id: string | undefined = context.parentAgentId; id !== undefined;) {
            const ancestor = context.manager.getRecord(id);
            if (!ancestor) break;
            addUsage(ancestor.lifetimeUsage, usage);
            id = ancestor.parentAgentId;
          }
        },
      };

      let childId: string | undefined;
      const attachTranscript = (id: string): void => {
        childId = id;
        if (!rootSessionId || config?.outputTranscript === false) return;
        const record = context.manager.getRecord(id);
        if (!record) return;
        // Idempotent: onSpawned attaches, and the detached path also calls this
        // after spawn returns. Re-running would rewrite the opening entry over
        // the conversation the stream has already appended.
        if (record.historyFile) return;
        record.outputFile = createOutputFilePath(context.configCwd, id, rootSessionId);
        writeInitialEntry(record.outputFile, id, params.prompt, ctx.cwd);

        // A durable transcript is what keeps the record alive past the manager's
        // cleanup TTL and what `canOpenAgentHistory` reads once the live session
        // is released. Without it `cleanup()` removes the child outright and the
        // parent's row loses its subtree. Filed beside its ancestors' under the
        // root session's directory, matching the top-level agent path.
        try {
          record.historyFile = createAgentHistoryPath(context.configCwd, id);
          record.transcriptPath = agentHistoryLocator(context.configCwd, record.historyFile);
          writeInitialEntry(record.historyFile, id, params.prompt, ctx.cwd);
          context.manager.setTranscript?.(id, record.historyFile, record.transcriptPath, context.configCwd);
        } catch {
          record.historyFile = undefined;
          record.transcriptPath = undefined;
        }
      };
      options.onSessionCreated = session => {
        const record = childId ? context.manager.getRecord(childId) : undefined;
        if (record?.outputFile && childId) {
          // The fifth argument is the durable transcript. Without it the child's
          // conversation never reaches `historyFile`, so once the live session is
          // released the viewer rebuilds from a transcript holding only the prompt.
          record.outputCleanup = streamToOutputFile(session, record.outputFile, childId, ctx.cwd, record.historyFile);
        }
      };

      try {
        if (invocation.runInBackground) {
          // onSpawned runs synchronously inside spawn(), before the session is
          // created. Attaching afterwards would set `childId` too late for
          // onSessionCreated to wire the transcript stream, leaving the durable
          // transcript with nothing but the opening prompt.
          const id = context.manager.spawn(context.pi, ctx, resolvedType, params.prompt, {
            ...options,
            isBackground: true,
            onSpawned: (spawnedId: string) => {
              attachTranscript(spawnedId);
              options.onSpawned?.(spawnedId);
            },
          });
          attachTranscript(id);
          return textResult(`Nested agent started in background. Agent ID: ${id}`);
        }
        const { record } = await context.manager.spawnAndWait(context.pi, ctx, resolvedType, params.prompt, options, attachTranscript);
        return textResult(formatRecord(record, false), record.status === "error");
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    },
  });

  const resultTool = defineTool({
    name: NESTED_TOOL_NAMES[1],
    label: "Wait for Nested Agent",
    description:
      "Block until a nested agent you own finishes, then return its result. This tool always waits — there is no "
      + "non-blocking variant and no flag to set. Use it for a child you launched with run_in_background: true; a "
      + "child launched in the foreground has already returned its result inline.\n\n"
      + "Only ids of nested agents owned by you are accepted. The wait is interruptible: if your own turn is "
      + "interrupted, this returns without cancelling the child.",
    parameters: Type.Object({ agent_id: Type.String({ description: "The nested agent id returned by Agent." }) }),
    execute: async (_toolCallId, params, signal) => {
      const record = context.manager.getRecord(params.agent_id);
      if (!ownsRecord(record, context.parentAgentId)) {
        const message = `Nested agent not found or not owned by this parent: "${params.agent_id}".`;
        report(`ownership violation: ${message}`);
        return textResult(message, true);
      }
      if ((record.status === "queued" || record.status === "running") && record.promise) {
        await abortable(record.promise, signal);
      }
      return textResult(formatRecord(record, true), record.status === "error");
    },
  });

  const steerTool = defineTool({
    name: NESTED_TOOL_NAMES[2],
    label: "Steer Nested Agent",
    description: "Send guidance to a running nested agent owned by this parent.",
    parameters: Type.Object({ agent_id: Type.String(), message: Type.String() }),
    execute: async (_toolCallId, params) => {
      const record = context.manager.getRecord(params.agent_id);
      if (!ownsRecord(record, context.parentAgentId) || record.status !== "running") {
        const message = `Running nested agent not found or not owned by this parent: "${params.agent_id}".`;
        report(`ownership violation: ${message}`);
        return textResult(message, true);
      }
      if (!record.session) {
        if (!record.pendingSteers) record.pendingSteers = [];
        record.pendingSteers.push(params.message);
        return textResult(`Steering message queued for nested agent ${params.agent_id}.`);
      }
      try {
        await record.session.steer(params.message);
        return textResult(`Steering message sent to nested agent ${params.agent_id}.`);
      } catch (err) {
        return textResult(`Failed to steer nested agent: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    },
  });

  return [agentTool, resultTool, steerTool];
}
