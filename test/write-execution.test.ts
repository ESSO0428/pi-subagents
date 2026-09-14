import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeWriteWithMetadata,
  MAX_DURABLE_DIFF_BYTES,
  WriteExecutionMetadataStore,
} from "../src/write-execution.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagents-write-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("executeWriteWithMetadata", () => {
  it("writes a new file and returns a durable display diff and patch", async () => {
    const cwd = await tempDir();
    const store = new WriteExecutionMetadataStore();
    const result = await executeWriteWithMetadata(store, "call-new", {
      path: "nested/file.txt",
      content: "new\n",
    }, undefined, cwd);

    expect(await readFile(join(cwd, "nested/file.txt"), "utf8")).toBe("new\n");
    expect(result.content[0]?.text).toContain("Successfully wrote to nested/file.txt");
    expect(result.details?.diff).toContain("+1 new");
    expect(result.details?.patch).toContain("+new");
    expect(store.get("call-new")?.diff).toBe(result.details?.diff);
  });

  it("returns durable details that remain independent of later file changes", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "file.txt"), "old\n", "utf8");
    const store = new WriteExecutionMetadataStore();
    const result = await executeWriteWithMetadata(store, "call-existing", {
      path: "file.txt",
      content: "new\n",
    }, undefined, cwd);
    const persisted = { ...result.details };

    await writeFile(join(cwd, "file.txt"), "later\n", "utf8");

    expect(persisted.diff).toContain("-1 old");
    expect(persisted.diff).toContain("+1 new");
    expect(persisted.patch).toContain("-old");
    expect(persisted.patch).toContain("+new");
    expect(persisted).not.toHaveProperty("previousContent");
  });

  it("writes successfully but marks an oversized durable diff unavailable", async () => {
    const cwd = await tempDir();
    const store = new WriteExecutionMetadataStore();
    const content = "x".repeat(MAX_DURABLE_DIFF_BYTES + 1);
    const result = await executeWriteWithMetadata(store, "call-large", {
      path: "large.txt",
      content,
    }, undefined, cwd);

    expect((await readFile(join(cwd, "large.txt"), "utf8")).length).toBe(content.length);
    expect(result.details?.diffUnavailableReason).toContain("durable diff exceeds");
    expect(result.details).not.toHaveProperty("diff");
    expect(store.get("call-large")?.previousContent).toBe("");
  });

  it("does not fabricate metadata when the write fails", async () => {
    const cwd = await tempDir();
    const store = new WriteExecutionMetadataStore();

    await expect(executeWriteWithMetadata(store, "call-fail", {
      path: "/dev/null/pi-subagents-impossible/file.txt",
      content: "nope",
    }, undefined, cwd)).rejects.toBeTruthy();
    expect(store.get("call-fail")).toBeUndefined();
  });
});
