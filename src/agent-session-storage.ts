/** Private native-session storage and reopen validation. */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "@earendil-works/pi-coding-agent";

export const PRIVATE_SESSION_RELATIVE_DIR = ".pi-subagents/agent-sessions";

export type ResumeStorageErrorCode =
  | "resume-session-locator-invalid"
  | "resume-session-missing"
  | "resume-session-corrupt"
  | "resume-session-incompatible";

export class ResumeStorageError extends Error {
  constructor(public readonly code: ResumeStorageErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ResumeStorageError";
  }
}

export type NativeSessionHeader = SessionHeader;

export interface PrivateSessionLocatorResolution {
  locator: string;
  file: string;
}

export interface PrivateSessionPreflight extends PrivateSessionLocatorResolution {
  header: NativeSessionHeader;
}

function fail(code: ResumeStorageErrorCode, message: string): never {
  throw new ResumeStorageError(code, message);
}

function assertSafeRoot(root: string): string {
  if (typeof root !== "string" || !root || root.includes("\0") || !isAbsolute(root)) {
    return fail("resume-session-locator-invalid", "artifact root must be an absolute path");
  }
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

/** Canonicalize the stable project root used by private storage. */
export function canonicalArtifactRootCwd(callerCwd: string): string {
  return assertSafeRoot(callerCwd);
}

/** Compare persisted and current project roots without exposing path errors to UI filters. */
export function sameArtifactRootCwd(
  persistedRoot: string | undefined,
  currentRoot: string | undefined,
): boolean {
  if (persistedRoot === undefined || currentRoot === undefined) return true;
  try {
    return canonicalArtifactRootCwd(persistedRoot) === canonicalArtifactRootCwd(currentRoot);
  } catch {
    return false;
  }
}

/** Return the private native-session namespace below an artifact root. */
export function privateSessionDirectory(artifactRootCwd: string): string {
  return join(assertSafeRoot(artifactRootCwd), PRIVATE_SESSION_RELATIVE_DIR);
}

function assertDirectory(path: string, label: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    fail("resume-session-locator-invalid", `${label} is missing`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail("resume-session-locator-invalid", `${label} must be a non-symlink directory`);
  }
}

function validateNamespace(root: string): string {
  const canonicalRoot = assertSafeRoot(root);
  assertDirectory(canonicalRoot, "artifact root");
  const subagentsDirectory = join(canonicalRoot, ".pi-subagents");
  const directory = join(canonicalRoot, PRIVATE_SESSION_RELATIVE_DIR);
  assertDirectory(subagentsDirectory, ".pi-subagents");
  assertDirectory(directory, "private session namespace");
  try {
    const namespaceRealpath = realpathSync(directory);
    if (namespaceRealpath !== directory) {
      return fail("resume-session-locator-invalid", "private session namespace escaped its lexical path");
    }
    return namespaceRealpath;
  } catch {
    return fail("resume-session-missing", "private session namespace is unavailable");
  }
}

/** Create the private namespace without following a symlinked directory. */
export function ensurePrivateSessionDirectory(artifactRootCwd: string): string {
  const root = assertSafeRoot(artifactRootCwd);
  assertDirectory(root, "artifact root");
  const subagentsDirectory = join(root, ".pi-subagents");
  const directory = join(root, PRIVATE_SESSION_RELATIVE_DIR);

  for (const [path, label] of [
    [subagentsDirectory, ".pi-subagents"],
    [directory, "private session namespace"],
  ] as const) {
    if (existsSync(path)) {
      assertDirectory(path, label);
      continue;
    }
    try {
      mkdirSync(path);
    } catch {
      return fail("resume-session-locator-invalid", `could not create ${label}`);
    }
    assertDirectory(path, label);
  }

  return validateNamespace(root);
}

function validateLocatorLexically(locator: string): string {
  if (typeof locator !== "string" || !locator || isAbsolute(locator) || locator.includes("\\") || locator.includes("\0")) {
    return fail("resume-session-locator-invalid", "locator must be a relative POSIX path");
  }
  const segments = locator.split("/");
  if (segments.length !== 3
    || segments[0] !== ".pi-subagents"
    || segments[1] !== "agent-sessions"
    || !/^[A-Za-z0-9_-]+\.jsonl$/.test(segments[2] ?? "")) {
    return fail("resume-session-locator-invalid", "locator must name one direct private .jsonl child");
  }
  return segments[2]!;
}

function validatePrivateFile(root: string, locator: string): PrivateSessionLocatorResolution {
  const basename = validateLocatorLexically(locator);
  const namespace = validateNamespace(root);
  const file = join(namespace, basename);

  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(file);
  } catch {
    fail("resume-session-missing", `private session file is missing: ${locator}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail("resume-session-locator-invalid", "private session file must be a non-symlink regular file");
  }

  let fileRealpath: string;
  try {
    fileRealpath = realpathSync(file);
  } catch {
    return fail("resume-session-missing", `private session file is unavailable: ${locator}`);
  }
  if (fileRealpath === namespace || !fileRealpath.startsWith(`${namespace}${sep}`)) {
    return fail("resume-session-locator-invalid", "private session file escaped its namespace");
  }

  return { locator, file };
}

/**
 * Return the validated private locator for a native session file returned by Pi.
 * This is also the creation-boundary check: the file must already exist and be
 * a regular, non-symlink direct child of the private namespace.
 */
export function privateSessionLocator(artifactRootCwd: string, file: string): string {
  if (typeof file !== "string"
    || !file
    || !isAbsolute(file)
    || file.includes("\\")
    || file.includes("\0")
    || file.split(sep).includes("..")) {
    return fail("resume-session-locator-invalid", "native session file must be an absolute direct path");
  }
  const root = assertSafeRoot(artifactRootCwd);
  const namespace = validateNamespace(root);
  const filePath = resolve(file);
  const child = relative(namespace, filePath);
  if (!child || child.includes("..") || child.includes("\\") || child.includes(sep)) {
    return fail("resume-session-locator-invalid", "native session file must be one direct namespace child");
  }
  const locator = `${PRIVATE_SESSION_RELATIVE_DIR}/${child.split(sep).join("/")}`;
  return validatePrivateFile(root, locator).locator;
}

/** Resolve and validate a persisted private locator before SessionManager.open. */
export function resolvePrivateSessionLocator(
  artifactRootCwd: string,
  locator: string,
): PrivateSessionLocatorResolution {
  const root = assertSafeRoot(artifactRootCwd);
  return validatePrivateFile(root, locator);
}

function isSupportedSessionVersion(value: unknown): value is number | undefined {
  return value === undefined
    || (typeof value === "number"
      && Number.isInteger(value)
      && value > 0
      && value <= CURRENT_SESSION_VERSION);
}

function parseNativeSessionHeader(value: unknown): NativeSessionHeader | undefined {
  if (!value || typeof value !== "object") return undefined;
  const header = value as Record<string, unknown>;
  if (header.type !== "session"
    || !isSupportedSessionVersion(header.version)
    || typeof header.id !== "string"
    || !header.id
    || header.id.includes("\0")
    || typeof header.timestamp !== "string"
    || typeof header.cwd !== "string"
    || (header.parentSession !== undefined && typeof header.parentSession !== "string")) {
    return undefined;
  }
  return header as unknown as NativeSessionHeader;
}

/**
 * Validate native JSONL storage before handing it to SessionManager.open.
 * Pi's open helper is deliberately not the validator: it can create missing
 * files and skip malformed records.
 */
export function preflightPrivateSession(
  artifactRootCwd: string,
  locator: string,
  expectedSessionId: string,
): PrivateSessionPreflight {
  const resolved = resolvePrivateSessionLocator(artifactRootCwd, locator);
  let raw: string;
  try {
    raw = readFileSync(resolved.file, "utf8");
  } catch {
    return fail("resume-session-corrupt", "private session file could not be read");
  }

  const lines = raw.split(/\r?\n/);
  const firstLine = lines[0]?.trim();
  if (!firstLine) return fail("resume-session-incompatible", "private session header is missing");

  const parsed: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {
      return fail("resume-session-corrupt", "private session JSONL contains malformed JSON");
    }
  }

  const header = parseNativeSessionHeader(parsed[0]);
  if (!header) return fail("resume-session-incompatible", "private session header is unsupported");
  if (header.id !== expectedSessionId) {
    return fail("resume-session-incompatible", "private session id does not match its checkpoint");
  }
  return { ...resolved, header };
}

/** Alias for callers that prefer an explicit validation verb. */
export const validatePrivateSession = preflightPrivateSession;
