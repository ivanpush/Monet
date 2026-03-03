# 2026-02-26: Cleanup + CLI launcher (remove worktrees, add monet CLI, simplify menu)

## Summary
Removed all Monet-managed worktree code (Claude Code handles worktrees natively now). Added `monet` CLI launcher for context-aware session creation from any integrated terminal. Simplified dropdown menu from 4 to 3 items. Added SessionEnd hook for clean terminal resets.

## Changes

**Feature 1: SessionEnd Hook** (`src/hooksManager.ts`)
- Added `SessionEnd` hook that emits OSC escape sequence to rename terminal back to "zsh" when Claude session ends
- Fires inside the terminal process — works even if Cursor/extension is dead

**Feature 2: Simplified Dropdown** (`src/extension.ts`, `package.json`)
- Removed `monet.newBranch` and `monet.continueSession` commands
- Added `monet.newSessionWithFlag` — input box for arbitrary claude flags (--resume, --worktree, etc.)
- Menu now: New Session, New with Flags, Change Project
- MonetTreeProvider updated to match

**Feature 3: Worktree Code Stripped**
- `src/types.ts` — Removed `worktreeName` from `SessionMeta` and `SessionStatusFile`
- `src/sessionManager.ts` — Removed `WORKTREES_DIR`, `getWorktreePath()`, `getDeadSessions()`, `continueSession()`, worktree cwd/naming logic
- `src/branchIndicator.ts` — Simplified to always use `session.projectPath`
- `src/projectManager.ts` — Removed `suppressWorktreeDiscovery()`
- `src/extension.ts` — Removed worktree suppression calls, execFile/promisify imports

**Feature 4: `monet` CLI Launcher**
- `src/hooksInstaller.ts` — New `MONET_LAUNCH_SCRIPT` bash script installed to `~/.monet/bin/monet`. Captures cwd, git root, branch, forwards args. Writes atomic JSON to `~/.monet/launch/`. Guarded by `TERM_PROGRAM=vscode`.
- `src/statusWatcher.ts` — Added launch watcher (`fs.watch` on `~/.monet/launch/`), `processLaunchRequest()` matches gitRoot to known projects, creates session with context. Stale cleanup on startup (>30s old files deleted).
- `src/sessionManager.ts` — Refactored `createSession()` from positional params to `CreateSessionOptions` object: `{ claudeArgs, cwd, projectPath, projectName }`.

## Files Changed
| File | Changes |
|------|---------|
| `src/hooksManager.ts` | SessionEnd hook |
| `src/hooksInstaller.ts` | monet launch script, version hash updated |
| `src/extension.ts` | Strip worktree code, simplify menu, add newSessionWithFlag |
| `src/sessionManager.ts` | Strip worktree code, CreateSessionOptions refactor |
| `src/branchIndicator.ts` | Strip worktree path logic |
| `src/projectManager.ts` | Remove suppressWorktreeDiscovery |
| `src/types.ts` | Remove worktreeName from interfaces |
| `src/statusWatcher.ts` | Launch watcher + processLaunchRequest |
| `package.json` | Remove newBranch/continueSession, add newSessionWithFlag |
