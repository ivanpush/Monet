# 2026-03-07: Late async hook race guards
**Commits:** `d0e5de3`, `29cd2fd`

## Problem
Hooks are async, so when a turn ends, Stop and Notification can complete in any order. If a late Notification completes AFTER Stop, it overwrites `idle` with `waiting` — and since no subsequent hook fires, the session stays yellow forever.

From user trace:
```
Async hook Stop completed        <- sets idle
Async hook Notification completed <- overwrites with waiting (BUG)
```

## Fix
Added one guard in `MONET_STATUS_SCRIPT` (inside `hooksInstaller.ts`) after the existing `stopped`/`pending_stop` checks:

- `waiting` cannot overwrite `idle` or `pending_stop` — only `active` (via UserPromptSubmit starting a new turn) exits idle

The guard `process.exit(0)` silently discards the stale status update.

### Reverted: `active` guard
Initially also added a guard blocking `active` from overwriting `idle` (to catch late PreToolUse after Stop). **Reverted in `29cd2fd`** because both `UserPromptSubmit` and `PreToolUse` call `monet-status active` — the script can't distinguish them, so the guard also blocked starting new turns (session stuck white/idle). The `active` overwriting `idle` race remains theoretical but is far less likely than the Notification race.

## Changes
- `src/hooksInstaller.ts` — one guard condition in `MONET_STATUS_SCRIPT` string (~line 54-56)

## Safety
- Only `hooksInstaller.ts` modified (inside the status script string)
- No changes to sessionManager, statusWatcher, hooksManager, projectManager, types, or extension.ts
- Legitimate mid-turn `active -> waiting` (Notification during tool use) unaffected because existing status is `active`, not `idle`
- Script hash auto-updates, so `~/.monet/bin/monet-status` rewritten on next activation
