/**
 * nico-overrides.ts — Read and apply agent overrides from `npm:pi-subagents`-style
 * `settings.json` (`subagents.agentOverrides`).
 *
 * Priority (after `@tintinweb/pi-subagents` has resolved its own .md chain):
 *   1. Local  JSON  (.pi/settings.json)  ← highest
 *   2. Global JSON  (~/.pi/agent/settings.json)
 *
 * Overrides are applied to matching agents in the registry. If an agent name
 * from the overrides does not exist in the registry, it is auto-registered
 * using the override fields as the full definition (no .md file needed).
 *
 * Skill mapping (Nico string[] → tintinweb true | string[] | false):
 *   ["*"]     → true   (all skills)
 *   ["foo"]   → ["foo"] (only listed)
 *   [] | false → false  (none)
 *   omitted   → true   (all, fallback)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES } from "./agent-types.js";
import type { AgentConfig } from "./types.js";

// ============================================================================
// Types matching npm:pi-subagents's settings.json schema
// ============================================================================

export interface NicoAgentOverride {
  model?: string | false;
  thinking?: string | false;
  fallbackModels?: string[];
  systemPrompt?: string;
  systemPromptMode?: "append" | "replace";
  inheritProjectContext?: boolean;
  inheritSkills?: boolean;
  defaultContext?: "fresh" | "fork" | false;
  disabled?: boolean;
  skills?: string[] | false;
  tools?: string[] | false;
  completionGuard?: boolean;
  toolBudget?: Record<string, unknown>;
}

interface NicoSubagentsSettings {
  defaultModel?: string;
  defaultTools?: string[];
  disableBuiltins?: boolean;
  disableThinking?: boolean;
  agentOverrides?: Record<string, NicoAgentOverride>;
}

interface NicoSettingsFile {
  subagents?: NicoSubagentsSettings;
}

/** Resolved tool fields kept separate so direct extension tool names do not look like built-ins. */
export interface ResolvedNicoTools {
  builtinToolNames: string[];
  directToolNames?: string[];
  extensionToolScope?: "inherit" | "explicit";
  extSelectors?: string[];
}

/**
 * Merge local Pi-style defaultTools over global defaults. A local list made
 * entirely of +/- entries patches the inherited list; any plain entry (or an
 * explicit empty list) replaces it.
 */
export function mergeNicoDefaultTools(
  globalTools: string[] | undefined,
  localTools: string[],
): string[] {
  if (localTools.length === 0 || localTools.some((entry) => !entry.startsWith("+") && !entry.startsWith("-"))) {
    return [...localTools];
  }
  return [...(globalTools ?? []), ...localTools];
}

function toolFields(config: ResolvedNicoTools): ResolvedNicoTools {
  return {
    builtinToolNames: [...config.builtinToolNames],
    ...(config.directToolNames?.length ? { directToolNames: [...config.directToolNames] } : {}),
    ...(config.extensionToolScope ? { extensionToolScope: config.extensionToolScope } : {}),
    ...(config.extSelectors?.length ? { extSelectors: [...config.extSelectors] } : {}),
  };
}

/**
 * Resolve a Nico/Pi defaultTools-style list against an agent's existing scope.
 * Plain entries start a complete selection; a list made only of +/- entries
 * patches the supplied base. `ext:` selectors remain separate from direct
 * tool names so the runner can apply its existing extension scoping rules.
 */
export function resolveNicoTools(
  entries: string[],
  base: Pick<AgentConfig, "builtinToolNames" | "directToolNames" | "extensionToolScope" | "extSelectors"> = {},
): ResolvedNicoTools {
  const normalized = entries.map((entry) => entry.trim()).filter(Boolean);
  const patchOnly = normalized.length > 0 && normalized.every((entry) => entry.startsWith("+") || entry.startsWith("-"));
  const builtinToolNames = patchOnly
    ? [...(base.builtinToolNames ?? BUILTIN_TOOL_NAMES)]
    : [];
  const directToolNames = patchOnly ? [...(base.directToolNames ?? [])] : [];
  const extSelectors = patchOnly ? [...(base.extSelectors ?? [])] : [];
  const extensionToolScope = patchOnly ? base.extensionToolScope : "explicit";

  const add = (name: string): void => {
    if (name === "*" || name.toLowerCase() === "all") {
      for (const builtin of BUILTIN_TOOL_NAMES) {
        if (!builtinToolNames.includes(builtin)) builtinToolNames.push(builtin);
      }
    } else if (name.startsWith("ext:")) {
      if (!extSelectors.includes(name)) extSelectors.push(name);
    } else if (BUILTIN_TOOL_NAMES.includes(name)) {
      if (!builtinToolNames.includes(name)) builtinToolNames.push(name);
    } else if (!directToolNames.includes(name)) {
      directToolNames.push(name);
    }
  };

  const remove = (name: string): void => {
    if (name === "*" || name.toLowerCase() === "all") {
      builtinToolNames.splice(0, builtinToolNames.length);
    } else if (name.startsWith("ext:")) {
      for (let i = extSelectors.length - 1; i >= 0; i--) {
        if (extSelectors[i] === name) extSelectors.splice(i, 1);
      }
    } else {
      for (let i = builtinToolNames.length - 1; i >= 0; i--) {
        if (builtinToolNames[i] === name) builtinToolNames.splice(i, 1);
      }
      for (let i = directToolNames.length - 1; i >= 0; i--) {
        if (directToolNames[i] === name) directToolNames.splice(i, 1);
      }
    }
  };

  const applyEntry = (entry: string): void => {
    const operation = entry[0];
    const name = operation === "+" || operation === "-" ? entry.slice(1) : entry;
    if (!name) return;
    if (operation === "-") remove(name);
    else add(name);
  };

  if (patchOnly) {
    for (const entry of normalized) applyEntry(entry);
  } else {
    // Plain entries define the complete selection regardless of where +/-
    // entries appear in the array; patches are applied afterwards.
    for (const entry of normalized) {
      if (!entry.startsWith("+") && !entry.startsWith("-")) add(entry);
    }
    for (const entry of normalized) {
      if (entry.startsWith("+") || entry.startsWith("-")) applyEntry(entry);
    }
  }

  return toolFields({ builtinToolNames, directToolNames, extensionToolScope, extSelectors });
}

function applyNicoTools(agent: AgentConfig, entries: string[]): AgentConfig {
  const resolved = resolveNicoTools(entries, agent);
  return {
    ...agent,
    ...resolved,
    directToolNames: resolved.directToolNames,
    extensionToolScope: resolved.extensionToolScope,
    extSelectors: resolved.extSelectors,
  };
}

// ============================================================================
// Reader
// ============================================================================

/**
 * Read subagents.agentOverrides, subagents.defaultModel, and
 * subagents.defaultTools from both local and global Nico-style settings.json.
 * Local overrides global on key collision.
 */
export function readNicoAgentOverrides(cwd: string): {
  overrides: Record<string, NicoAgentOverride>;
  defaultModel: string | undefined;
  defaultTools: string[] | undefined;
} {
  const merged: Record<string, NicoAgentOverride> = {};
  let defaultModel: string | undefined;
  let defaultTools: string[] | undefined;

  // Global: ~/.pi/agent/settings.json
  const globalPath = join(getAgentDir(), "settings.json");
  const globalSettings = readNicoSettingsFile(globalPath);
  if (globalSettings) {
    mergeOverrides(merged, globalSettings.agentOverrides);
    if (defaultModel === undefined) defaultModel = globalSettings.defaultModel;
    if (globalSettings.defaultTools !== undefined) defaultTools = [...globalSettings.defaultTools];
  }

  // Local: .pi/settings.json
  const localPath = join(cwd, ".pi", "settings.json");
  if (existsSync(localPath)) {
    const localSettings = readNicoSettingsFile(localPath);
    if (localSettings) {
      mergeOverrides(merged, localSettings.agentOverrides);
      if (localSettings.defaultModel !== undefined) defaultModel = localSettings.defaultModel;
      if (localSettings.defaultTools !== undefined) {
        defaultTools = mergeNicoDefaultTools(defaultTools, localSettings.defaultTools);
      }
    }
  }

  return { overrides: merged, defaultModel, defaultTools };
}

function readNicoSettingsFile(filePath: string): NicoSubagentsSettings | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as NicoSettingsFile;
    const sub = raw?.subagents;
    if (!sub || typeof sub !== "object") return undefined;
    const defaultTools = Array.isArray(sub.defaultTools)
      ? sub.defaultTools.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    return { ...sub, defaultTools };
  } catch {
    // Silently skip — bad Nico config must not break tintinweb
    return undefined;
  }
}

function mergeOverrides(
  target: Record<string, NicoAgentOverride>,
  source: Record<string, NicoAgentOverride> | undefined,
): void {
  if (!source) return;
  for (const [name, override] of Object.entries(source)) {
    target[name] = { ...target[name], ...override };
  }
}

// ============================================================================
// Skill converter: Nico string[] → tintinweb true | string[] | false
// ============================================================================

export function resolveNicoSkills(
  skills: string[] | false | undefined,
): true | string[] | false {
  // Not set → inherit all (tintinweb default)
  if (skills === undefined) return true;

  // Explicit false / empty array → none
  if (skills === false || skills.length === 0) return false;

  // ["*"] → all skills
  if (skills.length === 1 && skills[0] === "*") return true;

  // Specific list
  return [...skills];
}

// ============================================================================
// Applier — override existing agent
// ============================================================================

/**
 * Apply a Nico-style override to an existing tintinweb AgentConfig.
 * JSON values directly overwrite the config (highest priority).
 */
export function applyNicoOverride(
  agent: AgentConfig,
  override: NicoAgentOverride,
  nicoDefaultModel?: string,
  nicoDefaultTools?: string[],
): AgentConfig {
  let modified = false;
  let next: AgentConfig = agent;

  // model: explicit override wins; else use defaultModel when agent has none
  if (override.model !== undefined) {
    next = { ...next, model: override.model === false ? undefined : override.model };
    modified = true;
  } else if (nicoDefaultModel !== undefined && next.model === undefined) {
    next = { ...next, model: nicoDefaultModel };
    modified = true;
  }

  if (override.thinking !== undefined) {
    next = { ...next, thinking: override.thinking === false ? undefined : override.thinking as AgentConfig["thinking"] };
    modified = true;
  }

  if (override.systemPrompt !== undefined) {
    next = { ...next, systemPrompt: override.systemPrompt };
    modified = true;
  }

  if (override.systemPromptMode !== undefined) {
    next = { ...next, promptMode: override.systemPromptMode === "append" ? "append" : "replace" };
    modified = true;
  }

  if (override.disabled !== undefined) {
    next = { ...next, enabled: !override.disabled };
    modified = true;
  }

  if (override.tools !== undefined) {
    next = applyNicoTools(next, override.tools === false ? [] : override.tools);
    modified = true;
  } else if (nicoDefaultTools !== undefined) {
    next = applyNicoTools(next, nicoDefaultTools);
    modified = true;
  }

  return modified ? next : agent;
}

// ============================================================================
// Auto-register — create AgentConfig from override when agent doesn't exist
// ============================================================================

function createAgentFromOverride(
  name: string,
  override: NicoAgentOverride,
  defaultModel?: string,
  defaultTools?: string[],
): AgentConfig {
  const resolvedTools = override.tools !== undefined
    ? resolveNicoTools(override.tools === false ? [] : override.tools, { builtinToolNames: BUILTIN_TOOL_NAMES })
    : defaultTools !== undefined
      ? resolveNicoTools(defaultTools, { builtinToolNames: BUILTIN_TOOL_NAMES })
      : { builtinToolNames: [...BUILTIN_TOOL_NAMES] };

  return {
    name,
    displayName: name,
    description: `Auto-registered from npm:pi-subagents JSON settings`,
    ...toolFields(resolvedTools),
    extensions: true,
    skills: resolveNicoSkills(override.skills),
    model: override.model !== undefined ? (override.model === false ? undefined : override.model) : defaultModel,
    thinking: override.thinking !== undefined
      ? (override.thinking === false ? undefined : override.thinking as AgentConfig["thinking"])
      : undefined,
    systemPrompt: override.systemPrompt ?? "",
    promptMode: override.systemPromptMode === "append" ? "append" : "replace",
    enabled: !(override.disabled ?? false),
    source: "global",
    isDefault: false,
  };
}

// ============================================================================
// Bulk apply
// ============================================================================

/**
 * Apply all Nico overrides to a map of agents (mutating in-place).
 * Agents that don't exist yet are auto-registered from the override.
 */
export function applyNicoOverridesToMap(
  agents: Map<string, AgentConfig>,
  overrides: Record<string, NicoAgentOverride>,
  defaultModel?: string,
  defaultTools?: string[],
): void {
  for (const [name, override] of Object.entries(overrides)) {
    const existing = agents.get(name);
    if (existing) {
      agents.set(name, applyNicoOverride(existing, override, defaultModel, defaultTools));
    } else {
      agents.set(name, createAgentFromOverride(name, override, defaultModel, defaultTools));
    }
  }

  if (defaultTools !== undefined) {
    for (const [name, agent] of agents) {
      if (overrides[name] === undefined) agents.set(name, applyNicoTools(agent, defaultTools));
    }
  }
}
