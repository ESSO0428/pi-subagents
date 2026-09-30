# Agents roster、history navigation 與 ConversationViewer 規格

## 基準與目標

本規格保存 `64bbbb0`（v0.17.6）後的 Agents UI 演進，供 v0.17.17 之後逐項恢復。v0.17.6 的 ConversationViewer scrollbar/preview 是不可回退的 interaction baseline；Agents panel 則以 v0.17.0 的 single navigator 為前提，不恢復已移除的 duplicate FleetView。

## UI 契約

- above-editor `AgentWidget` 是唯一 roster；running 與 history selector 有各自 selected row 與 viewport。
- `↑`/`↓`、Pi normalized key event、key-release filtering、`Enter`、`Esc`、`Ctrl-C` 的 ownership 要清楚：modal history selector 開啟時，background widget 不得偷吃輸入。
- `Enter` 可開 live agent viewer 或 read-only durable history viewer；viewer 關閉後回到來源 submenu，selected row/viewport 要恢復。record 被 GC 時，用 nearest valid position，而不是跳回第一列或消失。
- recovered/completed rows 保留 status、model、thinking、cost、tool uses、duration 與 transcript locator；nested child 只出現在 owning parent 的語意下，不污染 top-level roster。
- widget 需按 terminal height 保留 editor 最小空間；overflow 顯示穩定，scrollbar bounds 不因短 terminal 或多行 activity 失效。
- ConversationViewer 必須維持：主 transcript rail、sticky/focus/search、read-only history、`[preview]` 與 `[Esc]` 不重疊、`w` 與 header preview 共用 focused-tool preview、in-place Tool Output preview、鍵盤/wheel scroll。
- viewer history 可顯示 Markdown mode、invocation/model/thinking、cost、truncation notice 與 terminal status，但不能透過 history mode 執行 tool 或改寫 transcript。

## 原始實作與測試

| 類別 | 原始路徑 |
|---|---|
| roster cache、selection、viewport、spinner、cost/status | `src/ui/agent-widget.ts`、`src/agent-color.ts` |
| Agents command/menu、history restore、input routing | `src/index.ts`、`src/agent-history-list.ts`、`src/ui/select-item.ts`、`src/ui/viewer-keys.ts` |
| transcript timeline、focus/search/preview/scrollbar | `src/ui/conversation-viewer.ts`、`src/ui/conversation-timeline.ts`、`src/ui/conversation-blocks.ts`、`src/ui/conversation-search.ts` |
| roster/history unit tests | `test/agent-widget.test.ts`、`test/ui/agent-widget.test.ts`、`test/agent-menu-history-navigation.test.ts`、`test/agent-history-list.test.ts` |
| viewer/key/mouse/search tests | `test/conversation-viewer.test.ts`、`test/ui/conversation-viewer.test.ts`、`test/conversation-viewer-keybindings.test.ts`、`test/ui/conversation-search.test.ts` |
| wiring/model/history tests | `test/agent-widget-wiring.test.ts`、`test/agent-mention-wiring.test.ts`、`test/agent-manager-gc.test.ts`、`test/agent-manager-history.test.ts` |

## 來源提交／tag

- `64bbbb0`（v0.17.6）與 `77de83f`：ConversationViewer scrollbar rail、`[preview]` header action baseline。
- `808cd81`：恢復 Agents history navigator。
- `99f75a1`：修復 legacy Agents panel interactions。
- `3706edc`：恢復 selected row/selection UX。
- `a72ee7c`：把 history input 正確路由給 selector，並保留 live widget。
- `32aba03`：重建 Agents widget lifecycle/cache/interaction model，保留 nested rows 與 durable records。
- `5443fc5`：恢復 selector routing 與 peer metadata，不可讓 modal input 再被 widget 搶走。
- `e42a8de`：移除 FleetView 與其 duplicate redraw/timer；只保留 AgentWidget/workflow menu。
- `3d91023`：上游 ConversationViewer render-cost bound；整合時不可覆蓋 fork 的 rail/preview/in-place preview。

## 選擇性恢復順序

先恢復 durable history rows 與 `AgentWidget` selection cache，再恢復 selector input ownership，最後接 viewer renderer。`src/ui/fleet-list.ts` 及其 tests 是 `e42a8de` 移除的重複 surface，不應為了恢復 roster 而重新引入。
