# Recovery、stop/abort 與 shutdown 規格

## 目的與來源

本文件保存 v0.17.6（`64bbbb0`）後的 interrupted-run 行為，目標是讓 v0.17.17 留下可檢視、可選擇恢復的規格。主要來源為 `8d4d4a7` 的 durable partial history，以及 `9afe114`／`9afe114` 對 child shutdown 的修正。

## Checkpoint 與狀態契約

- 每個 project 的 `.pi-subagents/agent-checkpoints/<id>.json` 是 atomic、可驗證的 metadata；包含 id/type/description/status、時間、tool uses、lifetime usage、compaction count、invocation 與 transcript locator。
- 可保存狀態：`queued`、`running`、`completed`、`steered`、`stopped`、`aborted`、`error`。terminal status 不是刪除許可；只要有 transcript，就必須可列入歷史。
- checkpoint 必須在 spawn/queue、session 建立、compaction、stop/abort、provider/startup error、completion、session switch/shutdown 等關鍵點更新；terminal checkpoint 前先 flush history/output。
- 啟動時若讀到帶有效 transcript 的 `running`/`queued` checkpoint，必須轉成 `stopped` partial record；不能假報 completed，也不能因 live session 已不存在而丟失。
- orphan、path traversal、壞 JSON、沒有有效 transcript 的 checkpoint/transcript 要被忽略；一個壞檔案不應阻塞其餘歷史。
- `SIGKILL` 無法執行最後 flush；可恢復的語意是「最後一次已寫入 snapshot + stale active checkpoint 於下次啟動轉 stopped」，不是宣稱捕捉到 kill 當下的 delta。

## Stop 與 shutdown 順序

1. queued agent 先從 queue 移除並寫 `stopped` checkpoint；已跑的 agent 發 abort signal，仍要由 settle path flush。
2. `abortAll()`、parent abort、session switch、dispose 都必須能喚醒等待 queue 的 caller，並保留 transcript locator。
3. manager 在釋放 live handle 前 flush history；GC 只移除 session/promise/cleanup，不刪除有 durable transcript 的 row。
4. child session teardown 先發 `session_shutdown` 給已 bind 的 extension runner，再呼叫 `session.dispose()`；handler 要有 bounded timeout，單一 hung handler 不能卡死 quit。
5. dispose 可在自身被單獨呼叫時完成 abort/checkpoint/child teardown；正常 quit 的 shutdown handler 需 await child teardown。

## 原始實作與測試

| 類別 | 原始路徑 |
|---|---|
| checkpoint schema、驗證、atomic write/read | `src/agent-recovery.ts`、`src/agent-history.ts` |
| abort、settle、queue、GC、dispose、child shutdown | `src/agent-manager.ts`、`src/agent-runner.ts` |
| output/history flush 與 partial result | `src/output-file.ts`、`src/status-note.ts` |
| recovery/checkpoint/partial output | `test/agent-recovery.test.ts`、`test/agent-manager-history.test.ts`、`test/agent-manager-gc.test.ts`、`test/output-file-history.test.ts` |
| abort、startup/provider/error 狀態 | `test/abortable.test.ts`、`test/agent-startup-error.test.ts`、`test/subagent-error-status-e2e.test.ts`、`test/agent-runner.test.ts` |
| child shutdown ordering/timeout | `test/child-session-shutdown.test.ts` |
| nested parent cleanup | `test/nested-tools.test.ts`、`test/nested-delegation-e2e.test.ts` |

## 來源提交／tag

- `8d4d4a7`：recovery checkpoint、partial transcript flush、reload/reopen 與 manager seam。
- `9afe114`：`session_shutdown` before child `dispose`（#242）。
- `af04224`：RPC/非 Agent-tool spawn 的 activity 與 lifecycle 接線，避免 recovery row 沒有可見狀態。
- `808cd81`、`a72ee7c`：GC/session cleanup 後恢復 history navigator。
- `64bbbb0`：回退時仍必須保留的 v0.17.6 read-only viewer contract。

## 選擇性恢復順序

先恢復 checkpoint/path validation 與 flush ordering，再恢復 `restoreRecovered`、history row 與 child shutdown。不要用「dispose session」代替 `session_shutdown`，也不要在 abort 前先刪除 history/checkpoint；那會讓部分執行失去可解釋性。
