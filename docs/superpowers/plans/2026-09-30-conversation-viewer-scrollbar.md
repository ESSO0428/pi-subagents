# Conversation Viewer Scrollbar Implementation Plan

> [!NOTE]
> **For agentic workers:** `subagent-driven-development` and
> `executing-plans` are optional execution helpers. When resolving either
> skill, prefer the namespaced form (`superpowers:<skill-name>`) when
> available, then the bare `<skill-name>` form.
>
> This name-resolution order does not give those skills priority over the
> current agent or host framework's native execution/delegation policy.
>
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在主 `ConversationViewer` transcript viewport 加入與 Tool Output 一致的右側 track/thumb scrollbar，同時保留現有鍵盤、wheel、focus、search 與 read-only 行為。

**Architecture:** 重用 `conversation-viewer.ts` 既有的 `renderScrollbarCell()`，只在 transcript content rows 預留最右一格 rail；header、invocation、分隔線、composer/search、footer 不加入 rail。沿用現有 `scrollOffset`、`viewportHeight()` 與 `autoScroll`，不引入第二個 viewport 狀態，也不改用原生 `ScrollView`。

**Tech Stack:** TypeScript、`@earendil-works/pi-tui`、Vitest、Biome、TypeScript compiler。

## Global Constraints

- 只修改 `/tmp/pi-canonical/pi-subagents-work` canonical checkout，不修改 npm-installed copy 或研究專案根目錄。
- Scrollbar 只提供視覺 track/thumb；不新增 mouse click-to-jump 或 drag-to-scroll。
- 保留 `j/k`、方向鍵、PageUp/PageDown、Home/End、wheel、`g/G`、search match、message/tool focus 的既有語意。
- Tool Preview 維持 parent-owned in-place preview 與既有 scrollbar，不與主 viewer rail 共用 offset。
- 不新增跨 package renderer dependency，不改變 transcript read-only 性質。
- 新增或改寫的測試必須使用 local `vitest`；不能以全域 binary 或 npm-installed package 取代 canonical repo 驗證。
- 完成後執行 targeted viewer test、`npm test`、`npm run lint`、`npm run typecheck`、`npm run build`、`npm run test:e2e` 與 `npm pack --dry-run`。

---

### Task 1: Add failing ConversationViewer scrollbar tests

**Files:**
- Modify: `test/ui/conversation-viewer.test.ts`

**Interfaces:**
- Consumes: current `ConversationViewer`, `createStaticConversationSource`, `tui()`, `record()` and test `theme` helpers.
- Produces: regression coverage for the main transcript rail that Task 2 must satisfy.

- [ ] **Step 1: Add a long-transcript fixture and rail assertions**

Use a transcript longer than the current test TUI viewport:

```ts
const longText = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n");
const viewer = new ConversationViewer(
  tui(),
  createStaticConversationSource([{ role: "assistant", content: [{ type: "text", text: longText }] }] as any),
  record(),
  undefined,
  theme,
  vi.fn(),
);

const atBottom = viewer.render(100);
expect(atBottom.some((line) => line.includes("┃") || line.includes("█"))).toBe(true);
```

The test must also assert that a short transcript does not show a thumb:

```ts
const shortViewer = new ConversationViewer(
  tui(),
  createStaticConversationSource([{ role: "assistant", content: [{ type: "text", text: "short" }] }] as any),
  record(),
  undefined,
  theme,
  vi.fn(),
);
expect(shortViewer.render(100).join("\n")).not.toMatch(/[┃█]/u);
```

- [ ] **Step 2: Add thumb movement coverage**

Capture the row containing the thumb before and after jumping to the top:

```ts
const bottomLines = viewer.render(100);
const bottomThumb = bottomLines.findIndex((line) => line.includes("┃") || line.includes("█"));
viewer.handleInput("g");
const topLines = viewer.render(100);
const topThumb = topLines.findIndex((line) => line.includes("┃") || line.includes("█"));
expect(bottomThumb).toBeGreaterThan(topThumb);
```

Keep the assertion focused on the rail location, not on a particular color escape sequence, because the test theme intentionally strips most color styles.

- [ ] **Step 3: Run the focused test and confirm it fails before implementation**

Run:

```bash
cd /tmp/pi-canonical/pi-subagents-work
npx vitest run test/ui/conversation-viewer.test.ts
```

Expected: the existing ConversationViewer tests pass, and the new long-transcript rail assertion fails because the main viewer currently has no `┃`/`█` rail. Do not change production code in this step.

---

### Task 2: Render the main transcript scrollbar without changing layout semantics

**Files:**
- Modify: `src/ui/conversation-viewer.ts:32-52, 444-548`

**Interfaces:**
- Consumes: `renderScrollbarCell()`, `scrollOffset`, `autoScroll`, `viewportHeight()`, `buildContentLines()`, and existing `handleMouse()` geometry.
- Produces: main viewer content rows with a reserved rightmost rail while Tool Preview continues using its own `FullToolPreview` viewport.

- [ ] **Step 1: Define the content rail width and preserve outer width**

Inside `render(width)`, keep `innerW = width - 4` for the existing frame/header geometry. Define one transcript-width rule and use it at every content-line build site:

```ts
const transcriptWidth = (innerW: number): number => Math.max(1, innerW - 1);
const contentWidth = transcriptWidth(innerW);
```

Use `contentWidth` when building transcript lines and rendering transcript text. Replace existing `buildContentLines(this.lastInnerW || 80)` calls in input/focus/search paths with `buildContentLines(transcriptWidth(this.lastInnerW || 80))`; use `transcriptWidth(innerW)` in mouse handling. Keep `lastInnerW` as the full inner width so header close-button geometry remains unchanged.

- [ ] **Step 2: Add a content-row renderer that reserves the rail**

Keep the current `row()` helper for header, invocation, separator, composer/search and footer. Add a separate content-row path with this shape:

```ts
const contentRow = (content: string, lineIndex: number, totalLines: number, viewportHeight: number, offset: number) => {
  const rail = renderScrollbarCell(th, totalLines, viewportHeight, offset, lineIndex, false);
  const text = truncateToWidth(pad(content, contentWidth), contentWidth, "...", true);
  return th.fg("border", "│") + " " + text + rail + " " + th.fg("border", "│");
};
```

The implementation may use an equivalent local helper, but the invariant is fixed: one rail cell is outside the transcript text width and the resulting row remains exactly `width` columns wide.

- [ ] **Step 3: Apply the rail only to visible transcript rows**

Build content lines at `contentWidth`, compute `visibleStart` and `viewportHeight` as before, and render each displayed/blank transcript row through `contentRow`. Pass the relative visible row index to `renderScrollbarCell()` with the existing total line count and `visibleStart` offset. Preserve the sticky role header replacement and all existing focus/search styling before adding the rail.

Do not add a rail to the outer header, invocation row, separator, composer/search row, or footer. When `totalLines <= viewportHeight`, `renderScrollbarCell()` must leave the rail visually empty while preserving its width.

- [ ] **Step 4: Keep mouse hit-testing out of the visual rail**

In `handleMouse()`, use the same `contentWidth = Math.max(1, innerW - 1)` for content geometry. Preserve wheel scrolling over the viewport, but do not pass click/press/move events from the reserved rail column into `ConversationTimeline`; the rail is visual-only and must not become a focus target. Header close-button hit testing continues to use full `innerW`.

- [ ] **Step 5: Run the focused tests and iterate**

Run:

```bash
cd /tmp/pi-canonical/pi-subagents-work
npx vitest run test/ui/conversation-viewer.test.ts
```

Expected: all focused tests pass, including the long-transcript rail presence, short-transcript no-thumb, and thumb movement assertions. If the content width or mouse coordinate assumptions fail, fix only the viewer geometry and rerun this focused suite.

---

### Task 3: Verify regression coverage and package gates

**Files:**
- Inspect: `src/ui/conversation-viewer.ts`
- Inspect: `test/ui/conversation-viewer.test.ts`
- Inspect: `docs/superpowers/specs/2026-09-30-conversation-viewer-scrollbar-design.md`

**Interfaces:**
- Consumes: the implementation and tests from Tasks 1–2.
- Produces: passing verification evidence and a clean diff suitable for release review.

- [ ] **Step 1: Run the full unit suite**

```bash
cd /tmp/pi-canonical/pi-subagents-work
npm test
```

Expected: all test files pass; skipped tests may remain only where the existing suite intentionally skips live-model coverage.

- [ ] **Step 2: Run static checks and build**

```bash
cd /tmp/pi-canonical/pi-subagents-work
npm run lint
npm run typecheck
npm run build
```

Expected: Biome reports no errors, TypeScript reports no errors, and `dist/` compiles successfully.

- [ ] **Step 3: Run the e2e and package checks**

```bash
cd /tmp/pi-canonical/pi-subagents-work
npm run test:e2e
npm pack --dry-run
```

Expected: the faux/scripted e2e suite passes, the tarball includes the compiled `dist/ui/conversation-viewer.js`, and no test source is required at runtime.

- [ ] **Step 4: Review the final diff and commit**

```bash
cd /tmp/pi-canonical/pi-subagents-work
git diff --check
git status --short
git add src/ui/conversation-viewer.ts test/ui/conversation-viewer.test.ts docs/superpowers/plans/2026-09-30-conversation-viewer-scrollbar.md
git commit -m "feat: add conversation viewer scrollbar"
```

Expected: only the intended viewer source, focused tests, and this implementation plan are included in the feature commit. Do not publish or push this feature unless the user explicitly requests a release after reviewing the verification results.
