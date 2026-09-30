# Durable agent history 與 transcript 重新開啟規格

## 狀態與邊界

- 類型：歷史保存／未來選擇性恢復規格。
- 基準：`64bbbb0`（v0.17.6）；主 viewer 的 scrollbar/preview baseline 見 `77de83f` 與 `b599e0e`。
- 主要落地：`8d4d4a7`（v0.17.7 changelog 的 durable history 整合）。
- 目標交付：v0.17.17 必須保留本規格，即使 runtime 先回退到基準。

## 必須恢復的契約

1. 每個可追蹤 spawn 在 queue/start 前建立 project-local `.pi-subagents/agent-transcripts/<safe-id>.jsonl`，寫入 initial user prompt；它是 history/UI/診斷的 source of truth。
2. `Agent tool`、foreground/background、scheduler、mention/resume、cross-extension RPC、Workflow child 都走同一個 manager history seam；不能只在某一個 tool caller 補 transcript。
3. 每個 turn 的 user/assistant/tool result（包含 details、error 與尚未完成的 partial assistant text）都要在 flush 時追加。`output_transcript: false` 只能關閉可選的 `.output` side transcript，不能關閉 `.pi-subagents`。
4. parent record/checkpoint 保存 project-relative `transcriptPath`；清理 live session、TTL、session switch 後，terminal record 仍能由 `/agents` 或 ConversationViewer read-only 開啟。
5. transcript 讀取必須拒絕絕對路徑、`..`、反斜線與不在 `.pi-subagents/agent-transcripts` namespace 的 locator；壞行可以跳過，不得令整份歷史消失。結果在 memory GC 後從 transcript 按需重載。
6. viewer 要保留 v0.17.6 的 scrollbar rail、`[preview]`/`[Esc]` 與 `w` focused-tool preview，不用新的 nested overlay 取代歷史 viewer。

## 原始實作與驗證索引

| 類別 | 原始路徑 |
|---|---|
| JSONL 建立、stream、讀取、path safety | `src/agent-history.ts`、`src/output-file.ts` |
| manager attach/checkpoint、GC 後 history record | `src/agent-manager.ts`、`src/types.ts` |
| Agent tool、resume、scheduler/RPC/Workflow 的共同接線 | `src/index.ts` |
| 歷史選擇與 read-only viewer | `src/agent-history-list.ts`、`src/ui/conversation-viewer.ts`、`src/ui/conversation-timeline.ts` |
| 歷史/結果/安全 locator | `test/agent-history.test.ts`、`test/agent-history-list.test.ts`、`test/output-file-history.test.ts`、`test/output-file-path.test.ts`、`test/output-transcript-wiring.test.ts` |
| manager attach、restore、GC | `test/agent-manager-history.test.ts`、`test/agent-manager-gc.test.ts`、`test/agent-manager.test.ts`、`test/agent-recovery.test.ts` |
| viewer reload/render | `test/conversation-viewer.test.ts`、`test/ui/conversation-viewer.test.ts` |

## 來源提交／tag

- `64bbbb0`（v0.17.6 release）及 `77de83f`：viewer layout/focus baseline。
- `8d4d4a7`：durable transcript、partial history、reopen 與 workflow/RPC history 接線。
- `808cd81`、`a72ee7c`：history record 在 runtime cleanup 後仍留在 navigator，並重新路由 selector。
- `32aba03`、`5443fc5`：Agents widget/selector 修復，避免重新開啟時遺失 durable row。
- 對應既有設計：[`superpowers/specs/2026-09-30-upstream-event-workflow-partial-history-design.md`](superpowers/specs/2026-09-30-upstream-event-workflow-partial-history-design.md)、[`superpowers/plans/2026-09-30-upstream-event-workflow-partial-history.md`](superpowers/plans/2026-09-30-upstream-event-workflow-partial-history.md)。

## 選擇性恢復順序

先恢復 `agent-history.ts`/`output-file.ts` 的資料格式與 `AgentManager` attach/flush，再恢復 history list/viewer wiring，最後接上各 spawn path。若只能恢復部分功能，寧可保留可讀的 transcript 與 read-only viewer，也不要恢復會刪除 terminal history 的 GC。
