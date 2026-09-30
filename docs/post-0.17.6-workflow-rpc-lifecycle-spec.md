# Workflow、lifecycle events 與 cross-extension RPC 規格

## 狀態與基準

這是 v0.17.17 保存用的歷史／未來恢復規格，不是要求本次重新整合 runtime。比較基準為 `64bbbb0`（v0.17.6）；主要功能在 `8d4d4a7`、`a9db27b`、`084d177`、`221df02` 落地。既有完整說明仍以 [`docs/rpc.md`](rpc.md)、[`docs/workflows.md`](workflows.md) 與 upstream partial-history spec 為準。

## Lifecycle 契約

- `session_start` 完成 extension 綁定後才廣播 `subagents:ready`，避免 caller 在 handler 尚未註冊時遺失 ready。
- top-level agent 依序可發出 `subagents:created`、`subagents:started`、`subagents:compacted`、`subagents:steered`，終止時發出 `subagents:completed` 或 `subagents:failed`；nested/workflow-owned child 不應被誤報成獨立 top-level notification。
- child `AgentSession` 由 manager 綁定 extension 後，清理/quit 必須先給其 extension runner `session_shutdown`，再 dispose；詳見 recovery/shutdown 規格。
- completion notification 與 RPC consume 必須可去重；caller 已取得結果後不應再讓 parent model 收到同一份 completion。

## RPC 契約

所有 request 走同一個 in-process `pi.events` bus，reply 為 `subagents:rpc:<name>:reply:<requestId>`，envelope 是 `{ success: true, data? }` 或 `{ success: false, error }`。Protocol version 為 `2`。

| channel | 用途與限制 |
|---|---|
| `subagents:rpc:ping` | 回報 protocol version。 |
| `subagents:rpc:spawn` | 解析 string model、執行 scopeModels、建立 top-level agent，並 await startup error。 |
| `subagents:rpc:stop` | 只允許 top-level owned record；停止 queued/running agent。 |
| `subagents:rpc:consume` | 標記已取用的 terminal result，抑制重複 completion notification。 |

RPC payload 不能偽造 `parentAgentId`、`workflowId`、`resumeSessionFile`、`rootSessionId` 等內部欄位；model 若由 caller 指定，要在 resolved model 上做 scope 檢查。這些限制是安全與 ownership 契約，不是可省略的輸入清理。

## Workflow 契約

`SubagentWorkflow` 是 deterministic script host：在 worker/sandbox 中提供 `agent`、`parallel`、`pipeline`、`workflow`、`phase`、`log` 等 orchestration API，受 schema、gate、concurrency、abort/resume 與 journal 約束；每個 child 仍由 manager 建立 durable history。Workflow progress/journal 與 agent transcript 分離：前者保存編排進度，後者保存每個 child 的對話。

## 原始實作與測試

| 類別 | 原始路徑 |
|---|---|
| event wiring、manager spawn/settle、ready/created/completed | `src/index.ts`、`src/agent-manager.ts`、`src/agent-runner.ts` |
| RPC handlers、reply envelope、scope/ownership/consume | `src/cross-extension-rpc.ts`、`src/model-scope.ts`、`src/model-resolver.ts` |
| Workflow host/runtime/task/journal/schema/progress | `src/workflow/entry.ts`、`host.ts`、`runtime.ts`、`task.ts`、`journal.ts`、`json-schema.ts`、`progress.ts`、`saved.ts`、`worker-source.ts` |
| Workflow UI與註冊 | `src/ui/workflow-card.ts`、`src/ui/workflow-dialog.ts`、`src/ui/workflow-menu.ts`、`src/index.ts` |
| event/RPC 行為 | `test/rpc-lifecycle-gating.test.ts`、`test/cross-extension-rpc.test.ts`、`test/rpc-result-consumption.test.ts`、`test/child-session-shutdown.test.ts` |
| Workflow host/runtime/journal/schema/UI | `test/workflow-tool.test.ts`、`test/workflow-runtime.test.ts`、`test/workflow-task.test.ts`、`test/workflow-journal.test.ts`、`test/workflow-json-schema.test.ts`、`test/workflow-progress.test.ts`、`test/workflow-dialog.test.ts`、`test/workflow-render.test.ts`、`test/e2e/workflow.e2e.test.ts` |

## 來源提交／tag

- `8d4d4a7`：upstream Workflow、lifecycle/RPC、partial-history 的整合基線；同時保存 fork 的 history/ConversationViewer 特性。
- `a9db27b`：新增 `subagents:rpc:consume` 與 result-consumption tests。
- `084d177`：RPC spawn 的 resolved-model `scopeModels` enforcement。
- `af04224`：RPC-spawn activity tracking，確保 widget/ConversationViewer 看得到正確生命週期。
- `9afe114`：child shutdown event 順序。
- `221df02`：Workflow tool、examples、worker runtime、journal 與 UI。
- `e955e29`（`upstream/master`）：lowercase `workflow` tool compatibility 修正；恢復時需保留 fork 的命名 collision guard。

## 恢復注意

先恢復 event/RPC 協定與 manager ownership，再恢復 Workflow worker/UI；不要先把 Workflow child 當成 top-level roster，也不要用 parent session branch 取代 child 的 durable transcript。`docs/rpc.md` 中的 in-process 限制、reply race 與 error strings 也是恢復驗收的一部分。
