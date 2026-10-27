/**
 * types.ts — Type definitions for the subagent system.
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { LifetimeUsage } from "./usage.js";

export type { ThinkingLevel };

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string;

/** Names of the three embedded default agents. */
export const DEFAULT_AGENT_NAMES = ["general-purpose", "Explore", "Plan"] as const;

/** Memory scope for persistent agent memory. */
export type MemoryScope = "user" | "project" | "local";

/** Isolation mode for agent execution. */
export type IsolationMode = "worktree";

/** Unified agent configuration — used for both default and user-defined agents. */
export interface AgentConfig {
  name: string;
  displayName?: string;
  description: string;
  builtinToolNames?: string[];
  /** Direct non-built-in tool names, e.g. ["codemode"]. */
  directToolNames?: string[];
  /** Explicit JSON tool selections opt extension tools into the same exact scope as built-ins. */
  extensionToolScope?: "inherit" | "explicit";
  /** Raw `ext:` selector entries from the `tools:` CSV, e.g. ["ext:foo", "ext:bar/x"].
   * Presence of any entry flips extension tools to an explicit allowlist. */
  extSelectors?: string[];
  /** Tool denylist — these tools are removed even if `builtinToolNames` or extensions include them. */
  disallowedTools?: string[];
  /** true = inherit all, string[] = only listed, false = none */
  extensions: true | string[] | false;
  /** Extension-name denylist applied after the `extensions:` include set. Exclude wins.
   * Plain canonical names only (case-insensitive); no paths, no wildcard. */
  excludeExtensions?: string[];
  /** true = inherit all, string[] = only listed, false = none */
  skills: true | string[] | false;
  model?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  /** Persist this subagent as a normal pi session instead of keeping it in memory only. */
  persistSession?: boolean;
  /** Write the optional temporary `.output` mirror. Defaults to true; false suppresses only that mirror. Durable `.pi-subagents` history is always written. */
  outputTranscript?: boolean;
  /** Optional session directory used when persistSession is true. Omitted = pi's normal session location. */
  sessionDir?: string;
  /** Nested delegation, off by default: "all" or an explicit type allowlist. */
  allowedSubagents?: "all" | string[];
  systemPrompt: string;
  promptMode: "replace" | "append";
  /** Default for spawn: fork parent conversation. undefined = caller decides. */
  inheritContext?: boolean;
  /** Default execution mode for Agent calls; an explicit tool-call value overrides it. */
  runInBackground?: boolean;
  /** Default for spawn: no extension tools. undefined = caller decides. */
  isolated?: boolean;
  /** Persistent memory scope — agents with memory get a persistent directory and MEMORY.md */
  memory?: MemoryScope;
  /** Isolation mode — "worktree" runs the agent in a temporary git worktree */
  isolation?: IsolationMode;
  /** true = this is an embedded default agent (informational) */
  isDefault?: boolean;
  /** false = agent is hidden from the registry */
  enabled?: boolean;
  /** Where this agent was loaded from */
  source?: "default" | "project" | "global";
}

export type JoinMode = 'async' | 'group' | 'smart';

/**
 * Display mode for the persistent above-editor agent widget.
 * - `all`: show every agent (foreground + background).
 * - `background`: hide foreground agents (they already render inline as the
 *   Agent tool result, #118); show background/queued/scheduled/RPC.
 * - `off`: hide the widget entirely.
 */
export type WidgetMode = 'all' | 'background' | 'off';

/** A workflow run projected as a grouping-only root in the shared agent tree. */
export interface WorkflowTreeRoot {
  /** Canonical project root that owns this live or restored workflow. */
  artifactRootCwd: string;
  /** Root Pi session that started this workflow; absent means history-only. */
  rootSessionId?: string;
  id: string;
  name: string;
  description: string;
  status: "running" | "completed" | "failed" | "killed" | "paused";
  startedAt: number;
  completedAt?: number;
  doneCount: number;
  agentCount: number;
  tokens: number;
  /** True when the root came from durable display-only workflow history. */
  restoredHistory?: boolean;
}

export type AgentOwnership =
  | { kind: "top-level" }
  | { kind: "nested"; parentAgentId: string; depth: number }
  | { kind: "workflow"; workflowId: string; depth?: number };

export type AgentRecoverySessionState =
  | { kind: "pending" }
  | {
      kind: "memory" | "explicit";
      artifactRootCwd: string;
      resourceCwd: string;
      originalExecutionCwd: string;
    }
  | {
      kind: "private";
      locator: string;
      sessionId: string;
      artifactRootCwd: string;
      resourceCwd: string;
      originalExecutionCwd: string;
      provider: string;
      modelId: string;
      thinking: ThinkingLevel;
    };

export interface AgentRecoveryRuntimeIdentity {
  depth: number;
  maxSubagentDepth: number;
  rootSessionId?: string;
}

export interface WorktreeResumeState {
  repoRoot: string;
  baseCommitSha: string;
  savedCommitSha?: string;
  originalTargetSubdirectory: string;
}

export interface AgentRecord {
  id: string;
  type: SubagentType;
  description: string;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error";
  result?: string;
  error?: string;
  toolUses: number;
  startedAt: number;
  completedAt?: number;
  session?: AgentSession;
  abortController?: AbortController;
  promise?: Promise<string>;
  groupId?: string;
  joinMode?: JoinMode;
  /** Set when result was already consumed via get_subagent_result — suppresses completion notification. */
  resultConsumed?: boolean;
  /** Steering messages queued before the session was ready. */
  pendingSteers?: string[];
  /** Worktree info if the agent is running in an isolated worktree. */
  worktree?: {
    path: string;
    branch: string;
    baseSha: string;
    repoRoot: string;
    originalTargetSubdirectory: string;
    workPath: string;
  };
  /** Worktree cleanup result after agent completion. */
  worktreeResult?: { hasChanges: boolean; branch?: string; savedCommitSha?: string };
  /** The tool_use_id from the original Agent tool call. */
  toolCallId?: string;
  /** Absolute path to the optional temporary `.output` mirror while live. */
  outputFile?: string;
  /** Absolute path to the mandatory durable project-local transcript while live. */
  historyFile?: string;
  /** Project-relative durable transcript path persisted in the parent session. */
  transcriptPath?: string;
  /** Cleanup function for the durable-history/optional-output stream subscription. */
  outputCleanup?: () => void;
  /**
   * Lifetime usage breakdown, accumulated via `message_end` events. Survives
   * compaction. Total = input + output + cacheWrite (cacheRead deliberately
   * excluded — see issue #38). Initialized to zeros at spawn.
   */
  lifetimeUsage: LifetimeUsage;
  /** Number of times this agent's session has compacted. Initialized to 0 at spawn. */
  compactionCount: number;
  /**
   * Whether this agent was spawned to run in the background. Tri-state, set at
   * spawn from `SpawnOptions.isBackground`: `true` = background, `false` =
   * foreground (has an inline Agent tool-result surface), `undefined` = the
   * caller never declared it (e.g. a cross-extension RPC spawn, which is detached
   * and has no inline surface). The widget's background-only filter keys off this
   * — and excludes only explicit `false`, so `undefined` agents stay visible.
   * Reliable across ALL spawn paths, unlike the UI-only `invocation` snapshot,
   * which only the Agent-tool path populates.
   */
  isBackground?: boolean;
  /** Resolved spawn params, captured for UI display. Fixed at spawn time. */
  invocation?: AgentInvocation;
  /** Nesting depth: main session is 0, top-level subagents are 1. */
  depth?: number;
  /** Parent agent ID for ownership-scoped nested controls. */
  parentAgentId?: string;
  /** Current-session roster identity; only exact restored provenance is admitted. */
  sessionId?: string;
  /** Parent description shown in a nested conversation viewer. */
  parentDescription?: string;
  /** Effective inherited nesting cap for this branch. */
  maxSubagentDepth?: number;
  /** Root session id used for nested optional `.output` mirrors. */
  rootSessionId?: string;
  /** Most recent live activity, including nested rows not tracked by the root UI callback. */
  liveActivity?: {
    activeTools: Map<string, string>;
    responseText: string;
    turnCount: number;
    maxTurns?: number;
    session?: AgentSession;
  };
  /** Latest nested delegation refusal, retained so the widget can explain it. */
  nestedIssue?: string;
  /** v2 checkpoint session state; pending until the native session is known. */
  sessionState?: AgentRecoverySessionState;
  /** Persisted owner shape used by the v2 checkpoint and later resume authority. */
  ownership?: AgentOwnership;
  /** Persisted child identity used when reconstructing nested tools. */
  runtimeIdentity?: AgentRecoveryRuntimeIdentity;
  /** Stable cwd metadata used by executable session recovery. */
  artifactRootCwd?: string;
  resourceCwd?: string;
  originalExecutionCwd?: string;
  /** Canonical worktree state used by a later resume reconstruction phase. */
  worktreeResume?: WorktreeResumeState;
}

export interface AgentInvocation {
  /** Short display name, e.g. "haiku" — only set when different from parent. */
  modelName?: string;
  /** Effective model captured from the child session, including inherited models. */
  effectiveModelName?: string;
  /** Requested/ effective thinking level. */
  effectiveThinking?: AgentSession["thinkingLevel"];
  thinking?: ThinkingLevel;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  /** Effective execution mode; retained for persisted UI compatibility. */
  runInBackground?: boolean;
  isolation?: IsolationMode;
}

/** Details attached to custom notification messages for visual rendering. */
export interface NotificationDetails {
  id: string;
  description: string;
  status: string;
  toolUses: number;
  turnCount: number;
  maxTurns?: number;
  totalTokens: number;
  durationMs: number;
  outputFile?: string;
  error?: string;
  resultPreview: string;
  /** Additional agents in a group notification. */
  others?: NotificationDetails[];
}

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string;
  platform: string;
}

/**
 * A subagent spawn registered to fire on a schedule.
 *
 * Stored at `<cwd>/.pi/subagent-schedules/<sessionId>.json`. Session-scoped:
 * survives `/resume` but resets on `/new`, mirroring pi-chonky-tasks.
 */
export interface ScheduledSubagent {
  id: string;
  /** Unique within store. Defaults to `description`. */
  name: string;
  description: string;
  /** Raw user input — cron expr | "+10m" | ISO | "5m". */
  schedule: string;
  scheduleType: "cron" | "once" | "interval";
  /** Computed at create time for interval/once. */
  intervalMs?: number;

  // spawn params (subset of Agent tool params; no inherit_context, no resume)
  subagent_type: SubagentType;
  prompt: string;
  model?: string;
  thinking?: ThinkingLevel;
  max_turns?: number;
  isolated?: boolean;
  isolation?: IsolationMode;

  // state
  enabled: boolean;
  /** ISO timestamp. */
  createdAt: string;
  lastRun?: string;
  lastStatus?: "success" | "error" | "running";
  /** Refreshed on every fire and on store load. */
  nextRun?: string;
  runCount: number;
}

export interface ScheduleStoreData {
  /** For future migrations. */
  version: 1;
  jobs: ScheduledSubagent[];
}
