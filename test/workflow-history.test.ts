import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { showWorkflowDialog, showWorkflowsMenu } from "../src/ui/workflow-menu.js";
import {
  loadWorkflowHistorySnapshots,
  toWorkflowHistoryTreeRoot,
  WORKFLOW_HISTORY_MAX_BYTES,
  writeWorkflowHistorySnapshot,
} from "../src/workflow/history.js";
import {
  createWorkflowTask,
  updateWorkflowProgressBatch,
  type WorkflowTask,
} from "../src/workflow/task.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-history-"));
  roots.push(root);
  return root;
}

function terminalTask(root: string, id: string, status: "completed" | "failed" | "killed", completedAt = 20): WorkflowTask {
  const task = createWorkflowTask({
    id,
    script: 'export const meta = { name: "secret", description: "secret" }; return "secret";',
    args: { secret: "must not persist" },
    artifactRootCwd: root,
    startTime: 10,
    meta: {
      name: "review workflow",
      description: "Review the project",
      phases: [{ title: "Inspect", detail: "Inspect files", model: "faux" }],
    },
  });
  updateWorkflowProgressBatch(task, [
    { type: "workflow_phase", index: 0, title: "Inspect" },
    {
      type: "workflow_agent",
      index: 0,
      label: "child",
      state: "done",
      agentId: "internal-child-id",
      recordId: "manager-record-id",
      phaseIndex: 0,
      phaseTitle: "Inspect",
      promptPreview: "prompt",
      resultPreview: "child result",
      tokens: 12,
      toolCalls: 2,
    },
    { type: "workflow_log", message: "safe log" },
  ]);
  task.status = status;
  task.endTime = completedAt;
  task.value = { safe: "result" };
  task.error = status === "failed" ? "safe error" : undefined;
  return task;
}

describe("durable workflow history storage", () => {
  it("writes only terminal display fields atomically and never writes active workflows", () => {
    const root = project();
    const active = createWorkflowTask({ id: "wf_active1", script: "secret", artifactRootCwd: root });
    expect(writeWorkflowHistorySnapshot(active, root)).toBeUndefined();
    expect(existsSync(join(root, ".pi-subagents"))).toBe(false);

    const task = terminalTask(root, "wf_terminal1", "completed");
    const snapshot = writeWorkflowHistorySnapshot(task, root);
    expect(snapshot?.status).toBe("completed");
    const path = join(root, ".pi-subagents", "workflow-history", "v1", "wf_terminal1.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(root, ".pi-subagents", "workflow-history", "v1"))).toEqual(["wf_terminal1.json"]);

    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("secret");
    const persisted = JSON.parse(raw) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty("script");
    expect(persisted).not.toHaveProperty("args");
    expect(persisted).not.toHaveProperty("control");
    expect(persisted).not.toHaveProperty("abortController");
    expect((persisted.progress as Array<Record<string, unknown>>).every(entry => !("agentId" in entry) && !("recordId" in entry))).toBe(true);
    expect(JSON.parse(raw)).toMatchObject({
      workflowId: "wf_terminal1",
      name: "review workflow",
      description: "Review the project",
      resultPreview: expect.stringContaining("safe"),
      progress: expect.arrayContaining([
        expect.objectContaining({ type: "workflow_log", message: "safe log" }),
      ]),
    });
  });

  it("persists session provenance while loading older snapshots without it", () => {
    const root = project();
    const currentTask = terminalTask(root, "wf_current1", "completed");
    currentTask.rootSessionId = "session-current";
    const current = writeWorkflowHistorySnapshot(currentTask, root)!;
    const legacy = writeWorkflowHistorySnapshot(terminalTask(root, "wf_legacy1", "completed", 21), root)!;

    expect(current.rootSessionId).toBe("session-current");
    expect(legacy.rootSessionId).toBeUndefined();
    const loaded = loadWorkflowHistorySnapshots(root);
    expect(loaded.find(snapshot => snapshot.workflowId === "wf_current1")).toMatchObject({ rootSessionId: "session-current" });
    expect(loaded.find(snapshot => snapshot.workflowId === "wf_legacy1")).not.toHaveProperty("rootSessionId");
    expect(toWorkflowHistoryTreeRoot(current)).toMatchObject({ rootSessionId: "session-current" });
    expect(toWorkflowHistoryTreeRoot(legacy).rootSessionId).toBeUndefined();
  });

  it("restores terminal snapshots as display roots and supplies no actions or child conversation binding", async () => {
    const root = project();
    const snapshots = (["completed", "failed", "killed"] as const).map((status, index) => {
      const task = terminalTask(root, `wf_status${index}`, status, 20 + index);
      return writeWorkflowHistorySnapshot(task, root)!;
    });
    expect(loadWorkflowHistorySnapshots(root).map(snapshot => snapshot.status)).toEqual(["killed", "failed", "completed"]);
    expect(snapshots.map(toWorkflowHistoryTreeRoot)).toEqual([
      expect.objectContaining({ id: "wf_status0", artifactRootCwd: root, status: "completed" }),
      expect.objectContaining({ id: "wf_status1", artifactRootCwd: root, status: "failed" }),
      expect.objectContaining({ id: "wf_status2", artifactRootCwd: root, status: "killed" }),
    ]);

    const snapshot = snapshots[1];
    const notify = vi.fn();
    const getRecord = vi.fn();
    const viewAgentConversation = vi.fn(async () => undefined);
    const rendered: string[] = [];
    const ctx = {
      ui: {
        custom: vi.fn(async (factory: any) => {
          const component = factory(
            { requestRender: vi.fn() },
            { fg: (_color: string, text: string) => text, bold: (text: string) => text },
            {},
            vi.fn(),
          );
          rendered.push(component.render(160).join("\n"));
          component.handleInput("x");
          component.handleInput("c");
          component.handleInput("\u001b");
        }),
        notify,
      },
    } as any;
    await showWorkflowDialog(ctx, snapshot, {
      tasks: new Map(),
      history: new Map([[snapshot.workflowId, snapshot]]),
      getRecord,
      viewAgentConversation,
      getCtx: () => ctx,
    });
    expect(rendered[0]).toContain("Restored workflow history");
    expect(rendered[0]).toContain("child conversations unavailable");
    expect(rendered[0]).toContain("safe error");
    expect(rendered[0]).not.toContain("x stop");
    expect(rendered[0]).not.toContain("c convo");
    expect(getRecord).not.toHaveBeenCalled();
    expect(viewAgentConversation).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("deduplicates a live terminal run ahead of a restored snapshot with the same id", async () => {
    const root = project();
    const snapshot = writeWorkflowHistorySnapshot(terminalTask(root, "wf_sameid1", "completed"), root)!;
    const live = terminalTask(root, snapshot.workflowId, "failed", 30);
    const select = vi.fn();
    const custom = vi.fn(async () => undefined);
    await showWorkflowsMenu({ ui: { select, custom } } as any, {
      tasks: new Map([[live.id, live]]),
      history: new Map([[snapshot.workflowId, snapshot]]),
      getRecord: () => undefined,
      viewAgentConversation: async () => undefined,
      getCtx: () => undefined,
    });
    expect(custom).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
  });

  it("ignores corrupt, oversized, symlinked, and foreign-root entries and retains only the newest valid own-root entries", () => {
    const root = project();
    const foreign = project();
    const foreignSnapshot = writeWorkflowHistorySnapshot(terminalTask(foreign, "wf_foreign1", "completed"), foreign)!;
    const dir = join(root, ".pi-subagents", "workflow-history", "v1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "wf_corrupt1.json"), "not json\n");
    writeFileSync(join(dir, "wf_oversize.json"), "x".repeat(WORKFLOW_HISTORY_MAX_BYTES + 1));
    writeFileSync(join(dir, "wf_foreign1.json"), JSON.stringify(foreignSnapshot));
    symlinkSync(join(foreign, ".pi-subagents", "workflow-history", "v1", "wf_foreign1.json"), join(dir, "wf_symlink1.json"));

    for (let index = 0; index < 102; index++) {
      writeWorkflowHistorySnapshot(terminalTask(root, `wf_valid${String(index).padStart(4, "0")}`, "completed", index + 11), root);
    }

    const loaded = loadWorkflowHistorySnapshots(root);
    expect(loaded).toHaveLength(100);
    expect(loaded.some(snapshot => snapshot.workflowId === "wf_valid0000")).toBe(false);
    expect(loaded.some(snapshot => snapshot.workflowId === "wf_valid0001")).toBe(false);
    expect(existsSync(join(dir, "wf_corrupt1.json"))).toBe(true);
    expect(existsSync(join(dir, "wf_oversize.json"))).toBe(true);
    expect(existsSync(join(dir, "wf_foreign1.json"))).toBe(true);
    expect(existsSync(join(dir, "wf_symlink1.json"))).toBe(true);
    expect(loadWorkflowHistorySnapshots(foreign).map(item => item.workflowId)).toEqual(["wf_foreign1"]);
  });
});
