# 2026-02-27: Dispose stale Monet terminals on fresh Cursor launch

## Summary
When Cursor fully closes and reopens, old Monet terminals persist visually (VS Code serializes them) but are just empty shells — the original Claude sessions are gone. Added `disposeStaleTerminals()` to clean these up on activation.

## Logic
For each terminal: check if name matches Monet pattern (`{emoji} — ...` or `zsh [ex-claude]`). If yes, check if its PID matches any disk status file. If PID matches → keep it (Extension Host restart, still alive). If not → dispose it (stale zombie). Runs before `hasMonetTerminals()` check, reads disk only, modifies nothing else.

## Changes
- `src/sessionManager.ts` — added `disposeStaleTerminals()` method, imported `STATUS_EMOJI`
- `src/extension.ts` — call `disposeStaleTerminals()` before `hasMonetTerminals()` check, removed temp test command
- `package.json` — removed `monet.testDispose` command entry

## Safety
- Only touches terminals matching Monet's unique name pattern
- PID check prevents killing live terminals during Extension Host restarts
- `onDidCloseTerminal` handler is a no-op for these (not in `terminalToSession` map)
- Read-only on disk — no status files or globalState modified
