# Durable Executable Agent Resume 設計規格

**狀態：** 已核准，待實作
**日期：** 2026-10-21

## 摘要

本功能讓 top-level 與 nested subagent 在原生 Pi session 已被 TTL cleanup、`/reload`、session switch 或程序重啟後，仍能以同一個可執行的原生 session 繼續下一個 turn。workflow child 只在原本的 `WorkflowHost` runtime mapping 尚存時可 rehydrate；不支援跨 `/reload` 重新綁定 workflow handle。可執行恢復的來源是 Pi 原生 session JSONL；`.pi-subagents/agent-transcripts` 只供 Agent View 顯示，永遠不能被解析回原生 executable session，也不能被拼回 resume prompt。

這是對現有 durable transcript/checkpoint 的延伸，不是把 transcript 變成 session。實作必須保留 0.18.0 的 AgentManager ownership、queue/pool、completion、worktree、history 與 workflow 行為，並把「重新建立 child runtime」集中到 `agent-runner.ts` 的單一路徑。

## 現況與問題邊界

現有程式的關鍵 seam 如下：

- `src/agent-runner.ts:536` 的 `runAgent()` 目前負責建構 `DefaultResourceLoader`、model/thinking、nested tools、`SessionManager`、`createAgentSession()`、extensions bind 與 tool scope；`src/agent-runner.ts:1030` 的 `resumeAgent()` 只接受仍在記憶體中的 `AgentSession`。
- `src/agent-runner.ts:870-872` 目前依 `persistSession` 二選一使用 `SessionManager.create()` 或 `SessionManager.inMemory()`；未設定 `persistSession` 時沒有可重新 open 的 executable session。
- `src/agent-manager.ts:273` 的 `makeCheckpoint()` 仍寫 checkpoint v1；`src/agent-manager.ts:367` 的 `restoreRecovered()` 只恢復 terminal record；`src/agent-manager.ts:739` 的 `resume()` 在 `record.session` 不存在時直接返回 `undefined`。
- `src/agent-manager.ts:978` 的 `cleanup()` 會釋放 session 與大結果，但目前只保留 transcript stub，沒有保留可 reopen 的 native session locator。
- `src/nested-tools.ts:174` 與 `src/index.ts:1285` 都能發起 resume；前者已有 exact `parentAgentId` 檢查，後者目前只檢查 id 與 live session。
- `src/workflow/host.ts:440` 透過 runtime id mapping resume workflow child；spawn 時在 `src/workflow/host.ts:318,357` 以 `parentAgentId: workflowId` 表達 workflow ownership。
- `src/worktree.ts:15,44,88` 已保存 `baseSha` 與結果 branch，但 `AgentRecord` 的 worktree state 在 cleanup 後不足以從 branch/base SHA 重建新的 execution cwd。
- `src/index.ts:558-570` 在 `session_start` 清理並載入 records；`src/index.ts:622-626` 在 shutdown dispose manager。這兩個生命週期點必須能讓 v2 stub 在下一次 activation 重新出現。

## 目標

1. 未明確指定 `persist_session` 的新 agent 使用 `artifactRootCwd/.pi-subagents/agent-sessions/` 下的 private native session，並可在 cleanup/reload 後 reopen；explicit `true` 與 `false` 在 session 消失後不可由 Agent checkpoint reopen。
2. 只要 `record.session` 仍存在，private、explicit `true`、memory `false` 都沿用目前 same-process `resumeAgent()`，不得另開 session；session 消失後只有 private 可由 Agent checkpoint rehydrate。
3. resume 只接受明確授權的 owner；不得因知道 agent id 就跨 top-level、nested、workflow ownership 讀取或繼續 agent。
4. checkpoint v2 能安全、可驗證地描述 private native session、五種 cwd 語意、model/thinking、ownership 與 worktree reconstruction state；queued/pre-session 狀態不得猜測尚未存在的 metadata。
5. TTL cleanup 只釋放 volatile runtime，不刪除 native private session；record identity、completion/result semantics、transcript locator 與 worktree state 保持可用。
6. worktree agent resume 一律建立新的 detached temporary worktree；任何 reconstruction 或後續 open/preflight 失敗都不得落回主 worktree，且要移除剛建立的資源。
7. resume 建構 child runtime 時，current tools、extensions、resource loader、model、thinking、system prompt、nested tools 與 tool scope 與初次 spawn 完全一致，且只建構一次。
8. 同一個 resumed background turn 的 completion callback 恰好觸發一次；保留既有 bypass-queue 行為，但只有 top-level counter/pool accounting 計入全域 background pool。

## 非目標

- 不支援 TaskExecute resume/rebinding，也不發明 TaskExecute worktree rebinding。
- 不從 transcript 重建 executable session，也不把 transcript 內容塞回 prompt。
- 不支援 cross-model resume；不可因 stored provider/model 不可用而 fallback 到 caller 或 parent model。
- 不新增 user-facing history deletion/GC UI。
- 不匯入 upstream 的 `@handle` 或 tombstone UI。

## 核心不變量

### 0. 五種 cwd 語意

- `artifactRootCwd`：穩定的 project/config artifact root，包含 `.pi-subagents/`；private checkpoint、transcript 與 native session storage 一律以此為根，絕不放在 temporary worktree。
- `resourceCwd`：`DefaultResourceLoader`、agent config、extensions、memory/skill 等 resource discovery 使用的 cwd。
- `originalExecutionCwd`：caller 初次要求的 execution cwd；普通非 worktree run 中可能與 `resourceCwd` 相同，但欄位語意不可合併。worktree reconstruction 不把 temporary first-run path 當成 persisted reconstruction input。
- `repoRoot`：由 `git rev-parse --show-toplevel` 取得並 canonicalize 的 repository root，只用於 worktree capability 與 target subdirectory 驗證。
- `executionCwd`：當前 turn 實際交給 `createAgentSession({ cwd: executionCwd, ... })` 的 cwd；worktree resume 時由 manager 以 `join(freshWorktree.path, originalTargetSubdirectory)` 產生，`originalTargetSubdirectory === ""` 時就是 fresh root。

worktree checkpoint 唯一保存的 cwd reconstruction concept 是 `originalTargetSubdirectory`：caller 原始要求的 cwd 相對 canonical `repoRoot` 的 POSIX-relative path；repo root 為 `""`，caller-supplied subdirectory 則保存其相對路徑。普通非 worktree run 可以讓 `resourceCwd === originalExecutionCwd`，但 checkpoint 與 runtime adapter 仍保留兩個名稱；`artifactRootCwd` 也不可因為當下 cwd 相同而省略。

### 1. 兩種檔案、兩種用途

| 儲存物 | 路徑 | 用途 | 可否執行 resume |
|---|---|---|---|
| Agent View transcript | `.pi-subagents/agent-transcripts/<id>.jsonl` | 顯示 user/assistant/tool messages、歷史 viewer、結果 fallback | 否，永遠 display-only |
| Native executable session | `.pi-subagents/agent-sessions/<session>.jsonl` | 由 Pi `SessionManager.open()` 恢復上下文與下一個 turn | 是，僅透過合法 v2 checkpoint locator |

任何 `Agent View` transcript，即使內容看起來完整，也不得被 `SessionManager.open()`、`createAgentSession()` 或 resume prompt 使用。v1 checkpoint 的 `transcriptPath` 也只能指向 display-only history；不得從 v1 transcript 推斷 native session。

### 2. Persistence precedence

每次新建 child session 依下列順序決定儲存策略。resume 先檢查 `record.session`：若 live session 尚在，private、explicit `true`、memory `false` 都直接沿用目前 same-process `resumeAgent()`，絕不呼叫 `SessionManager.open()`。只有 session 已因 cleanup/reload 消失時才進入下表；此時不能建立新 session 掩蓋原 session。

| `persist_session` | 新 session 行為 | `session_dir` | session 消失後的 Agent checkpoint resume |
|---|---|---|---|
| `true` | 保留目前 normal/custom 行為：`SessionManager.create(executionCwd, configuredSessionDir ?? defaultSessionDir)` | 只有此列有效 | 否；保留 Pi normal/custom `/resume` 語意，Agent checkpoint 不保存或 reopen 任意 explicit 路徑 |
| `false` | `SessionManager.inMemory(executionCwd)` | 忽略 | 否；只保留 display transcript/record semantics，清理或 reload 後故意不可 executable resume |
| 未設定 | 新的 private durable default：`SessionManager.create(executionCwd, privateDir)` | 忽略 | 是；`privateDir = artifactRootCwd/.pi-subagents/agent-sessions/`，且只從通過 validator 的 v2 locator reopen |

Automatic private executable session 不設定 `parentSession`。它不是 parent Pi session 的 child branch，普通 Pi `/resume` 不會掃描 `.pi-subagents/agent-sessions/`；Agent View 與 pi-subagents 自己的 v2 checkpoint 是唯一入口。private storage 永遠使用 `artifactRootCwd`，不可使用 temporary worktree。`session_dir` 不得影響未設定或明確 `false` 的分支。

Pi peer lower bound 維持 `>=0.80.8`。實作使用 `SessionManager.open(file, privateDir, executionCwd)` 與 `createAgentSession({ cwd: executionCwd, sessionManager, resourceLoader, sessionStartEvent })`；不得把 `cwdOverride` 或 `parentSession` 當成 `CreateAgentSessionOptions` 欄位。`parentSession` 是否存在以 `sessionManager.getHeader()?.parentSession` 驗證。

### 3. Resume authority

所有 resume 都先驗證 owner，再讀檔、建立 worktree 或建構 session：

- **Top-level Agent tool：** authority 必須帶 canonical caller `artifactRootCwd`；只有 `ownership.kind === "top-level"` 且 persisted `artifactRootCwd` 相同的 record 可被 resume；含 `parentAgentId` 或 workflow ownership 的 record 一律拒絕。
- **Nested tool：** authority 必須帶 canonical caller `artifactRootCwd` 與 exact `parentAgentId`；`ownership.kind === "nested"` 且 persisted artifact root、`parentAgentId` 都必須 exact match。只有 type/description 相同不算授權。
- **Workflow host：** authority 必須帶 canonical caller `artifactRootCwd`、exact workflow id 與 runtime handle；runtime handle 必須 exact match 該 host 的 `records` mapping，且 mapped record 的 `ownership.kind === "workflow"`、persisted artifact root 與 `workflowId` 都 exact match；mapping 只負責 handle → manager id，最終 persisted-owner/root 驗證仍由 `AgentManager` 執行。原本的 `WorkflowHost` runtime mapping 消失後（包含跨 `/reload`）不支援 workflow rebind；不可用另一個 workflow root 或只靠 id prefix 代替檢查。
- TaskExecute 不加入任何 authority path。

caller 可以先做 UX precheck，但任何直接 `AgentManager.resume()` caller 都必須通過 manager 的 `assertResumeAuthority()`；測試必須直接證明繞過 caller precheck 仍會被 manager 拒絕。

拒絕應使用穩定的 `resume-ownership-denied` 錯誤碼與明確訊息，不能以「找不到」掩蓋 ownership violation。`AgentManager` 是最後且唯一的 ownership authority；它先 canonicalize caller `artifactRootCwd` 並與 persisted root 比較，之後才允許任何 checkpoint、locator、worktree 或 model operation；runtime adapter 不自行放寬 owner。

## Checkpoint v2

### 資料形狀

`src/agent-recovery.ts` 新增 v2 discriminated data model。實際欄位名稱可依既有命名微調，但語意與必要性不可降低：

```ts
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

export interface AgentRecoveryCheckpointV2 {
  version: 2;
  id: string;
  type: string;
  description: string;
  status: AgentRecoveryStatus;
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  resultConsumed?: boolean;
  toolCallId?: string;
  toolUses: number;
  lifetimeUsage: LifetimeUsage;
  compactionCount: number;
  transcriptPath?: string;
  runtime: {
    depth: number;
    maxSubagentDepth: number;
    rootSessionId?: string;
  };
  session: AgentRecoverySessionState;
  ownership:
    | { kind: "top-level" }
    | { kind: "nested"; parentAgentId: string; depth: number }
    | { kind: "workflow"; workflowId: string; depth?: number };
  worktree?: {
    repoRoot: string;
    baseCommitSha: string;
    savedCommitSha?: string;
    originalTargetSubdirectory: string;
  };
}
```

規則：

- 新寫入一律 `version: 2`。v1 仍可被讀取作 display-only record，但沒有 executable authority；v1 的 `transcriptPath` 永遠不能轉成 `session.locator`。
- `session` 是 discriminated union：queued 或尚未建立 native session 的 record 使用 `pending`，不得猜 provider/model/thinking/locator；`memory` 與 `explicit` 在 session 消失後是 non-executable display stubs；只有 `private` 可由 Agent checkpoint reopen。
- private state 唯一保存 native `sessionId`、validated locator、exact provider/model/thinking；open 前必須確認 session header 的 `id === sessionId`。`artifactRootCwd`、`resourceCwd`、`originalExecutionCwd` 的語意不可互換，fresh `executionCwd` 由本次 runtime/worktree reconstruction 產生。
- `runtime.depth`、`runtime.maxSubagentDepth`、`runtime.rootSessionId` 是 resumed child 重建 nested tools 的持久 identity。checkpoint write、validation 與 restore 必須完整 round-trip；不得在 reload 後從 caller authority 或目前 parent session 猜回這三個值。
- 未知 future version、corrupt checkpoint、缺 required v2 fields（包含 `runtime` identity）必須 fail closed：可保留為不可執行的歷史提示與 stable diagnostic，但不得嘗試猜欄位或 open session。
- v2 private checkpoint 不要求 transcriptPath 存在才能由 `restoreRecovered()` 恢復 stub；native executable session 與 Agent View transcript 是獨立來源。v1 仍只供 display/history。
- `provider` 與 `modelId` 必須是 session 實際使用的 exact identity，不可只保存 fuzzy input 或顯示名稱。`thinking` 是 session 實際有效值；若 Pi 在建立時 clamp，checkpoint 保存 clamp 後的值。
- checkpoint 寫入以 atomic temporary file + rename；validation 失敗不得覆蓋上一份有效 checkpoint。

### Private locator validator

新增集中 validator（可放在 `src/agent-recovery.ts` 的小型 helper，若檔案過長再拆成 `src/agent-session-storage.ts`），其輸入為 `artifactRootCwd` 與 persisted locator，輸出為已驗證的 absolute native session file 或帶 stable code 的錯誤。

只接受一個直接子檔案的 safe basename：

```text
.pi-subagents/agent-sessions/<safe-basename>.jsonl
```

`<safe-basename>` 不得為空，且只能含 implementation 明確允許的安全字元；不得含 `/`、`\\`、`.` 或 `..` path segment、NUL，亦不得透過多層 segment 表達子路徑。creation 與 reopen 都必須檢查 namespace 與 file 的 symlink；新建完成後也要對 `getSessionFile()` 做同一份 regular/non-symlink/containment validation。

reopen 在呼叫 `SessionManager.open()` 前必須自行驗證：locator lexical boundary、namespace/file 存在、`lstat` 顯示 regular file 且非 symlink、`realpath()` 仍在 private namespace、每一個非空 JSONL line 都能 parse、第一行是受支援的 Pi session header、header `id` 等於 checkpoint 的 `sessionId`，以及 header version/shape 受支援。`SessionManager.open()` 單獨不算 validator，因 Pi 0.80.8 對 missing path 會建立新 session，且會跳過 malformed JSONL line。檔案不存在、JSONL 損壞、Pi session 格式不相容要分別回傳 stable explicit error；不能把任何一種情況轉成新 session 或主 worktree 執行。

建議穩定錯誤碼：

- `resume-checkpoint-missing`
- `resume-checkpoint-invalid`
- `resume-session-locator-invalid`
- `resume-session-missing`
- `resume-session-corrupt`
- `resume-session-incompatible`
- `resume-model-unavailable`
- `resume-invalid-options`
- `resume-worktree-missing-cwd`
- `resume-worktree-invalid-ref`
- `resume-ownership-denied`

## Runtime adapter 與 session 建構

### 單一路徑

`src/agent-runner.ts` 新增一個窄介面與一個共用 helper；`runAgent()` 的 create path 與 manager resume 的 private reopen path 都必須呼叫同一個 helper。Manager 不負責 loader、prompt、tool scope、model resolution 或 nested tool 建構；model/runtime resolution 由 adapter 完成。

```ts
export type ChildSessionMode =
  | {
      kind: "create";
      artifactRootCwd: string;
      resourceCwd: string;
      originalExecutionCwd: string;
      executionCwd: string;
      privateDir?: string;
      persistence: "private" | "explicit" | "memory";
    }
  | {
      kind: "open";
      artifactRootCwd: string;
      resourceCwd: string;
      originalExecutionCwd: string;
      executionCwd: string;
      privateDir: string;
      file: string;
      sessionId: string;
      persistence: "private";
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

`prepareChildSession()` 必須把目前 `runAgent()` 中的以下建構全部集中一次：config/agent config、`artifactRootCwd`/`resourceCwd`/`originalExecutionCwd`/`executionCwd`、env、system prompt 與 memory/skill extras、extensions/resource loader、built-in/custom/nested tools、model runtime、thinking、settings manager、session manager、`createAgentSession()`、session name、extensions bind 與 live tool scope。create 時使用 `session_start` reason `fork`；private open 時使用 reason `resume`。runtime adapter 只接收 manager 已授權的 final `executionCwd` 與 record-derived `childIdentity`；caller authority context 不進入 resumed child nested identity。

- private create：先檢查 `artifactRootCwd/.pi-subagents/agent-sessions/` namespace boundary，再使用 `SessionManager.create(executionCwd, privateDir)`；建立後取得 native `sessionId`/file 並再次驗證 file。
- private reopen：先完成 locator/session JSONL/header validator，再使用 `SessionManager.open(file, privateDir, executionCwd)`；`executionCwd` 是 worktree reconstruction 後的新路徑。
- 建構 session 的實際呼叫必須是 `createAgentSession({ cwd: executionCwd, sessionManager, resourceLoader, sessionStartEvent: { type: "session_start", reason: "resume" } })`（create 時 reason 為 `fork`）。`CreateAgentSessionOptions` 不放 `cwdOverride` 或 `parentSession`；private lineage 以 `sessionManager.getHeader()?.parentSession === undefined` 驗證。
- adapter 以 `modelRegistry.find(provider, modelId)` 取得 exact stored model，再以 `hasConfiguredAuth()` 檢查可用性；不得呼叫 fuzzy/general-purpose/parent fallback。建立後比對 native session context 的 provider/model 與 checkpoint，並確認 Pi 實際有效 thinking 等級符合 checkpoint；失敗一律 `resume-model-unavailable` 或 `resume-session-incompatible`。
- caller 的 model、thinking、max turns、isolated、inherit context、isolation、schedule 等 spawn-only override 在 resume 時拒絕；schema-required 的 `subagent_type` 與 `description` 只為 schema/輸入相容，執行與顯示使用 stored record，不採用 caller 值。
- nested tools、current extension allowlist、resource loader、memory、system prompt 與 original `type` 從 record/checkpoint 重建；`AgentResumeRuntimeDependencies` 明確提供 nested manager 與 record-derived `childIdentity`，使 nested tools 可被重建，而 caller authority 的 parent id 不會污染 child identity。resume prompt 本身只是新 user turn，不包含 transcript replay。

### Manager 與 adapter 分工

`AgentManager` 仍是唯一的 lifecycle owner，負責：

- record map、既有 queue/bypass 行為、global background counter/pool、abort/await、completion callback。
- checkpoint 寫入與 restore、terminal TTL、resultConsumed/toolCallId/completion semantics。
- persisted owner/root validation 與 nested/workflow/top-level pool policy；這是最後 authority，不可由 caller 繞過。
- worktree target state、fresh worktree reconstruction、cleanup、commit capability preservation 與 repo tracking；runtime adapter 不建立或移除 worktree。

`AgentManager.resume()` 先完成 authority 與 busy checks。若 `record.session` 存在，private、explicit `true`、memory `false` 都直接進現有 live `resumeAgent()`，不要求 executable checkpoint、不建立 worktree、不呼叫 `runtime.rehydrate()` 或 `SessionManager.open()`。只有 session 不存在時，才要求 v2 private checkpoint，執行 locator/model/worktree preflight，由 manager 產生最終 `executionCwd`，再呼叫收到該 cwd 的 `runtime.rehydrate()`；model/provider/auth resolution 屬 adapter，不屬 manager。任何 preflight 或 rehydrate 失敗都不得改變原 terminal record 的 status、result、error、completedAt、resultConsumed、toolCallId。成功後才進入 running state，並以既有但擴充過的 `resumeAgent()` 執行新 prompt。

建議介面：

```ts
async resume(
  id: string,
  prompt: string,
  runtimeFactory: AgentResumeRuntimeFactory,
  authority: ResumeAuthority,
  signalOrOptions?: AbortSignal | ResumeOptions,
  options?: ResumeOptions,
): Promise<AgentRecord | undefined>;
```

`ResumeAuthority` 必須包含 canonical caller root：

```ts
export type ResumeAuthority =
  | { kind: "top-level"; artifactRootCwd: string }
  | { kind: "nested"; artifactRootCwd: string; parentAgentId: string }
  | { kind: "workflow"; artifactRootCwd: string; workflowId: string; runtimeAgentId: string };
```

caller 可以先做 UX precheck，但 manager 必須先 canonicalize `authority.artifactRootCwd`、與 persisted `record.artifactRootCwd` exact compare，再進行任何 checkpoint、locator、worktree 或 model operation；direct manager bypass test 必須由 manager 拒絕。錯誤用 `AgentResumeError`（含 stable `code`）拋出；找不到普通 record 才可保留目前的 `undefined`/not-found surface。

### Resume invocation contract

resume branch 必須直接從 raw params 在 spawn、type/config/model resolution 之前分流：`const isBackground = params.run_in_background ?? false`。schema-required 的 `subagent_type` 與 `description` 必須存在，但只作輸入驗證；執行與顯示一律使用 stored record 的 type/description/config。resume 允許的控制只有 `prompt`、`resume`、`run_in_background` 與 `signal` semantics。此分支不得先呼叫 `resolveSpawnType`、針對 caller type 的 `getAgentConfig` 或 `resolveAgentInvocationConfig`；stored type/config 只在 manager authority 通過後由 rehydrate runtime 載入。

runtime factory 也必須在 manager authority 通過後才收到 `nestedManager` 與 record-derived child identity；caller 的 parent id 只存在 `ResumeAuthority`，不傳入 resumed child 的 nested runtime。

若 request 帶有任何 spawn-only optional override：`model`、thinking level、`max_turns`、`isolated`、`inherit_context`、`isolation` 或 `schedule`，必須以 stable `resume-invalid-options` 拒絕，不得採用，也不得以 caller/parent fallback。不存在的 stored type/config、exact provider/model 無法取得或 auth 不可用時同樣 fail closed；不可落入 general-purpose fallback。

## Terminal TTL 與 reload

terminal record 到達 TTL 時：

1. flush durable history 與 optional `.output`；
2. `AgentSession.dispose()` 以同步呼叫釋放 live native session；不假設它會發出 `session_shutdown`；
3. 清除 `session`、`promise`、`abortController`、`historyFile`、`outputFile`、`outputCleanup`、大 `result` 等 volatile handles；
4. 保留 `id`、type/description/status、`startedAt/completedAt`、`resultConsumed`/`toolCallId`、lifetime usage/compaction、v2 private locator/sessionId、checkpoint、ownership、transcriptPath 與 worktree state；
5. 寫回 v2 stub checkpoint；private native session file 不刪除，explicit user session file 也不由本功能刪除。

`dispose()` 與下一次 `session_start` 的 restore 必須讓 v2 private stub 回到 manager；private stub 不要求 transcriptPath 存在。restore 後仍可由有權限的 top-level/nested caller reopen；workflow 只有原 `WorkflowHost` mapping 尚存時可 rehydrate，跨 `/reload` 不可 rebind。v1 record 只恢復 display/history stub，不可 resume。明確 `persist_session:false` 的 memory record 在 live session 被清理或 reload 後不可 executable resume；explicit `true` 也只保留 Pi normal/custom `/resume` 語意。

有 live `record.session` 時不 reopen，直接使用現有 same-process `resumeAgent()`。reopen 前記錄一次 `historyStartIndex = session.messages.length`；同一 index 同時傳給 transcript stream 與 `resumeAgent()`，避免 replay 舊歷史。per-turn callbacks/subscriptions 只由擴充後的 `resumeAgent()` 管理，`rehydrate()` 不重複訂閱。

successful new turn 開始時才把 `resultConsumed` reset 為 `false`；preflight 失敗不得修改 `resultConsumed`、`toolCallId` 或任何 terminal field。terminal result callback 與 notification 仍維持現有 semantics。每次 resume turn 只能呼叫一次 `onComplete`；background resumed work 延續既有 bypass-queue 行為，只維護 counter/pool accounting，且只有 top-level ownership 計入 `runningBackground`，nested 與 workflow child 不計入全域 pool。

任何 open、model、checkpoint、worktree 或 nested runtime 失敗都必須：

- 回傳 stable explicit error；
- 保持舊 terminal record 的狀態與 result semantics 不變；
- 不執行新 prompt，不發出 started/completed callback；
- 若已建立新 session 或 fresh worktree，先同步 dispose/remove 它們；
- 不在 main worktree 執行。

## Worktree resume

### Persisted state

初次 worktree spawn 必須在 checkpoint v2 保存：

- canonical `repoRoot`（`git rev-parse --show-toplevel` 的完整 absolute path）；
- `baseCommitSha`：驗證為完整 SHA 且 object type 為 commit；
- cleanup 後最後一個可用的 `savedCommitSha`（若本輪或之前有變更）；不可因本輪無變更而清掉前一輪 saved commit；
- `originalTargetSubdirectory`：caller 原始要求 cwd 相對 `repoRoot` 的 POSIX-relative path；plain isolation at repo root 為 `""`，caller-supplied cwd 才保存其相對 subdirectory；
- isolation mode。

`AgentManager` 擁有上述 state 與 reconstruction/cleanup orchestration；`src/worktree.ts` 只提供低階 worktree/git primitive。不可保存 temporary first-run path、任意 branch/ref 或把 temporary path 當成 `originalExecutionCwd`，因 cleanup 後 temporary path 已不存在。private storage 仍固定使用 `artifactRootCwd`，不可建在 temporary worktree 內。

### Rehydrate

resume isolation 時由 `AgentManager` 執行：

1. 驗證 canonical `repoRoot` 仍是可用 git worktree、`baseCommitSha` 與 `savedCommitSha`（若有）存在且 object type 為 commit，並驗證 `originalTargetSubdirectory` 位於 repository root；
2. 以 `savedCommitSha ?? baseCommitSha` 建立 fresh detached temporary worktree，永不使用 main tree；
3. 產生唯一的 fresh effective `executionCwd = join(freshWorktree.path, originalTargetSubdirectory)`，subdirectory 為 `""` 時就是 fresh root；
4. 將這個已授權的 final `executionCwd` 傳給 runtime adapter；adapter 只呼叫 `SessionManager.open(file, privateDir, executionCwd)` 與 child session helper，不建立或移除 worktree；
5. resume 結束後沿用既有 cleanup，將本輪最新 saved commit 更新回 checkpoint，若本輪無變更則保留前一輪 `savedCommitSha`；
6. repo/commit/subdir 任一缺失或 object 非 commit 時回傳 `resume-worktree-missing-cwd` 或 `resume-worktree-invalid-ref`；若 session/model/open 或任何後續 preflight 失敗，manager 移除剛建立的 fresh tree，絕不得把 cwd 改成 main worktree。

既有 `isolation: "worktree"` 的 strict fail-loud 行為保留；不能因 rehydrate 困難而靜默 fallback。

## UI、history 與普通 Pi resume

- Agent View 的 history viewer 繼續使用 `readAgentHistory()`/`readAgentHistoryResult()`，但只作顯示與結果 fallback。
- `canOpenAgentHistory()` 可以因 transcriptPath 開啟 history；這不代表 record 有 executable session。
- private native session 只存在 `artifactRootCwd/.pi-subagents/agent-sessions/` 且沒有 `parentSession`；普通 Pi `/resume` 不應列入它。contract test 必須使用 real `SessionManager.list(artifactRootCwd)` 與 `SessionManager.listAll()`，分別 assert neither result contains private session/file；另行 assert private path 與 normal path separation，以及 `privateManager.getHeader()?.parentSession === undefined`。不要以 UI 隱藏或假設 normal directory 名稱替代這些檢查。
- 不新增 history deletion/GC UI；private native session 由 cleanup 保留，清理策略不在本 feature 擴大。

## 驗收標準

1. unset/true/false 三種 persistence precedence 與 `session_dir` scope 都有 targeted tests；live session 三種分支都證明不會 open，session 消失後只有 private 可由 Agent checkpoint reopen。
2. private create 使用 `artifactRootCwd/.pi-subagents/agent-sessions/`、不設 `parentSession`，並以 path separation、`SessionManager.list(artifactRootCwd)`、`SessionManager.listAll()`、header assertion 四個獨立 contract 證明普通 Pi `/resume` 不可見。
3. checkpoint v2 round-trip 保存 private 的 native `sessionId`、exact model/thinking、artifact/resource/original cwd、ownership、`runtime.depth/maxSubagentDepth/rootSessionId` 與 worktree `originalTargetSubdirectory` state；pending/memory/explicit 不可執行；v1 display-only；future/corrupt fail closed；private stub 不要求 transcript。
4. private locator 的 absolute/traversal/backslash/NUL/empty segment/multi-segment/symlink/non-regular/realpath escape 全部拒絕；create 與 reopen 都驗證 namespace/file。
5. open 前驗證 session exists、regular/non-symlink、JSONL 每行、首行 header、supported version 與 header id/sessionId；missing/corrupt/incompatible 回傳穩定錯誤且舊 terminal state 不變。
6. resume branch 早於 spawn/type/config/model resolution；stored type/provider/model/thinking/isolation authoritative，spawn-only options 用 `resume-invalid-options` 拒絕；exact model 使用 `find(provider, modelId)` + `hasConfiguredAuth()`，type/model/auth 消失不 fallback。
7. `runAgent()` 與 private reopen 共用一個 child-session helper，使用正確 `SessionManager.open(file, privateDir, executionCwd)` 與 `createAgentSession({ cwd, sessionManager, resourceLoader, sessionStartEvent })`；runtime config、extensions、resource loader、model/thinking、system prompt、nested tools 只重建一次。
8. live session uses no open；reopen 使用一次 `historyStartIndex`；per-turn callbacks 僅由 `resumeAgent()` 綁定；sync dispose 不假設 `session_shutdown`；新 session/worktree 失敗會 cleanup。
9. TTL、dispose、`/reload` reconstruction harness 能恢復 top-level/nested v2 private stub；`resultConsumed`/`toolCallId` failure unchanged；成功的新 turn reset `resultConsumed`，resumed counter 與 completion exactly once。
10. nested exact parent、workflow exact mapping/root、canonical caller artifact-root scope、manager bypass authority 與 same-id other-project rejection tests 通過；workflow 跨 `/reload` 明確不支援；TaskExecute 不新增支援。
11. worktree 用 canonical repoRoot、full commit SHA capability、savedCommitSha ?? baseCommitSha 建 fresh detached tree，保留 `originalTargetSubdirectory`（repo root 為空字串）；no-change 保留前次 saved commit；任何後續 preflight/open failure 移除 fresh tree，永不在 main worktree 執行。
12. targeted tests、full `npm test`、lint、typecheck、build 與 `git diff --check` 均屬本計畫授權的 verification；commit、push、publish 與其他 git mutation 不授權。
