import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyNicoOverride,
  applyNicoOverridesToMap,
  mergeNicoDefaultTools,
  readNicoAgentOverrides,
  resolveNicoTools,
} from "../src/nico-overrides.js";
import type { AgentConfig } from "../src/types.js";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "agent",
    description: "Agent",
    builtinToolNames: ["read", "write"],
    extensions: true,
    skills: true,
    systemPrompt: "",
    promptMode: "replace",
    ...overrides,
  };
}

describe("resolveNicoTools", () => {
  it("treats plain built-in entries as a complete selection", () => {
    expect(resolveNicoTools(["read", "bash"], makeAgent())).toEqual({
      builtinToolNames: ["read", "bash"],
      extensionToolScope: "explicit",
    });
  });

  it("adds direct names and keeps extension selectors separate", () => {
    expect(resolveNicoTools(["read", "+codemode", "ext:foo/bar"], makeAgent())).toEqual({
      builtinToolNames: ["read"],
      directToolNames: ["codemode"],
      extensionToolScope: "explicit",
      extSelectors: ["ext:foo/bar"],
    });
  });

  it("patches the existing scope when every entry is +/-", () => {
    expect(resolveNicoTools(["+codemode", "-write", "-ext:old"], makeAgent({
      directToolNames: ["old-direct"],
      extSelectors: ["ext:old", "ext:keep"],
    }))).toEqual({
      builtinToolNames: ["read"],
      directToolNames: ["old-direct", "codemode"],
      extSelectors: ["ext:keep"],
    });
  });

  it("supports wildcard, explicit empty, and false-equivalent empty selections", () => {
    expect(resolveNicoTools(["*", "+codemode"])).toEqual({
      builtinToolNames: expect.arrayContaining(["read", "bash", "edit", "write", "grep", "find", "ls"]),
      directToolNames: ["codemode"],
      extensionToolScope: "explicit",
    });
    expect(resolveNicoTools([])).toEqual({ builtinToolNames: [], extensionToolScope: "explicit" });
  });
});

describe("mergeNicoDefaultTools", () => {
  it("appends local patch entries to inherited global defaults", () => {
    expect(mergeNicoDefaultTools(["read", "write"], ["+bash", "-write"])).toEqual([
      "read", "write", "+bash", "-write",
    ]);
  });

  it("replaces global defaults for plain or empty local lists", () => {
    expect(mergeNicoDefaultTools(["read"], ["read", "bash"])).toEqual(["read", "bash"]);
    expect(mergeNicoDefaultTools(["read"], [])).toEqual([]);
  });
});

describe("readNicoAgentOverrides", () => {
  let cwd: string;
  let globalDir: string;
  let previousAgentDir: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-nico-local-"));
    globalDir = mkdtempSync(join(tmpdir(), "pi-nico-global-"));
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = globalDir;
    writeFileSync(join(globalDir, "settings.json"), JSON.stringify({
      subagents: { defaultTools: ["read", "write"] },
    }));
  });

  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it("reads and merges local defaultTools patches", () => {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
      subagents: { defaultTools: ["+bash"] },
    }));

    expect(readNicoAgentOverrides(cwd).defaultTools).toEqual(["read", "write", "+bash"]);
  });

  it("lets an empty local defaultTools explicitly replace global defaults", () => {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
      subagents: { defaultTools: [] },
    }));

    expect(readNicoAgentOverrides(cwd).defaultTools).toEqual([]);
  });
});

describe("Nico tool application", () => {
  it("applies defaultTools only when an override omits tools", () => {
    const agent = makeAgent({ description: "keep this" });
    const patched = applyNicoOverride(agent, { model: "test/model" }, undefined, ["-write"]);
    expect(patched.builtinToolNames).toEqual(["read"]);
    expect(patched.description).toBe("keep this");

    const explicit = applyNicoOverride(agent, { tools: ["+codemode"] }, undefined, ["read"]);
    expect(explicit.builtinToolNames).toEqual(["read", "write"]);
    expect(explicit.directToolNames).toEqual(["codemode"]);
  });

  it("preserves existing fields and handles false as an explicit empty set", () => {
    const agent = makeAgent({ model: "old/model", extSelectors: ["ext:foo"] });
    const empty = applyNicoOverride(agent, { tools: false });
    expect(empty.builtinToolNames).toEqual([]);
    expect(empty.directToolNames).toBeUndefined();
    expect(empty.extSelectors).toBeUndefined();
    expect(empty.extensionToolScope).toBe("explicit");
    expect(empty.model).toBe("old/model");
  });

  it("applies systemPromptMode to existing agents", () => {
    const agent = makeAgent({ promptMode: "replace" });
    const updated = applyNicoOverride(agent, { systemPromptMode: "append" });
    expect(updated.promptMode).toBe("append");
  });

  it("applies defaults to unoverridden and auto-registered agents", () => {
    const agents = new Map<string, AgentConfig>([["existing", makeAgent({ name: "existing" })]]);
    applyNicoOverridesToMap(
      agents,
      { "existing": { model: "test/model" }, "new-agent": {} },
      undefined,
      ["read", "+codemode"],
    );

    expect(agents.get("existing")?.builtinToolNames).toEqual(["read"]);
    expect(agents.get("existing")?.directToolNames).toEqual(["codemode"]);
    expect(agents.get("new-agent")?.builtinToolNames).toEqual(["read"]);
    expect(agents.get("new-agent")?.directToolNames).toEqual(["codemode"]);
  });
});
