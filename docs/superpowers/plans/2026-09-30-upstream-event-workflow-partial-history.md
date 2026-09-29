# 上游事件管理、Workflow 與中途歷史實作計畫

> [!NOTE]
> **給 agentic workers：** 本計畫以目前 fork `64bbbb0` 與 `upstream/master` `e955e29` 的實際差異為準。所有步驟使用 checkbox 追蹤；不得刪除 fork 的 durable history/recovery 與 ConversationViewer 特性。

**目標：** 接收上游 Workflow、lifecycle/RPC 與 render-cost 改善，同時讓所有子代理 launch path 都留下可重新開啟的 stopped/aborted/partial `.pi-subagents` 歷史。

**架構：** 先將上游功能整合進現有 manager/runner/index seam，再把 durable transcript 附掛下沉到 `AgentManager.spawn()`，使 Agent tool、scheduler、RPC、Workflow 共用同一歷史介面。`.output` 僅是可選的外部串流檔；`.pi-subagents` 是 UI/history/checkpoint 的永久資料源。

**技術：** TypeScript、pi ExtensionAPI、pi-tui、Vitest、worker-thread Workflow runtime、JSONL transcript、atomic checkpoint。

## 全域限制

- 保留套件名稱 `@esso0428/pi-subagents` 與 JSON agent override。
- 保留 pi peer floor `>=0.80.8`，除非 typecheck 證明不可行且另有相容性處理。
- `output_transcript: false` 僅停用 temp `.output`，不得停用 `.pi-subagents` durable history。
- 不刪除 `src/agent-history.ts`、`src/agent-history-list.ts`、`src/agent-recovery.ts`。
- 不覆蓋 fork 的 ConversationViewer scrollbar、`[preview] [Esc]`、`w` focused-tool preview、in-place Tool Preview。
- 任何新日期型路徑使用當天 `2026-09-30`。
- 完成前執行 lint、typecheck、`npm test`、`npm run test:e2e`、build、pack；使用者已明確要求 commit、push、publish。

---

### Task 1：建立上游整合基線

**Files:**
- Modify: `src/agent-manager.ts`, `src/agent-runner.ts`, `src/agent-types.ts`, `src/types.ts`, `src/settings.ts`
- Modify: `src/index.ts`, `src/cross-extension-rpc.ts`, `src/output-file.ts`, `src/ui/agent-widget.ts`, `src/ui/fleet-list.ts`
- Add: `src/workflow/*.ts`, `src/ui/workflow-*.ts`, `docs/workflows.md`, `docs/rpc.md`, `examples/workflows/*`
- Test: upstream workflow/RPC/lifecycle tests selected from `test/workflow-*.test.ts`, `test/rpc-result-consumption.test.ts`, `test/child-session-shutdown.test.ts`

**Interfaces:**
- Consumes: current fork manager/history/UI interfaces and `upstream/master` workflow/runtime/event contracts.
- Produces: `SubagentWorkflow` registration, workflow host/runtime/task/journal modules, RPC `consume`, lifecycle event ordering, and RPC activity tracking.

- [ ] **Step 1: Record the merge inventory.**

  In `/tmp/pi-canonical/pi-subagents-work`, compare `git diff --name-status 64bbbb0..upstream/master` and group changes into workflow, lifecycle/RPC, UI, package metadata, and deleted history modules. Treat upstream deletions of fork history/recovery as rejected changes.

- [ ] **Step 2: Integrate upstream workflow/event files without replacing fork metadata.**

  Bring in `src/workflow/`, workflow UI, workflow docs/examples, RPC consume/result-consumption changes, session shutdown ordering, scope-model validation, and RPC-spawn activity tracking. Resolve `src/index.ts`, `src/agent-manager.ts`, `src/agent-runner.ts`, `src/types.ts`, `src/settings.ts`, `src/ui/agent-widget.ts`, `src/ui/fleet-list.ts`, and `src/ui/conversation-viewer.ts` manually. Keep `src/nico-overrides.ts` and fork package identity.

- [ ] **Step 3: Keep event semantics explicit.**

  Ensure readiness is emitted only after the extension is bound; normal Agent tool emits `created`, `started`, terminal `completed`/`failed`, compaction emits `compacted`, steering emits `steered`, and shutdown emits `session_shutdown` before child session disposal. RPC-spawned agents must be observable from returned id and must not rely on `created`.

- [ ] **Step 4: Run integration-focused tests.**

  Run:
  ```bash
  npx vitest run test/cross-extension-rpc.test.ts test/rpc-result-consumption.test.ts test/rpc-lifecycle-gating.test.ts test/child-session-shutdown.test.ts test/workflow-tool.test.ts test/workflow-runtime.test.ts test/workflow.e2e.test.ts
  ```
  Expected: all selected tests pass; failures caused by the history/UI seam remain for Tasks 2–3, not hidden by deleting assertions.

---

### Task 2：把 durable partial history 下沉到 manager seam

**Files:**
- Modify: `src/agent-manager.ts`
- Modify: `src/index.ts`, `src/output-file.ts`
- Modify: `src/agent-history.ts`, `src/agent-history-list.ts`, `src/agent-recovery.ts`
- Modify: `src/types.ts`
- Test: `test/agent-manager-history.test.ts`, `test/agent-history.test.ts`, `test/agent-history-list.test.ts`, `test/agent-recovery.test.ts`, `test/output-file-history.test.ts`, new `test/partial-history-lifecycle.test.ts`

**Interfaces:**
- Consumes: `createAgentHistoryPath`, `agentHistoryLocator`, `writeInitialEntry`, `streamToOutputFile`, `setTranscript`, `checkpoint`, `restoreRecovered`.
- Produces: every `manager.spawn()` record has a project-local transcript before queue/start; `output_transcript` only controls `.output`; terminal records retain `transcriptPath`.

- [ ] **Step 1: Add one manager-owned durable attach operation.**

  Add a private operation in `AgentManager` that, for a new record, creates `.pi-subagents/agent-transcripts/<safe-id>.jsonl`, writes the initial user entry, assigns `historyFile`/`transcriptPath`, and checkpoints. Make it idempotent so Agent tool callers do not duplicate the initial entry. Invoke it before the external `onSpawned` callback and clean only the checkpoint/record on a failed spawn; do not discard a successfully created transcript.

- [ ] **Step 2: Separate `.output` gating from durable history.**

  Change `attachTranscript()` in `src/index.ts` so `outputTranscript === false` skips only `createOutputFilePath()` and the temp initial entry. It must still use the manager-provided `historyFile` and `transcriptPath`. Keep `streamToOutputFile()` dual-write behavior when `record.outputFile` exists, and ensure no duplicate JSONL entry is written to history.

- [ ] **Step 3: Flush before every terminal checkpoint.**

  In manager stop/abort/queue cancellation, runner completion/error, resume failure, parent abort, and session shutdown paths, call `flushOutput(record)` before `checkpoint(record)`. Preserve status precedence: externally stopped remains `stopped`; hard max-turn interruption becomes `aborted`; provider/length failure becomes `error`; partial assistant text remains in JSONL even when `record.result` is empty.

- [ ] **Step 4: Make history visibly partial and reopenable.**

  Extend `AgentHistoryStatus`/formatting only as needed to label `stopped`, `aborted`, and `error` as terminal partial-capable states. Keep `canOpenAgentHistory()` based on live session or durable locator. In `ConversationViewer`, use the persisted status/read-only source and show a concise status marker in the header/footer without removing `[preview] [Esc]` or existing scrollbar geometry.

- [ ] **Step 5: Add path matrix regression tests.**

  Cover:
  - tool call in progress followed by `manager.abort()`;
  - queued agent cancellation;
  - provider error after an assistant partial delta;
  - max-turn abort/steer;
  - parent signal abort and `abortAll()`;
  - manager restore of running checkpoint as stopped;
  - scheduler and RPC spawn creating `.pi-subagents` history;
  - `output_transcript: false` still retaining durable history;
  - history menu and viewer reopening after live session disposal.

  Run the focused history/lifecycle tests before proceeding.

---

### Task 3：合併 UI render-cost 與事件刷新防閃動

**Files:**
- Modify: `src/ui/conversation-viewer.ts`
- Modify: `src/ui/agent-widget.ts`, `src/ui/fleet-list.ts`
- Test: `test/ui/conversation-viewer.test.ts`, `test/conversation-viewer.test.ts`, `test/agent-widget.test.ts`, `test/fleet-list.test.ts`, `test/perf/render-invariants.perf.test.ts` if integrated

**Interfaces:**
- Consumes: `ConversationTimeline` cache, fork parent-owned `FullToolPreview`, existing deferred/coalesced refresh behavior, upstream `3d91023` render bound.
- Produces: stable render cost under rapid text/tool events, no nested overlay/input theft, and regression evidence for the original Tool Output failure.

- [ ] **Step 1: Port only the upstream render-cost changes.**

  Inspect upstream `3d91023` and port bounded hidden-tail/truncation and Markdown fallback behavior into the fork's current viewer. Do not replace the fork's scrollbar rail, header action hitboxes, or `openFocusedToolPreview()` path.

- [ ] **Step 2: Coalesce live refreshes.**

  On session event bursts, invalidate only changed timeline/cache state and schedule one `requestRender()` per event-loop turn. Ensure preview mode owns all input/mouse events and returns to the parent viewer without a nested `ctx.ui.custom` overlay.

- [ ] **Step 3: Test the event sequence.**

  Assert that repeated `message_update`/tool activity does not rebuild unchanged rows indefinitely, that the visible scrollbar thumb remains stable, that Tool Output cannot close the underlying subagent panel, and that `Esc`/`q` restore parent focus. Run all focused UI tests.

---

### Task 4：文件、文件說明與相容性整理

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `AGENTS.md`
- Modify: `docs/rpc.md`, `docs/workflows.md`
- Add/modify: `examples/workflows/*`
- Preserve: `package.json` identity and peer floor unless verification requires a documented change

**Interfaces:**
- Consumes: implemented lifecycle/workflow/history behavior and test evidence.
- Produces: user-facing documentation that explains event channels, Workflow ownership, durable partial history, and `.output` opt-out distinction.

- [ ] **Step 1: Document partial-history guarantees.**

  State that `.pi-subagents` is always the durable diagnostic/history source, including stopped/aborted/error/partial runs; `output_transcript` controls only the temp `.output` mirror. Document reopenability and status labels.

- [ ] **Step 2: Reconcile upstream docs.**

  Add the upstream RPC/Workflow usage and caveats, including RPC readiness, no `created` guarantee for RPC spawns, workflow-owned hidden children, and journal replay rules. Keep fork branding and JSON override instructions.

- [ ] **Step 3: Add Unreleased entries.**

  Add separate changelog bullets for Workflow/event management, durable partial history, and UI render stability. Do not rewrite released sections.

---

### Task 5：完整驗證、版本、commit、push、publish

**Files:**
- Modify: `package.json`, `package-lock.json`, `CHANGELOG.md`, `README.md` only if release metadata requires it
- Test: all repository gates

- [ ] **Step 1: Run the full local gates from the canonical checkout.**

  ```bash
  npm run lint
  npm run typecheck
  npm test
  npm run test:e2e
  npm run build
  npm pack --dry-run
  ```
  Fix every failure; do not weaken durable-history, RPC lifecycle, Workflow, or UI regression assertions.

- [ ] **Step 2: Select a release version.**

  Because Workflow and lifecycle management are notable additions, update the package to the next minor version after `0.17.6` only after all gates pass. Move Unreleased entries into that version and create a fresh Unreleased section.

- [ ] **Step 3: Commit the complete integration.**

  ```bash
  git add docs src test README.md CHANGELOG.md package.json package-lock.json AGENTS.md examples
  git commit -m "feat: integrate upstream workflows and durable partial history"
  ```

- [ ] **Step 4: Push and publish only after verification.**

  ```bash
  git push origin master
  npm publish
  ```
  Then independently verify:
  ```bash
  git ls-remote origin refs/heads/master
  npm view @esso0428/pi-subagents version dist-tags.latest
  ```
  Confirm the remote commit and npm version match the committed release.
