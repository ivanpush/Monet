# 2026-03-07: Fix rename-triggered workspace switch
**Commit:** _pending_

## Problem
When the status watcher renames a terminal (e.g. session goes idle), it briefly focuses that terminal. The `onDidChangeActiveTerminal` listener sees the focus change and auto-switches the workspace to that terminal's project. Result: working in Project A, a Project B session goes idle, workspace yanks to Project B.

## Fix
Guard the focus listener with `statusWatcher.isRenamingTerminal`. The `isRenaming` flag is already set during renames — added a public getter and a 50ms settle delay so the flag stays true through the restore-focus event.

## Changes
- `src/statusWatcher.ts` — added `isRenamingTerminal` getter; added 50ms delay in `finally` before clearing `isRenaming`
- `src/extension.ts` — added `if (statusWatcher.isRenamingTerminal) return;` guard in focus listener

## Safety
- No effect on: session creation, status files, PIDs, colors, hooks, reconnection, title state
- User clicks still switch workspace instantly (guard only true during ~150ms rename window)
- `isRenaming` lifecycle: set true → focus + rename + restore + 50ms settle → cleared
