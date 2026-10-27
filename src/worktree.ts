/**
 * worktree.ts — Git worktree isolation for agents.
 *
 * Creates a temporary git worktree so the agent works on an isolated copy of the repo.
 * On completion, if no changes were made, the worktree is cleaned up.
 * If changes exist, a branch is created and returned in the result.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface WorktreeInfo {
  /** Absolute path to the worktree directory (the copied repo's root). */
  path: string;
  /** Branch name created for this worktree (if changes exist). */
  branch: string;
  /** Commit SHA that the worktree was created from. */
  baseSha: string;
  /** Canonical repository root that owns this worktree. */
  repoRoot: string;
  /** Caller cwd relative to repoRoot, using POSIX separators. */
  originalTargetSubdirectory: string;
  /**
   * Where the agent should work inside the worktree: the equivalent of the
   * cwd the worktree was created from. Equals `path` when that cwd was the
   * repo root; points at the copied subdirectory when it was deeper (e.g. a
   * monorepo package), so the requested scoping survives isolation.
   */
  workPath: string;
}

export interface WorktreeCleanupResult {
  /** Whether changes were found in the worktree. */
  hasChanges: boolean;
  /** Branch name if changes were committed. */
  branch?: string;
  /** Full commit SHA preserved for later reconstruction. */
  savedCommitSha?: string;
  /** Worktree path if it was kept. */
  path?: string;
}

export type WorktreeErrorCode = "resume-worktree-missing-cwd" | "resume-worktree-invalid-ref";

export class WorktreeError extends Error {
  constructor(public readonly code: WorktreeErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "WorktreeError";
  }
}

function fail(code: WorktreeErrorCode, message: string): never {
  throw new WorktreeError(code, message);
}

function isFullCommitSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function gitOutput(cwd: string, args: string[], timeout = 10_000): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", timeout }).toString().trim();
}

export function verifyCommitSha(repoRoot: string, value: unknown): string {
  if (!isFullCommitSha(value)) fail("resume-worktree-invalid-ref", "worktree commit must be a full 40-character SHA");
  try {
    if (gitOutput(repoRoot, ["cat-file", "-t", value], 5_000) !== "commit") {
      fail("resume-worktree-invalid-ref", "worktree ref is not a commit object");
    }
    const resolved = gitOutput(repoRoot, ["rev-parse", "--verify", `${value}^{commit}`], 5_000);
    if (!isFullCommitSha(resolved)) fail("resume-worktree-invalid-ref", "worktree ref did not resolve to a full commit SHA");
    return resolved;
  } catch (error) {
    if (error instanceof WorktreeError) throw error;
    fail("resume-worktree-invalid-ref", "worktree commit is unavailable");
  }
}

export function getCanonicalRepoRoot(cwd: string, code: WorktreeErrorCode, requireRoot = false): string {
  if (typeof cwd !== "string" || !cwd || cwd.includes("\0") || !isAbsolute(cwd)) {
    fail(code, "repository cwd must be an absolute path");
  }
  let requestedCwd: string;
  let repoRoot: string;
  try {
    requestedCwd = realpathSync(cwd);
    if (!statSync(requestedCwd).isDirectory()) fail(code, "repository cwd is not a directory");
    repoRoot = realpathSync(gitOutput(cwd, ["rev-parse", "--show-toplevel"], 5_000));
  } catch (error) {
    if (error instanceof WorktreeError) throw error;
    fail(code, "repository root is unavailable");
  }
  const target = relative(repoRoot, requestedCwd);
  if (target.startsWith(`..${sep}`) || target === ".." || isAbsolute(target)) {
    fail(code, "requested cwd escaped the repository root");
  }
  if (requireRoot && requestedCwd !== repoRoot) {
    fail(code, "saved repository root is not the canonical repository root");
  }
  return repoRoot;
}

function targetSubdirectory(repoRoot: string, cwd: string): string {
  const requestedCwd = realpathSync(cwd);
  const relativeTarget = relative(repoRoot, requestedCwd);
  if (relativeTarget.startsWith(`..${sep}`) || relativeTarget === ".." || isAbsolute(relativeTarget)) {
    fail("resume-worktree-missing-cwd", "requested cwd escaped the repository root");
  }
  return relativeTarget.split(sep).join("/");
}

export function validateWorktreeTargetPath(repoRoot: string, target: string): string {
  if (typeof target !== "string"
    || target.includes("\\")
    || target.includes("\0")
    || target.includes("\r")
    || target.includes("\n")
    || isAbsolute(target)) {
    fail("resume-worktree-missing-cwd", "original target subdirectory is invalid");
  }
  if (target.length > 0 && target.split("/").some(segment => !segment || segment === "." || segment === "..")) {
    fail("resume-worktree-missing-cwd", "original target subdirectory is invalid");
  }
  const lexicalTarget = resolve(repoRoot, target);
  const lexicalRelative = relative(repoRoot, lexicalTarget);
  if (lexicalRelative.startsWith(`..${sep}`) || lexicalRelative === ".." || isAbsolute(lexicalRelative)) {
    fail("resume-worktree-missing-cwd", "original target subdirectory escaped the repository root");
  }
  return lexicalTarget;
}

export function validateWorktreeTarget(repoRoot: string, target: string): string {
  const lexicalTarget = validateWorktreeTargetPath(repoRoot, target);
  let realTarget: string;
  try {
    realTarget = realpathSync(lexicalTarget);
    if (!statSync(realTarget).isDirectory()) fail("resume-worktree-missing-cwd", "original target is not a directory");
  } catch (error) {
    if (error instanceof WorktreeError) throw error;
    fail("resume-worktree-missing-cwd", "original target subdirectory does not exist");
  }
  const realRelative = relative(repoRoot, realTarget);
  if (realRelative.startsWith(`..${sep}`) || realRelative === ".." || isAbsolute(realRelative)) {
    fail("resume-worktree-missing-cwd", "original target subdirectory escaped the repository root");
  }
  return realTarget;
}

function worktreeTarget(worktreePath: string, target: string): string {
  return target ? join(worktreePath, target.split("/").join(sep)) : worktreePath;
}

/**
 * Create a temporary git worktree for an agent.
 * Returns the worktree path, or undefined if not in a git repo.
 */
export function createWorktree(cwd: string, agentId: string): WorktreeInfo | undefined {
  try {
    const repoRoot = getCanonicalRepoRoot(cwd, "resume-worktree-missing-cwd");
    const baseSha = verifyCommitSha(repoRoot, gitOutput(cwd, ["rev-parse", "HEAD"], 5_000));
    const originalTargetSubdirectory = targetSubdirectory(repoRoot, cwd);
    validateWorktreeTarget(repoRoot, originalTargetSubdirectory);
    const branch = `pi-agent-${agentId}`;
    const suffix = randomUUID().slice(0, 8);
    const worktreePath = join(tmpdir(), `pi-agent-${agentId}-${suffix}`);

    try {
      execFileSync("git", ["worktree", "add", "--detach", worktreePath, baseSha], {
        cwd: repoRoot,
        stdio: "pipe",
        timeout: 30_000,
      });
    } catch {
      removeWorktree(repoRoot, worktreePath);
      return undefined;
    }

    return {
      path: worktreePath,
      branch,
      baseSha,
      repoRoot,
      originalTargetSubdirectory,
      workPath: worktreeTarget(worktreePath, originalTargetSubdirectory),
    };
  } catch {
    return undefined;
  }
}

/**
 * Clean up a worktree after agent completion.
 * - If no changes: remove worktree entirely.
 * - If changes exist: create a branch, commit changes, return branch and SHA.
 */
export function cleanupWorktree(
  cwd: string,
  worktree: WorktreeInfo,
  agentDescription: string,
): WorktreeCleanupResult {
  if (!existsSync(worktree.path)) {
    return { hasChanges: false };
  }

  try {
    const status = gitOutput(worktree.path, ["status", "--porcelain"]);
    if (status) {
      execFileSync("git", ["add", "-A"], { cwd: worktree.path, stdio: "pipe", timeout: 10_000 });
      const safeDesc = agentDescription.slice(0, 200);
      execFileSync("git", ["commit", "--no-verify", "-m", `pi-agent: ${safeDesc}`], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 10_000,
      });
    }

    const currentSha = verifyCommitSha(worktree.repoRoot, gitOutput(worktree.path, ["rev-parse", "HEAD"], 5_000));
    if (currentSha === worktree.baseSha) {
      removeWorktree(worktree.repoRoot, worktree.path);
      return { hasChanges: false };
    }

    let branchName = worktree.branch;
    try {
      execFileSync("git", ["branch", branchName], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 5_000,
      });
    } catch {
      branchName = `${worktree.branch}-${Date.now()}`;
      execFileSync("git", ["branch", branchName], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 5_000,
      });
    }
    worktree.branch = branchName;
    removeWorktree(worktree.repoRoot, worktree.path);

    return {
      hasChanges: true,
      branch: worktree.branch,
      savedCommitSha: currentSha,
      path: worktree.path,
    };
  } catch {
    try { removeWorktree(worktree.repoRoot || cwd, worktree.path); } catch { /* ignore */ }
    return { hasChanges: false };
  }
}

/**
 * Low-level detached worktree primitive. The caller owns resume policy and
 * must validate the repository, source SHA, and target subdirectory first.
 */
export function createDetachedWorktree(
  repoRoot: string,
  sourceSha: string,
  originalTargetSubdirectory: string,
  agentId: string,
): WorktreeInfo {
  const verifiedSourceSha = verifyCommitSha(repoRoot, sourceSha);
  validateWorktreeTargetPath(repoRoot, originalTargetSubdirectory);
  const suffix = randomUUID().slice(0, 8);
  const worktreePath = join(tmpdir(), `pi-agent-${agentId}-${suffix}`);
  try {
    execFileSync("git", ["worktree", "add", "--detach", worktreePath, verifiedSourceSha], {
      cwd: repoRoot,
      stdio: "pipe",
      timeout: 30_000,
    });
  } catch {
    removeWorktree(repoRoot, worktreePath);
    fail("resume-worktree-invalid-ref", "fresh detached worktree creation failed");
  }
  const worktree: WorktreeInfo = {
    path: worktreePath,
    branch: `pi-agent-${agentId}`,
    baseSha: verifiedSourceSha,
    repoRoot,
    originalTargetSubdirectory,
    workPath: worktreeTarget(worktreePath, originalTargetSubdirectory),
  };
  try {
    const executionCwd = realpathSync(worktree.workPath);
    if (!statSync(executionCwd).isDirectory()) fail("resume-worktree-missing-cwd", "fresh execution cwd is not a directory");
    const executionRelative = relative(realpathSync(worktree.path), executionCwd);
    if (executionRelative.startsWith(`..${sep}`) || executionRelative === ".." || isAbsolute(executionRelative)) {
      fail("resume-worktree-missing-cwd", "fresh execution cwd escaped the worktree");
    }
  } catch (error) {
    removeWorktree(repoRoot, worktreePath);
    if (error instanceof WorktreeError) throw error;
    fail("resume-worktree-missing-cwd", "fresh execution cwd is unavailable");
  }
  return worktree;
}

/** Idempotently remove a worktree path and prune stale registrations. */
export function removeWorktree(cwd: string, worktree: WorktreeInfo | string): void {
  const worktreePath = typeof worktree === "string" ? worktree : worktree.path;
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd,
      stdio: "pipe",
      timeout: 10_000,
    });
  } catch {
    try {
      execFileSync("git", ["worktree", "prune"], { cwd, stdio: "pipe", timeout: 5_000 });
    } catch { /* ignore */ }
  }
}

/** Prune any orphaned worktrees (crash recovery). */
export function pruneWorktrees(cwd: string): void {
  try {
    execFileSync("git", ["worktree", "prune"], { cwd, stdio: "pipe", timeout: 5_000 });
  } catch { /* ignore */ }
}
