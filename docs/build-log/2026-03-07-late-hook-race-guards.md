# 2026-03-07: Late async hook race guards
**Commit:** —

## Problem
Hooks are async, so when a turn ends, Stop and Notification/PreToolUse can complete in any order. If a late Notification completes AFTER Stop, it overwrites `idle` with `waiting` — and since no subsequent hook fires, the session stays yellow forever. Same race applies to a late PreToolUse overwriting `idle` with `active`.

From user trace:
```
Async hook Stop completed        ← sets idle
Async hook Notification completed ← overwrites with waiting (BUG)
```

## Fix
Added two guards in `MONET_STATUS_SCRIPT` (inside `hooksInstaller.ts`) after the existing `stopped`/`pending_stop` checks:

1. `waiting` cannot overwrite `idle` or `pending_stop` — only UserPromptSubmit (new turn) exits idle
2. `active` cannot overwrite `idle` — a stale PreToolUse after Stop is the same race class

Both guards `process.exit(0)` to silently discard the stale status update.

## Changes
- `src/hooksInstaller.ts` — two guard conditions in `MONET_STATUS_SCRIPT` string (~line 54-59)

## Safety
- Only `hooksInstaller.ts` modified (inside the status script string)
- No changes to sessionManager, statusWatcher, hooksManager, projectManager, types, or extension.ts
- Legitimate mid-turn transitions unaffected: `active → waiting` (Notification during tool use) and `thinking → active` (PreToolUse during turn) both work because existing status is not `idle`
- Script hash auto-updates, so `~/.monet/bin/monet-status` rewritten on next activation
