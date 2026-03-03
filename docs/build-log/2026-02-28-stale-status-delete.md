> Superseded by [2026-03-01-orphan-status-cleanup](./2026-03-01-orphan-status-cleanup.md)

# ~~2026-02-28: Delete stale status files instead of nulling PIDs~~

## Summary
`cleanupStaleStatusFiles()` previously nulled the `processId` in orphan status files but kept them on disk "for history." No code ever reads these orphan files — no history UI exists. Changed to delete the file entirely.

## Rationale
Status files serve two purposes while a session is alive: (1) IPC channel for hooks→watcher terminal renaming, (2) PID persistence for Extension Host restart reconnection. Claude's built-in `--resume` handles Claude-side session continuity. Once the process is dead and no terminal exists, the file is dead weight.

## Changes
- `src/sessionManager.ts` — `cleanupStaleStatusFiles()`: `fs.unlink` instead of null-and-rewrite

## Safety
- Only runs on fresh Cursor loads (`hasMonetTerminals()` → false), never during EH restarts
- `isProcessAlive(pid)` check means live sessions across Cursor windows are untouched
- Watcher `poll()` catches ENOENT silently — no crash if file disappears mid-poll
- `disposeStaleTerminals()` runs before this, so PID reads for disposal are unaffected
- Scope identical to before (only files WITH processId where process is dead)
