# v0.17.17：0.17.6 之後功能保存規格

## 文件用途

這組文件是 **v0.17.17 的文件交付物**：保存 `v0.17.6` 之後、程式碼可能回退前的功能契約，讓日後可以按功能選擇性恢復。它不是新的 runtime 設計，也不取代原始測試。`v0.17.17` 保留為 Git／文件里程碑；npm 未公開該保留版本槽後，v0.17.18 僅重發相同 rollback runtime，第一個未來功能恢復版本從 v0.17.19 開始。

- **基準**：`64bbbb0`（`chore: release 0.17.6`，v0.17.6）；其父提交 `77de83f` 是 scrollbar 實作。
- **保存範圍**：基準之後至目前 `bad54e4` 的功能；上游整合參考 `upstream/master` 的 `e955e29`。
- **既有準確文件**：
  - [`docs/superpowers/specs/2026-09-30-upstream-event-workflow-partial-history-design.md`](superpowers/specs/2026-09-30-upstream-event-workflow-partial-history-design.md)
  - [`docs/superpowers/plans/2026-09-30-upstream-event-workflow-partial-history.md`](superpowers/plans/2026-09-30-upstream-event-workflow-partial-history.md)
  - [`docs/superpowers/specs/2026-09-30-conversation-viewer-scrollbar-design.md`](superpowers/specs/2026-09-30-conversation-viewer-scrollbar-design.md)
  - [`docs/superpowers/plans/2026-09-30-conversation-viewer-scrollbar.md`](superpowers/plans/2026-09-30-conversation-viewer-scrollbar.md)
  - [`docs/rpc.md`](rpc.md)、[`docs/workflows.md`](workflows.md)

## 保存文件

| 主題 | 規格 |
|---|---|
| Durable agent history、transcript 與重新開啟 | [`post-0.17.6-durable-history-spec.md`](post-0.17.6-durable-history-spec.md) |
| Workflow、lifecycle events、cross-extension RPC | [`post-0.17.6-workflow-rpc-lifecycle-spec.md`](post-0.17.6-workflow-rpc-lifecycle-spec.md) |
| Nested agents | [`post-0.17.6-nested-agents-spec.md`](post-0.17.6-nested-agents-spec.md) |
| Recovery、stop、shutdown | [`post-0.17.6-recovery-shutdown-spec.md`](post-0.17.6-recovery-shutdown-spec.md) |
| Agents roster、history navigation、ConversationViewer | [`post-0.17.6-agents-roster-viewer-spec.md`](post-0.17.6-agents-roster-viewer-spec.md) |
| UI latency findings 與 v0.17.6 interaction baseline | [`post-0.17.6-ui-latency-baseline-spec.md`](post-0.17.6-ui-latency-baseline-spec.md) |

## 不可遺失的 v0.17.6 baseline

- `b599e0e`（v0.17.5）建立 read-only Tool Output 的 **in-place preview**；離開 preview 回到同一個 ConversationViewer。
- `77de83f` 加入主 ConversationViewer 的右側 scrollbar rail；`64bbbb0` 將此契約標為 v0.17.6。
- 主 viewer 必須保留 `[preview]`、`[Esc]`、`w` focused-tool preview、鍵盤/wheel 滾動、read-only history，以及 preview 不改變主 viewer focus/layout 的行為。

後續整合（尤其 `8d4d4a7`）不得用上游 viewer、FleetView 或 overlay 取代這個 baseline。

## 主要 post-baseline 提交索引

- `8d4d4a7`：整合 upstream Workflow、lifecycle/RPC 與 durable agent history。
- `8976c63`、`2966cd5`：nested delegation、深度/allowlist 與 fail-closed agent type。
- `86c72ae`：background-by-default 及 background resume wiring。
- `9afe114`：child session 在 dispose 前發出 `session_shutdown`。
- `a9db27b`、`084d177`：RPC `consume`、scopeModels spawn 驗證。
- `221df02`：deterministic Workflow tool、parallel/pipeline、journal、Workflow UI。
- `3d91023`：ConversationViewer render-cost bound。
- `808cd81`、`99f75a1`、`3706edc`、`a72ee7c`、`32aba03`、`5443fc5`、`e42a8de`：Agents roster/history 互動修復、輸入路由、移除重複 FleetView 與降低 redraw overhead。

每一份子規格都列出原始 implementation files、tests、commit/tag；若程式碼回退，只按該表復原，不把本文件的歷史敘述當作可省略的測試。

## 交付限制

本次只新增/保存 Markdown 規格；runtime source、package metadata、`AGENTS.md` 與 publish 均不在範圍。依任務要求，不執行 Vitest、E2E 或 build。
