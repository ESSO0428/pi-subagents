import { describe, expect, it, vi } from "vitest";
import { createWorkflowHost } from "../src/workflow/host.js";
import type { WorkflowEntry } from "../src/workflow/progress.js";
import type { WorkflowHost } from "../src/workflow/runtime.js";

/**
 * A detached `agent()` hands back an id and returns immediately. Without a way
 * to resolve that id the fan-out could start work but never assemble its
 * answers, which is what made `run_in_background` unusable.
 */
describe("collecting a detached agent", () => {
  const HEAD = 'export const meta = { name: "t", description: "t" };\n';

  function host(result: { ok: boolean; text?: string; error?: string }): WorkflowHost {
    return {
      spawnAgent: async () => ({ ok: true, text: "id-1", detached: true }),
      abortAgent: () => {},
      waitForAgent: async () => result,
    };
  }

  it("resolves a detached child to its final text", async () => {
    const { runWorkflow } = await import("../src/workflow/runtime.js");
    const script = `${HEAD}
const id = await agent("go", { run_in_background: true });
const text = await waitForAgent(id);
return text;`;

    const result = await runWorkflow({ script, host: host({ ok: true, text: "the answer" }) });
    expect(result.value).toBe("the answer");
  });

  it("surfaces a collection failure instead of an empty string", async () => {
    const { runWorkflow } = await import("../src/workflow/runtime.js");
    const script = `${HEAD}
const id = await agent("go", { run_in_background: true });
try { await waitForAgent(id); return "no throw"; }
catch (error) { return "threw"; }`;

    const result = await runWorkflow({
      script,
      host: host({ ok: false, error: "Agent gone" }),
    });
    expect(result.value).toBe("threw");
  });

  it("rejects an empty id by name, uncaught", async () => {
    const { runWorkflow } = await import("../src/workflow/runtime.js");
    const script = `${HEAD}
return await waitForAgent("");`;

    const result = await runWorkflow({ script, host: host({ ok: true, text: "x" }) });
    expect(result.status).toBe("failed");
    expect(String((result as { error?: string }).error)).toContain("waitForAgent");
  });

  it("fails loudly when the host cannot collect at all", async () => {
    const { runWorkflow } = await import("../src/workflow/runtime.js");
    const script = `${HEAD}
const id = await agent("go", { run_in_background: true });
return await waitForAgent(id);`;

    const bare: WorkflowHost = {
      spawnAgent: async () => ({ ok: true, text: "id-1", detached: true }),
      abortAgent: () => {},
    };
    const result = await runWorkflow({ script, host: bare });
    expect(result.status).toBe("failed");
    expect(String((result as { error?: string }).error)).toContain("cannot collect detached agents");
  });
});

/**
 * The plumbing above is only worth anything if the host can actually resolve an
 * id, and if a detached launch is never mistaken for a finished agent. Both
 * were bugs: the run reported `1/1 agents` while the child was still working.
 */
describe("a detached launch is not a finished agent", () => {
  const HEAD = 'export const meta = { name: "t", description: "t" };\n';

  it("leaves the agent unfinished in the progress entries", async () => {
    const { runWorkflow } = await import("../src/workflow/runtime.js");
    const host: WorkflowHost = {
      spawnAgent: async () => ({ ok: true, text: "id-1", detached: true }),
      abortAgent: () => {},
    };
    const script = `${HEAD}return await agent("go", { run_in_background: true });`;

    const result = await runWorkflow({ script, host });
    const agents = result.progress.filter((e): e is Extract<WorkflowEntry, { type: "workflow_agent" }> => e.type === "workflow_agent");
    const last = agents[agents.length - 1];

    expect(last?.state).not.toBe("done");
    expect(last?.detached).toBe(true);
  });
});

describe("the host resolves a detached child", () => {
  function fakeManager(record: unknown) {
    return {
      getRecord: () => record,
      spawn: vi.fn((_pi: unknown, _ctx: unknown, _type: string, _prompt: string, options: { onSpawned?: (id: string) => void }) => {
        options.onSpawned?.("child-1");
        return "child-1";
      }),
    } as never;
  }

  async function launch(host: WorkflowHost): Promise<void> {
    await host.spawnAgent!({
      agentId: "child-1",
      index: 0,
      prompt: "work",
      label: "child",
      agentType: "general-purpose",
      runInBackground: true,
    });
  }

  it("returns the child's final text once it settles", async () => {
    let settled = false;
    const record = {
      promise: Promise.resolve().then(() => { settled = true; }),
      result: "the answer",
    };
    const host = createWorkflowHost({
      pi: {} as never,
      ctx: {} as never,
      manager: fakeManager(record),
    });

    await launch(host);
    const out = await host.waitForAgent!("child-1");
    expect(settled).toBe(true);
    expect(out).toEqual({ ok: true, text: "the answer" });
  });

  it("reports a failed child rather than an empty answer", async () => {
    const host = createWorkflowHost({
      pi: {} as never,
      ctx: {} as never,
      manager: fakeManager({ promise: Promise.resolve(), error: "rate limited" }),
    });

    await launch(host);
    const out = await host.waitForAgent!("child-1");
    expect(out.ok).toBe(false);
    expect((out as { error?: string }).error).toBe("rate limited");
  });

  it("fails by name for an id it never handed out", async () => {
    const host = createWorkflowHost({
      pi: {} as never,
      ctx: {} as never,
      manager: fakeManager(undefined),
    });

    const out = await host.waitForAgent!("ghost");
    expect(out.ok).toBe(false);
    expect((out as { error?: string }).error).toContain("ghost");
  });

  it("does not collect a completed manager record from a foreign handle", async () => {
    const foreign = { promise: Promise.resolve(), result: "secret foreign result" };
    const getRecord = vi.fn((id: string) => id === "foreign-record" ? foreign : undefined);
    const manager = {
      getRecord,
      spawn: vi.fn((_pi: unknown, _ctx: unknown, _type: string, _prompt: string, options: { onSpawned?: (id: string) => void }) => {
        options.onSpawned?.("local-record");
        return "local-record";
      }),
    } as never;
    const host = createWorkflowHost({
      pi: {} as never,
      ctx: { cwd: process.cwd() } as never,
      manager,
    });

    await host.spawnAgent!({
      agentId: "local-handle",
      index: 0,
      prompt: "work",
      label: "local child",
      agentType: "general-purpose",
      runInBackground: true,
    });

    const out = await host.waitForAgent!("foreign-record");
    expect(out).toEqual({
      ok: false,
      error: 'Cannot collect "foreign-record" — no such agent. It may have finished and been dropped already.',
    });
    expect(getRecord).not.toHaveBeenCalledWith("foreign-record");
    expect(foreign.result).toBe("secret foreign result");
  });
});
