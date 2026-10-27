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
import { readAgentHistoryResult } from "./agent-history.js";
import type { ResumeAuthority, ResumeOptions } from "./agent-manager.js";
import type {
  AgentResumeRuntime,
  AgentResumeRuntimeDependencies,
  AgentResumeRuntimeFactory,
} from "./agent-runner.js";
import { canonicalArtifactRootCwd } from "./agent-session-storage.js";
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
import { createOutputFilePath, writeInitialEntry } from "./output-file.js";
import { getStatusNote } from "./status-note.js";
import type { AgentConfig, AgentInvocation, AgentOwnership, AgentRecord, IsolationMode, ThinkingLevel } from "./types.js";
import { addUsage } from "./usage.js";

let maxSubagentDepth = 2;

export function getMaxSubagentDepth(): number { return maxSubagentDepth; }
export function setMaxSubagentDepth(n: number): void { maxSubagentDepth = Math.max(0, Math.floor(n)); }

const NESTED_TOOL_NAMES = ["Agent", "get_subagent_result", "steer_subagent"] as const;

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
  artifactRootCwd?: string;
  ownership?: AgentOwnership;
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
  resume(
    id: string,
    prompt: string,
    runtimeFactory: AgentResumeRuntimeFactory,
    authority: ResumeAuthority,
    signalOrOptions?: AbortSignal | ResumeOptions,
    options?: ResumeOptions,
  ): Promise<AgentRecord | undefined>;
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
  createResumeRuntime?: (ctx: ExtensionContext, deps: AgentResumeRuntimeDependencies) => AgentResumeRuntime;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError, details: {} };
}

function ownsRecord(record: AgentRecord | undefined, parentAgentId: string): record is AgentRecord {
  return record?.parentAgentId === parentAgentId;
}

function formatRecord(record: AgentRecord, fetched: boolean, fallbackResult?: string): string {
  if (record.status === "error") {
    const partial = record.result?.trim() || fallbackResult?.trim();
    return `Agent failed: ${record.error ?? "unknown error"}${partial ? `\n\nPartial output before the failure:\n${partial}` : ""}`;
  }
  if (record.status === "queued" || record.status === "running") return `Agent ${record.id} is ${record.status}.`;
  const text = record.result?.trim() || fallbackResult?.trim() || record.error?.trim() || "No output.";
  const note = getStatusNote(record.status);
  if (!note) return text;
  return fetched ? `Nested agent${note}.\n\n${text}` : `Nested agent${note}.\n\n${text}`;
}

/** Poll queued records until they start, then wait for the active run. */
async function waitForTerminalRecord(record: AgentRecord, signal?: AbortSignal): Promise<void> {
  while (record.status === "queued" || (record.status === "running" && !record.promise)) {
    await abortable(new Promise<void>(resolve => setTimeout(resolve, 25)), signal);
  }
  if (record.status === "running" && record.promise) {
    await abortable(record.promise, signal);
  }
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
    const { overrides, defaultModel, defaultTools } = readNicoAgentOverrides(context.configCwd);
    applyNicoOverridesToMap(registry, overrides, defaultModel, defaultTools);
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
      + "the child id immediately and collect the outcome later with get_subagent_result. Use wait: true to block "
      + "cancellably, or omit wait to check immediately. Run several detached children in parallel and collect them "
      + "when you are ready. The model, thinking, max_turns, inherit_context, isolated, and isolation parameters "
      + "only fill fields left unspecified by the selected agent's frontmatter or agentOverrides; an explicit "
      + "run_in_background value overrides its configured default.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Self-contained task for the nested agent." }),
      description: Type.String({ description: "Short 3-5 word task description." }),
      subagent_type: Type.String({ description: `Allowed nested agent type. Available: ${availableIn(loadRegistry()).join(", ") || "none"}.` }),
      model: Type.Optional(Type.String({ description: "Optional model. Used only when the selected agent's frontmatter or agentOverrides leaves model unspecified." })),
      thinking: Type.Optional(Type.String({ description: "Optional thinking level. Used only when the selected agent's frontmatter or agentOverrides leaves thinking unspecified." })),
      max_turns: Type.Optional(Type.Number({ description: "Maximum agentic turns. Used only when the selected agent's frontmatter or agentOverrides leaves max_turns unspecified; omit for unlimited.", minimum: 1 })),
      run_in_background: Type.Optional(Type.Boolean({ description: "Run detached and collect it later with get_subagent_result. An explicit tool-call value overrides the selected agent's frontmatter or agentOverrides default; when omitted, that default applies." })),
      resume: Type.Optional(Type.String({ description: "Resume a nested agent owned by this parent." })),
      isolated: Type.Optional(Type.Boolean({ description: "If true, use only built-in tools. Used only when the selected agent's frontmatter or agentOverrides leaves isolated unspecified." })),
      inherit_context: Type.Optional(Type.Boolean({ description: "If true, fork the parent conversation. Used only when the selected agent's frontmatter or agentOverrides leaves inherit_context unspecified." })),
      isolation: Type.Optional(Type.Literal("worktree", { description: 'Run the agent in an isolated git worktree. Used only when the selected agent\'s frontmatter or agentOverrides leaves isolation unspecified.' })),
    }),
    execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
      if (params.resume) {
        const existing = context.manager.getRecord(params.resume);
        if (!ownsRecord(existing, context.parentAgentId)) {
          const message = `Nested agent not found or not owned by this parent: "${params.resume}".`;
          report(`ownership violation: ${message}`);
          return textResult(message, true);
        }
        const invalid = [
          ["model", params.model],
          ["thinking", params.thinking],
          ["max_turns", params.max_turns],
          ["isolated", params.isolated],
          ["inherit_context", params.inherit_context],
          ["isolation", params.isolation],
        ].find(([, value]) => value !== undefined);
        if (invalid) {
          return textResult(
            `resume-invalid-options: resume cannot override spawn option "${invalid[0]}".`,
            true,
          );
        }
        const isBackground = params.run_in_background ?? false;
        const runtimeFactory: AgentResumeRuntimeFactory = {
          create: (deps: AgentResumeRuntimeDependencies) => context.createResumeRuntime?.(ctx, deps) ?? {
            rehydrate: async () => {
              throw new Error("resume-session-incompatible: resume runtime is unavailable");
            },
          },
        };
        try {
          const resumed = await context.manager.resume(
            params.resume,
            params.prompt,
            runtimeFactory,
            {
              kind: "nested",
              artifactRootCwd: canonicalArtifactRootCwd(context.configCwd),
              parentAgentId: context.parentAgentId,
            },
            { isBackground, ...(isBackground ? {} : { signal }), toolCallId },
          );
          if (isBackground) {
            return textResult(`Nested agent resumed in background. Agent ID: ${params.resume}`);
          }
          return resumed
            ? textResult(formatRecord(resumed, false), resumed.status === "error")
            : textResult(`Failed to resume nested agent "${params.resume}".`, true);
        } catch (error) {
          const code = error instanceof Error && "code" in error
            && typeof (error as { code?: unknown }).code === "string"
            ? (error as { code: string }).code
            : undefined;
          const message = error instanceof Error
            ? code ? `${code}: ${error.message.replace(`${code}: `, "")}` : error.message
            : String(error);
          return textResult(message, true);
        }
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
        artifactRootCwd: canonicalArtifactRootCwd(context.configCwd),
        ownership: { kind: "nested", parentAgentId: context.parentAgentId, depth: childDepth },
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

      const attachTranscript = (id: string): void => {
        if (!rootSessionId || config?.outputTranscript === false) return;
        const record = context.manager.getRecord(id);
        if (!record || record.outputFile) return;
        // AgentManager owns mandatory durable history. Nested delegation only
        // opts into the optional temporary `.output` mirror.
        record.outputFile = createOutputFilePath(context.configCwd, id, rootSessionId);
        writeInitialEntry(record.outputFile, id, params.prompt, ctx.cwd);
      };
      try {
        if (invocation.runInBackground) {
          // The manager attaches mandatory durable history and its event stream
          // around this callback; this callback only prepares the optional `.output` mirror.
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
    label: "Get Nested Agent Result",
    description:
      "Check the status or retrieve the result of a nested agent owned by this parent. Omit wait, or set wait: false, "
      + "to check immediately without consuming a pending result. Set wait: true to wait cancellably until it finishes.\n\n"
      + "If your own turn is interrupted while waiting, the child keeps running and its result remains available.",
    parameters: Type.Object({
      agent_id: Type.String({ description: "The nested agent id returned by Agent." }),
      wait: Type.Optional(Type.Boolean({ description: "Wait cancellably for a queued or running nested agent to finish." })),
    }),
    execute: async (_toolCallId, params, signal) => {
      const record = context.manager.getRecord(params.agent_id);
      if (!ownsRecord(record, context.parentAgentId)) {
        const message = `Nested agent not found or not owned by this parent: "${params.agent_id}".`;
        report(`ownership violation: ${message}`);
        return textResult(message, true);
      }
      if (params.wait === true && (record.status === "queued" || record.status === "running")) {
        await waitForTerminalRecord(record, signal);
      }

      const fallbackResult = !record.result?.trim() && record.transcriptPath
        ? readAgentHistoryResult(context.configCwd, record.transcriptPath)
        : undefined;
      if (record.status !== "queued" && record.status !== "running") {
        record.resultConsumed = true;
      }
      return textResult(
        formatRecord(record, params.wait === true, fallbackResult),
        record.status === "error",
      );
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
