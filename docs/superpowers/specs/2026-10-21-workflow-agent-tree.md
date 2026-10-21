# Workflow Agent Tree 設計規格

**狀態：** 已核准，待實作
**日期：** 2026-10-21

## 背景

目前 workflow 在 AgentWidget 中以 synthetic workflow row 顯示，但不同執行路徑的 agent ownership 不一致：detached workflow agent 會掛在 workflow root 下，blocking workflow agent 則因未設定 `parentAgentId` 而出現在頂層。另一方面，`/agents` 仍使用 flat list，使用者只能看到抽象 workflow 進度與獨立 agent 清單，無法從同一棵樹逐一選取 workflow agent 與 nested descendants，查看每個 Agent View 實際做了什麼。

本 fork 刻意不同於 upstream：workflow 不得以 workflow-only progress surface 取代真實 agents 的可觀測性。

## 目標

建立一份 AgentWidget 與 `/agents` 共用的 Agent Tree：

```text
▾ Workflow: review-changes
  ├─ finder:bugs
  │  └─ verifier:bug-1
  ├─ finder:perf
  └─ synthesizer
```

- Workflow root 只是 grouping row，不是 `AgentRecord`，也不擁有 conversation。
- Workflow 擁有的真實 agents 與所有 nested descendants 都是第一級可觀測資料。
- 每個 agent row 都能開啟自己的 Agent View，查看 prompt、response、tool calls 與 transcript。
- `/agents` 與 above-editor AgentWidget 使用同一個 hierarchy、排序、terminal filtering 與 collapse 規則。

## 非目標

- 不引入 Fleet View 或另一套獨立 navigator。
- 不重寫 workflow runtime、journal、worker、pause/skip/retry/kill 或 pipeline semantics。
- 不把 synthetic workflow root 寫入 `AgentManager`、checkpoint 或 transcript。
- 不移除既有 workflow inspector；它保留為 workflow root 的次要入口。
- 不改變 Agent blocking/detached、nested ownership、durable history、codemode/defaultTools 或 `pi-haiku` 行為。

## 資料模型

新增 framework-free 的 pure tree module。輸入：

1. `AgentManager.listAgents()` 的真實 `AgentRecord`s。
2. `workflowTasks` 轉出的 workflow root descriptors。
3. session、widget mode、terminal openability 與 collapse state。

輸出為 visible preorder rows，每列包含：

- 穩定 key：`workflow:<id>` 或 `agent:<id>`。
- node kind：workflow root 或 real agent。
- depth、parent key、ancestor rails、isLast。
- hasChildren、expanded、orphan/cycle metadata。

Workflow child ownership只能透過 `AgentRecord.parentAgentId === workflowId` 表達。Blocking 與 detached workflow spawn 都必須設定該欄位。

Synthetic roots 永遠不進入 `AgentManager`。

## 可見性

- 預設全部 expanded；使用者明確 collapse 後，新 children 不得自動展開。
- Running／queued real agents 可見。
- Terminal real agents 僅在 Agent View 可開啟時可見。
- Workflow root 即使 terminal 也可見，因為它可開啟 workflow inspector。
- Current-session widget/tree 先做 session scoping。
- `background` widget mode 繼續排除已知 foreground top-level agents，但不得隱藏 owned workflow／nested descendants。
- Missing-parent 與 cycle records 不可消失、不可造成遞迴爆炸；以 orphan row 顯示且每筆至多出現一次。

## 互動規格

| 輸入 | 行為 |
|---|---|
| `↑`／`↓` | 在 visible preorder rows 中移動 |
| `→` | 展開目前 collapsed 且有 children 的 row |
| `←` | 若目前 expanded 則 collapse；否則移到 visible parent |
| Enter on workflow root | 開啟既有 workflow inspector |
| Enter on real agent | 開啟該 agent 的 live/history Agent View |
| Esc | 離開 widget navigation 或關閉 `/agents` tree |

- Collapsed descendants 不參與 rendering 或 keyboard navigation。
- AgentWidget 仍只從空白且有 focus 的 editor 以 `↓` 啟動。
- Foreign modal／SettingsList／workflow dialog 擁有 focus 時，AgentWidget 必須 stand down。
- `/agents` tree 關閉 Agent View 後，要回到同一 row、viewport 與 expansion state。

## 視覺規格

- 使用既有 `├─`、`└─`、`│` rails。
- 有 children 的 row 顯示 `▾`（expanded）或 `▸`（collapsed）。
- Workflow root 顯示 literal `workflow`、status、done/agent count、tokens、elapsed；不可偽裝成 agent type。
- Real agent 保留目前 model、thinking、tools、token、duration 與 live activity 顯示。
- Terminal 寬度不足時優先省略 model／tokens／duration，不省略 selection、disclosure、status 與 description。
- 不靠顏色單獨表達 selection 或 status。

## `/agents` 結構

主要入口改為 current-session Agent conversations tree，包含：

- Workflow roots。
- Workflow-owned real agents。
- Ordinary top-level agents。
- Nested descendants。
- Openable terminal rows。

保留以下次要入口：

- All-session agent history。
- Agent types。
- Scheduled jobs。
- Workflows inspector。
- Create new agent。
- Settings。

不得以 workflow task/progress list 當成主要 conversation surface。

## 必須保留的不變量

- Widget key：`agents`。
- Placement：`aboveEditor`。
- Structural editor-focus detection。
- Modal-depth suppression。
- Event-driven hierarchy/layout change使用 `requestRender(true)`。
- Spinner-only tick 使用 incremental redraw。
- Stable ID selection 與 bounded viewport。
- Openable-only terminal rows。
- Mandatory durable history 與 optional `.output`。
- Workflow inspector 與 workflow lifecycle controls。
- `pi-haiku` model resolution與 widget lifecycle。

## 驗收標準

1. Blocking 與 detached workflow agents 都掛在正確 workflow root 下。
2. Workflow child 的 nested descendants 依序顯示。
3. AgentWidget 與 `/agents` 產生相同 visible preorder。
4. `↑/↓/←/→` 行為符合規格，collapse 後 descendants 不可被選到。
5. Enter on workflow root 開 inspector；Enter on real agent 開該 Agent View。
6. Completed workflow root 仍可見；無 history 的 terminal agent 不可見。
7. 新 child 加入 collapsed root 時不得強制展開。
8. Missing parent 與 cycle 不會消失、重複或無限遞迴。
9. Focus、modal、redraw、viewport、history、workflow runtime 與 model regression tests 全部通過。
10. `ROADMAP.md` 永久記錄不得恢復 upstream workflow-only hiding。
