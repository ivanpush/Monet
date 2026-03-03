# 2026-02-24: Reconnection System

Evolution of session reconnection through multiple iterations — from anchor folders to PID matching to disk persistence.

---

## Belt and Suspenders - Anchor Folder + PID Reconnection

**Problem:** Extension Host restarts when switching projects (VS Code limitation). All terminal-to-session mappings lost.

**Solution: Two-pronged approach**

**Part 1: Anchor Folder (Prevention)**
- Keep `~/.monet` as workspace folder index 0 at all times
- Project folders swap at index 1 only
- Prevents Extension Host restart because folder 0 never changes

**Part 2: PID Reconnection (Recovery)**
- Store terminal PID in `SessionMeta.processId` field
- On activation, match live terminal PIDs to stored sessions
- Double-tap: `reconnectSessions()` called immediately + after 750ms delay

**Key Changes:**
1. `src/types.ts` — Added `processId?: number` to `SessionMeta`
2. `src/extension.ts` — Added `ensureAnchorFolder()`, `swapProjectFolder()` functions
3. `src/sessionManager.ts` — Added `getPidWithRetry()`, `reconnectSessions()`, PID saving

---

## Remove ensureAnchorFolder — User Manages Anchor

User now manually pins `~/.monet-anchor` as workspace folder index 0. Extension code must never add, remove, or modify index 0.

**Files modified:** `src/extension.ts`

---

## Remove Anchor Folder + Add Output Channel Logging

1. **Removed anchor folder code entirely** — reverted to simple `updateWorkspaceFolders(0, length, {uri})`
2. **Added VS Code Output Channel for logging** — `vscode.window.createOutputChannel('Monet')`, all `console.log` calls replaced

**Files modified:** `src/extension.ts`, `src/sessionManager.ts`

---

## Name+Path Fallback for Session Reconnection

**Problem:** PID matching can fail if VS Code assigns new PIDs after restart.

**Solution:** Added fallback matching by `terminal.name === meta.terminalName && meta.projectPath !== undefined`. If matched via fallback, update stored PID.

**Files modified:** `src/sessionManager.ts`

---

## Disk-Persisted PID for Reconnection (Extension Host Restart Fix)

**Problem:** `reconnectSessions()` tried to match terminal PIDs against `meta.processId` from VS Code workspaceState. BUT workspaceState is wiped on every Extension Host restart. PID matching never worked.

**Solution:** Persist `processId`, `terminalName`, and `projectPath` to disk in status files (`~/.monet/status/{sessionId}.json`). `reconnectSessions()` now reads session data from disk files instead of globalState.

**Key Changes:**
1. `src/types.ts` — Added `processId`, `terminalName`, `projectPath` to `SessionStatusFile`
2. `src/sessionManager.ts` — Rewrote `writeStatusFile()` and `reconnectSessions()` to use disk
3. `src/statusWatcher.ts` — Updated `writeIdleStatus()` to preserve new fields

---

## Remove terminalName from Status Files

**Change:** Replaced terminalName-based fallback matching with projectPath matching. Terminal names change frequently; projectPath is stable. Fallback now uses `terminal.shellIntegration?.cwd` or `terminal.creationOptions.cwd`.

**Files modified:**
- `src/types.ts` — Removed `terminalName` from SessionStatusFile
- `src/sessionManager.ts` — Updated writeStatusFile(), reconnectSessions() fallback
- `src/statusWatcher.ts` — Updated comments
- `scripts/verify-reconnect.py` — Shows projectPath instead of terminalName
