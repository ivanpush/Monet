# 2026-02-26: Fix terminal focus listener swapping workspace during session creation

## Problem
After switching projects and creating a new session, the `claude` command fires into a terminal whose workspace just got swapped back to the previous project. First session works fine; breaks after switching projects.

## Root Cause
The `terminalFocusListener` has a 500ms debounce, but `createSession()` has a large async gap (~600ms+) between `createTerminal()` and `terminal.show()` (saveSessions, getPidWithRetry, writeStatusFile, installHooks). During this window, VS Code may briefly refocus a previous project's terminal, causing the debounce to fire `updateWorkspaceFolders()` back to the old project mid-creation.

## Fix
- Added `_isCreatingSession` guard flag to `SessionManager` (set true at start, false in `finally` block)
- Focus listener checks `sessionManager.isCreatingSession` and returns early during the critical window
- Applied to both `createSession()` and `continueSession()`

## Files Changed
- `src/sessionManager.ts` — `_isCreatingSession` flag + getter, try/finally in `createSession()` and `continueSession()`
- `src/extension.ts` — guard check in `terminalFocusListener`
