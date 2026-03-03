# 2026-03-01: Fix status file cleanup — delete all orphans

## Summary
`cleanupStaleStatusFiles()` only deleted files with a dead `processId`. Files with **no PID at all** (most of the 80+ accumulated files) and junk filenames (`active.json`, `stopped.json`, `test1234.json`) were never cleaned up. Fixed to catch all orphan cases. Also added post-reconnect cleanup so EH restarts don't leave orphans either.

## Root cause
The original guard `if (parsed.processId && !this.isProcessAlive(parsed.processId))` skipped any file where `processId` was falsy (undefined/null). Most old status files from early testing never had a PID written.

## Changes
- `src/sessionManager.ts` — Rewrote `cleanupStaleStatusFiles()` with 3 deletion paths: (1) non-standard filenames, (2) dead PIDs, (3) no PID at all. Added `cleanupUnmatchedStatusFiles()` — runs after the second reconnectSessions() pass, deletes any status file not matched to a tracked session (with PID alive guard for multi-window safety). Updated reconnect setTimeout to chain cleanup after second pass.
- `src/extension.ts` — Updated comment to reflect new behavior (delete, not null)

## Safety
- `process.kill(pid, 0)` is a kernel-level system-wide check — multi-window safe. Window B won't delete Window A's live files.
- `cleanupUnmatchedStatusFiles` runs after the 750ms second reconnect pass — no race with late-connecting terminals
- Fresh load path unchanged: still gated by `hasMonetTerminals()` check
- All deletions use `fs.unlink` with catch — won't crash on missing files

### ~~2026-02-28: Delete stale status files instead of nulling PIDs~~
> Superseded by this entry. The original fix still only targeted files with dead PIDs.
