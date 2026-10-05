import { createReadStream, readdirSync } from "node:fs";
import { join } from "node:path";
import { encodeCwd } from "./output-file.js";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentInvocation, AgentRecord } from "./types.js";

/**
 * Reads `subagents:record` entries out of session files.
 *
 * Older builds appended one such entry per finished agent to the parent session
 * branch. Durable checkpoints superseded that: they survive reboot, carry the
 * owning session, and do not bloat the session file. This reader exists purely
 * so history written before that change stays reachable from `/agents`; nothing
 * writes these entries any more.
 *
 * Session files can be very large, so each is streamed line by line and only
 * lines mentioning the entry type are parsed.
 */

const RECORD_MARKER = '"subagents:record"';
const SESSION_EXTENSION = ".jsonl";

/** `<timestamp>_<sessionId>.jsonl` — the sessionId is the part after the first underscore. */
function sessionIdFromFile(name: string): string | undefined {
  if (!name.endsWith(SESSION_EXTENSION)) return undefined;
  const base = name.slice(0, -SESSION_EXTENSION.length);
  const separator = base.indexOf("_");
  if (separator < 0) return undefined;
  const id = base.slice(separator + 1);
  return /^[0-9a-f-]{8,}$/i.test(id) ? id : undefined;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || entry.id.length === 0) return false;
  return typeof entry.type === "string" && typeof entry.description === "string";
}

function toRecord(entry: Record<string, unknown>, sessionId: string): AgentRecord {
  const startedAt = typeof entry.startedAt === "number" ? entry.startedAt : 0;
  const transcriptPath = typeof entry.transcriptPath === "string" ? entry.transcriptPath : undefined;
  return {
    id: entry.id as string,
    type: entry.type as string,
    description: entry.description as string,
    status: (typeof entry.status === "string" ? entry.status : "completed") as AgentRecord["status"],
    startedAt,
    completedAt: typeof entry.completedAt === "number" ? entry.completedAt : startedAt,
    result: typeof entry.result === "string" ? entry.result : undefined,
    error: typeof entry.error === "string" ? entry.error : undefined,
    toolUses: typeof entry.toolUses === "number" ? entry.toolUses : 0,
    compactionCount: 0,
    lifetimeUsage: (entry.lifetimeUsage as AgentRecord["lifetimeUsage"]) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    invocation: entry.invocation as AgentInvocation | undefined,
    transcriptPath,
    historyFile: transcriptPath,
    sessionId,
  };
}

/** Yield the parsed JSON value of each line that carries the marker. */
async function* matchingLines(path: string): AsyncGenerator<unknown> {
  const stream = createReadStream(path, { encoding: "utf-8" });
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.includes(RECORD_MARKER)) {
        try {
          yield JSON.parse(line);
        } catch { /* a malformed line must not hide the rest of the session */ }
      }
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.includes(RECORD_MARKER)) {
    try {
      yield JSON.parse(buffer);
    } catch { /* ignore trailing partial line */ }
  }
}

function collectEntries(parsed: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(parsed)) {
    for (const item of parsed) collectEntries(item, out);
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const node = parsed as Record<string, unknown>;
  if (node.customType === "subagents:record" && isRecordLike(node.data)) {
    out.push(node.data);
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") collectEntries(value, out);
  }
}

/**
 * Agent records this extension wrote into session files before durable
 * checkpoints. Sessions whose directory does not exist simply contribute none.
 */
export async function readLegacySessionRecords(cwd: string, agentDir: string = getAgentDir()): Promise<AgentRecord[]> {
  const directory = join(agentDir, "sessions");
  let files: string[];
  try {
    files = readdirSync(directory).filter((name) => name.endsWith(SESSION_EXTENSION));
  } catch {
    return [];
  }

  const records: AgentRecord[] = [];
  const seen = new Set<string>();
  void files;

  // pi scopes sessions by project: <sessions>/--<encoded-cwd>--/<file>. Without
  // this filter every project's agents would show up in every other project.
  const projectDir = `--${encodeCwd(cwd)}--`;
  const entriesIn: string[] = [];
  try {
    for (const name of readdirSync(directory, { withFileTypes: true })) {
      if (name.isDirectory() && name.name === projectDir) entriesIn.push(name.name);
    }
  } catch {
    return [];
  }
  if (entriesIn.length === 0) return records;

  // Session files live one directory deeper: <sessions>/<encoded-cwd>/<file>.
  for (const name of entriesIn.map((entryName) => ({ isDirectory: () => true, name: entryName }))) {
    let sessionFiles: string[];
    try {
      sessionFiles = readdirSync(join(directory, name.name));
    } catch {
      continue;
    }
    for (const sessionFile of sessionFiles) {
      const sessionId = sessionIdFromFile(sessionFile);
      if (!sessionId) continue;
      const entries: Record<string, unknown>[] = [];
      try {
        for await (const parsed of matchingLines(join(directory, name.name, sessionFile))) {
          collectEntries(parsed, entries);
        }
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (seen.has(entry.id as string)) continue;
        seen.add(entry.id as string);
        records.push(toRecord(entry, sessionId));
      }
    }
  }
  return records;
}