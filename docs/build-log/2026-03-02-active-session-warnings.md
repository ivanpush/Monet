# 2026-03-02: Warn before interrupting active sessions on color change
**Commit:** `eb54aa2`

## Problem
When a user changes project color and selects "Apply to existing sessions", `refreshSession()` disposes the old terminal immediately. If Claude is mid-response (thinking, active, or waiting for input), the output gets truncated with no warning.

## Fix
Before showing the "Apply to N sessions" QuickPick, read each session's status file via `statusWatcher.getStatus()`. If any sessions are non-idle/non-stopped, change the QuickPick description from the neutral "Migrates conversations..." to "Note: will interrupt N active tasks".

## Changes
- `src/extension.ts` — `monet.changeColor` command: insert busy-count loop before QuickPick, make `description` conditional on `busyCount`

## Safety
- Read-only: `getStatus()` is a single `fs.readFile` + JSON.parse, no writes
- No new control flow after the QuickPick — `refreshSession()`, `markSessionsStale()`, `getAllSessions()` called identically
- No changes to: statusWatcher, sessionManager, hooksManager, hooksInstaller, types, terminal lifecycle, PID tracking, `.csid` forwarding
- try/catch around each `getStatus()` call — read failures treated as idle (no false positives)
