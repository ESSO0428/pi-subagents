import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensurePrivateSessionDirectory,
  preflightPrivateSession,
  privateSessionLocator,
} from "../src/agent-session-storage.js";

const projects: string[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) rmSync(project, { recursive: true, force: true });
});

describe("private native session visibility contract", () => {
  it("keeps private sessions separate from normal project and global listings", async () => {
    const projectCwd = mkdtempSync(join(tmpdir(), "pi-private-session-contract-"));
    projects.push(projectCwd);
    const privateDir = ensurePrivateSessionDirectory(projectCwd);
    mkdirSync(privateDir, { recursive: true });

    const privateSession = SessionManager.create(projectCwd, privateDir);
    privateSession.appendMessage({
      role: "user",
      content: "private contract probe",
      timestamp: Date.now(),
    });
    const privateFile = privateSession.getSessionFile();
    const privateId = privateSession.getSessionId();
    expect(privateFile).toBeDefined();
    expect(privateFile!.startsWith(privateDir)).toBe(true);
    expect(privateFile).not.toContain(join(projectCwd, ".pi", "sessions"));
    expect(privateSession.getHeader()?.parentSession).toBeUndefined();

    const locator = privateSessionLocator(projectCwd, privateFile!);
    expect(preflightPrivateSession(projectCwd, locator, privateId)).toMatchObject({
      file: privateFile,
      locator,
      header: { id: privateId, cwd: projectCwd },
    });

    const privateListing = await SessionManager.list(projectCwd, privateDir);
    expect(privateListing.some(session => session.id === privateId || session.path === privateFile)).toBe(true);

    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(projectCwd, "agent-dir");
    try {
      const projectListing = await SessionManager.list(projectCwd);
      expect(projectListing.some(session => session.id === privateId || session.path === privateFile)).toBe(false);
      expect(projectListing.map(session => session.path)).not.toContain(privateFile);

      const globalListing = await SessionManager.listAll();
      expect(globalListing.some(session => session.id === privateId || session.path === privateFile)).toBe(false);
    } finally {
      if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
  }, 30_000);
});
