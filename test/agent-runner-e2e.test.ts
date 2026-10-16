/**
 * agent-runner-e2e.test.ts — End-to-end test against the REAL pi-mono runtime.
 *
 * Every other agent-runner test mocks `@earendil-works/pi-coding-agent`: it
 * asserts that `runAgent` hands the right `tools:` allowlist to a *simulated*
 * `createAgentSession`. That proves our allowlist math, but not the assumption
 * the math rests on — that real pi-mono actually gates a session to that
 * allowlist, admitting extension-registered tools (the #47 fix) and dropping
 * the rest.
 *
 * This test closes that loop with NO pi-mono mock:
 *   - a real extension fixture (`fixtures/e2e-probe-ext.mjs`) registers a tool,
 *   - the real `DefaultResourceLoader` loads it via `additionalExtensionPaths`,
 *   - the real `createAgentSession` builds the session,
 *   - we read the real `session.getActiveToolNames()` at `onSessionCreated`
 *     (fires after construction, before any prompt) and assert what the LLM
 *     would actually be allowed to call.
 *
 * No network/LLM: a faux Model object satisfies `createAgentSession`'s `model`
 * param, and we never depend on a turn completing — the assertion is on the
 * gated tool set, which is fixed at construction. (Driving a live faux model
 * through `session.prompt()` is intentionally avoided: under Vite the faux
 * provider registers in a different `pi-ai` module instance than the one
 * pi-coding-agent streams through, which is brittle and orthogonal to gating.)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extensionCanonicalName, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig } from "../src/types.js";
import { fauxProvider } from "./helpers/pi-ai.js";

// These tests spin up the REAL pi-mono runtime (loader + dynamic extension
// import + session construction), so a cold first run under full-suite CPU
// contention can exceed vitest's 5s default. Give the file generous headroom —
// a genuine hang still fails, just later.
vi.setConfig({ testTimeout: 30_000 });

const FIXTURE = resolve(fileURLToPath(new URL("./fixtures/e2e-probe-ext.mjs", import.meta.url)));
const CODEMODE_REPLACEMENT_FIXTURE = resolve(fileURLToPath(new URL("./fixtures/codemode.mjs", import.meta.url)));
/** The fixture registers exactly this tool. */
const EXT_TOOL = "e2e_probe";
const BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Minimal `pi` stub — `detectEnv` only needs `exec` (returns non-git). */
function makePi() {
  return { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any;
}

describe("agent-runner end-to-end (real pi-mono session + real extension)", () => {
  let cwd: string;
  let faux: ReturnType<typeof fauxProvider>;
  let modelRuntime: ModelRuntime;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-e2e-"));
    // Only used as a valid Model object for createAgentSession; we never rely
    // on it actually streaming (we assert on the pre-prompt gated tool set).
    faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
  });
  afterEach(() => {
    modelRuntime.unregisterProvider("faux");
    rmSync(cwd, { recursive: true, force: true });
  });

  /**
   * Register `cfg` as agent type "e2e", run it through the REAL runAgent, and
   * return the real session's active tool names captured at construction time.
   */
  async function activeToolsFor(
    cfg: Partial<AgentConfig>,
    options: {
      isolated?: boolean;
      onToolActivity?: (activity: { type: "start" | "end"; toolName: string }) => void;
    } = {},
  ): Promise<string[]> {
    registerAgents(
      new Map([
        [
          "e2e",
          {
            name: "e2e",
            description: "e2e",
            builtinToolNames: BUILTINS,
            skills: false,
            systemPrompt: "You are e2e.",
            promptMode: "replace",
            inheritContext: false,
            runInBackground: false,
            isolated: false,
            ...cfg,
          } as AgentConfig,
        ],
      ]),
    );
    const model = faux.getModel();
    const modelRegistry: any = {
      runtime: modelRuntime,
      find: () => model,
      getAll: () => [model],
      getAvailable: () => [model],
      hasConfiguredAuth: () => true,
      isUsingOAuth: () => false,
      getApiKeyAndHeaders: async () => ({ apiKey: "faux", headers: {} }),
      registerProvider: () => {},
      unregisterProvider: () => {},
    };
    const ctx: any = { cwd, getSystemPrompt: () => "PARENT", model, modelRegistry };

    let active: string[] = [];
    let sessionCreated = false;
    const stopAfterCapture = new Error("stop after capturing active tools");
    try {
      await runAgent(ctx, "e2e", "go", {
        pi: makePi(),
        model,
        ...options,
        onSessionCreated: (s) => {
          active = s.getActiveToolNames();
          sessionCreated = true;
          // The tool set is fixed before the prompt; stop here instead of
          // starting an unnecessary faux-provider turn.
          throw stopAfterCapture;
        },
      });
    } catch (error) {
      if (error !== stopAfterCapture) throw error;
      // onSessionCreated intentionally aborts the run after capturing the
      // construction-time gated tool set.
    }
    expect(sessionCreated).toBe(true);
    return active;
  }

  it("real pi-mono admits an extension-registered tool when it's in the allowlist (#47)", async () => {
    const active = await activeToolsFor({ extensions: [FIXTURE] });
    // The extension actually loaded and its tool reached the live session.
    expect(active).toContain(EXT_TOOL);
    for (const b of BUILTINS) expect(active).toContain(b);
  });

  it("an extension tool is absent when extensions are disabled (not loaded)", async () => {
    const active = await activeToolsFor({ extensions: false });
    expect(active).not.toContain(EXT_TOOL);
    for (const b of BUILTINS) expect(active).toContain(b);
  });

  it("direct codemode selection loads and activates the real SDK built-in", async () => {
    const active = await activeToolsFor({ directToolNames: ["codemode"], extensions: true });
    expect(active).toContain("codemode");
  });

  it("does not supply the SDK codemode factory when direct codemode is unselected", async () => {
    const active = await activeToolsFor({ extensions: true });
    expect(active).not.toContain("codemode");
    for (const b of BUILTINS) expect(active).toContain(b);
  });

  it("a codemode extension replaces the SDK built-in without collision diagnostics", async () => {
    const onToolActivity = vi.fn();
    const active = await activeToolsFor(
      {
        directToolNames: ["codemode"],
        extensions: [CODEMODE_REPLACEMENT_FIXTURE],
      },
      { onToolActivity },
    );
    expect(active.filter((name) => name === "codemode")).toHaveLength(1);
    expect(onToolActivity.mock.calls.map(([activity]) => activity.toolName)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/(?:collision|load error|extension-error)/i)]),
    );
  });

  it("isolated mode disables a requested extension and the SDK codemode built-in", async () => {
    const active = await activeToolsFor(
      { directToolNames: ["codemode"], extensions: [FIXTURE] },
      { isolated: true },
    );
    expect(active).not.toContain(EXT_TOOL);
    expect(active).not.toContain("codemode");
    for (const b of BUILTINS) expect(active).toContain(b);
  });

  it("wildcard extension selection activates the real SDK codemode built-in", async () => {
    const active = await activeToolsFor({ directToolNames: ["codemode"], extensions: ["*"] });
    expect(active).toContain("codemode");
  });

  it("direct codemode selection works with an explicit codemode extension include", async () => {
    const active = await activeToolsFor({ directToolNames: ["codemode"], extensions: ["codemode"] });
    expect(active).toContain("codemode");
  });

  it("builtin:codemode selects the real SDK built-in", async () => {
    const active = await activeToolsFor({
      directToolNames: ["codemode"],
      extensions: ["builtin:codemode"],
    });
    expect(active).toContain("codemode");
  });

  it("direct codemode selection stays absent when extensions are disabled", async () => {
    const active = await activeToolsFor({ directToolNames: ["codemode"], extensions: false });
    expect(active).not.toContain("codemode");
    for (const b of BUILTINS) expect(active).toContain(b);
  });

  it("an explicit extension allowlist that omits codemode does not load it", async () => {
    const active = await activeToolsFor({ directToolNames: ["codemode"], extensions: ["some-other-extension"] });
    expect(active).not.toContain("codemode");
  });

  it("explicit codemode exclusion prevents loading the real SDK built-in", async () => {
    const active = await activeToolsFor({
      directToolNames: ["codemode"],
      extensions: true,
      excludeExtensions: ["codemode"],
    });
    expect(active).not.toContain("codemode");
  });

  it("builtin:codemode exclusion has no unmatched-exclusion warning", async () => {
    const onToolActivity = vi.fn();
    const active = await activeToolsFor(
      {
        directToolNames: ["codemode"],
        extensions: true,
        excludeExtensions: ["builtin:codemode"],
      },
      { onToolActivity },
    );
    expect(active).not.toContain("codemode");
    expect(onToolActivity).not.toHaveBeenCalledWith(
      expect.objectContaining({ toolName: expect.stringContaining("did not match any discovered extension") }),
    );
  });

  it("disallowedTools removes the real SDK codemode built-in", async () => {
    const active = await activeToolsFor({
      directToolNames: ["codemode"],
      extensions: ["*"],
      disallowedTools: ["codemode"],
    });
    expect(active).not.toContain("codemode");
    expect(active).toContain("read");
  });

  it("the codemode modifier preserves requested built-ins and extension tools", async () => {
    const active = await activeToolsFor({
      builtinToolNames: ["read"],
      directToolNames: ["codemode"],
      extensions: [FIXTURE, "builtin:codemode"],
    });
    expect(active).toContain("read");
    expect(active).toContain(EXT_TOOL);
    expect(active).toContain("codemode");
    expect(active).not.toContain("bash");
  });

  it("disallowedTools removes a real extension tool from the live session", async () => {
    const active = await activeToolsFor({ extensions: [FIXTURE], disallowedTools: [EXT_TOOL] });
    expect(active).not.toContain(EXT_TOOL); // loaded, then denied at construction
    expect(active).toContain("read");
  });

  it("the ext: allowlist flip mutes a loaded-but-unselected extension in real pi-mono", async () => {
    // Extension loads (extensions: [FIXTURE]), but a single ext: selector for a
    // *different* name flips extension tools to an allowlist — the unselected
    // fixture contributes nothing, even though it loaded and ran its handlers.
    const active = await activeToolsFor({ extensions: [FIXTURE], extSelectors: ["ext:not-the-fixture"] });
    expect(active).not.toContain(EXT_TOOL);
    for (const b of BUILTINS) expect(active).toContain(b);
  });

  it("an ext: selector surfaces the loaded extension's tool through the flip", async () => {
    // Derive the canonical name the loader/selector matcher uses, so the test
    // tracks `extensionCanonicalName` rather than hard-coding a filename form.
    const canon = extensionCanonicalName(FIXTURE);
    const active = await activeToolsFor({
      extensions: [FIXTURE],
      builtinToolNames: ["read"],
      extSelectors: [`ext:${canon}`],
    });
    expect(active).toContain(EXT_TOOL); // selected → surfaces despite the flip
    expect(active).toContain("read");
    expect(active).not.toContain("bash"); // builtinToolNames: ["read"] only
  });
});
