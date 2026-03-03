# 2026-02-26: Revert sendTextWhenReady — use direct terminal.sendText()

## Problem
`claude` command stopped being sent into new Monet terminals. The `sendTextWhenReady()` wrapper relied on VS Code's shell integration API (`onDidChangeTerminalShellIntegration`), which doesn't exist in Cursor, causing the command to silently never fire.

## Fix
- Reverted `sendTextWhenReady(terminal, cmd)` back to `terminal.sendText(cmd)` in both `createSession()` and `continueSession()`
- Deleted the entire `sendTextWhenReady()` method (37 lines) — no longer used

## Files Changed
- `src/sessionManager.ts` — two call sites reverted, method deleted
