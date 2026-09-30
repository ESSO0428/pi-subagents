# v0.17.17 回退、v0.17.18 registry recovery 與 v0.17.19+ 恢復路線圖

本文件是 v0.17.17 的回退邊界與後續恢復決策，不是 runtime 實作計畫，也不承諾任何日曆日期。v0.17.18 只因 npm 保留但未公開 v0.17.17 而重發相同 rollback runtime；v0.17.17 仍是 Git／文件里程碑，第一個未來功能恢復版本從 v0.17.19 開始。主要規格索引是 [`docs/post-0.17.6-feature-specs.md`](docs/post-0.17.6-feature-specs.md)；各階段都必須以該索引及其保存的原始 implementation、測試與 commit 證據為準。

## 目標與不可變邊界

- [x] 將 v0.17.17 定義為 intentional rollback：runtime/UI reset to v0.17.6 的 [`64bbbb0`](https://github.com/ESSO0428/pi-subagents/commit/64bbbb0)，而不是把後續功能當成已恢復功能。
- [x] 保留 v0.17.6 的 ConversationViewer interaction baseline：scrollbar rail、`[preview]`/`[Esc]`、`w` focused-tool preview、in-place read-only Tool Output preview、keyboard/wheel scroll、focus 與 layout 行為。
- [x] 在回退 runtime/UI 的同時保留 resource-policy metadata、資源規則與文件；特別是目前的 resource-safe local verification 政策（Vitest、E2E、build 需要明確授權，以及既有 worker/resource 限制）不得因功能恢復而被撤回。
- [x] 保存 post-v0.17.6 規格與證據索引；文件保存不代表 v0.17.17 已重新提供該功能。
- [ ] 後續任何恢復都必須先通過單一功能的證據與人工 UI latency acceptance，才可考慮與其他已驗證功能組合。

## v0.17.17 回退內容

- [x] runtime 與 UI 以 `64bbbb0`（v0.17.6）為基準；不得用 upstream viewer、FleetView 或 overlay 覆蓋既有 v0.17.6 viewer contract。
- [x] 保留資源政策的文件與 metadata，不把 resource-policy rollback 混入功能 rollback；恢復功能也不得移除 `AGENTS.md`、CHANGELOG、package/Vitest 設定中對資源安全的約束。
- [x] 本次交付只保存 Markdown 路線圖與既有規格索引；不修改 runtime source、package metadata，不 publish，也不在本路線圖階段執行 Vitest、E2E 或 build。
- [ ] 將所有 post-v0.17.6 功能視為「待證據恢復」，而非在 v0.17.17 中隱式保留或半恢復。

## v0.17.17 暫時移除的功能與保存規格

以下功能在 v0.17.17 runtime/UI 回到 v0.17.6 時暫時不提供；每項都保留可追溯的 archived spec。這些勾選項是恢復清單，不表示本次要在 runtime 中實作。

- [ ] **Durable agent history、transcript 與重新開啟**：`.pi-subagents` JSONL、partial turns、GC 後的 read-only history 與安全 locator。保存於 [`docs/post-0.17.6-durable-history-spec.md`](docs/post-0.17.6-durable-history-spec.md)。
- [ ] **Workflow、lifecycle events 與 cross-extension RPC**：ready/created/completed 等 lifecycle、RPC ownership/consume、deterministic Workflow host 與 journal。保存於 [`docs/post-0.17.6-workflow-rpc-lifecycle-spec.md`](docs/post-0.17.6-workflow-rpc-lifecycle-spec.md)。
- [ ] **Nested agents**：child-safe tool context、parent ownership、depth cap、allowlist、foreground/background 與 recursive cleanup。保存於 [`docs/post-0.17.6-nested-agents-spec.md`](docs/post-0.17.6-nested-agents-spec.md)。
- [ ] **Recovery、stop/abort 與 shutdown**：checkpoint、partial recovery、terminal record、abort/queue 喚醒、`session_shutdown` 順序與 bounded cleanup。保存於 [`docs/post-0.17.6-recovery-shutdown-spec.md`](docs/post-0.17.6-recovery-shutdown-spec.md)。
- [ ] **Agents roster、history navigation 與 ConversationViewer 整合**：single AgentWidget roster、selector input ownership、history row、viewer reopen 與 nested row 語意。保存於 [`docs/post-0.17.6-agents-roster-viewer-spec.md`](docs/post-0.17.6-agents-roster-viewer-spec.md)。
- [ ] **Render-cost 與 UI latency 修復**：ConversationTimeline bounded cache、render path 不讀檔、AgentWidget cache、單一 roster、短 terminal 的 editor budget 與 redraw 限制。保存於 [`docs/post-0.17.6-ui-latency-baseline-spec.md`](docs/post-0.17.6-ui-latency-baseline-spec.md)。
- [x] **v0.17.6 baseline 本身不是待移除功能**：其 viewer rail/preview/read-only 行為是所有後續恢復的不可回退基線；完整索引仍見 [`docs/post-0.17.6-feature-specs.md`](docs/post-0.17.6-feature-specs.md)。

## 恢復證據規則

- [ ] 每次恢復只選一個功能邊界，先從主索引找到對應 archived spec，再核對其中的原始 implementation files、tests、commit/tag 與既有錯誤語意。
- [ ] 先建立 v0.17.6 baseline evidence：確認 viewer rail、preview、focus、keyboard/wheel scroll 與 read-only history 的行為沒有被待恢復變更改寫。
- [ ] 對資料與安全邊界先取證：project-relative transcript/checkpoint、path traversal 拒絕、ownership、allowlist、depth cap、lifecycle 順序都要有可重現的證據。
- [ ] 對 UI 功能另外保存人工操作紀錄：terminal 尺寸、操作步驟、畫面結果、可見延遲與任何回歸；不要把「測試通過」單獨當成 latency acceptance。
- [ ] 若證據不足、行為與 archived spec 不一致，或人工操作出現可見卡頓，該功能停留在待恢復狀態，不與其他功能合併。
- [ ] 本文件本身不執行 Vitest、E2E 或 build；恢復工作是否需要這些檢查，依當時授權與 `AGENTS.md` 的資源政策處理。

## v0.17.19 的決策：只恢復 durable history 基礎層

- [ ] 將 v0.17.19 限定為第一個、可獨立驗證的 durable history/recovery data plane：先處理 transcript 格式、project-local path safety、checkpoint metadata 與 flush/attach seam。
- [ ] 以 [`docs/post-0.17.6-durable-history-spec.md`](docs/post-0.17.6-durable-history-spec.md) 和 [`docs/post-0.17.6-recovery-shutdown-spec.md`](docs/post-0.17.6-recovery-shutdown-spec.md) 為證據邊界；不得順便恢復 nested agents、Workflow/RPC、FleetView 或整套 Agents UI。
- [ ] 確保 `output_transcript: false` 不會關閉 `.pi-subagents` durable history，且 GC/session cleanup 不會刪除仍可讀的 terminal record；壞 locator、壞 JSON 或 traversal input 必須 fail safely。
- [ ] 在接受 v0.17.19 前，人工確認既有 v0.17.6 viewer interaction 沒有 layout/focus/scroll regression；若此基礎層不改 UI，也仍要記錄 baseline 操作結果。
- [ ] v0.17.19 不承諾任何日曆日期；版本成立條件是上述單一功能的證據完整，而不是時間到期或功能數量達標。

## v0.17.19 之後的證據驅動順序

每一列都是獨立候選恢復項；「後續版本」只代表通過前一項 acceptance 後再決定的版本，不預設版本號或日期。

| 順序 | 單一恢復項 | 主要證據與邊界 |
|---|---|---|
| 1 | Durable history 的 history list、read-only reopen 與 reload | [`durable-history`](docs/post-0.17.6-durable-history-spec.md)：先完成 history row/viewer wiring，再接各 spawn path；不得執行 tool 或改寫 transcript。 |
| 2 | Recovery 的 restore、stop/abort 與 child shutdown | [`recovery-shutdown`](docs/post-0.17.6-recovery-shutdown-spec.md)：先保留 checkpoint/flush，再加入 `restoreRecovered`、queue wake-up 與 `session_shutdown` ordering。 |
| 3 | Single Agents roster 與 selector ownership | [`agents-roster-viewer`](docs/post-0.17.6-agents-roster-viewer-spec.md)：先 cache durable rows/selection，再處理 selector input；不得重新引入已移除的 duplicate FleetView。 |
| 4 | ConversationViewer 與 roster 的 latency/render bounds | [`ui-latency-baseline`](docs/post-0.17.6-ui-latency-baseline-spec.md)：bounded cache、render 不讀檔、arrow 不重建 widget、單一 roster、短 terminal 保留 editor 空間。 |
| 5 | Nested agent ownership 與 lifecycle | [`nested-agents`](docs/post-0.17.6-nested-agents-spec.md)：先恢復 child-safe context、ownership/depth/allowlist，再接 manager spawn/abort/history；foreground/background 與 print-mode 另行取證。 |
| 6 | Lifecycle events 與 cross-extension RPC | [`workflow-rpc-lifecycle`](docs/post-0.17.6-workflow-rpc-lifecycle-spec.md)：先恢復 event/RPC protocol、scope 與 ownership/consume，再接非 top-level child 的 activity 顯示。 |
| 7 | Workflow worker、journal、schema 與 UI | [`workflow-rpc-lifecycle`](docs/post-0.17.6-workflow-rpc-lifecycle-spec.md)：最後接 Workflow host/runtime/UI；Workflow child 必須保留自己的 durable transcript，不得冒充 top-level roster。 |

- [ ] 每完成一列，先獨立取證並完成人工 UI latency acceptance，再開始下一列。
- [ ] 若某列需要前列的 seam，仍只接入必要依賴，不把後列功能預先帶入；依賴關係不能成為一次恢復多個 user-facing feature 的理由。

## 人工 UI latency acceptance 門檻

- [ ] **Viewer baseline**：在短、一般與較長 terminal 高度下，檢查 transcript scrollbar rail、hidden content、sticky/focus/search、`[preview]`、`[Esc]`、`w`、鍵盤與 wheel scroll；Tool Output preview 必須仍是 parent-owned、read-only、in-place。
- [ ] **History path**：從 running、completed、stopped、recovered record 開啟 viewer，關閉後回到原 selector；selected row/viewport 不應跳回第一列，GC 後仍能從 durable transcript 讀取。
- [ ] **Roster path**：大量 agent activity、長 transcript、多行 activity 與短 terminal 下，只有一個 roster；selector 開啟時 background widget 不得搶 key，editor 必須保留最小空間。
- [ ] **Render path**：人工觀察長歷史與頻繁事件時沒有隨歷史長度惡化的可見卡頓；同時以規格列出的 perf guards 驗證 render 不做 filesystem I/O，並記錄證據而非臆測數字門檻。
- [ ] **失敗處理**：任何可見延遲、focus/layout 變化、重複 redraw、stale row 或 history 消失都代表該單一功能未接受；先隔離或回退該變更，不得進入組合 release。

## 0.17.19 與後續 release 的組合決策

- [ ] **v0.17.19**：只接受 durable history/recovery 基礎層；不把 Agents UI、nested、RPC 或 Workflow 當作同一 release 的附帶恢復。
- [ ] **後續版本**：只有已在獨立變更中完成 spec、targeted evidence 與人工 UI latency acceptance 的功能，才可在後續 release 與另一個已接受功能組合。
- [ ] 組合前要重新執行人工回歸矩陣，特別是 viewer baseline、selector input ownership、長 transcript render 與 resource-policy metadata；單項通過不等於組合後通過。
- [ ] 若組合回歸失敗，拆回最後一個已接受的功能邊界；不得為了湊版本內容而放寬 acceptance 或重新引入 duplicate UI。
- [ ] 版本號只在證據與 release gate 都成立後決定；本路線圖不指定未來日期、不 publish、不替使用者執行 release 操作。

## 完成定義與範圍守則

- [ ] 每個恢復項都有對應 archived spec、implementation/test/commit evidence、人工 UI latency 紀錄與明確的保留/回退決策。
- [ ] 所有恢復都維持 `64bbbb0` 的 viewer baseline，並保留 resource-policy metadata、資源規則與文件。
- [ ] 不以功能數量、日期或單次自動檢查取代逐項 acceptance；不可接受的功能留在文件化的待恢復狀態。
- [x] 本次工作只新增本根目錄 `ROADMAP.md`；沒有 runtime edits、測試、build 或 publish。
