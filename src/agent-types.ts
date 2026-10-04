/**
 * agent-types.ts — Unified agent type registry.
 *
 * Merges embedded default agents with user-defined agents from .pi/agents/*.md, .agents/agents/*.md, and global agents.
 * User agents override defaults with the same name. Disabled agents are kept but excluded from spawning.
 */

import { createCodingTools, createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { DEFAULT_AGENTS } from "./default-agents.js";
import { applyNicoOverridesToMap, readNicoAgentOverrides } from "./nico-overrides.js";
import type { AgentConfig } from "./types.js";


/**
 * All known built-in tool names, derived from pi's own tool factories rather
 * than hardcoded so the set tracks pi-mono if it adds/renames a built-in.
 * `createCodingTools` → read/bash/edit/write; `createReadOnlyTools` →
 * read/grep/find/ls; their de-duplicated union is the 7 built-ins
 * (read, bash, edit, write, grep, find, ls). The `cwd` only binds tool
 * operations we never invoke here — we read each tool's `.name` and discard it.
 */
export const BUILTIN_TOOL_NAMES: string[] = [
  ...new Set([...createCodingTools("."), ...createReadOnlyTools(".")].map((t) => t.name)),
];

/** Unified runtime registry of all agents (defaults + user-defined). */
const agents = new Map<string, AgentConfig>();

/** When true, DEFAULT_AGENTS are skipped during registration. */
let disableDefaults = false;
/** Optional top-level fallback; nested resolution never consults this value. */
let fallbackSubagent: string | undefined;
export const NO_FALLBACK = "none";
export function getFallbackSubagent(): string | undefined { return fallbackSubagent; }
export function setFallbackSubagent(value: string | undefined): void { fallbackSubagent = value; }

/** Check whether default agents are disabled. */
export function isDefaultsDisabled(): boolean { return disableDefaults; }

/** Set whether default agents are disabled. */
export function setDefaultsDisabled(b: boolean): void { disableDefaults = b; }

/**
 * Register agents into the unified registry.
 * Starts with DEFAULT_AGENTS, then overlays user agents (overrides defaults with same name).
 * Disabled agents (enabled === false) are kept in the registry but excluded from spawning.
 */
export function buildAgentRegistry(userAgents: Map<string, AgentConfig>): Map<string, AgentConfig> {
  const registry = new Map<string, AgentConfig>();
  if (!disableDefaults) {
    for (const [name, config] of DEFAULT_AGENTS) registry.set(name, config);
  }
  for (const [name, config] of userAgents) registry.set(name, config);
  return registry;
}

export function registerAgents(userAgents: Map<string, AgentConfig>): void {
  agents.clear();
  for (const [name, config] of buildAgentRegistry(userAgents)) agents.set(name, config);
}

/**
 * Apply npm:pi-subagents-style JSON overrides to the current agent registry.
 * Reads from ~/.pi/agent/settings.json and .pi/settings.json and applies
 * them as the highest-priority layer. Auto-registers agents that don't
 * exist in the registry yet.
 */
export function applyNicoOverrides(): void {
  const { overrides, defaultModel } = readNicoAgentOverrides(process.cwd());
  applyNicoOverridesToMap(agents, overrides, defaultModel);
}

/** Case-insensitive key resolution within a registry. */
function resolveKeyIn(registry: Map<string, AgentConfig>, name: string): string | undefined {
  if (registry.has(name)) return name;
  const lower = name.toLowerCase();
  for (const key of registry.keys()) {
    if (key.toLowerCase() === lower) return key;
  }
  return undefined;
}

/** Case-insensitive key resolution. */
function resolveKey(name: string): string | undefined {
  return resolveKeyIn(agents, name);
}

/** Resolve a type name case-insensitively within a private registry. */
export function resolveTypeIn(registry: Map<string, AgentConfig>, name: string): string | undefined {
  return resolveKeyIn(registry, name);
}

/** Get an agent config from a private registry. */
export function getAgentConfigIn(registry: Map<string, AgentConfig>, name: string): AgentConfig | undefined {
  const key = resolveKeyIn(registry, name);
  return key ? registry.get(key) : undefined;
}

/** Get all enabled agent types from a private registry. */
export function getAvailableTypesIn(registry: Map<string, AgentConfig>): string[] {
  return [...registry.entries()]
    .filter(([_, config]) => config.enabled !== false)
    .map(([name]) => name);
}

/** Check whether a type resolves to one enabled registry entry. */
export function isValidTypeIn(registry: Map<string, AgentConfig>, type: string): boolean {
  return resolveEnabledTypeIn(registry, type) !== undefined;
}

/** Resolve exactly one enabled type without applying the top-level fallback policy. */
export function resolveEnabledTypeIn(
  registry: Map<string, AgentConfig>,
  requested: unknown,
): string | undefined {
  const raw = typeof requested === "string" ? requested.trim() : "";
  if (!raw) return undefined;
  const exact = registry.has(raw) ? raw : undefined;
  if (exact !== undefined) return registry.get(exact)?.enabled === false ? undefined : exact;
  const matches = [...registry.keys()].filter(key => key.toLowerCase() === raw.toLowerCase());
  return matches.length === 1 && registry.get(matches[0])?.enabled !== false ? matches[0] : undefined;
}

export type SpawnTypeResolution =
  | { ok: true; type: string; fellBackFrom?: string }
  | { ok: false; message: string };

/** Resolve a top-level caller type, retaining the historical general-purpose fallback. */
export function resolveSpawnTypeIn(registry: Map<string, AgentConfig>, requested: unknown): SpawnTypeResolution {
  const raw = typeof requested === "string" ? requested.trim() : "";
  const available = () => getAvailableTypesIn(registry).join(", ") || "(none)";
  const key = resolveEnabledTypeIn(registry, raw);
  if (key !== undefined) return { ok: true, type: key };
  const reason = raw ? `Unknown or disabled agent type: "${raw}".` : "No agent type given.";
  const configured = fallbackSubagent?.trim();
  if (configured?.toLowerCase() === NO_FALLBACK) {
    return { ok: false, message: `${reason} Available: ${available()}.` };
  }
  if (configured) {
    const fallback = resolveEnabledTypeIn(registry, configured);
    if (fallback === undefined) {
      return { ok: false, message: `${reason} The configured fallbackSubagent "${configured}" is itself unknown or disabled. Available: ${available()}.` };
    }
    return { ok: true, type: fallback, fellBackFrom: raw };
  }
  return { ok: true, type: "general-purpose", fellBackFrom: raw };
}

export function resolveSpawnType(requested: unknown): SpawnTypeResolution {
  return resolveSpawnTypeIn(agents, requested);
}

/** Resolve a type name case-insensitively. Returns the canonical key or undefined. */
export function resolveType(name: string): string | undefined {
  return resolveKey(name);
}

/** Get the agent config for a type (case-insensitive). */
export function getAgentConfig(name: string): AgentConfig | undefined {
  const key = resolveKey(name);
  return key ? agents.get(key) : undefined;
}

/** Get all enabled type names (for spawning and tool descriptions). */
export function getAvailableTypes(): string[] {
  return [...agents.entries()]
    .filter(([_, config]) => config.enabled !== false)
    .map(([name]) => name);
}

/** Get all type names including disabled (for UI listing). */
export function getAllTypes(): string[] {
  return [...agents.keys()];
}

/** Get names of default agents currently in the registry. */
export function getDefaultAgentNames(): string[] {
  return [...agents.entries()]
    .filter(([_, config]) => config.isDefault === true)
    .map(([name]) => name);
}

/** Get names of user-defined agents (non-defaults) currently in the registry. */
export function getUserAgentNames(): string[] {
  return [...agents.entries()]
    .filter(([_, config]) => config.isDefault !== true)
    .map(([name]) => name);
}

/** Check if a type is valid and enabled (case-insensitive). */
export function isValidType(type: string): boolean {
  const key = resolveKey(type);
  if (!key) return false;
  return agents.get(key)?.enabled !== false;
}

/** Tool names required for memory management. */
const MEMORY_TOOL_NAMES = ["read", "write", "edit"];

/**
 * Get memory tool names (read/write/edit) not already in the provided set.
 */
export function getMemoryToolNames(existingToolNames: Set<string>): string[] {
  return MEMORY_TOOL_NAMES.filter(n => !existingToolNames.has(n));
}

/** Tool names needed for read-only memory access. */
const READONLY_MEMORY_TOOL_NAMES = ["read"];

/**
 * Get read-only memory tool names not already in the provided set.
 */
export function getReadOnlyMemoryToolNames(existingToolNames: Set<string>): string[] {
  return READONLY_MEMORY_TOOL_NAMES.filter(n => !existingToolNames.has(n));
}

/** Get built-in tool names for a type (case-insensitive). */
export function getToolNamesForType(type: string): string[] {
  const key = resolveKey(type);
  const raw = key ? agents.get(key) : undefined;
  const config = raw?.enabled !== false ? raw : undefined;
  // `undefined` (definition omitted the field) → all built-ins; an explicit `[]`
  // (`tools: none` or a `tools:` with only `ext:` entries) → zero built-ins.
  return config?.builtinToolNames ?? [...BUILTIN_TOOL_NAMES];
}

/** Get config for a type (case-insensitive, returns a SubagentTypeConfig-compatible object). Falls back to general-purpose. */
export function getConfig(type: string): {
  displayName: string;
  description: string;
  builtinToolNames: string[];
  extensions: true | string[] | false;
  excludeExtensions?: string[];
  skills: true | string[] | false;
  promptMode: "replace" | "append";
} {
  const key = resolveKey(type);
  const config = key ? agents.get(key) : undefined;
  if (config && config.enabled !== false) {
    return {
      displayName: config.displayName ?? config.name,
      description: config.description,
      builtinToolNames: config.builtinToolNames ?? BUILTIN_TOOL_NAMES,
      extensions: config.extensions,
      excludeExtensions: config.excludeExtensions,
      skills: config.skills,
      promptMode: config.promptMode,
    };
  }

  // Fallback for unknown/disabled types — general-purpose config
  const gp = agents.get("general-purpose");
  if (gp && gp.enabled !== false) {
    return {
      displayName: gp.displayName ?? gp.name,
      description: gp.description,
      builtinToolNames: gp.builtinToolNames ?? BUILTIN_TOOL_NAMES,
      extensions: gp.extensions,
      excludeExtensions: gp.excludeExtensions,
      skills: gp.skills,
      promptMode: gp.promptMode,
    };
  }

  // Absolute fallback (should never happen)
  return {
    displayName: "Agent",
    description: "General-purpose agent for complex, multi-step tasks",
    builtinToolNames: BUILTIN_TOOL_NAMES,
    extensions: true,
    skills: true,
    promptMode: "append",
  };
}

