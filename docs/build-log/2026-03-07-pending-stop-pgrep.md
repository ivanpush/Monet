# 2026-03-07: Process-based session exit detection via pending_stop + pgrep
**Commit:** `35fedaf`

## Problem
SessionEnd hook's `matcher: 'logout'` missed Ctrl+C exits (they fire as `prompt_input_exit`, not `logout`). Using `prompt_input_exit` catches those but also fires on plan acceptance, falsely marking sessions as `stopped`. Since `stopped` is a one-way state, the session can't recover.

## Fix
Two-phase exit detection: SessionEnd hook signals intent (`pending_stop`), statusWatcher confirms via `pgrep -P <shellPid> -x claude` before committing to `stopped`.

1. SessionEnd matcher changed to `logout|prompt_input_exit`, writes `pending_stop` instead of `stopped`, OSC escape removed (statusWatcher handles rename after confirmation)
2. StatusWatcher schedules a one-shot 1.5s timer when it sees `pending_stop`, then runs `pgrep` to check if claude child process is alive
3. If dead: writes `stopped` + renames terminal. If alive (false positive): reverts to `idle`. If check failed: leaves as `pending_stop`, next poll retries.
4. If status changes before timer fires (e.g. UserPromptSubmit -> active), timer is cancelled.
5. reconnectSessions handles `pending_stop` on extension restart with the same pgrep check.

## Changes
- `src/types.ts` — added `pending_stop: '⚪'` to STATUS_EMOJI
- `src/hooksManager.ts` — SessionEnd matcher `logout|prompt_input_exit`, writes `pending_stop`, removed OSC escape
- `src/hooksInstaller.ts` — monet-status: guard `pending_stop` from overwriting `stopped`. monet-title-check: skip for `stopped` or `pending_stop` (both pre and post claude -p guards)
- `src/statusWatcher.ts` — `pendingStopTimers` map, `hasClaudeChild()` via pgrep, `confirmPendingStop()`, `writeStoppedStatus()`, pending_stop display as idle, timer cleanup in `stop()`
- `src/extension.ts` — changeColor filter skips `pending_stop` alongside `stopped`
- `src/sessionManager.ts` — `hasClaudeChild()`, `writeStoppedStatusFile()`, `writeIdleStatusFile()`, reconnectSessions handles `pending_stop`

## Safety
- Stop hook unchanged (still writes `idle`)
- UserPromptSubmit / PreToolUse / Notification hooks unchanged
- Terminal rename queue mechanics unchanged
- Title system unchanged (except guard additions in monet-title-check)
- Color assignment / release unchanged
- onDidCloseTerminal cleanup path unchanged
- `pending_stop` displays as idle (⚪) — no visual disruption during confirmation window
