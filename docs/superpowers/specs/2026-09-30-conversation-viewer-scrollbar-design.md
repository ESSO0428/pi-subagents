# Conversation Viewer 主內容 scrollbar 設計

## 狀態

- 狀態：已取得使用者對推薦方案的批准，等待 spec review
- 日期：2026-09-30
- 範圍：`src/ui/conversation-viewer.ts` 與對應 UI tests

## 問題

目前 `ConversationViewer` 的主 transcript 內容可以用 `j/k`、方向鍵、PageUp/PageDown、wheel 與 footer 百分比滾動，但內容列沒有右側 scrollbar。現有 `FullToolPreview` 已有 track/thumb，因此主 viewer 與 Tool Output 的 viewport 視覺契約不一致，使用者也無法快速判斷目前在 transcript 的位置。

## 目標

- 在 ConversationViewer 的 transcript content rows 右側提供真正可見的 track/thumb rail。
- thumb 位置與高度反映完整 transcript 行數、目前 viewport 高度與 `scrollOffset`。
- 保留現有鍵盤與 wheel 滾動行為，不增加滑鼠拖曳或點擊跳轉。
- 保留 ConversationViewer header 的 `[preview]` action；它必須與 `w` 使用同一個 focused-tool preview handler，並與 `[Esc]` 保持不重疊。
- 保留 message/tool focus、search highlight、sticky header、composer、read-only 行為與 Tool Output preview 行為。
- 內容寬度預留 rail，避免文字覆蓋 scrollbar。

## 非目標

- 本次不新增可拖曳 thumb 或點擊 track 跳轉。
- 本次不改用 Pi 原生 `ScrollView`。
- 本次不重構 ConversationTimeline 或抽出跨元件 scrollbar package。
- 不修改 Tool Output preview 已有的 scrollbar 行為。

## 設計

### 渲染幾何

`ConversationViewer.render(width)` 維持現有外框、header、invocation row、footer 與 status layout。只在 transcript content viewport 中保留最右一格作 scrollbar rail：

1. 計算原本的 `innerW`。
2. 當 content row render 時，將可用文字寬度設為 `innerW - 1`，最右一格固定輸出 rail。
3. 以 `cachedLines.length` 作為 `totalLines`，以 `viewportHeight()` 作為 `viewportHeight`，以 `visibleStart` 或 `scrollOffset` 作為目前 offset。
4. 使用既有 `renderScrollbarCell()`：沒有 overflow 時輸出 track 空白；有 overflow 時輸出 track `│` 與 thumb `┃`，scrollbar active 時可使用醒目 thumb `█`。
5. Header、invocation row、分隔線、composer/search/footer 不消耗 transcript rail，避免改變既有互動區域。

content line 的文字、focus rail 與 search highlight 先完成，再將結果放入保留 rail 的寬度；不可讓 `truncateToWidth` 把 scrollbar 覆蓋掉。

### 狀態與滾動

沿用現有 `scrollOffset`、`autoScroll`、`viewportHeight()` 與 `scrollBy()`，不新增第二份 offset。既有的：

- `j/k` 與方向鍵
- PageUp/PageDown
- Home/End
- wheel
- `g/G`
- search match 跳轉
- tool/message focus 導航

都繼續更新同一個 offset，render 時由同一個 offset 計算 thumb。自動追蹤最新內容時 thumb 留在底部；使用者向上滾動後則依現有規則停止 auto-follow。

### 互動與事件

本次 scrollbar 是視覺 track/thumb，不是滑鼠控制元件。`ConversationViewer.handleMouse()` 的 wheel 路由維持不變；click/press 仍依現有 timeline 與 header action hit-test 處理，不讓 scrollbar rail 新增意外 focus target。

ConversationViewer header 保留兩個 action：`[preview] [Esc]`。`[preview]` 的 click/press geometry 必須固定在 close action 左側，並呼叫與 `w` 相同的 `openFocusedToolPreview()`；沒有 focused tool 時維持 no-op。Scrollbar rail 不得改變 header action 的 hit-test。

Tool Preview 開啟時仍由 `FullToolPreview` 完全接管 render/input/mouse，不將主 viewer rail 與 preview rail 混用。

## 測試

在 `test/ui/conversation-viewer.test.ts` 增加或調整測試：

1. 建立超過 viewport 的長 transcript，確認 content row 最右側出現 track/thumb 字元。
2. 使用 `j`、PageDown 或 wheel 後重新 render，確認 thumb 位置會改變，且 hidden content 仍可到達。
3. 建立不超過 viewport 的短 transcript，確認不顯示 thumb，且既有文字與外框寬度不變。
4. 確認 header `[preview]` 仍可見且可 click，並與 `w` 開啟相同的 read-only Tool Output preview；沒有 focused tool 時不會誤觸 close。
5. 確認 search、message/tool focus 與 Tool Output preview 仍可正常使用，沒有因 rail 保留而改變快捷鍵或 close 行為。
6. 執行 targeted viewer test，再執行完整 unit tests、lint、typecheck、build、e2e 與 pack。

## 驗收條件

- 長 transcript 的主 ConversationViewer 右側可見 track/thumb。
- thumb 隨現有鍵盤或 wheel 滾動正確移動。
- 短 transcript 不顯示誤導性的 thumb。
- 所有原有 ConversationViewer 與 Tool Output 行為測試通過。
- 不新增 nested overlay、不改變 transcript read-only 性質、不引入跨 package renderer dependency。
