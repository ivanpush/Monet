# 2026-02-26: Fix Worktree Bugs & Double Command Firing

## Fix 1: PTY Race Condition — Double Command Firing
- Added `sendTextWhenReady()` method to `SessionManager` that feature-detects `onDidChangeTerminalShellIntegration` (VS Code 1.93+)
- Modern VS Code: waits for shell integration readiness signal, 1.5s fallback
- Cursor/older: 500ms delay after `terminal.show()`
- Replaced both `terminal.sendText()` call sites in `createSession()` and `continueSession()`

## Fix 2: Worktree Listing Bug — `fs.promises.readdir` → `fs.readdir`
- `fs` was imported from `fs/promises`, so `fs.promises` was `undefined`
- Silent throw in try/catch meant existing worktrees never appeared in picker

## Fix 3: Project Selection for New Branch
- Added project picker fallback (filtered to git repos) when no project is open
- Mirrors the pattern from `newSession` command

## Fix 4: Worktree Delete Option
- Added `$(trash) Delete: {name}` entries to worktree QuickPick
- Uses `execFile` (no shell) to prevent command injection
- Modal confirmation → `git worktree remove` → `git branch -d` (non-fatal) → success message

## Fix 5: Worktree Name in Session Metadata
- Added `worktreeName?: string` to `SessionMeta` in `types.ts`
- Stored in `createSession()` when provided
- Initial terminal name: `⚪ — Claude | {worktreeName}` instead of generic `new session`

## Files Changed
- `src/sessionManager.ts` — `sendTextWhenReady()`, worktree name in metadata + initial name
- `src/extension.ts` — `fs.readdir` fix, project picker, delete worktree action
- `src/types.ts` — `worktreeName` field on `SessionMeta`
