# 2026-03-01: Forward .csid during color change refresh (re-packaged & installed)
**Commit:** `eb54aa2`

## Problem
When `refreshSession` creates a new terminal with `claude --resume UUID`, the `--resume` flag does NOT trigger `UserPromptSubmit` — only the user typing a new prompt does. So `monet-title-draft` never writes a `.csid` for the new session. If the user changes colors again before typing anything, the new session has no `.csid` → `refreshSession` reads `undefined` → starts a bare `claude` instead of resuming → conversation lost.

Chain: A→B reads A's `.csid` (exists) → works. B→C tries to read B's `.csid` → doesn't exist → bare `claude` → conversation lost.

## Fix
In `refreshSession()`, after creating the new session, forward the `claudeSessionId` (already read from the old `.csid`) to a new `.csid` file keyed by the new session's `sessionId`. Covers both branches: title-copy path and no-title path.

## Changes
- `src/sessionManager.ts` — `refreshSession()`: write `claudeSessionId` to `{newSessionId}.csid` via atomic tmp+rename, inside the existing `if (newSession)` blocks (lines 410-427).

## Safety
- Old `.csid` still cleaned up by `deleteStatusFiles` when `oldTerminal.dispose()` fires
- New `.csid` protected from `cleanupUnmatchedStatusFiles` (new session already in `this.sessions`)
- New `.csid` protected from `cleanupStaleStatusFiles` (matching `.json` exists — written by `createSession`)
- If user eventually types, `monet-title-draft` overwrites with same (or updated) UUID — correct either way
- Atomic write pattern consistent with all Monet file writes
- No changes to any other system: hooks, status watcher, project manager, types, terminal lifecycle
