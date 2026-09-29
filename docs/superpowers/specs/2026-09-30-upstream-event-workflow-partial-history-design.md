# 上游事件管理、Workflow 與中途歷史設計規格

## 目標

在保留 fork 既有 JSON agent override、ConversationViewer scrollbar、in-place Tool Output preview 與 `.pi-subagents` 本地資料層的前提下，接收上游的 Workflow 與 lifecycle/RPC 事件管理；任何子代理即使被停止、逾時、達到 turn limit、父程序中斷或 session shutdown，都要留下可重新開啟、可解釋的中途歷史。

## 範圍

### 必須接收

- 上游 `SubagentWorkflow`：`agent`、`parallel`、`pipeline`、`workflow`、`phase`、`log`、schema/gate、retry/resume、journal、saved workflow、worker-thread sandbox、Workflow UI。
- 上游 lifecycle/RPC 管理：`subagents:ready`、`created`、`started`、`completed`、`failed`、`steered`、`compacted`、`session_shutdown`，以及 `ping`、`spawn`、`stop`、`consume` reply channels。
- 上游 RPC spawned agent 的 activity tracking、scopeModels 驗證、completion consume 去重與 shutdown 順序。
- 上游 ConversationViewer render-cost bound；但不覆蓋 fork 已有的 scrollbar、`[preview] [Esc]`、focused-tool preview 與 in-place overlay 行為。

### 必須保留或強化

- `src/agent-history.ts`、`src/agent-history-list.ts`、`src/agent-recovery.ts` 與相關測試不可因上游刪檔而移除。
- `.pi-subagents/agent-transcripts/<agent-id>.jsonl` 是 UI 與診斷所需的 durable source of truth；`.output` 是可選的 Claude-compatible side transcript。`output_transcript: false` 只能停用 `.output`，不可停用 `.pi-subagents` 歷史。
- durable transcript 必須涵蓋 Agent tool、foreground/background、scheduler、cross-extension RPC 與 Workflow child 所有 manager spawn path。
- transcript 必須逐步保存 user prompt、assistant partial text、tool call、tool result/error、steering message、compaction 前後可恢復內容與終止狀態。
- checkpoint 必須在 spawn/queued、session 建立、turn/compaction、stop/abort/error/completion/shutdown 等關鍵時點更新；重新啟動時 running/queued checkpoint 若有 transcript，一律還原為可開啟的 `stopped` partial record。
- `/agents` 與 ConversationViewer 必須把 `stopped`、`aborted`、`error`、`steered` 等終止狀態顯示清楚，歷史可重新開啟且 read-only。

## 設計決策

1. **事件管理採上游協定，資料層採 fork durable history。** `pi.events` 只負責 lifecycle/RPC 通知與跨 extension 協調；`.pi-subagents` 保存完整可解釋過程，兩者不互相取代。
2. **歷史附掛下沉至 `AgentManager.spawn()`。** 不再只由 Agent tool 的 `attachTranscript()` 建立歷史；manager 在 caller callback 前確保 project-local transcript 已建立並寫入 initial user entry，因此 scheduler、RPC、Workflow child 也不會漏記。
3. **輸出與歷史分離。** `record.outputFile` 仍受 `output_transcript` 控制；`record.historyFile`／`record.transcriptPath` 永遠建立（若檔案系統失敗，checkpoint 仍保存 metadata 並以 warning 呈現）。streamer 同時寫入兩個檔案時必須去重。
4. **終止狀態不是刪除。** abort/stop 先停止 session、flush transcript、寫 checkpoint，再釋放 live handle；TTL 只釋放 session，不刪除有 `transcriptPath` 的 record。清理與 session shutdown 不得讓已寫入的歷史消失。
5. **Workflow child 的生命週期由 Workflow 管理，但 manager 仍是歷史附掛的單一 seam。** Workflow 事件可維持上游的 hidden child 語義；`.pi-subagents` 以 child id 保存每個 worker 的工具與結果，Workflow journal 另外保存 orchestration progress。
6. **UI 閃動採上游 render-cost bound 加 fork 的 deferred/coalesced refresh。** 不引入第二個 overlay，也不讓 spinner/timer 直接重建整個 viewer；只在有效 session change 時 invalidate/requestRender，並以 render key/cache 保持穩定行數。
7. **套件身份與相容性不盲目照搬。** 保留 `@esso0428/pi-subagents`、JSON override 與 pi `>=0.80.8` peer floor；只在 typecheck/test 證明 API 必須提高時才調整。

## 驗收條件

- upstream Workflow 文件、實作、examples、tests 均可在 fork 中使用，且與 JSON override / existing Agents UI 共存。
- RPC `consume` 可抑制重複 completion notification；RPC spawn/stop/ready/failed 流程有測試。
- 各 spawn path 的 `.pi-subagents` transcript 都存在；在 tool call 尚未完成時 stop/abort，重新開啟仍可看到 prompt、tool call、tool result/error 與 partial assistant output。
- turn limit、provider failure、父 signal abort、session shutdown、SIGKILL 後的 checkpoint restore 都標成 stopped/aborted/error/partial，而不是消失或誤報 completed。
- ConversationViewer 仍保有 scrollbar rail、`[preview] [Esc]`、`w` 同一路徑與 in-place Tool Preview，並有 render cost regression coverage。
- 通過 lint、typecheck、完整 unit、E2E、build、pack；版本更新、commit、push、publish 後以 GitHub 與 npm 狀態獨立確認。

## 不在本次範圍

- 不刪除 fork 的 durable history/recovery 模組來追上游檔案布局。
- 不把上游 package name、作者、README branding 或 peer floor 直接覆蓋到 fork。
- 不以「有 output transcript」替代 `.pi-subagents` durable history。
- 不把 UI flicker 宣稱為上游已完全解決；上游 0.19.0 的 3d91023 是 render cost bound，仍需以 fork regression test 驗證實際事件序列。
