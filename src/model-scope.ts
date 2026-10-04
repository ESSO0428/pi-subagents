/** Shared model-scope policy for top-level and nested spawns. */

import { isModelInScope, type ModelRegistryRef, readEnabledModels, resolveEnabledModels } from "./enabled-models.js";

let scopeModelsEnabled = false;

export function isScopeModelsEnabled(): boolean { return scopeModelsEnabled; }
export function setScopeModelsEnabled(enabled: boolean): void { scopeModelsEnabled = enabled; }

export type ModelScopeVerdict =
  | { kind: "ok" }
  | { kind: "error"; message: string }
  | { kind: "warn"; message: string };

export function checkModelScope(args: {
  model: { provider: string; id: string } | undefined;
  cwd: string;
  modelRegistry: ModelRegistryRef;
  callerSupplied: boolean;
  agentLabel: string;
  modelInput?: string;
}): ModelScopeVerdict {
  const { model, cwd, modelRegistry, callerSupplied, agentLabel, modelInput } = args;
  if (!scopeModelsEnabled || !model) return { kind: "ok" };
  const allowed = resolveEnabledModels(readEnabledModels(cwd), modelRegistry, cwd);
  if (!allowed || isModelInScope(model, allowed)) return { kind: "ok" };
  if (callerSupplied) {
    const list = [...allowed].sort().map(item => `  ${item}`).join("\n");
    return { kind: "error", message: `Model not in scope: "${modelInput}".\n\nAllowed models (from enabledModels):\n${list}` };
  }
  return {
    kind: "warn",
    message: `Agent "${agentLabel}" using out-of-scope model "${modelInput ?? `${model.provider}/${model.id}`}"`,
  };
}
