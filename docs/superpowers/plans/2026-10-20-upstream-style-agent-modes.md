# 上游式 Agent Blocking／Detached 模式實作計畫

> [!NOTE]
> **For agentic workers:** `subagent-driven-development` and
> `executing-plans` are optional execution helpers. When resolving either
> skill, prefer the namespaced form (`superpowers:<skill-name>`) when
> available, then the bare `<skill-name>` form.
>
> This name-resolution order does not give those skills priority over the
> current agent or host framework's native execution/delegation capabilities.
> Choose the execution approach based on the implementation plan, user
> instructions, available capabilities, and the host framework's own
> routing/delegation policy. Do not automatically search for or install
> missing skills.
>
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 main 與 nested `Agent` 共用 blocking／detached 執行介面，預設 blocking，並移除公開 wait-group 複雜度。

**Architecture:** `resolveAgentInvocationConfig()` 是執行模式的單一解析點；`AgentManager` 持續擁有所有 durable history 與 lifecycle；top-level 與 nested adapters 只選擇 `spawnAndWait()` 或 `spawn()`。Detached completion 使用上游 `CompletionOutbox` 與 automatic join；blocking completion inline 回傳且不送 follow-up notification。

**Tech Stack:** TypeScript、Pi Extension API、Pi SDK child sessions、Vitest、Biome。

## Global Constraints

- 未指定 `run_in_background` 時，main 與 nested `Agent` 都預設 blocking。
- 明確 tool-call `run_in_background` 覆蓋 agent frontmatter；frontmatter 僅提供預設。
- `run_in_background:false` blocking；`run_in_background:true` detached。
- Fresh spawn 與 resume 使用同一套 mode resolution。
- Blocking completion inline 回傳完整結果，標記 consumed，不送 completion follow-up，也不額外喚醒 Goal。
- Detached completion立即回傳 ID，保留 `triggerTurn:true` notification。
- Main／nested 共用 `Agent`、`get_subagent_result`、`steer_subagent` 名稱與語意；nested result／resume／steer 必須 fail-closed ownership check。
- 移除公開 `subagent_wait_group`、`Agent.wait`、`wait_group`、`wait_group_done` 與 nested `wait_for_nested_agent`。
- `get_subagent_result({wait:true})` 是 cancellable blocking join；取消等待不取消 child。
- Internal automatic join 對齊官方 upstream v0.22.0，不公開 group ID。
- RPC／TaskExecute 保持 upstream-style detached；不新增 Goal detection、RPC blocking 或 notification interception。
- Durable `.pi-subagents/agent-transcripts/<id>.jsonl` 對所有 spawn path 必須存在；`output_transcript:false` 只停用 optional OS-temp `.output` mirror。
- 保留 AgentWidget structural focus、forced redraw、`pi-haiku`、workflow UI、exact-session recovery、codemode/defaultTools 與目前所有 WIP。
- 不移植 Fleet、mention、foreground handoff、額外 concurrency pool或其他無關 upstream runtime/UI 變動。
- Peer dependency 保持 `@earendil-works/pi-coding-agent >=0.80.8`。
- Targeted Vitest 只能在取得使用者明確授權後執行；版本、commit、push、tag、publish 另需明確授權。
- 不執行 Git 狀態修改操作。

---

## Work Graph

| Lane | 檔案所有權 | 依賴 | 驗證 owner |
|---|---|---|---|
| A：模式解析 | `src/invocation-config.ts`、`src/types.ts`、對應測試 | 無 | Lane F |
| B：Manager lifecycle | `src/agent-manager.ts`、manager/history 測試 | A | Lane F |
| C：Top-level Agent／automatic join | `src/index.ts`、`src/completion-outbox.ts`、`src/group-join.ts`、`src/wait-group.ts`、top-level 測試 | A、B | Lane F |
| D：Nested parity | `src/nested-tools.ts`、nested 測試 | A、B、C 公開名稱定案 | Lane F |
| E：文件 | `README.md`、`CHANGELOG.md` | C、D | Lane F |
| F：整合驗證 | 唯讀驗證，不擁有 production files | A–E | 最終 validation owner |

為避免目前大型未提交 WIP 被互相覆蓋，writer 依 A → B → C → D → E 順序執行；`src/index.ts` 僅由 Lane C 修改。

---

### Task 1：固定 mode resolution 契約

**Files:**
- Modify: `src/invocation-config.ts`
- Modify: `src/types.ts`
- Modify: `test/invocation-config.test.ts`
- Modify: `test/custom-agents.test.ts`
- Modify: `test/agent-types.test.ts`

**Interfaces:**
- Produces: `resolveAgentInvocationConfig()` 的 effective `runInBackground:boolean`。
- Consumes: tool-call `run_in_background`、agent frontmatter `runInBackground`、global fallback `false`。

- [ ] **Step 1: 新增 precedence matrix 測試**

  覆蓋：無設定→false、frontmatter true/false、tool call true/false 覆蓋相反 frontmatter。

- [ ] **Step 2: 確認測試先失敗**

  授權後執行：

  ```bash
  npx vitest run test/invocation-config.test.ts test/custom-agents.test.ts test/agent-types.test.ts
  ```

- [ ] **Step 3: 最小修改 mode resolver**

  ```ts
  runInBackground:
    params.run_in_background
    ?? agentConfig?.runInBackground
    ?? opts?.defaultRunInBackground
    ?? false
  ```

  其他 `model`、`thinking`、`max_turns` 等 precedence 不變；frontmatter 欄位從 compatibility no-op 改成預設值語意。

- [ ] **Step 4: 驗證 Task 1 targeted tests**

  預期全部通過。

---

### Task 2：讓 AgentManager 正確處理 blocking／detached lifecycle

**Files:**
- Modify: `src/agent-manager.ts`
- Modify: `test/agent-manager.test.ts`
- Modify: `test/agent-manager-history.test.ts`
- Modify: `test/output-transcript-wiring.test.ts`

**Interfaces:**
- Consumes: Task 1 的 effective `runInBackground`。
- Produces: blocking `spawnAndWait()`、mode-aware `resume()`、consumption 與 history lifecycle。

- [ ] **Step 1: 新增 manager failing tests**

  驗證 blocking spawn/resume 等待 terminal record、`isBackground:false`、`resultConsumed:true`；detached 維持 queue/concurrency 與 unread result。

- [ ] **Step 2: 新增 durable-history regression tests**

  Blocking/detached fresh/resume 都必須在外部可觀察 ID 前建立 transcript，terminal/partial history flush；`output_transcript:false` 仍保留 durable history。

- [ ] **Step 3: 實作 mode-aware resume**

  `resume()` 不再無條件把 record 設成 background；接受小型 options 並在 completion notification 可觀察前標記 blocking result consumed。

- [ ] **Step 4: 保留 manager-owned history seam**

  不把 `attachDurableHistory()`、stream subscription 或 flush 邏輯搬回任何 adapter。

- [ ] **Step 5: 執行 manager targeted tests**

  ```bash
  npx vitest run test/agent-manager.test.ts test/agent-manager-history.test.ts test/output-transcript-wiring.test.ts
  ```

---

### Task 3：恢復 top-level blocking Agent 並移除公開 wait-group API

**Files:**
- Modify: `src/index.ts`
- Modify: `src/agent-runner.ts`
- Delete: `src/wait-group.ts`
- Modify: `test/agent-detached-wiring.test.ts`
- Modify: `test/tool-description-mode.test.ts`
- Modify: `test/agent-runner.test.ts`
- Modify: `test/clear-completed-wiring.test.ts`
- Modify: `test/status-note-wiring.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2 的 mode resolver 與 manager methods。
- Produces: top-level `Agent` fresh/resume blocking／detached contract。

- [ ] **Step 1: 將 always-detached 測試改成完整 mode contract**

  Plain／explicit false 必須 pending 到 child terminal 並 inline 回傳；explicit true 立即回 ID。

- [ ] **Step 2: 新增 notification assertions**

  Blocking 不呼叫 `pi.sendMessage`；detached 保留 `deliverAs:"followUp"`、`triggerTurn:true`。

- [ ] **Step 3: 新增 public API removal assertions**

  Agent schema 不含 `wait`、`wait_group`、`wait_group_done`；registry 不含 `subagent_wait_group`。

- [ ] **Step 4: 分流 spawn／resume**

  ```ts
  if (invocation.runInBackground) {
    return manager.spawn(/* isBackground: true */);
  }
  return await manager.spawnAndWait(/* signal */);
  ```

  Resume 使用同一 mode decision；schedule 仍始終 detached 且與 foreground request 不相容。

- [ ] **Step 5: 移除公開 wait-group runtime/types/rendering**

  刪除 manager、tool registration、schema fields、record metadata、notification group details與 shutdown cleanup，不觸碰 AgentWidget layout/focus/render cadence。

---

### Task 4：移植 upstream v0.22.0 CompletionOutbox／automatic join

**Files:**
- Create: `src/completion-outbox.ts`
- Modify: `src/index.ts`
- Modify: `src/group-join.ts`（只做必要對齊）
- Create: `test/completion-outbox.test.ts`
- Modify: `test/group-join.test.ts`
- Modify: `test/wait-queued.test.ts`

**Interfaces:**
- Produces: `CompletionOutbox.add()`、`cancel()`、`onTurnEnd()`、`onAgentEnd()`、`dispose()`。
- Consumes: detached terminal notifications；blocking record 不得加入 outbox。

- [ ] **Step 1: 寫 CompletionOutbox failing tests**

  Parent active 時等待 boundary；idle 時 200ms hold；多 completion 合併；cancel 已消費結果；同 ID resume 取代舊項目；dispose 清除 timer/items。

- [ ] **Step 2: 寫 automatic join regression tests**

  `smart`／相容 alias `async` 使用 outbox；`group` 只合併同一 parent turn 的 detached spawns；單一 spawn 退化為一般 notification；30 秒 partial與15秒 straggler保留；不公開 group ID。

- [ ] **Step 3: 移植 upstream deep module**

  用 CompletionOutbox 取代 `pendingNudges`、`scheduleNudge` 與 100ms batch debounce；在 `turn_end` 登記 groups／flush boundary，在 `agent_end` 或 `agent_settled` 處理 parent settled。

- [ ] **Step 4: 維持 detached wake semantics**

  Delivery 仍為 `triggerTurn:true`；blocking consumed records不加入 outbox。

---

### Task 5：恢復 cancellable `get_subagent_result(wait:true)`

**Files:**
- Modify: `src/index.ts`
- Modify: `test/wait-queued.test.ts`
- Modify: `test/clear-completed-wiring.test.ts`
- Modify: `test/status-note-wiring.test.ts`

**Interfaces:**
- Consumes: manager record/promise、`CompletionOutbox.cancel()`、既有 durable-history fallback。
- Produces: nonblocking check 與 cancellable blocking join。

- [ ] **Step 1: 新增 check／join failing tests**

  `wait:false`／省略立即回狀態且不消費；`wait:true` 可跨 queued→running→terminal，完整回傳並取消 outbox item。

- [ ] **Step 2: 新增 cancellation test**

  取消只中止 result-tool wait，不停止 child、不標記 consumed；child 後續完成仍通知。

- [ ] **Step 3: 用既有 `abortable()` 實作等待**

  Queued 使用有界短 poll，running 等待 `record.promise`；不得用無法取消的裸 await。

- [ ] **Step 4: 保留 status/partial/history fallback**

  stopped、aborted、error與 TTL 後 transcript fallback 行為不變。

- [ ] **Step 5: 執行 top-level/outbox targeted tests**

  ```bash
  npx vitest run test/agent-detached-wiring.test.ts test/wait-queued.test.ts test/group-join.test.ts test/completion-outbox.test.ts test/clear-completed-wiring.test.ts test/status-note-wiring.test.ts
  ```

---

### Task 6：統一 nested Agent／result 介面

**Files:**
- Modify: `src/nested-tools.ts`
- Modify: `test/nested-feature.test.ts`
- Modify: `test/nested-session-wiring.test.ts`
- Modify: `test/nested-tool-scope.test.ts`
- Modify: `test/nested-history.test.ts`

**Interfaces:**
- Produces: nested `Agent`、`get_subagent_result`、`steer_subagent`。
- Consumes: shared mode resolver、manager methods、parent ownership metadata。

- [ ] **Step 1: 固定 nested tool names**

  移除 `wait_for_nested_agent`；加入 scoped `get_subagent_result`。

- [ ] **Step 2: 固定 nested mode matrix**

  Plain 預設 blocking；explicit true detached；explicit false blocking；tool call 覆蓋 frontmatter；resume 相同。

- [ ] **Step 3: 寫 scoped result tests**

  `wait:false` 即時查詢；`wait:true` cancellable join；terminal retrieval consumed；foreign ID fail closed。

- [ ] **Step 4: 更新 extension tool scope**

  只 re-admit nested scoped versions；global orchestration tools不得任意繼承。Depth cap、allowlist、JSON overrides、defaultTools/codemode不變。

- [ ] **Step 5: 驗證 nested durable history**

  Blocking／detached fresh/resume 都有 mandatory transcript；`.output` 仍可選。

- [ ] **Step 6: 執行 nested targeted tests**

  ```bash
  npx vitest run test/nested-feature.test.ts test/nested-session-wiring.test.ts test/nested-tool-scope.test.ts test/nested-history.test.ts
  ```

---

### Task 7：更新文件與 migration 說明

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 更新 README**

  展示預設 blocking、explicit detached、detached join；刪除公開 Wait groups；說明 tool-call override、resume、nested scoped result、internal automatic join，以及 schedule／RPC／TaskExecute仍 detached。

- [ ] **Step 2: 更新 Unreleased changelog**

  記錄預設值 breaking change、恢復 mode control、移除公開 wait-group、nested tool rename、cancellable join與 notification batching 對齊。

- [ ] **Step 3: 搜尋 stale public API**

  ```bash
  grep -R "subagent_wait_group\|wait_for_nested_agent\|wait_group_done\|wait_group:" src test README.md
  ```

  Runtime、schema、prompt與 fixtures 不得殘留；migration文字可保留。

---

### Task 8：整合驗證與 release gate

**Files:**
- Verify only; production file ownership歸前述 lanes。

- [ ] **Step 1: 執行 WIP regression set（需授權）**

  ```bash
  npx vitest run \
    test/cross-extension-rpc.test.ts \
    test/rpc-lifecycle-gating.test.ts \
    test/agent-history-scope.test.ts \
    test/agent-widget-wiring.test.ts \
    test/ui/agent-widget.test.ts \
    test/workflow-host.test.ts \
    test/workflow-borrowed.test.ts \
    test/workflow-index-wiring.test.ts \
    test/agent-runner.test.ts \
    test/agent-runner-e2e.test.ts \
    test/nico-overrides.test.ts
  ```

- [ ] **Step 2: 執行靜態檢查**

  ```bash
  node_modules/.bin/biome check src/ test/
  npm run typecheck
  git diff --check
  ```

- [ ] **Step 3: 人工 Goal／reload 驗證**

  驗證 plain blocking不喚醒 Goal；explicit detached會 notification；`get_subagent_result(wait:true)`與 Esc cancellation；frontmatter/tool-call precedence；nested ownership；smart/group batching；RPC仍 detached；reload後所有模式 history可開啟；AgentWidget／selectors／workflow UI／pi-haiku無回歸。

- [ ] **Step 4: Release checks（另需授權）**

  ```bash
  npm pack --dry-run
  npm run prepublishOnly
  ```

- [ ] **Step 5: 停在 release gate**

  不更新版本、不 commit、不 push、不 tag、不 publish，直到使用者再次明確批准。

---

## Success Criteria

1. Direct main／nested `Agent` 省略 mode 時都 blocking；explicit true才 detached。
2. Tool call mode確實覆蓋 frontmatter。
3. Blocking結果完整 inline回傳，不產生 completion follow-up或 Goal wake。
4. Detached保留 ID-first與 notification wake。
5. `get_subagent_result(wait:true)` 可取消且不會因取消而停止 child。
6. 公開 wait-group API與 `wait_for_nested_agent` 完全移除。
7. Internal automatic join與 upstream v0.22.0 行為一致。
8. RPC／TaskExecute仍 detached，且 Agent list/history完整性不受影響。
9. Mandatory durable history、optional `.output`、AgentWidget、workflow、recovery、codemode/defaultTools與peer floor全部保留。
10. Targeted tests、WIP regressions、Biome、typecheck與diff check全數通過；人工 reload／Goal驗證完成後才可進入 release gate。
