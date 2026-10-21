# Shared Workflow Agent Tree 實作計畫

> [!NOTE]
> **For agentic workers:** `subagent-driven-development` and `executing-plans` are optional execution helpers. Prefer native Pi delegation when available. Steps use checkbox syntax.

**Goal:** 讓 AgentWidget 與 `/agents` 共用同一棵可折疊 Agent Tree，使 workflow-owned agents 與 nested descendants 全部可選、可開啟 Agent View。

**Architecture:** 新增 framework-free pure tree module，將 real `AgentRecord`s 與 separate workflow root descriptors 投影為 safe visible preorder。UI adapters只負責 rendering、selection 與 open dispatch；synthetic roots永不進入 `AgentManager`。

**Tech Stack:** TypeScript、Pi Extension/TUI、Vitest、Biome。

## Global Constraints

- 遵循 `docs/superpowers/specs/2026-10-21-workflow-agent-tree.md`。
- 預設 expanded；使用者 collapse優先。
- Workflow root grouping-only；real agents first-class。
- `/agents → Workflows` 保留為次要 inspector。
- 不引入 Fleet View、不重寫 workflow runtime。
- 保留 AgentWidget focus、modal、redraw、`agents` key、`aboveEditor` 與 `pi-haiku`。
- Targeted／regression Vitest 需使用者明確授權。
- 不執行版本、commit、push、tag、publish。

---

## Work Graph

| Lane | Ownership | Depends on | Validation |
|---|---|---|---|
| A：Pure tree model | `src/agent-tree.ts`、shared types/tests | 無 | F |
| B：Workflow ownership | `src/workflow/host.ts`、host tests | 無 | F |
| C：AgentWidget | `src/ui/agent-widget.ts`、widget tests | A | F |
| D：`/agents` tree | `src/ui/agent-tree-menu.ts`、`src/index.ts`、history helpers/tests | A、C | F |
| E：Docs | `ROADMAP.md`、README、workflow docs、CHANGELOG | C、D | F |
| F：Integration verification | 唯讀 | A–E | final owner |

A、B 可平行；其餘依序，避免 writer 同時修改 `src/index.ts` 或 AgentWidget。

### Task 1：建立 pure shared tree projection

**Files:**
- Create: `src/agent-tree.ts`
- Modify: `src/types.ts`
- Modify: `src/workflow/task.ts`
- Create: `test/agent-tree.test.ts`
- Modify: `test/workflow-task.test.ts`

- [ ] 定義 `WorkflowTreeRoot`、`AgentTreeNode`、`AgentTreeRow`、`AgentTreeProjection`。
- [ ] 使用 prefixed keys：`workflow:<id>`／`agent:<id>`。
- [ ] 寫 workflow→agent→nested preorder、terminal filter、session scope、orphan、cycle、stable rank 測試。
- [ ] 寫 default expanded、collapsed descendants、left/right/up/down pure navigation 測試。
- [ ] 實作 `projectAgentTree()`，不得 mutation input。
- [ ] 將 `toWidgetWorkflowRun()` 更名為 `toWorkflowTreeRoot()`，移除 widget-specific vocabulary。
- [ ] 視實際引用移除或收斂 synthetic-only `AgentRecord.workflowId/workflowProgress`。
- [ ] 執行授權後 targeted tests。

### Task 2：修正 workflow child ownership

**Files:**
- Modify: `src/workflow/host.ts`
- Modify: `test/workflow-host.test.ts`

- [ ] 以 table test 覆蓋 blocking／detached spawn。
- [ ] 兩種模式都斷言 real record `parentAgentId === workflowId`。
- [ ] 斷言 manager內不存在 synthetic workflow root。
- [ ] Blocking `spawnAndWait()` options補上 `parentAgentId: deps.workflowId`。
- [ ] 保留 gate、worktree、history、optional output與結果格式。

### Task 3：AgentWidget 改用 shared tree

**Files:**
- Modify: `src/ui/agent-widget.ts`
- Modify: `test/ui/agent-widget.test.ts`
- Modify: `test/ui/workflow-roster-row.test.ts`
- Modify: `test/ui/orphan-rows.test.ts`

- [ ] 移除 local `workflowRecords()`／recursive roster builder，改呼叫 `projectAgentTree()`。
- [ ] 新增 session-scoped `collapsedKeys` 與 stable selected node key。
- [ ] Workflow root用 grouping renderer；real agent renderer保持既有資訊。
- [ ] 增加 `▾`／`▸` disclosure。
- [ ] `←/→` 只在 navigation active時攔截。
- [ ] `↑/↓` 使用 visible preorder，collapsed descendants不可選。
- [ ] Root Enter開 inspector；agent Enter開自身 Agent View。
- [ ] 修正 settled workflow root terminal filtering。
- [ ] Render key納入 hierarchy、workflow progress與collapse state。
- [ ] 保留 structural focus、modal-depth、viewport、forced redraw與spinner incremental。

### Task 4：建立 `/agents` Agent Tree modal

**Files:**
- Create: `src/ui/agent-tree-menu.ts`
- Modify: `src/index.ts`
- Modify: `src/agent-history-list.ts`
- Create: `test/ui/agent-tree-menu.test.ts`
- Modify: `test/agent-history-list.test.ts`
- Modify: `test/agent-menu-history-navigation.test.ts`
- Modify: `test/workflow-index-wiring.test.ts`
- Modify: `test/agent-widget-wiring.test.ts`

- [ ] 使用 shared projection與相同 key contract。
- [ ] 實作 up/down/left/right/Enter/Esc及selection/viewport restore。
- [ ] 新增 `resolveAgentViewMode()`，只開啟真實可用 conversation/history。
- [ ] 將 current-session running/history主要入口整合為 `Agent conversations this session (N)`。
- [ ] 保留 all-session history、types、scheduled jobs、Workflows inspector、create、settings。
- [ ] Modal一律經 `withModal()`，AgentWidget不得搶鍵盤。
- [ ] Root dispatch到 workflow inspector；agent dispatch到 Agent View。
- [ ] 不讓 progress/task list成為主要 conversation入口。

### Task 5：收斂 workflow integration terminology

**Files:**
- Modify: `src/index.ts`
- Verify: `src/ui/workflow-menu.ts`
- Verify: `src/ui/workflow-dialog.ts`

- [ ] `getWorkflowRuns` 更名為 `getWorkflowRoots`。
- [ ] `toWidgetWorkflowRun()` 改為 `toWorkflowTreeRoot()`。
- [ ] 移除 workflow children被隱藏或由run取代的 stale comments。
- [ ] 保留 `workflowTasks`、WorkflowDialog、inline workflow cards與 lifecycle controls。

### Task 6：文件與永久 fork invariant

**Files:**
- Modify: `ROADMAP.md`
- Modify: `README.md`
- Modify: `docs/workflows.md`
- Modify: `CHANGELOG.md`

- [ ] ROADMAP新增「Fork 永久不變量」例外與 workflow observability規則。
- [ ] 移除「workflow agents不列於top-level surface」的矛盾敘述。
- [ ] README記錄 Agent Tree controls與workflow grouping-only語意。
- [ ] workflow docs將 inspector定位為次要 run-progress/control surface。
- [ ] Unreleased changelog記錄shared projection、tree navigation與children visibility。

### Task 7：驗證

- [ ] 授權後執行 targeted tests：

```bash
npx vitest run \
  test/agent-tree.test.ts \
  test/workflow-task.test.ts \
  test/workflow-host.test.ts \
  test/ui/agent-widget.test.ts \
  test/ui/workflow-roster-row.test.ts \
  test/ui/orphan-rows.test.ts \
  test/ui/agent-tree-menu.test.ts \
  test/agent-history-list.test.ts \
  test/agent-menu-history-navigation.test.ts \
  test/workflow-index-wiring.test.ts \
  test/agent-widget-wiring.test.ts
```

- [ ] 授權後執行 preservation regressions：

```bash
npx vitest run \
  test/agent-manager-history.test.ts \
  test/agent-history-scope.test.ts \
  test/nested-history.test.ts \
  test/nested-session-wiring.test.ts \
  test/workflow-runtime.test.ts \
  test/workflow-detached-collect.test.ts \
  test/workflow-journal.test.ts \
  test/agent-types.test.ts \
  test/model-resolver.test.ts
```

- [ ] 執行 direct Biome、typecheck與`git diff --check`。
- [ ] 人工啟動含 blocking、detached、nested descendant的workflow，驗證兩個UI surface。
- [ ] 驗證collapsed root新增children時不自動展開。
- [ ] 驗證Settings／workflow inspector／Agent View focus與back navigation。
- [ ] 驗證completed workflow root與openable terminal agents。
- [ ] 不執行full test、pack、prepublish或release，除非另行授權。

## Success Criteria

1. Shared pure model是兩個UI surface唯一 hierarchy來源。
2. Workflow roots不進AgentManager。
3. Blocking／detached workflow children都設定`parentAgentId`。
4. Workflow agents與nested descendants在兩處都可見、可選、可開Agent View。
5. Collapse、selection、viewport、session、terminal、orphan、cycle行為通過測試。
6. Runtime、history、focus、redraw、workflow inspector與model行為無回歸。
7. ROADMAP永久禁止恢復workflow-only hiding。
