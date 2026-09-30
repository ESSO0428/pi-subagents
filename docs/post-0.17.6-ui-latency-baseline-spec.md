# UI latency findings 與 v0.17.6 interaction baseline

## 定位

這份文件把 post-0.17.6 的效能／互動修復保存成可驗證的 future-restoration spec。它不是新的 benchmark 結果，也不宣稱本次已重新執行測試。基準 commit/tag 為 `64bbbb0`（v0.17.6），上游 render-cost 來源為 `3d91023`，目前最後相關修復為 `e42a8de`。

## v0.17.6 不可回退的 interaction baseline

- 主 ConversationViewer transcript content 預留右側 rail；scroll offset、viewport、thumb 位置與 hidden content 狀態一致。
- header 保留 `[preview]` 與 `[Esc]`；`[preview]` 和 `w` 使用同一個 focused-tool preview handler，hitbox 不重疊。
- Tool Output preview 是 parent-owned、read-only、in-place；`Esc`/`q`/close 返回原 conversation，不能再開一層 overlay。
- viewer 保留 focus、search、sticky header、read-only history、keyboard/page/wheel scroll、composer/search/footer 幾何。

依據：`b599e0e`（v0.17.5 in-place preview）、`77de83f`（scrollbar 實作）、`64bbbb0`（v0.17.6 release）；詳細設計見 [`superpowers/specs/2026-09-30-conversation-viewer-scrollbar-design.md`](superpowers/specs/2026-09-30-conversation-viewer-scrollbar-design.md)。

## 已觀察的 latency 根因與保存方案

| 發現 | 保存的方案 | 來源 |
|---|---|---|
| transcript/tool/Markdown 事件頻繁時，整個 viewer 重新格式化會造成 render cost 隨歷史長度上升 | `ConversationTimeline`/viewer 保持 bounded cache、hidden tail/truncation，render 不做 filesystem I/O；局部 changed range 只更新受影響 rows | `3d91023`；`src/ui/conversation-viewer.ts`、`src/ui/conversation-timeline.ts` |
| Agents widget 與 duplicate FleetView 都會對同一批 agent lifecycle 做 timer/refresh，造成 redraw 與 input surface 重複 | above-editor `AgentWidget` 作唯一 roster；`FleetView` 移除；`requestUiRefresh(force=false)` 預設正常 render，只有必要時 force | `e42a8de`；`src/ui/agent-widget.ts`、`src/index.ts`、`src/ui/workflow-menu.ts` |
| widget 在 agent records 變動時重建 rows，selector 開啟時 background widget 仍可能搶 key | cache roster/record snapshot，arrow 只改 selection；selector modal 取得 input ownership，key-release/filter/normalized key 統一 | `32aba03`、`a72ee7c`、`5443fc5`；`src/ui/agent-widget.ts`、`src/index.ts` |
| live cleanup、recovery restore 與 nested/RPC activity 令 UI row 閃爍或顯示 stale status | lifecycle update 只 invalidate 有效變更；durable history row 不隨 session handle GC 消失；RPC spawn 也建立 activity | `8d4d4a7`、`af04224`、`808cd81`、`3706edc` |
| 短 terminal、長 roster、多行 activity 會侵蝕 editor 或越過 scrollbar bounds | 依 terminal height 計算 widget budget、保留 editor 最小空間、穩定 overflow/rail；不要新增第二個 roster | `99f75a1`、`32aba03`、`e42a8de`；`src/ui/agent-widget.ts` |

## 原始實作與驗證索引

| 類別 | 原始路徑 |
|---|---|
| viewer cache/render/preview/rail | `src/ui/conversation-viewer.ts`、`src/ui/conversation-timeline.ts`、`src/ui/conversation-blocks.ts` |
| widget cache/refresh/viewport | `src/ui/agent-widget.ts`、`src/index.ts` |
| interaction baseline tests | `test/conversation-viewer.test.ts`、`test/ui/conversation-viewer.test.ts`、`test/conversation-viewer-keybindings.test.ts`、`test/ui/agent-widget.test.ts` |
| render/perf guards | `test/perf/no-fs-on-render.perf.test.ts`、`test/perf/render-invariants.perf.test.ts`、`test/perf/viewer.bench.ts`、`test/perf/widget.bench.ts`、`test/perf/formatters.bench.ts` |
| selector/roster regression | `test/agent-widget.test.ts`、`test/agent-menu-history-navigation.test.ts`、`test/agent-widget-wiring.test.ts` |

## 來源提交／tag

- `64bbbb0`／v0.17.6、`77de83f`：baseline rail/preview contract。
- `3d91023`：upstream render-cost bound；其方案只能移植到 fork 現有 viewer，不可覆蓋 scrollbar 或 preview ownership。
- `808cd81`、`99f75a1`、`3706edc`、`a72ee7c`、`32aba03`、`5443fc5`：roster/history/selector latency 與 input ownership 修復。
- `e42a8de`：FleetView removal、AgentWidget redraw overhead reduction。
- `bad54e4`：local verification resource-safety；它不改 runtime latency，亦不應被誤記為 UI feature。

## 恢復驗收（不在本次執行）

恢復實作時至少要保留：render path 不讀檔、長 transcript cost 有 bound、widget cache 不因 arrow 重建、selector 開啟時 background input 不介入、只有一個 roster、v0.17.6 viewer rail/preview 行為不變。原始 perf/unit/e2e tests 是證據索引；本次任務依要求不執行 Vitest、E2E 或 build。
