# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check `node_modules` for external API types (`@earendil-works/pi-*`, `@sinclair/typebox`, etc.); don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Match the surrounding code style — it is enforced by biome (`biome.json`).
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- This is a pi extension. Respect the Claude Code-compatible tool names, calling conventions, and UI patterns the extension deliberately mirrors; don't diverge from them without a stated reason.
- When reviewing a diff, favor solutions that are elegant, not overengineered — flag needless abstraction, layering, or defensive code that the change doesn't warrant.

## Commands

- After code changes (not docs), run only the resource-safe static checks by default:
  ```bash
  npm run lint        # biome
  npm run typecheck   # tsc --noEmit
  ```
- `npm run lint:fix` auto-fixes most style issues.
- **E2E, build, and Vitest are prohibited by default on this device due to resource and runtime limits. Run any of them only with explicit user authorization.**
- `npm test` excludes E2E directories and E2E-named test files, but the remaining suite still contains expensive integration-style tests. Do not use it as a default local gate on this device.
- The `build` script remains available only for an explicitly authorized build verification.
- For ad-hoc scripts, write them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.

### Dependency and release verification reminder

- Vitest, TypeScript, and Biome are local `devDependencies`; the complete local dependency tree is mandatory. Do not install these tools globally or rely on globally available binaries.
- `@shikijs/cli` is a runtime dependency for the optional async syntax-highlighting path. Do not move it to `devDependencies`; its transitive grammar packages are required at runtime.
- Run verification and release checks from the canonical repository checkout, not an npm-installed copy under `node_modules`. Install the complete local dependency tree with the repository's lockfile when available before checking anything.
- A missing `vitest` or `tsc` binary means the environment was not installed correctly; it is not a test assertion failure. Vitest requires explicit user authorization on this device and is not part of its default release gate.
- Offline installs are only valid when the npm cache contains the complete dependency tree. If npm reports `ENOTCACHED` (for example, a missing `@shikijs/vscode-textmate`), record the cache miss and do not claim that tests passed.

### Upstream Pi API and test-fixture compatibility

- Pi `v0.80.8` replaced `CreateAgentSessionOptions.authStorage` and `modelRegistry` with async `modelRuntime`. Keep the peer lower bound aligned with the API actually used by source; do not lock verification to an older `0.80.x` patch that predates `ModelRuntime`.
- A custom `ResourceLoader` must satisfy the complete upstream contract and implement `reload()`; a mock that only exposes `getExtensions()` is not a valid SDK fixture. Prefer a partial mock based on `importOriginal` so newly imported public helpers such as `createWriteToolDefinition` remain available.
- Faux end-to-end tests must register a real `fauxProvider()` with the test `ModelRuntime` (`models.setProvider()` or `registerNativeProvider()` as appropriate). Do not pass a legacy `modelRegistry` auth shim; missing faux credentials then appears as `No API key found for faux` and is a fixture failure, not a model failure.
- Classify failures before changing assertions: stale UI wording/shortcut tests may be updated to the current contract; width-safety, durable transcript, wiring, and lifecycle tests must retain their behavioral coverage and require an implementation fix when they fail.
- Run verification from the canonical repository, not an npm-installed copy under `node_modules`; the latter is intentionally outside Biome's workspace and may omit development tests or repository guidance.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor guidelines and quality bar.

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, and in the user's tone.

## Changelog

Location: `CHANGELOG.md` (single file, [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format).

- All new entries go under `## [Unreleased]`, in the right subsection (`### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Security`, `### Refactored`). Read the section first and append to existing subsections; never duplicate them.
- One bullet per issue/PR. Never combine separate issues or pull requests into a single entry, even when they touch the same or similar components. (A PR together with the issue it closes or that diagnosed it is one change — one bullet citing both.)
- Breaking changes are not a separate subsection. Call them out with a `> **⚠️ Breaking: …**` blockquote at the top of the version section, and/or a bold `**BREAKING:**` bullet under `### Changed`, with a migration note.
- Entries are detailed — a bold lead-in summarizing the change, then prose explaining the behavior, rationale, and any migration. Match the surrounding density.
- Released version sections (e.g. `## [0.12.0]`) are immutable; never modify them.
- Attribute external contributions: `... ([#456](https://github.com/tintinweb/pi-subagents/pull/456) — thanks [@username](https://github.com/username))`.

## Releasing

**Versioning** (all releases are `0.x`, no major bumps):

- `minor` (`0.x.0`) — a notable new feature, or any breaking change.
- `patch` (`0.x.y`) — bug fixes and smaller additions.

Before a release:

- Update `CHANGELOG.md` — move the `## [Unreleased]` entries under a new `## [X.Y.Z]` version section, and add a fresh empty `## [Unreleased]` for the next cycle.
- Update `README.md` if user-facing behavior changed (features list, settings, usage).
- Run the resource-safe release checks and fix anything that fails:
  ```bash
  npm run lint
  npm run typecheck
  npm pack --dry-run
  npm run prepublishOnly
  ```
- Vitest, E2E, and build are excluded from release verification on this device and require explicit user authorization.
- `prepublishOnly` runs lint and typecheck only; it must not invoke Vitest, E2E, or build.

**Release, push, and publish gates are explicit.** Do not push release commits or publish the package until the required verification above has passed and the user has explicitly approved that action. The user runs `npm version`, any push/tagging, and `npm publish` manually. Never run `npm publish` or push on the user's behalf unless explicitly asked.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
