# pi-subagents 路線圖

只記錄**尚未完成**的工作。完成的項目直接移除，不保留完成記錄；功能的完整歷史以 [`CHANGELOG.md`](CHANGELOG.md) 為準。最終狀態是空檔案。

上游 fork 為 `upstream` remote（`git show upstream/master:<path>`）。後續只做 feature port，不做 large upstream merge。

## 仍成立的恢復規則

- 一次只做一個功能邊界；功能與 UI 同時交付，不留看不見的中間狀態
- 每項都要有對應的 archived spec 與上游 implementation/test/commit 證據
- UI 功能必須有人工操作紀錄（terminal 尺寸、操作步驟、畫面結果、可見延遲）。不要把「測試通過」單獨當成 latency acceptance
- v0.17.6 的 ConversationViewer baseline（scrollbar rail、`[preview]`/`[Esc]`、`w` preview、in-place read-only Tool Output、鍵盤與 wheel scroll）不可被改寫
- 資源安全政策不因功能恢復而撤回：Vitest / E2E / build 在此裝置需明確授權

## 未來：讓模型知道 nested 怎麼用

`allowed_subagents` 目前只能由人手寫進 agent 檔案。上游刻意如此 — 它的 `Agent` 工具描述、`promptGuidelines`、`skills/`、範例 agent 檔全都沒有提 nested，所以模型不會自己開自己的權限。這是對的安全立場，不是缺陷。

若要改善可用性，安全作法是**只教模型怎麼「建議」**，不給它自己開的權限：

- 在建立/編輯 agent 檔案的流程裡提示 `allowed_subagents` 的存在與語意（`all` / 逗號清單 / 省略 = 不開）
- 明確標示這是授權邊界，該由人確認，不接受模型自行套用
- 不在 `Agent` 工具描述或 `promptGuidelines` 中指示模型對既有 agent 開啟巢狀

設計前提未定：這段提示該放哪（工具描述、skill、`/agents` 建立精靈的表單、還是 agent 檔的模板註解），以及如何避免模型把「建議」當成「已授權」。

## 交付 B：Workflow

上游規模約 6,200 行：`src/workflow/**` 11 檔約 4,458 行（`runtime.ts` 1,219 + `worker-source.ts` 781 為骨幹）、`ui/workflow-*.ts` 3 檔約 1,778 行（`workflow-dialog.ts` 1,115 最大）。含 `node:vm` sandbox、worker thread、journal，是新的執行模型而非 UI，風險等級與 nested 不同，不與其他交付合併。

- API：`agent()` / `parallel()` / `pipeline()` / `phase()` / `log()` / `args()`
- `pipeline()` stage 之間無 barrier；`parallel()` 是 barrier
- `agent({ gate: "npm test" })` 以執行指令驗證 child；`agent({ resume: "<label>" })` 接續 child
- live card + `/agents → Workflows` 兩欄 inspector
- workflow 自己擁有的 agents 不列於任何 top-level surface，由 run 負責回報
- 若 `docs/workflows.md`（現有 30 KB）在交付時仍描述尚未實作的行為，需一併收斂

### 引導機制（不可省略）

上游不靠被動技能，靠**工具描述中的選擇準則**。`SubagentWorkflow` 的 `promptGuidelines` 明寫「何時用 Workflow、何時用 Agent」以及「優先 `pipeline` 而非 `parallel`」。沒有這段引導，模型不會主動選工具。任何功能恢復都必須同時交付引導文字。

## pi-tui 版本分裂（需使用者決策）

本 extension 宣告 peer `@earendil-works/pi-tui >=0.80.8`，但在 `~/.pi/agent/npm` 實際解析到 `0.74.2`，pi host 使用 `1.0.0`。後果是 `agent-widget.ts` 的 `focused instanceof Editor` 恆 false，roster `↑`/`↓` 在此環境 inert。

阻擋者：`@nklisch/pi-mcp-adapter`（`^0.74.0`）與 `@aliou/pi-utils-ui`（`>=0.74.0 <1`）。inert 是刻意的安全失效——改用結構式探針會讓 widget 從其他擴充套件的對話框搶走方向鍵（曾發生，見 0.17.23/0.17.28）。根治需調整 host 端相依圖。

## 未來：`/workflow` 使用者指令

讓使用者能主動要求 workflow，而非完全依賴模型自行判斷。設計前提未定：

- 與 `Agent` 工具自動產生的 workflow 如何劃分責任
- 已儲存腳本（上游 `examples/workflows/`）的存放位置與發現方式
- 是否與 `/agents → Workflows` inspector 合併，或作為其快捷入口
- 是否接受 inline 腳本，或只接受已儲存腳本