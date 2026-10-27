# Durable Executable Agent Resume 實作計畫

> [!NOTE]
> **For agentic workers:** `subagent-driven-development` and
> `executing-plans` are optional execution helpers. When resolving either
> skill, prefer the namespaced form (`superpowers:<skill-name>`) when
> available, then the bare `<skill-name>` form.
>
> This name-resolution order does not give those skills priority over the
> current agent or host framework's native execution/delegation capabilities.
> Choose the execution approach based on the implementation plan, user
> instructions, available capabilities, and the host framework's own
> routing/delegation policy. Do not automatically search for or install
> missing skills.
>
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓未明確指定 persistence 的 top-level/nested subagent 在 cleanup、`/reload`、session switch 或程序重啟後，以同一個原生 Pi session 安全地繼續下一個 turn；explicit `true` 只保留 Pi normal/custom `/resume`，explicit `false` 不可在 session 消失後由 Agent checkpoint resume。workflow child 只在原 `WorkflowHost` runtime mapping 尚存時可 rehydrate，跨 `/reload` workflow rebind 不在範圍內。

**Architecture:** 以 checkpoint v2 保存受驗證的 private native-session locator/sessionId、artifact/resource/original execution cwd、exact model/thinking、ownership、child runtime identity（depth/max depth/root session）與 canonical worktree commit capabilities。`AgentManager` 保留 lifecycle、既有 queue/bypass 行為、background counter、completion、checkpoint、TTL、authority 與 worktree ownership；`agent-runner.ts` 提供唯一的 child-session prepare/create/open helper，create 與 private reopen 共享同一套 loader、tools、extensions、prompt、model 與 nested runtime。

**Tech Stack:** TypeScript、Pi `@earendil-works/pi-coding-agent >=0.80.8`、Vitest、Biome、Node.js filesystem/path、git worktree。

## Global Constraints

- 遵循 `docs/superpowers/specs/2026-10-21-durable-executable-agent-resume.md`。
- Agent View transcript (`.pi-subagents/agent-transcripts`) 只供顯示，永遠不能被解析回原生 executable session，也不能被拼回 resume prompt。
- Automatic private executable session 不設定 `parentSession`；它不是 parent Pi session 的 child branch，普通 Pi `/resume` 不會掃描 `.pi-subagents/agent-sessions/`。
- 五種 cwd 語意固定為：`artifactRootCwd`（含 `.pi-subagents` 的穩定 storage root）、`resourceCwd`（resource/config discovery）、`originalExecutionCwd`（caller 初次要求的 execution cwd）、canonical `repoRoot`（git root）、fresh `executionCwd`（當前 turn 實際執行 cwd）。worktree checkpoint 另只保存 `originalTargetSubdirectory`，即 caller 原始要求 cwd 相對 repoRoot 的 POSIX-relative path（repo root 為 `""`）；不得把 temporary first-run path 當成 reconstruction input。普通非 worktree run 可讓 resource/original execution 值相同，但不可合併欄位；private storage 永遠在 artifactRootCwd，不在 temporary worktree。
- live `record.session` 存在時，private、explicit `true`、memory `false` 都使用目前 same-process `resumeAgent()`，不 open。session 消失後只有未設定的 automatic private 可由 Agent checkpoint reopen；explicit `true` 僅保留 Pi normal/custom `/resume`，memory `false` 不可 reopen。
- Pi peer lower bound 維持 `>=0.80.8`。使用 `SessionManager.open(file, privateDir, executionCwd)` 與 `createAgentSession({ cwd: executionCwd, sessionManager, resourceLoader, sessionStartEvent })`；不得在 `CreateAgentSessionOptions` 使用 `cwdOverride` 或 `parentSession`。
- `AgentManager` 是唯一 lifecycle/ownership authority；每個 `ResumeAuthority` variant 都帶 canonical caller `artifactRootCwd`，manager 先與 persisted root exact compare，再做任何 checkpoint/locator/worktree/model operation。manager 不負責 loader、prompt、tool scope、nested tool 建構或 model resolution，後者由 adapter 以 exact stored model 完成。caller 可 precheck，但 direct manager bypass 必須被 manager 拒絕；workflow 只做 runtime handle → manager id mapping。
- 新寫入一律 `version: 2`。session state 是 `pending | memory | explicit | private` union：v1 display-only；v2 pending/memory/explicit 在 session loss 後 non-executable；只有 private 帶 locator/sessionId/exact model/thinking 可 reopen；所有 v2 checkpoint 都完整保存並驗證 child `depth`、`maxSubagentDepth`、`rootSessionId` runtime identity；未知 future/corrupt fail closed。v2 private restore 不要求 transcript 存在。
- Private locator 只接受 `.pi-subagents/agent-sessions/<safe-basename>.jsonl` 單一 direct child，creation/reopen 都檢查 namespace/file symlink、regular file、realpath containment；open 前逐行 parse、檢查首行 supported header 與 `header.id === sessionId`。不得因 Pi `SessionManager.open()` 的 missing-path 建檔或 malformed-line skipping 而省略 validator。
- Resume branch 在 spawn/type/config/model resolution 之前分流。schema-required 的 `subagent_type`/`description` 只作輸入相容；只允許 prompt/resume/run_in_background/signal semantics。若 request 帶 `model`、thinking、max_turns、isolated、inherit_context、isolation、schedule，使用 stable `resume-invalid-options` 拒絕；exact model 用 `modelRegistry.find(provider, modelId)` + `hasConfiguredAuth()`，不 fallback。
- terminal record 到達 TTL 時，flush durable history/optional `.output`、同步 `AgentSession.dispose()`（不假設 `session_shutdown`）、清除 volatile handles，但保留 v2 private locator/sessionId、checkpoint、ownership、`transcriptPath`、`resultConsumed`/`toolCallId` 與 worktree state；private/explicit native session file 不由本功能刪除。
- Background resumed work 延續既有 bypass-queue 行為，只維護 counter/pool accounting；只有 top-level ownership 計入全域 pool；completion callback 每一 turn 恰好一次。
- Worktree checkpoint 保存 canonical repoRoot、baseCommitSha、latest savedCommitSha（若有）與 `originalTargetSubdirectory`；plain repo-root isolation 保存 `""`，caller-supplied cwd 保存相對 subdirectory。AgentManager 以 `savedCommitSha ?? baseCommitSha` 建 fresh detached worktree，並以 `join(freshWorktree.path, originalTargetSubdirectory)` 產生 final executionCwd；no-change 保留前次 saved commit，任何後續 failure 清除 fresh tree，runtime adapter 不建立/移除 worktree，永不 fallback 到 main worktree。
- 不支援 TaskExecute resume/rebinding，也不發明 TaskExecute worktree rebinding；不從 transcript 重建 executable session；不支援 cross-model resume；不新增 user-facing history deletion/GC UI；不匯入 upstream `@handle` 或 tombstone UI。
- 不修改與本功能無關的 source、test、package 或 UI；不執行 `git add`、`git commit`、`git push`、`git stash`、`git merge`、`git rebase`、`git reset`、`git checkout` 等 git mutation。
- Targeted tests、full `npm test`、lint、typecheck、build 與 `git diff --check` 都是本計畫授權的 verification；commit、push、publish 與其他 git mutation 仍不授權。

---

## 檔案地圖與 ownership

本計畫採單一 implementation writer 依 Task 1→7 順序執行；不啟動平行 writer。validation 只在對應 task 的寫入完成後執行，後續 task 若需修改前一 task 的檔案，視為同一 writer 的 dependency-ordered handoff，不是平行 ownership。

| 檔案 | 職責 | writer | validation owner |
|---|---|---|---|
| `src/agent-session-storage.ts` | private session directory、locator、filesystem boundary validator、stable storage errors | single implementation writer / Task 1 | targeted storage tests + final reviewer |
| `src/agent-recovery.ts` | checkpoint v1/v2 schema、validation、atomic read/write、future-version fail-closed | single implementation writer / Task 1→4 handoff | recovery tests + final reviewer |
| `src/types.ts` | runtime record、ownership、session persistence、worktree reconstruction types | single implementation writer / Task 1 only | typecheck + recovery/worktree tests |
| `src/worktree.ts` | low-level git/worktree primitives used by manager | single implementation writer / Task 2 | worktree tests + final reviewer |
| `src/agent-runner.ts` | shared child-session prepare/create/open helper、runtime adapter、session metadata | single implementation writer / Task 3 | runner tests + final reviewer |
| `src/agent-manager.ts` | records、final authority gate、worktree reconstruction/cleanup、resume state machine、TTL stubs、counter/completion/checkpoint | single implementation writer / Task 2→4 handoff | manager/worktree tests + final reviewer |
| `src/index.ts` | top-level authority/runtime wiring、reload lifecycle、private `/resume` contract seam | single implementation writer / Task 5→6 handoff | caller/reload tests |
| `src/nested-tools.ts` | nested UX precheck and exact owner forwarding | single implementation writer / Task 5 | nested tests + final reviewer |
| `src/workflow/host.ts` | same-host handle mapping and exact workflow forwarding; no reload rebind | single implementation writer / Task 5 | workflow tests + final reviewer |
| listed `test/**/*.test.ts` | TDD contracts and regression coverage | single implementation writer, task-ordered | targeted tests, full npm test, final reviewer |

## Work Graph

| Task | Work | Depends on | Validation owner |
|---|---|---|---|
| 1 | v2 discriminated state、private locator/session preflight boundary、storage errors | 無 | storage/recovery tests |
| 2 | AgentManager-owned canonical worktree state、fresh detached reconstruction、cleanup/failure removal | Task 1 types | worktree/manager isolation tests |
| 3 | shared runner helper、persistence precedence、private open/create session metadata | Tasks 1–2 | runner/private session tests |
| 4 | manager final authority、resume state machine、TTL stub、counter/completion | Tasks 1–3 | manager/recovery tests |
| 5 | top-level/nested/same-host workflow authority與caller wiring | Task 4 public signature | nested/workflow/index tests |
| 6 | top-level/nested `/reload` harness、ordinary `/resume` invisibility、workflow reload exclusion | Tasks 1–5 | reload/private contract tests |
| 7 | targeted/full verification與independent review | Tasks 1–6 | implementation writer + reviewer |

Tasks 1–7 嚴格依序執行；同一檔案或測試不可由多個 lane 平行修改。每一 task 先寫 failing test，再實作，再跑該 task 的 targeted tests；Task 7 才執行完整 verification。

---

### Task 1: 建立 v2 checkpoint 與 private locator boundary

**Files:**
- Create: `src/agent-session-storage.ts`
- Modify: `src/agent-recovery.ts:1-193`
- Modify: `src/types.ts:1-180`
- Create: `test/agent-session-storage.test.ts`
- Modify: `test/agent-recovery.test.ts:60-264`
- Modify: `test/agent-manager-history.test.ts:1-88`

**Interfaces:**
- Consumes: 現有 `AgentRecoveryCheckpoint` v1、`AgentInvocation`、`LifetimeUsage`、`AgentRecord` 與 `.pi-subagents/agent-checkpoints/*.json`。
- Produces: `AgentOwnership`、`AgentRecoverySessionState`、`WorktreeResumeState`、`AgentRecoveryCheckpointV2`、`ResumeStorageError`、`privateSessionDirectory()`、`privateSessionLocator()`、`resolvePrivateSessionLocator()` 與 native session preflight；後續 runner/manager 只使用這些 boundary，不自行拼 path。

- [ ] **Step 1: 先寫 v2 與 locator 的 failing tests**

```ts
it("accepts exactly one direct safe private .jsonl basename", () => {
  const artifactRootCwd = makeProject();
  const file = join(artifactRootCwd, ".pi-subagents", "agent-sessions", "session-1.jsonl");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{"type":"session","id":"session-1","version":1}\n');

  expect(resolvePrivateSessionLocator(
    artifactRootCwd,
    ".pi-subagents/agent-sessions/session-1.jsonl",
  ).file).toBe(file);
});

it.each([
  "/tmp/session.jsonl",
  ".pi-subagents/agent-sessions/../agent-transcripts/x.jsonl",
  ".pi-subagents/agent-sessions/nested/x.jsonl",
  ".pi-subagents\\agent-sessions\\x.jsonl",
  ".pi-subagents/agent-sessions/x\0.jsonl",
  ".pi-subagents/agent-sessions//x.jsonl",
  ".pi-subagents/agent-transcripts/x.jsonl",
])("rejects unsafe locator %s", locator => {
  expect(() => resolvePrivateSessionLocator(artifactRootCwd, locator))
    .toThrowError(expect.objectContaining({ code: "resume-session-locator-invalid" }));
});
```

在同一 task 增加：creation 與 reopen 各自的 symlink file/namespace、directory named `x.jsonl`、regular file realpath 逃出 namespace、missing file、malformed nonempty JSONL line、首行非 supported header、header version 不支援、header id 與 checkpoint `sessionId` 不符、v1 checkpoint、v2 pending/memory/explicit/private checkpoint、unknown `version: 3`、缺 model/ownership/session locator/runtime identity 的 validation tests。另加入 `depth`、`maxSubagentDepth`、`rootSessionId` checkpoint write/read/restore round-trip，以及 `restoreRecovered()` 在 private transcriptPath 缺失時仍恢復 valid v2 stub 的測試。

- [ ] **Step 2: 執行 targeted tests，確認新 contract 先失敗**

Run:

```bash
npx vitest run test/agent-session-storage.test.ts test/agent-recovery.test.ts test/agent-manager-history.test.ts
```

Expected: FAIL，原因包括 module/function 尚未存在、v1 validator 尚未接受 v2、unsafe locator 沒有 stable error code。不要把 failing assertion 改成較寬鬆的 path assertion。

- [ ] **Step 3: 寫最小 storage boundary**

`src/agent-session-storage.ts` 提供下列實作：

```ts
export const PRIVATE_SESSION_RELATIVE_DIR = ".pi-subagents/agent-sessions";

// The locator is one direct safe basename, for example `session-1.jsonl`.
// It never encodes a nested path.

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

export function privateSessionDirectory(artifactRootCwd: string): string;
export function privateSessionLocator(artifactRootCwd: string, file: string): string;
export function resolvePrivateSessionLocator(
  artifactRootCwd: string,
  locator: string,
): { locator: string; file: string };

export function canonicalArtifactRootCwd(callerCwd: string): string;
```

`resolvePrivateSessionLocator()` 先做 string/segment lexical validation，接受 `.pi-subagents/agent-sessions/<safe-basename>.jsonl` 且只允許一個 direct basename；再 `lstat` namespace 與 file，拒絕 symlink/non-regular，最後用 `realpath` 確認 candidate 位於 namespace realpath 下。creation path 與 reopen path 都呼叫此 boundary；不要以 `resolve()` 後仍在 namespace 為充分條件，因為 symlink escape 必須被拒絕。另提供 private native session preflight：檢查 exists、每個非空 JSONL line 可 parse、第一行是 supported header、header id 等於 persisted `sessionId`，然後才可呼叫 `SessionManager.open()`。

- [ ] **Step 4: 將 v2 schema 與 type guard 接到 recovery**

在 `src/types.ts` 定義固定 union（Task 1 完成後由後續 task 消費，不再由平行 lane 修改）：

```ts
export type AgentOwnership =
  | { kind: "top-level" }
  | { kind: "nested"; parentAgentId: string; depth: number }
  | { kind: "workflow"; workflowId: string; depth?: number };

export type AgentRecoverySessionState =
  | { kind: "pending" }
  | {
      kind: "memory" | "explicit";
      artifactRootCwd: string;
      resourceCwd: string;
      originalExecutionCwd: string;
    }
  | {
      kind: "private";
      locator: string;
      sessionId: string;
      artifactRootCwd: string;
      resourceCwd: string;
      originalExecutionCwd: string;
      provider: string;
      modelId: string;
      thinking: ThinkingLevel;
    };

export interface AgentRecoveryRuntimeIdentity {
  depth: number;
  maxSubagentDepth: number;
  rootSessionId?: string;
}

export interface WorktreeResumeState {
  repoRoot: string;
  baseCommitSha: string;
  savedCommitSha?: string;
  originalTargetSubdirectory: string;
}
```

在 `src/agent-recovery.ts` 將 `CHECKPOINT_VERSION` 改成 v2 writer；保留 `AgentRecoveryCheckpointV1` reader；export `AgentRecoveryCheckpoint = AgentRecoveryCheckpointV1 | AgentRecoveryCheckpointV2 | AgentRecoveryCheckpointFutureMarker`。v2 checkpoint 必填 `runtime: AgentRecoveryRuntimeIdentity`。`isAgentRecoveryCheckpoint()` 必須先依 `version` 分支：v1 只能驗證 display fields，v2 依 `pending | memory | explicit | private` 驗證，並驗證非負整數 `depth`/`maxSubagentDepth`（`maxSubagentDepth >= depth`）與 optional string `rootSessionId`；future/corrupt 只能轉成 non-executable marker。checkpoint writer 與 `restoreRecovered()` 必須原樣 round-trip 這三個欄位，不得從 caller/parent 猜值；`readAgentRecoveryCheckpoints()` 與 restore 不得要求 transcriptPath 存在才能恢復 valid v2 private stub，也不得從 v1 transcript 推導 session。

- [ ] **Step 5: 執行 targeted tests，確認 boundary 通過**

Run:

```bash
npx vitest run test/agent-session-storage.test.ts test/agent-recovery.test.ts test/agent-manager-history.test.ts
```

Expected: PASS；v1 round-trip 仍可被 history/menu 使用，但 `checkpoint.session` 不會由 `transcriptPath` 推導；v2 的 exact provider/model/thinking、artifact/resource/original cwd、`runtime.depth/maxSubagentDepth/rootSessionId` 與 worktree `originalTargetSubdirectory` 欄位完整 round-trip。

---

### Task 2: 擴充 worktree state 並實作 resume reconstruction

**Files:**
- Modify: `src/worktree.ts:1-191` (low-level git/worktree primitives only)
- Modify: `src/agent-manager.ts:218-1090` (exclusive reconstruction/cleanup owner; sequential handoff to Task 4)
- Modify: `test/worktree.test.ts:22-258`
- Modify: `test/agent-manager.test.ts:618-735`

**Interfaces:**
- Consumes: Task 1 的 `WorktreeResumeState`、現有 `WorktreeInfo`、`createWorktree()`/`cleanupWorktree()`。
- Produces: AgentManager-owned `originalTargetSubdirectory` state、`reconstructResumeWorktree(state, agentId): { worktree: WorktreeInfo; executionCwd: string }` 與 cleanup/failure removal orchestration；`src/worktree.ts` 只提供低階 primitive，不持有 resume policy，runtime adapter 不呼叫 reconstruction。Task 1 已完成所有 shared type edits；Task 2 不與其平行修改 `src/types.ts`。

- [ ] **Step 1: 寫 reconstruction failing tests**

```ts
it("reconstructs a caller-supplied target subdirectory through AgentManager", () => {
  const originalTargetSubdirectory = "packages/api";
  const first = createWorktree(join(repo, originalTargetSubdirectory), "first")!;
  writeFileSync(join(first.workPath, "changed.ts"), "export const changed = true;\n");
  const result = cleanupWorktree(repo, first, "save branch");

  const state: WorktreeResumeState = {
    repoRoot: repo,
    baseCommitSha: first.baseSha,
    savedCommitSha: result.savedCommitSha,
    originalTargetSubdirectory,
  };
  const resumed = manager.reconstructResumeWorktree(state, "resumed");

  expect(resumed.worktree.path).not.toBe(first.path);
  expect(resumed.executionCwd).toBe(join(resumed.worktree.path, originalTargetSubdirectory));
  expect(existsSync(resumed.executionCwd)).toBe(true);
  expect(resumed.executionCwd).not.toBe(repo);
});

it("keeps plain repo-root isolation at the fresh worktree root", () => {
  const first = createWorktree(repo, "plain")!;
  const state: WorktreeResumeState = {
    repoRoot: repo,
    baseCommitSha: first.baseSha,
    originalTargetSubdirectory: "",
  };
  const resumed = manager.reconstructResumeWorktree(state, "plain-resumed");
  expect(resumed.executionCwd).toBe(resumed.worktree.path);
});

it("fails closed when the saved commit or target subdirectory is missing", () => {
  expect(() => manager.reconstructResumeWorktree({
    repoRoot: repo,
    baseCommitSha: "0000000000000000000000000000000000000000",
    savedCommitSha: undefined,
    originalTargetSubdirectory: "missing/package",
  }, "bad")).toThrowError(expect.objectContaining({ code: "resume-worktree-invalid-ref" }));
});
```

另外加入 manager test：mock `runAgent`，assert `options.cwd` 是 manager 產生的 fresh `executionCwd` 且不是 `repoRoot`；reconstruction、cleanup 與後續 open/preflight failure 都由 manager 負責清除 fresh tree，runtime adapter 只收到 final cwd。

- [ ] **Step 2: 執行 worktree targeted tests，確認先失敗**

Run:

```bash
npx vitest run test/worktree.test.ts test/agent-manager.test.ts -t "resume|worktree"
```

Expected: FAIL，因 reconstruction API 與 saved state 尚未存在；既有 create/cleanup tests 必須仍然通過，若出現非 resume regression 先停止並修正，不得以放寬 assertion 掩蓋。

- [ ] **Step 3: 實作 saved state 與 fresh detached reconstruction**

由 AgentManager 保存 canonical `repoRoot`/`originalTargetSubdirectory` 的可重建資料，並新增 manager-owned orchestration：

```ts
// AgentManager-owned orchestration; src/worktree.ts remains low-level only.
function reconstructResumeWorktree(
  state: WorktreeResumeState,
  agentId: string,
): { worktree: WorktreeInfo; executionCwd: string };

function toWorktreeResumeState(
  repoRoot: string,
  originalTargetSubdirectory: string,
  worktree: WorktreeInfo,
  result?: WorktreeCleanupResult,
): WorktreeResumeState;
```

`AgentManager.reconstructResumeWorktree()` 的 git source 順序是 `savedCommitSha ?? baseCommitSha`；先 canonicalize/驗證 repository root、以 `git rev-parse --verify <sha>^{commit}` 確認完整 SHA 與 object type 為 commit、驗證 `originalTargetSubdirectory`（空字串代表 repo root），再呼叫低階 `git worktree add --detach` primitive。fresh `executionCwd = join(freshWorktree.path, originalTargetSubdirectory)`，經 realpath 後不得 escape。所有失敗都 throw stable worktree code，不回傳 `undefined`，使 manager 不可能誤判成可在 main tree 執行。cleanup 後以最新 commit 更新 state；本輪無變更時保留前一輪 savedCommitSha。

- [ ] **Step 4: 讓 AgentManager 在 cleanup 後保存 target state**

由 AgentManager 呼叫低階 `cleanupWorktree()`，將結果解析成 full `savedCommitSha`（可保留 branch 作為 display metadata，但 checkpoint 不依賴任意 ref），並使 cleanup 之後 `AgentRecord` 保留 `repoRoot/baseCommitSha/savedCommitSha/originalTargetSubdirectory`；temporary path 可清除。若後續 session/model/open preflight 失敗，manager 必須移除本次新建的 temporary worktree；runtime adapter 不得擁有或清理這份 state。

- [ ] **Step 5: 執行 worktree tests，確認通過**

Run:

```bash
npx vitest run test/worktree.test.ts test/agent-manager.test.ts -t "resume|worktree"
```

Expected: PASS；saved/base full commit SHA 都可重建，plain root 與 caller-supplied subdirectory 語意正確，缺 commit/repo/subdirectory 時 stable error，任何 resume path 都不使用 main worktree。

---

### Task 3: 抽出 shared child-session prepare/create/open helper

**Files:**
- Modify: `src/agent-runner.ts:536-1119`
- Modify: `test/agent-runner.test.ts:1-1889`
- Modify: `test/agent-runner-e2e.test.ts:1-294`
- Modify: `test/nested-session-wiring.test.ts:1-95`

**Interfaces:**
- Consumes: Task 1 的 persistence/checkpoint types、現有 `runAgent()` 全部 config/resource/tool/model wiring、Task 2 的 reconstructed `executionCwd`。
- Produces: `ChildSessionMode`、`PreparedChildSession`、`AgentResumeRuntimeDependencies`、`AgentResumeRuntime`、`prepareChildSession()`、`createAgentResumeRuntime()`；`runAgent()` 與 manager private resume 不再各自建構 session。

- [ ] **Step 1: 先擴充 runner tests，鎖住 persistence precedence 與 reopen API**

```ts
it("uses the private durable default when persist_session is unset", async () => {
  vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ persistSession: undefined }));
  const { session } = createSession("OK");
  createAgentSession.mockResolvedValue({ session });

  await runAgent(ctx, "Explore", "go", { pi });

  expect(sessionManagerCreate).toHaveBeenCalledWith(
    "/tmp/worktree",
    "/tmp/.pi-subagents/agent-sessions",
  );
  expect(sessionManagerInMemory).not.toHaveBeenCalled();
  expect(capturedCreateAgentSessionOptions()).not.toHaveProperty("cwdOverride");
  expect(sessionManager.getHeader()?.parentSession).toBeUndefined();
});

it("uses SessionManager.open and session_start reason resume without rebuilding from transcript", async () => {
  const opened = { kind: "opened" };
  sessionManagerOpen.mockReturnValue(opened);
  const runtime = createAgentResumeRuntime(pi, ctx, {
    nestedManager: manager,
    childIdentity: {
      parentAgentId: "resumed-agent-1",
      depth: 1,
      maxSubagentDepth: 2,
      rootSessionId: "root-session",
    },
  });
  await runtime.rehydrate(
    makeV2PrivateRecord({ id: "resumed-agent-1" }),
    "/tmp/worktree",
    new AbortController().signal,
  );

  expect(sessionManagerOpen).toHaveBeenCalledWith(
    "/tmp/.pi-subagents/agent-sessions/session-1.jsonl",
    "/tmp/.pi-subagents/agent-sessions",
    "/tmp/worktree",
  );
  expect(createAgentSession.mock.calls[0][0]).toMatchObject({
    cwd: "/tmp/worktree",
    sessionStartEvent: { type: "session_start", reason: "resume" },
  });
  expect(createAgentSession.mock.calls[0][0]).not.toHaveProperty("cwdOverride");
  expect(createAgentSession.mock.calls[0][0]).not.toHaveProperty("parentSession");
});
```

補上 `persistSession:true + sessionDir`、`persistSession:false`、private session file `getSessionFile()`、creation/reopen namespace/file symlink rejection、native header id/version/corruption preflight、live session path does not call open、exact provider/model unavailable/auth failure、stored type disappearance、caller override rejected with `resume-invalid-options`、nested tools/extension scope preserved 的 tests。

- [ ] **Step 2: 執行 runner targeted tests，確認 helper contract 先失敗**

Run:

```bash
npx vitest run test/agent-runner.test.ts test/agent-runner-e2e.test.ts test/nested-session-wiring.test.ts -t "persistence|private|resume|nested"
```

Expected: FAIL，因 `SessionManager.open` mock、private default、correct `cwd`/resume reason 與新 helper 尚未存在。既有 extension/tool scope tests 的 failure 要單獨修正，不可刪除 live scoping assertions。

- [ ] **Step 3: 定義 shared helper 的 exact signature**

在 `src/agent-runner.ts` 建立：

```ts
export type ChildSessionMode =
  | {
      kind: "create";
      artifactRootCwd: string;
      resourceCwd: string;
      originalExecutionCwd: string;
      executionCwd: string;
      persistence: "private" | "explicit" | "memory";
      privateDir?: string;
    }
  | {
      kind: "open";
      artifactRootCwd: string;
      resourceCwd: string;
      originalExecutionCwd: string;
      executionCwd: string;
      persistence: "private";
      privateDir: string;
      file: string;
      sessionId: string;
    };

export interface PreparedChildSession {
  session: AgentSession;
  sessionFile?: string;
  executionCwd: string;
  resourceCwd: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
}

export async function prepareChildSession(
  ctx: ExtensionContext,
  type: SubagentType,
  options: RunOptions,
  mode: ChildSessionMode,
): Promise<PreparedChildSession>;

export interface AgentResumeRuntimeDependencies {
  nestedManager: NestedAgentManager;
  childIdentity: {
    parentAgentId: string;
    depth: number;
    maxSubagentDepth: number;
    rootSessionId?: string;
  };
}

export interface AgentResumeRuntime {
  rehydrate(
    record: AgentRecord,
    executionCwd: string,
    signal?: AbortSignal,
  ): Promise<PreparedChildSession>;
}

export interface AgentResumeRuntimeFactory {
  create(deps: AgentResumeRuntimeDependencies): AgentResumeRuntime;
}

export function createAgentResumeRuntime(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  deps: AgentResumeRuntimeDependencies,
): AgentResumeRuntime;
```

把 `runAgent()` 目前從 config resolution 到 `createAgentSession()` 的區段搬入 helper；`runAgent()` 只負責選擇 create mode、prompt subscriptions、turn/failure capture 與回傳 metadata。resume branch 在任何 spawn/type/config/model resolution 前分流；manager authority 通過後才由 `AgentResumeRuntimeFactory.create({ nestedManager, childIdentity })` 建立 runtime。`createAgentResumeRuntime()` 只接收 manager 與 record-derived child identity，以及 manager 已授權的 final `executionCwd`（透過 `rehydrate(record, executionCwd, signal)`）；它絕不呼叫 Task 2 reconstruction、建立或移除 worktree，再把 stored type/config/model/thinking、resourceCwd、nested runtime 與 extension settings 傳給同一個 helper。

- [ ] **Step 4: 固定 persistence precedence 與 peer API 行為**

實作下列分支，不要使用 truthy coercion：

```ts
const persistence = agentConfig?.persistSession === true
  ? "explicit"
  : agentConfig?.persistSession === false
    ? "memory"
    : "private";

const sessionManager = mode.kind === "open"
  ? SessionManager.open(mode.file, mode.privateDir, mode.executionCwd)
  : mode.persistence === "private"
    ? SessionManager.create(mode.executionCwd, mode.privateDir!)
    : mode.persistence === "explicit"
      ? SessionManager.create(mode.executionCwd, configuredSessionDir ?? defaultSessionDir)
      : SessionManager.inMemory(mode.executionCwd);

await createAgentSession({
  cwd: mode.executionCwd,
  sessionManager,
  resourceLoader,
  sessionStartEvent: {
    type: "session_start",
    reason: mode.kind === "open" ? "resume" : "fork",
  },
});
```

private branch 不設 `parentSession`；explicit branch 只使用 `session_dir`/normal default；memory branch 不寫 executable locator。`getSessionFile()` 只在 private native session 建立成功後讀取並回報 manager，並立即檢查 namespace/file symlink、regular file、session header id/version；transcript path 不得進入此流程。live session resume 不呼叫 open。`AgentSession.dispose()` 以同步方式呼叫，且不假設會觸發 `session_shutdown`。

- [ ] **Step 5: 執行 runner 與 real Pi session tests，確認通過**

Run:

```bash
npx vitest run test/agent-runner.test.ts test/agent-runner-e2e.test.ts test/nested-session-wiring.test.ts
```

Expected: PASS；create/private open 共享一個 helper，current extension/tool/nested wiring regression 保持通過，open 用 reason `resume`，create 用 reason `fork`，`createAgentSession` 使用 `cwd: executionCwd` 且沒有 `cwdOverride`/`parentSession` 欄位。

---

### Task 4: 重寫 AgentManager resume state machine、v2 stubs 與 completion semantics

**Files:**
- Modify: `src/agent-manager.ts:218-1090`
- Modify: `src/agent-recovery.ts:20-193` (sequential handoff from Task 1)
- Modify: `test/agent-manager.test.ts:1-1152`
- Modify: `test/agent-recovery.test.ts:60-264`
- Modify: `test/agent-manager-history.test.ts:1-88`

**Interfaces:**
- Consumes: Task 1 checkpoint/ownership/storage types、Task 2 worktree reconstruction、Task 3 `AgentResumeRuntime`。
- Produces: `ResumeAuthority`（含 canonical caller artifact root）、`AgentResumeError`、`AgentManager.resume(id,prompt,runtimeFactory,authority,...)`、v2 record restore/stub/TTL behavior；後續 callers 只透過這個 API resume。

- [ ] **Step 1: 寫 manager state-machine failing tests**

```ts
it("uses the live resumeAgent path for every persistence mode without rehydrate/open", async () => {
  for (const persistence of ["private", "explicit", "memory"] as const) {
    const manager = makeManagerWithLiveSession({ persistence });
    const runtimeFactory = { create: vi.fn() };

    await manager.resume(
      "agent-1",
      "continue",
      runtimeFactory,
      { kind: "top-level", artifactRootCwd: "/project" },
      { isBackground: false },
    );

    expect(manager.resumeAgent).toHaveBeenCalledOnce();
    expect(runtimeFactory.create).not.toHaveBeenCalled();
    expect(manager.sessionManagerOpen).not.toHaveBeenCalled();
  }
});

it("requires private v2 rehydrate only after the live session is absent", async () => {
  const manager = makeManagerWithV2Stub({ artifactRootCwd: "/project" });
  const runtime = { rehydrate: vi.fn(async (_record, executionCwd) => preparedSession(executionCwd)) };

  await manager.resume(
    "agent-1",
    "continue",
    { create: () => runtime },
    { kind: "top-level", artifactRootCwd: "/project" },
    { isBackground: false },
  );

  expect(runtime.rehydrate).toHaveBeenCalledOnce();
  expect(manager.sessionManagerOpen).toHaveBeenCalledOnce();
});

it.each([
  "resume-session-missing",
  "resume-session-corrupt",
  "resume-model-unavailable",
  "resume-worktree-missing-cwd",
])("leaves the prior terminal state unchanged on absent-session preflight failure: %s", async code => {
  const manager = makeManagerWithV2Stub({ artifactRootCwd: "/project" });
  const before = snapshotTerminal(manager.getRecord("agent-1")!);
  const runtimeFactory = { create: vi.fn(() => ({ rehydrate: vi.fn(async () => { throw new AgentResumeError(code, code); }) })) };

  await expect(manager.resume(
    "agent-1",
    "continue",
    runtimeFactory,
    { kind: "top-level", artifactRootCwd: "/project" },
  )).rejects.toMatchObject({ code });
  expect(snapshotTerminal(manager.getRecord("agent-1")!)).toEqual(before);
  expect(manager.getRecord("agent-1")?.resultConsumed).toBe(before.resultConsumed);
  expect(manager.getRecord("agent-1")?.toolCallId).toBe(before.toolCallId);
});
```

補上：live session path uses no open；v1 session 不可 resume、unknown future/corrupt version fail closed、v2 pending/memory/explicit stub 不可 resume、v2 private without transcript 可 restore、restored `depth/maxSubagentDepth/rootSessionId` 原樣供 child nested runtime 使用、top-level does not resume nested/workflow、manager direct authority bypass rejects、top-level project scope、top-level background counter exactly once、nested/workflow background does not affect global counter、completion once、successful turn resets `resultConsumed`、preflight failure leaves `resultConsumed`/`toolCallId` unchanged、history cursor、exact model auth/type disappearance、rehydrate failure disposes new session/removes fresh worktree、TTL sync dispose retains v2 stub/checkpoint/private file、不刪 private/explicit file、workflow cross-reload exclusion。

- [ ] **Step 2: 執行 manager/recovery tests，確認 state machine 先失敗**

Run:

```bash
npx vitest run test/agent-manager.test.ts test/agent-recovery.test.ts test/agent-manager-history.test.ts -t "resume|checkpoint|cleanup|completion|pool"
```

Expected: FAIL，因 manager 目前要求 live `record.session`、沒有 runtime adapter、checkpoint 仍是 v1、cleanup 不能留下 executable stub。

- [ ] **Step 3: 定義 authority 與 resume error types**

在 `src/agent-manager.ts` 或 `src/types.ts` export（Task 2 的 worktree orchestration 與本 task 的 resume state machine 由同一 implementation writer 依序完成）：

```ts
export type ResumeAuthority =
  | { kind: "top-level"; artifactRootCwd: string }
  | { kind: "nested"; artifactRootCwd: string; parentAgentId: string }
  | { kind: "workflow"; artifactRootCwd: string; workflowId: string; runtimeAgentId: string };

export type AgentResumeErrorCode =
  | "resume-checkpoint-missing"
  | "resume-checkpoint-invalid"
  | "resume-session-missing"
  | "resume-session-corrupt"
  | "resume-session-incompatible"
  | "resume-model-unavailable"
  | "resume-invalid-options"
  | "resume-worktree-missing-cwd"
  | "resume-worktree-invalid-ref"
  | "resume-ownership-denied";

export class AgentResumeError extends Error {
  constructor(public readonly code: AgentResumeErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "AgentResumeError";
  }
}
```

`assertResumeAuthority(record, authority)` 先 canonicalize `authority.artifactRootCwd`，與 persisted `record.artifactRootCwd` exact compare，再驗證 top-level 無 parent/workflow owner、nested exact parent、workflow exact mapping/root。authority 或 busy check 不通過時不可呼叫 runtime、讀 checkpoint、解析 model 或建立 worktree。新增 direct manager bypass tests：即使 caller 偽造 id、跳過 UX precheck，或從另一個 project/root 傳入同一 id，manager 仍拋 `resume-ownership-denied`，且不呼叫 runtime。

- [ ] **Step 4: 將 `resume()` 改成「驗證 → rehydrate → commit state → run」**

使用下列順序；`runtimeFactory` 是參數而非 caller 已建構的 runtime：

```ts
async resume(
  id: string,
  prompt: string,
  runtimeFactory: AgentResumeRuntimeFactory,
  authority: ResumeAuthority,
  signalOrOptions?: AbortSignal | ResumeOptions,
  options?: ResumeOptions,
): Promise<AgentRecord | undefined>;

const record = this.agents.get(id);
if (!record) return undefined;
assertResumeAuthority(record, authority); // canonical caller root first
assertResumeNotBusy(record); // preserve existing busy/terminal rules

const isBackground = options?.isBackground ?? false;
if (record.session) {
  // Live private/explicit/memory sessions never require checkpoint/open.
  return this.resumeAgent(record, prompt, {
    isBackground,
    ...(isBackground ? {} : { signal }),
  });
}

const checkpoint = this.requirePrivateV2Checkpoint(record);
const executionCwd = checkpoint.worktree
  ? this.reconstructResumeWorktree(checkpoint.worktree, record.id).executionCwd
  : checkpoint.session.originalExecutionCwd;
const runtime = runtimeFactory.create({
  nestedManager: this,
  childIdentity: {
    parentAgentId: record.id,
    depth: checkpoint.runtime.depth,
    maxSubagentDepth: checkpoint.runtime.maxSubagentDepth,
    rootSessionId: checkpoint.runtime.rootSessionId,
  },
});
const prepared = await runtime.rehydrate(record, executionCwd, signal);

record.session = prepared.session;
record.executionCwd = prepared.executionCwd;
record.sessionFile = prepared.sessionFile;
record.status = "running";
record.startedAt = Date.now();
record.completedAt = undefined;
record.result = undefined;
record.error = undefined;
record.resultConsumed = false;
record.isBackground = isBackground;
```

authority/busy checks、checkpoint validation、worktree reconstruction 與 runtime creation 都在任何 record mutation 前執行。live branch 只由 `resumeAgent()` 管理 callbacks；absent-session branch 的任何 preflight/rehydrate exception 都保留舊 terminal state、`resultConsumed` 與 `toolCallId`。若 manager 已建立 fresh worktree 或 runtime 已配置新的 AgentSession 後才失敗，manager 同步 dispose/remove 新資源，再把原 record 留在 terminal state。成功後只由擴充後的 `resumeAgent()` 綁定 per-turn callbacks，先捕捉一次 `historyStartIndex = prepared.session.messages.length`，並把同一 index 傳給 transcript stream 與 resumeAgent；保存 usage/compaction、flush transcript、checkpoint、completion callback。`occupiesBackgroundPool` 改成 `isBackground && record.ownership.kind === "top-level"`，不再只靠 `parentAgentId === undefined`，且延續既有 bypass-queue 行為。

- [ ] **Step 5: 實作 TTL stub 與 reload restore**

`cleanup()` 對有 executable v2 private checkpoint 的 terminal record 清除 live/large fields，但保留 lightweight `AgentRecord` 與 v2 checkpoint；memory/explicit 只保留 non-executable stub。`dispose()` 在清除 manager map 前先 flush/checkpoint，使用同步 `AgentSession.dispose()` 且不假設 `session_shutdown`；不得 unlink private/explicit native session。`restoreRecovered()` 將 v2 stub 讀回並保留 ownership/session/worktree metadata，且 private stub 不要求 transcriptPath 存在；v1 只建立 display-only record，`session` 與 executable locator 都是 `undefined`。

`clearCompleted(true)` 不得因 v2 private checkpoint 仍可被本次或下次 session 使用而刪除 native file；若移除 map，必須讓下一個 restore 的語意仍符合 v2 private stub contract。不要新增 user-facing delete/GC API。

- [ ] **Step 6: 執行 manager/recovery tests，確認 state machine 通過**

Run:

```bash
npx vitest run test/agent-manager.test.ts test/agent-recovery.test.ts test/agent-manager-history.test.ts
```

Expected: PASS；所有 resume failure 都在舊 terminal state 上 fail closed；successful new turn reset `resultConsumed`，background completion exactly once，pool 只計 top-level。

---

### Task 5: 接上 top-level、nested 與 workflow 的 exact authority

**Files:**
- Modify: `src/index.ts:558-626,1285-1320`
- Modify: `src/nested-tools.ts:48-200`
- Modify: `src/workflow/host.ts:54-500`
- Modify: `src/workflow/runtime.ts:188-230`（只在 boundary type 需要補充時）
- Modify: `test/nested-feature.test.ts:140-300`
- Modify: `test/nested-history.test.ts:1-173`
- Modify: `test/workflow-host.test.ts:145-252`
- Modify: `test/workflow-runtime.test.ts:607-640`
- Modify: `test/agent-detached-wiring.test.ts:1-149`
- Modify: `test/wait-queued.test.ts:1-196`

**Interfaces:**
- Consumes: Task 3 的 `createAgentResumeRuntime(pi,ctx,deps)`、Task 4 的 `ResumeAuthority` 與 manager resume signature。
- Produces: 三個 caller 的 exact authority wiring；workflow mapping 不改 runtime journal semantics；nested tools 不新增跨 parent 能力。

- [ ] **Step 1: 先寫 caller authority failing tests**

```ts
it("manager rejects a top-level bypass and a different project root for the same id", async () => {
  const runtimeFactory = { create: vi.fn() };
  await expect(manager.resume(
    "nested",
    "continue",
    runtimeFactory,
    { kind: "top-level", artifactRootCwd: "/project" },
  )).rejects.toMatchObject({ code: "resume-ownership-denied" });
  await expect(manager.resume(
    "top-level",
    "continue",
    runtimeFactory,
    { kind: "top-level", artifactRootCwd: "/other-project" },
  )).rejects.toMatchObject({ code: "resume-ownership-denied" });
  expect(runtimeFactory.create).not.toHaveBeenCalled();
});

it("workflow host requires exact runtime mapping and workflow root", async () => {
  const host = createWorkflowHost({ ...deps, workflowId: "wf-1" });
  const result = await host.resumeAgent!("wf-agent-2", "continue", undefined, false);
  expect(result.ok).toBe(false);
  expect(result.error).toContain("resume-ownership-denied");
});

it("nested caller may precheck, while manager remains the final owner authority", async () => {
  const result = await nestedAgentTool.execute("call", {
    resume: "child-1", prompt: "continue", description: "continue", subagent_type: "Explore",
  }, undefined, undefined, childContextFor("parent-a"));
  expect(result.isError).toBe(true);

  await expect(manager.resume(
    "child-1",
    "continue",
    { create: vi.fn() },
    { kind: "nested", artifactRootCwd: "/project", parentAgentId: "parent-b" },
  )).rejects.toMatchObject({ code: "resume-ownership-denied" });
});
```

- [ ] **Step 2: 執行 caller tests，確認 authority 先失敗**

Run:

```bash
npx vitest run \
  test/nested-feature.test.ts \
  test/nested-history.test.ts \
  test/workflow-host.test.ts \
  test/workflow-runtime.test.ts \
  test/agent-detached-wiring.test.ts \
  test/wait-queued.test.ts
```

Expected: FAIL，因 top-level index 尚未傳 authority/runtime、nested/workflow 尚未使用新 manager signature。既有 workflow `resume` progress model、detached collection 與 nested result consumption 不得失去。

- [ ] **Step 3: 接 top-level Agent tool**

`src/index.ts` 的 `params.resume` path 必須在解析 caller 的 `subagent_type`、model、thinking/config 或 spawn options 前分流；不再先以 `existing.session` 判斷是否可見。直接從 raw params 計算 `const isBackground = params.run_in_background ?? false`；只驗證 schema-required `subagent_type`/`description` 與允許的 prompt/resume/run_in_background/signal，禁止呼叫 `resolveSpawnType`、caller type 的 `getAgentConfig` 或 `resolveAgentInvocationConfig`。若 `existing.session` 存在，manager/runtime 走 live same-process path；不存在時只允許 private v2 checkpoint。runtime factory 由 manager 在 authority 通過後以 record-derived child identity 建立：

```ts
const runtimeFactory = {
  create: (deps: AgentResumeRuntimeDependencies) => createAgentResumeRuntime(pi, ctx, deps),
};
const resumed = await manager.resume(
  params.resume,
  params.prompt,
  runtimeFactory,
  { kind: "top-level", artifactRootCwd: canonicalArtifactRootCwd(ctx.cwd) },
  { isBackground, ...(isBackground ? {} : { signal }) },
);
```

保留 top-level Agent 的 inline/background render contract；manager `AgentResumeError` 轉成穩定 text result。top-level 只能開 `ownership.kind === "top-level"`；不讓 `parentAgentId`/workflow id 進入此 path。

- [ ] **Step 4: 接 nested exact parent**

`src/nested-tools.ts` 保留 `ownsRecord(record,parentAgentId)` 的 exact equality 作 UX precheck；caller 的 `context.parentAgentId` 只進 authority。直接從 raw params 計算 `const isBackground = params.run_in_background ?? false`，不得先呼叫 `resolveAgentInvocationConfig()`；manager authority 通過後才把 record-derived child identity 傳給 runtime factory：

```ts
const isBackground = params.run_in_background ?? false;
const runtimeFactory = {
  create: (deps: AgentResumeRuntimeDependencies) => createAgentResumeRuntime(context.pi, ctx, deps),
};
await context.manager.resume(
  params.resume,
  params.prompt,
  runtimeFactory,
  {
    kind: "nested",
    artifactRootCwd: canonicalArtifactRootCwd(ctx.cwd),
    parentAgentId: context.parentAgentId,
  },
  { isBackground, ...(isBackground ? {} : { signal }) },
);
```

nested runner 使用 record 的 original type/config/session metadata；不得用 resume call 的 `subagent_type`、model、thinking 或 isolation 重新選模型。

- [ ] **Step 5: 接 workflow exact mapping/root**

`src/workflow/host.ts` 的 `records` map 仍是 runtime handle → manager id 的唯一 mapping，不持久化也不在跨 `/reload` 重建。same-host resume 前只檢查 mapping 存在並取得 manager id；manager 再檢查 record owner kind 是 `workflow`、persisted artifact root 與 owner workflowId exact match `deps.workflowId`。直接從 raw params 計算 `const isBackground = params.run_in_background ?? false`；通過 manager authority 後，record-derived child identity（`parentAgentId: record.id`、stored depth/max depth/root session）才進入 runtime factory：

```ts
const runtimeFactory = {
  create: (childDeps: AgentResumeRuntimeDependencies) => createAgentResumeRuntime(pi, ctx, childDeps),
};
await manager.resume(
  managerId,
  params.prompt,
  runtimeFactory,
  {
    kind: "workflow",
    artifactRootCwd: deps.artifactRootCwd,
    workflowId: deps.workflowId!,
    runtimeAgentId: agentId,
  },
  { isBackground, ...(isBackground ? {} : { signal }) },
);
```

`runInBackground` 只決定 resumed turn mode，不改 stored ownership/model/thinking/isolation。跨 `/reload` 或新 WorkflowHost 不得使用舊 runtime handle 重新綁定 workflow child；測試必須明確證明此路徑被排除。`src/workflow/runtime.ts` 只維持既有 optional `resumeAgent` boundary，不加入 TaskExecute rebinding。

- [ ] **Step 6: 執行 caller targeted tests，確認通過**

Run:

```bash
npx vitest run \
  test/nested-feature.test.ts \
  test/nested-history.test.ts \
  test/workflow-host.test.ts \
  test/workflow-runtime.test.ts \
  test/agent-detached-wiring.test.ts \
  test/wait-queued.test.ts
```

Expected: PASS；top-level/nested/workflow authority exact match、workflow child pool policy、detached notification、nested result consumption 與 workflow progress semantics 都保留。

---

### Task 6: 建立 `/reload` reconstruction harness 與 private `/resume` invisibility contract

**Files:**
- Create: `test/durable-resume-reload.test.ts`
- Create: `test/private-session-resume.test.ts`
- Modify: `test/agent-runner.test.ts:774-830`
- Modify: `test/agent-recovery.test.ts:60-264`
- Modify: `test/agent-detached-wiring.test.ts:1-149`

**Interfaces:**
- Consumes: Task 1–5 的 v2 checkpoint、runner open/create、manager restore與 index lifecycle wiring。
- Produces: 可重複的 process/activation reload harness 與普通 Pi `/resume` 不可見性證據。

- [ ] **Step 1: 寫 `/reload`-shaped harness 的 failing test**

測試不能依賴目前 manager instance；使用兩次獨立 extension activation 模擬 `/reload`，只覆蓋 top-level/nested private records；workflow cross-reload rebind 必須另以拒絕測試明確排除：

```ts
it("reconstructs a v2 stub across a reload-shaped activation", async () => {
  const project = makeProject();
  const first = makePiActivation(project, "session-a");
  subagentsExtension(first.pi);
  await first.lifecycle.get("session_start")?.({}, first.ctx);

  const id = await spawnAndFinishWithPrivateSession(first, "continue me");
  await first.lifecycle.get("session_shutdown")?.({}, first.ctx);

  const second = makePiActivation(project, "session-b");
  subagentsExtension(second.pi);
  await second.lifecycle.get("session_start")?.({}, second.ctx);

  const restored = second.managerRecords().find(record => record.id === id);
  expect(restored).toMatchObject({ id, status: "completed" });
  expect(restored?.session).toBeUndefined();
  expect(restored?.session?.messages).toBeUndefined();
  expect(restored?.transcriptPath).toMatch(/^\.pi-subagents\/agent-transcripts\/.*\.jsonl$/);

  const result = await second.tools.get("Agent").execute(
    "resume-call",
    { resume: id, prompt: "continue", description: "continue", subagent_type: restored!.type },
    undefined,
    undefined,
    second.ctx,
  );
  expect(textOf(result)).toContain("resumed");
  expect(second.sessionManager.open).toHaveBeenCalledOnce();
});
```

測試 harness 必須實際檢查 v2 checkpoint 與 private native file 仍在，不以 transcript 內容直接代替 open。

- [ ] **Step 2: 寫 ordinary `/resume` invisibility contract failing test**

使用 real Pi `SessionManager`（不 mock session scan）建立 private session 與 ordinary normal session manager；驗證 private file 只在 private directory，且 normal directory enumeration 沒有該 file：

```ts
it("keeps the private native session out of ordinary Pi resume storage", async () => {
  const artifactRootCwd = makeProject();
  const privateDir = join(artifactRootCwd, ".pi-subagents", "agent-sessions");
  const privateManager = SessionManager.create(artifactRootCwd, privateDir);
  const privateFile = privateManager.getSessionFile();

  expect(privateFile).toContain(privateDir);
  expect(privateFile).not.toContain(artifactRootCwd + "/.pi/sessions");
  expect((await SessionManager.list(artifactRootCwd)).map(session => session.path))
    .not.toContain(privateFile);
  expect((await SessionManager.listAll()).map(session => session.path))
    .not.toContain(privateFile);
  expect(privateManager.getHeader()?.parentSession).toBeUndefined();
});

it("keeps path separation independent from list visibility", () => {
  const artifactRootCwd = makeProject();
  const privateDir = join(artifactRootCwd, ".pi-subagents", "agent-sessions");
  const privateManager = SessionManager.create(artifactRootCwd, privateDir);
  const privateFile = privateManager.getSessionFile();
  expect(privateFile.startsWith(privateDir)).toBe(true);
  expect(privateFile.startsWith(artifactRootCwd + "/.pi/sessions")).toBe(false);
  expect(privateManager.getHeader()?.parentSession === undefined).toBe(true);
});
```

測試必須另外 assert `session_start` reason `fork`/`resume` 的差異；普通 Pi `/resume` invisibility 不是靠隱藏 UI，而是由 private directory separation、`list()`/`listAll()` exclusion 與 absence of `parentSession` 三組獨立 assertions 證明。

- [ ] **Step 3: 執行 harness tests，確認先失敗**

Run:

```bash
npx vitest run test/durable-resume-reload.test.ts test/private-session-resume.test.ts
```

Expected: FAIL，若 manager reload 後 record 消失、只恢復 transcript、open 沒被呼叫、private file 被當成 normal session，或 `parentSession` 存在。

- [ ] **Step 4: 完成 harness adapter 與 lifecycle assertions**

`makePiActivation()` 必須每次建立新的 `AgentManager`/extension closure，但共用同一 artifactRootCwd；first activation shutdown 後只允許寫 checkpoint/flush/dispose，不刪 native private file；second activation 的 `session_start` 必須呼叫 `manager.restoreRecovered(artifactRootCwd)` 並載入 v2 stub。resume 成功前的 open failure case 另測舊 terminal state unchanged；另測新 WorkflowHost 不可使用前一 host 的 runtime handle 進行 cross-reload workflow rebind。

- [ ] **Step 5: 執行 harness tests，確認通過**

Run:

```bash
npx vitest run test/durable-resume-reload.test.ts test/private-session-resume.test.ts
```

Expected: PASS；reload 後從 v2 native locator reopen，transcript 只供 viewer/result fallback，private session 不進 ordinary Pi resume storage。

---

### Task 7: 整合 targeted regression、focused static gates 與 full gates

**Files:**
- Modify only files already listed in Tasks 1–6；此 task 不新增 implementation scope。
- Read-only review: `src/agent-manager.ts`、`src/agent-runner.ts`、`src/agent-recovery.ts`、`src/types.ts`、`src/nested-tools.ts`、`src/workflow/host.ts`、`src/worktree.ts`、`src/index.ts` 與所有 listed tests。

**Interfaces:**
- Consumes: Tasks 1–6 的全部 implementation 與 tests。
- Produces: 可供 reviewer 驗收的 targeted/full gate 結果與 unresolved ambiguity list。

- [ ] **Step 1: 執行 durable resume targeted suite**

Run:

```bash
npx vitest run \
  test/agent-session-storage.test.ts \
  test/agent-recovery.test.ts \
  test/agent-manager-history.test.ts \
  test/agent-manager.test.ts \
  test/agent-runner.test.ts \
  test/agent-runner-e2e.test.ts \
  test/worktree.test.ts \
  test/durable-resume-reload.test.ts \
  test/private-session-resume.test.ts
```

Expected: PASS，覆蓋 v2 schema、path security、persistence precedence、open/create、TTL、reload、same-model、worktree、private invisibility、pool與completion。

- [ ] **Step 2: 執行 ownership/workflow/nested regression suite**

Run:

```bash
npx vitest run \
  test/nested-feature.test.ts \
  test/nested-history.test.ts \
  test/nested-session-wiring.test.ts \
  test/workflow-host.test.ts \
  test/workflow-runtime.test.ts \
  test/workflow-detached-collect.test.ts \
  test/workflow-detached-sandbox.test.ts \
  test/workflow-index-wiring.test.ts \
  test/agent-detached-wiring.test.ts \
  test/wait-queued.test.ts
```

Expected: PASS；workflow journal/progress、nested ownership、detached collection、structured output 與 existing tool wiring 不回歸。

- [ ] **Step 3: 執行 repository focused static checks**

Run:

```bash
npm run lint
npm run typecheck
npx biome check docs/superpowers/specs/2026-10-21-durable-executable-agent-resume.md docs/superpowers/plans/2026-10-21-durable-executable-agent-resume.md
```

Expected: PASS；Biome、TypeScript 與 documentation diff check 不報 v2 union、runtime adapter、SessionManager API 或 ownership signature 錯誤。

- [ ] **Step 4: 執行完整 test/build gates**

Run:

```bash
npm test
npm run build
git diff --check
```

Expected: PASS；`npm test` 與 `npm run build` 是本計畫已授權的 verification。任何 test/build failure 都必須回到對應 task 修正，不能只更新文件結論；這些 verification 不授權 commit、push、publish 或其他 git mutation。

- [ ] **Step 5: 交付 independent reviewer review**

Reviewer 必須逐項檢查：

1. `Agent View` transcript 沒有任何 executable reopen 或 prompt reconstruction path。
2. private default path、`parentSession` absence、ordinary `/resume` invisibility contract 由 test 與 source wiring 同時證明。
3. `persist_session:true/false/unset` 的 precedence 沒有 truthy coercion；`session_dir` 沒有洩漏到 false/unset。
4. checkpoint v1/v2/future version 行為是 display-only、v2 executable、future fail closed；locator validator 覆蓋 symlink/realpath escape。
5. `AgentManager.resume()` 在 preflight failure 後保持舊 terminal state；成功後 resultConsumed、pool、completion exactly once 正確。
6. top-level/nested/workflow authority 是 exact owner match；沒有 TaskExecute rebinding 或 id-only bypass。
7. worktree resume 永遠使用 fresh detached tree；missing repo/ref/subdir 不會執行主 worktree。
8. runner shared helper 沒有 create/reopen duplicate wiring；model/provider exact match，沒有 fallback。
9. diff 只包含本功能需要的 source/tests/docs；沒有 unrelated refactor、package bump 或 source deletion。
10. `npm run lint`、`npm run typecheck`、targeted tests、full test/build、`git diff --check` 的實際結果與命令一致。

---

## Success Criteria

1. v2 private checkpoint 可以在新的 manager/activation 中 reopen native session，而不是讀 transcript 充當 session；private stub 沒有 transcript 仍可 restore，且 `depth/maxSubagentDepth/rootSessionId` 完整 round-trip 後用於重建 child nested runtime。
2. live session 的 private/explicit/memory resume 都不 open；session 消失後只有 unset persistence 使用 private native directory，explicit true 保留 normal/custom，explicit false 明確不可 Agent checkpoint resume。
3. private locator/session preflight、exact model/auth、ownership、worktree 與 cwd boundary 全部 fail closed，且舊 terminal state、`resultConsumed`、`toolCallId` 不被破壞。
4. top-level、nested、same-host workflow caller 都只能 resume 自己明確擁有的 record；manager 是 final authority，workflow cross-reload rebind 與 TaskExecute 都排除。
5. TTL/dispose/reload 保留 lightweight private stub、completion/result semantics、sessionId/locator 與 worktree state；native files 不被自動刪除；sync dispose 不假設 `session_shutdown`。
6. resumed background turn 延續 bypass-queue 行為，只有 top-level counter/pool accounting，completion callback 恰好一次。
7. shared runner helper 讓初次 spawn 與 private checkpoint reopen 的 tools/extensions/resource loader/model/thinking/system prompt/nested tools wiring 一致且只建構一次；exact API 不使用 `cwdOverride` 或 `parentSession` option。
8. worktree resume 以 canonical repoRoot、savedCommitSha ?? baseCommitSha 建 fresh detached worktree，保留 original subdirectory/no-change saved commit，任何後續 failure 都移除 fresh tree，永不 fallback 到 main worktree。
9. 所有 targeted tests、reload/private/worktree/authority/history-cursor contracts、focused/full lint/typecheck/test/build、`git diff --check` 與 independent reviewer criteria 都有可追溯證據。

## Plan self-review

- [x] **Spec coverage:** persistence precedence（live vs cleanup/reload）、private transcript distinction、五種 cwd、Pi 0.80.8 API、runtime adapter、v2 union/native session preflight、locator security、exact model/auth、history cursor、TTL stub、final authority、pool/completion、worktree reconstruction、workflow reload exclusion、scope exclusions 都各有 task 與驗收項目。
- [x] **佔位內容掃描：** 計畫沒有留下未決標記、空泛的「稍後處理」、未具體化的 error handling，或只說「寫 tests」卻沒有 test shape；每個 implementation task 都附有 interface、failing test、命令、expected result 與 passing gate。
- [x] **Type consistency:** Task 1 定義 `AgentOwnership`/`AgentRecoverySessionState`/`AgentRecoveryRuntimeIdentity`/`WorktreeResumeState`；Task 2 使用 canonical commit state；Task 3 定義 `PreparedChildSession`/`AgentResumeRuntimeDependencies`/`AgentResumeRuntime`；Task 4 的 `resume()` 接受該 adapter 與 `ResumeAuthority`；Task 5 由三個 caller 傳入 exact authority；Task 6/7 只消費這些既定介面。
- [x] **Scope review:** 沒有 commit step、git mutation、package bump、TaskExecute rebinding、workflow cross-reload rebind、history deletion UI、cross-model resume 或 transcript reconstruction；verification commands 是已授權的檢查，但不授權 commit/push/publish；文件工作本身只新增指定 spec/plan。
