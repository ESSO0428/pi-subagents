import { describe, expect, it } from "vitest";
import {
  runWorkflow,
  type WorkflowHost,
  type WorkflowSpawnRequest,
  type WorkflowSpawnResult,
} from "../src/workflow/runtime.js";

const HEAD = 'export const meta = { name: "probe", description: "sandbox" };\n';

function hostFor(calls: WorkflowSpawnRequest[], result: WorkflowSpawnResult): WorkflowHost {
  return {
    async spawnAgent(request) {
      calls.push(request);
      return result;
    },
    abortAgent() {},
  };
}

describe("workflow detached launches", () => {
  it("forwards run_in_background and returns the child id immediately", async () => {
    const calls: WorkflowSpawnRequest[] = [];
    const result = await runWorkflow({
      script: `${HEAD}return await agent("detached", { run_in_background: true });`,
      host: hostFor(calls, { ok: true, text: "child-1", detached: true }),
    });

    expect(result.status).toBe("completed");
    expect(result.value).toBe("child-1");
    expect(calls).toHaveLength(1);
    expect(calls[0].runInBackground).toBe(true);
  });
});

describe("workflow VM sandbox", () => {
  it("rejects host escape attempts without invoking the host", async () => {
    const calls: WorkflowSpawnRequest[] = [];
    const result = await runWorkflow({
      script: `${HEAD}
        const errors = [];
        const capture = (fn) => {
          try { fn(); errors.push("escaped"); }
          catch (error) { errors.push(error.name + ":" + error.message); }
        };
        capture(() => eval("process"));
        capture(() => Function("return process")());
        capture(() => globalThis.constructor.constructor("return process")());
        capture(() => agent.constructor.constructor("return process")());
        capture(() => parallel.constructor.constructor("return process")());
        capture(() => budget.spent.constructor.constructor("return process")());
        capture(() => console.log.constructor.constructor("return process")());
        capture(() => globalThis.__proto__.constructor.constructor("return process")());
        capture(() => require("node:fs"));
        return errors;
      `,
      host: hostFor(calls, { ok: true, text: "unexpected" }),
    });

    expect(result.status).toBe("completed");
    const errors = result.value as string[];
    expect(errors).toHaveLength(9);
    expect(errors.every(error => error !== "escaped")).toBe(true);
    expect(errors.slice(0, 8).every(error => error.startsWith("EvalError:"))).toBe(true);
    expect(errors[8]).toContain("ReferenceError");
    expect(calls).toHaveLength(0);
  });
});
