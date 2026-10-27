import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalArtifactRootCwd,
  ensurePrivateSessionDirectory,
  preflightPrivateSession,
  privateSessionDirectory,
  privateSessionLocator,
  resolvePrivateSessionLocator,
} from "../src/agent-session-storage.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeProject(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-agent-session-storage-"));
  directories.push(directory);
  return directory;
}

function makeSession(root: string, id = "session-1"): { directory: string; file: string; locator: string } {
  const directory = ensurePrivateSessionDirectory(root);
  const file = join(directory, `${id}.jsonl`);
  writeFileSync(file, `${JSON.stringify({
    type: "session",
    id,
    version: CURRENT_SESSION_VERSION,
    timestamp: new Date(0).toISOString(),
    cwd: root,
  })}\n`);
  return {
    directory,
    file,
    locator: `.pi-subagents/agent-sessions/${id}.jsonl`,
  };
}

describe("private native session storage boundary", () => {
  it("accepts exactly one direct safe private .jsonl basename", () => {
    const root = makeProject();
    const session = makeSession(root);

    expect(resolvePrivateSessionLocator(root, session.locator)).toEqual({
      locator: session.locator,
      file: session.file,
    });
    expect(privateSessionLocator(root, session.file)).toBe(session.locator);
    expect(privateSessionDirectory(root)).toBe(session.directory);
    expect(canonicalArtifactRootCwd(root)).toBe(root);
  });

  it.each([
    "/tmp/session.jsonl",
    ".pi-subagents/agent-sessions/../agent-transcripts/x.jsonl",
    ".pi-subagents/agent-sessions/nested/x.jsonl",
    ".pi-subagents\\agent-sessions\\x.jsonl",
    ".pi-subagents/agent-sessions/x\0.jsonl",
    ".pi-subagents/agent-sessions//x.jsonl",
    ".pi-subagents/agent-transcripts/x.jsonl",
    ".pi-subagents/agent-sessions/.jsonl",
    ".pi-subagents/agent-sessions/x.y.jsonl",
  ])("rejects unsafe locator %s", (locator) => {
    const root = makeProject();
    expect(() => resolvePrivateSessionLocator(root, locator)).toThrowError(
      expect.objectContaining({ code: "resume-session-locator-invalid" }),
    );
  });

  it("rejects a missing private session file with a stable error", () => {
    const root = makeProject();
    ensurePrivateSessionDirectory(root);

    expect(() => resolvePrivateSessionLocator(
      root,
      ".pi-subagents/agent-sessions/missing.jsonl",
    )).toThrowError(expect.objectContaining({ code: "resume-session-missing" }));
  });

  it.each([
    ["directory", (file: string) => mkdirSync(file)],
    ["symlink", (file: string) => symlinkSync(join(tmpdir(), "outside.jsonl"), file)],
  ] as const)("rejects a non-regular or symlink session file (%s)", (_label, create) => {
    const root = makeProject();
    const session = makeSession(root);
    rmSync(session.file, { force: true });
    if (_label === "symlink") writeFileSync(join(tmpdir(), "outside.jsonl"), "{}\n");
    create(session.file);

    expect(() => resolvePrivateSessionLocator(root, session.locator)).toThrowError(
      expect.objectContaining({ code: "resume-session-locator-invalid" }),
    );
  });

  it("rejects a symlinked private namespace", () => {
    const root = makeProject();
    const subagents = join(root, ".pi-subagents");
    const outside = mkdtempSync(join(tmpdir(), "pi-agent-session-outside-"));
    directories.push(outside);
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, subagents);

    expect(() => ensurePrivateSessionDirectory(root)).toThrowError(
      expect.objectContaining({ code: "resume-session-locator-invalid" }),
    );
  });

  it("rejects a regular file whose real path escapes the private namespace", () => {
    const root = makeProject();
    const session = makeSession(root);
    const outside = join(root, "outside.jsonl");
    rmSync(session.file);
    writeFileSync(outside, '{"type":"session","id":"session-1","version":1}\n');
    symlinkSync(outside, session.file);

    expect(() => resolvePrivateSessionLocator(root, session.locator)).toThrowError(
      expect.objectContaining({ code: "resume-session-locator-invalid" }),
    );
  });

  it("preflights every nonempty JSONL line and the expected native header", () => {
    const root = makeProject();
    const session = makeSession(root);
    writeFileSync(session.file, [
      JSON.stringify({
        type: "session",
        id: "session-1",
        version: CURRENT_SESSION_VERSION,
        timestamp: new Date(0).toISOString(),
        cwd: root,
      }),
      JSON.stringify({ type: "message", id: "message-1" }),
      "",
    ].join("\n"));

    expect(preflightPrivateSession(root, session.locator, "session-1")).toMatchObject({
      locator: session.locator,
      file: session.file,
      header: { type: "session", id: "session-1", version: CURRENT_SESSION_VERSION },
    });
  });

  it("accepts a legacy header with its optional version omitted", () => {
    const root = makeProject();
    const session = makeSession(root);
    writeFileSync(session.file, `${JSON.stringify({
      type: "session",
      id: "session-1",
      timestamp: new Date(0).toISOString(),
      cwd: root,
    })}\n`);

    expect(preflightPrivateSession(root, session.locator, "session-1").header.version).toBeUndefined();
  });

  it("accepts the actual native file produced by SessionManager.create", () => {
    const root = makeProject();
    const directory = ensurePrivateSessionDirectory(root);
    const native = SessionManager.create(root, directory);
    native.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });

    const file = native.getSessionFile();
    expect(file).toBeDefined();
    const locator = privateSessionLocator(root, file!);
    const header = native.getHeader();
    expect(header?.version).toBe(CURRENT_SESSION_VERSION);

    expect(preflightPrivateSession(root, locator, native.getSessionId())).toMatchObject({
      file,
      locator,
      header: { type: "session", id: native.getSessionId(), version: CURRENT_SESSION_VERSION, cwd: root },
    });
  });

  it("reports malformed JSON as corrupt and an invalid header as incompatible", () => {
    const root = makeProject();
    const session = makeSession(root);

    writeFileSync(session.file, `${JSON.stringify({
      type: "session",
      id: "session-1",
      version: CURRENT_SESSION_VERSION,
      timestamp: new Date(0).toISOString(),
      cwd: root,
    })}\nnot json\n`);
    expect(() => preflightPrivateSession(root, session.locator, "session-1")).toThrowError(
      expect.objectContaining({ code: "resume-session-corrupt" }),
    );

    writeFileSync(session.file, `${JSON.stringify({
      type: "message",
      id: "session-1",
      version: CURRENT_SESSION_VERSION,
      timestamp: new Date(0).toISOString(),
      cwd: root,
    })}\n`);
    expect(() => preflightPrivateSession(root, session.locator, "session-1")).toThrowError(
      expect.objectContaining({ code: "resume-session-incompatible" }),
    );
  });

  it("rejects unsupported headers and mismatched session ids", () => {
    const root = makeProject();
    const session = makeSession(root);

    writeFileSync(session.file, `${JSON.stringify({
      type: "session",
      id: "session-1",
      version: CURRENT_SESSION_VERSION + 1,
      timestamp: new Date(0).toISOString(),
      cwd: root,
    })}\n`);
    expect(() => preflightPrivateSession(root, session.locator, "session-1")).toThrowError(
      expect.objectContaining({ code: "resume-session-incompatible" }),
    );

    writeFileSync(session.file, `${JSON.stringify({
      type: "session",
      id: "other",
      version: CURRENT_SESSION_VERSION,
      timestamp: new Date(0).toISOString(),
      cwd: root,
    })}\n`);
    expect(() => preflightPrivateSession(root, session.locator, "session-1")).toThrowError(
      expect.objectContaining({ code: "resume-session-incompatible" }),
    );
  });

  it("validates the creation boundary after a native session file is returned", () => {
    const root = makeProject();
    const directory = ensurePrivateSessionDirectory(root);
    const file = join(directory, "created.jsonl");
    writeFileSync(file, `${JSON.stringify({
      type: "session",
      id: "created",
      version: CURRENT_SESSION_VERSION,
      timestamp: new Date(0).toISOString(),
      cwd: root,
    })}\n`);

    expect(existsSync(file)).toBe(true);
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    expect(privateSessionLocator(root, file)).toBe(".pi-subagents/agent-sessions/created.jsonl");
    expect(dirname(file)).toBe(directory);
  });

  it("keeps a real private session out of Pi listings while allowing explicit reopen", async () => {
    const root = makeProject();
    const directory = ensurePrivateSessionDirectory(root);
    const privateManager = SessionManager.create(root, directory);
    privateManager.appendMessage({ role: "user", content: "private prompt", timestamp: Date.now() });

    const file = privateManager.getSessionFile();
    expect(file).toBeDefined();
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent-dir");
    try {
      const ordinary = await SessionManager.list(root);
      const all = await SessionManager.listAll();
      expect(ordinary.some(session => session.path === file)).toBe(false);
      expect(all.some(session => session.path === file)).toBe(false);
    } finally {
      if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }

    const reopened = SessionManager.open(file!, directory, root);
    expect(reopened.getSessionId()).toBe(privateManager.getSessionId());
    expect(reopened.getHeader()?.parentSession).toBeUndefined();
    expect(reopened.buildSessionProjection().messages).toHaveLength(1);
  }, 30_000);
});
