# 2026-03-01: Remove 20-session slot limit

## Summary
Removed the artificial 1-20 slot system that capped concurrent sessions. Sessions are now keyed by their 8-char hex `sessionId` (which was already the true unique identifier on disk, in hooks, and in env vars). No session limit.

## Changes
- `src/types.ts` — Removed `position: number` from `SessionMeta` interface
- `src/sessionManager.ts` — Deleted `MAX_SLOTS`, `findNextSlot()`, `getSlotForTerminal()`, `getActiveSlots()`. Changed `sessions` Map from `Map<number, SessionMeta>` to `Map<string, SessionMeta>` keyed by sessionId. Simplified `terminalToSession` from `Map<Terminal, {slot, sessionId}>` to `Map<Terminal, string>`. `deleteSession(slot, sessionId)` → `deleteSession(sessionId)`. Simplified `loadSessions()`, `saveSessions()`, `reconnectSessions()`, and PID save block.
- `src/extension.ts` — Terminal focus handler now uses `getSessionIdForTerminal()` + `sessionId` lookup instead of `getSlotForTerminal()` + `position` lookup. Removed stale FUTURE comment about slots becoming UUIDs.

## Not changed (verified safe)
- `statusWatcher.ts` — uses `getTerminalForSession(sessionId)`, zero slot references
- `projectManager.ts` — has its own color "slots" (0-9), unrelated
- `hooksManager.ts`, `hooksInstaller.ts` — use sessionId only

## GlobalState migration
No migration code needed — `clearGlobalStateSessions()` wipes globalState on fresh loads, and `reconnectSessions()` rebuilds from disk on Extension Host restarts.
