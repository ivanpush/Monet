# 2026-02-26: Fix project-switch terminal race condition

## Problem
Switching to a different project then creating a session caused garbled command delivery. User saw "Terminal 5" briefly, then the `claude` command sent before the shell was ready (conda/nvm still activating). Worked fine when staying in the same project.

## Root Cause
1. `sendTextWhenReady` used a hardcoded 500ms delay — insufficient when shell needs to activate conda/nvm in a new directory
2. `updateWorkspaceFolders()` is fire-and-forget (returns boolean, not promise) — terminal was created while VS Code was still processing the workspace change

## Fix 1: Smart shell readiness detection in `sendTextWhenReady`
- Tries `terminal.shellIntegration` first (immediate if already ready)
- Listens for `onDidChangeTerminalShellIntegration` event (fires after full shell init including conda)
- Falls back to 3s timeout with listener, 1.5s without (vs old 500ms)

## Fix 2: Wait for workspace folder change before creating terminal
- In `newSession` and `newBranch`, await `onDidChangeWorkspaceFolders` event after `updateWorkspaceFolders()` call
- 1s timeout fallback if event doesn't fire

## Files Changed
- `src/sessionManager.ts` — rewrote `sendTextWhenReady` with shell integration + fallback
- `src/extension.ts` — added workspace change wait in `newSession` and `newBranch`
