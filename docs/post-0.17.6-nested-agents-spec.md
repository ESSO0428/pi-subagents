# Nested agents 規格

## 目的與來源

保存 `v0.17.6` 後 nested delegation 的行為，供 v0.17.17 之後選擇性恢復。基準是 `64bbbb0`；主要實作由 `8976c63`（#164）開始，後續由 `8d4d4a7` 與 background/workflow 整合延伸。

## 必須保留的行為

1. child tool 只由 owning parent 建立：`Agent`、`get_subagent_result`、`steer_subagent` 透過 child-safe context 注入，不暴露未授權的全域 manager 操作。
2. 每個 child 帶有 `parentAgentId`、`depth`、`maxSubagentDepth`；達到深度上限時 fail closed。parent settle/abort 時要遞迴停止仍在跑的 children，避免隱形 token 消耗。
3. `allowed_subagents` 若指定只能解析 allowlist；未指定才是所有 enabled agent。nested type 必須從繼承的 `configCwd` 解析，不可污染 process-global registry，也不可藉由 fallback policy 越權。
4. child 的 `get result`、resume、steer 都要檢查 ownership；foreign child 不能讀取、操控或 resume。foreground child 預設 inline 等待並回傳結果；`run_in_background: true` 才交還 id，且 parent 結束前必須可被收回。
5. nested child 與 workflow child 可以共用 manager 的 queue、model scope、worktree/abort/history seam，但 roster/lifecycle notification 不可把 child 假裝成 top-level agent。每個 child 仍應有自己的 durable transcript。
6. nested path 必須保留既有錯誤語意：unknown/disabled type、allowlist violation、depth cap、foreign id 與 startup/isolation error 都回傳 tool error，而不是靜默 fallback。

## 原始實作與測試

| 類別 | 原始路徑 |
|---|---|
| child-safe tools、allowlist、depth、ownership、resume/steer/result | `src/nested-tools.ts`、`src/child-context.ts` |
| parent/child record、queue、abort、usage、history | `src/agent-manager.ts`、`src/agent-runner.ts`、`src/types.ts` |
| child session 注入與工具 veto | `src/index.ts`、`src/output-file.ts`、`src/model-scope.ts` |
| 單元契約 | `test/nested-tools.test.ts`、`test/child-context.test.ts`、`test/model-scope.test.ts` |
| 真實 boundary/print mode | `test/nested-delegation-e2e.test.ts`、`test/subagents-nested-print-mode-e2e.test.ts`、`test/subagents-print-mode-e2e.test.ts` |
| queue/foreground lifecycle | `test/foreground-concurrency.test.ts`、`test/foreground-concurrency-wiring.test.ts`、`test/foreground-concurrency-print-mode-e2e.test.ts`、`test/foreground-result-retrieval.test.ts` |

## 來源提交／tag

- `8976c63`：opt-in nested subagent delegation、child context、depth 與 ownership 基礎。
- `2966cd5`：fallbackSubagent fail-closed dispatch；nested unknown/disabled type 不可任意 fallback。
- `86c72ae`：background-by-default 後仍維持 nested foreground 預設與明確 background opt-in。
- `8d4d4a7`：將 nested spawn 接到 durable history、recovery、Workflow/RPC 及現有 fork UI。
- `9ba6280`、`3f9d35c`：recursive nested print-mode boundary tests。
- `64bbbb0`（v0.17.6）是 UI interaction baseline；nested child 不得破壞主 ConversationViewer 的 scrollbar/preview 行為。

## 選擇性恢復順序

先恢復 `NestedToolContext` 的 ownership/depth/allowlist，再接 manager spawn/abort/history；最後接 background/wait 與 print-mode boundary。不要以「允許 Agent tool」取代 child-safe tool set，也不要以 global agent registry 取代 inherited config root。
