# Plan: Clean up terminal state on exit / shutdown

> 2026-02-27

## Context

When Ctrl+C kills Claude Code, or Cursor closes/restarts, terminals are left dirty:
- Emoji stuck at 🟢/🟡 (never transitions)
- Terminal name frozen at last state
- The SessionEnd hook's `printf '\033]0;zsh\007'` OSC escape doesn't work because `renameWithArg` locks the terminal name in VS Code — OSC sequences are ignored after that
- Status files left with stale `active`/`waiting` state on disk

**Desired end state on Ctrl+C / exit**: Terminal name becomes `zsh [X-CLAUDE]` — strip the Monet emoji/title, show shell name with a dead-session marker. NOT white emoji idle.

Four failure scenarios:
- **A** — Ctrl+C kills Claude (terminal stays alive, onDidCloseTerminal does NOT fire)
- **B** — User closes terminal tab (onDidCloseTerminal fires, file immediately deleted)
- **C** — Cursor window closes (deactivate fires but does no cleanup)
- **D** — Cursor crash / force-quit (nothing fires, stale files remain)

---

## Changes

### 1. SessionEnd hook → write idle via monet-status (fixes Scenario A)
**File**: `src/hooksManager.ts:128-138`

Replace the broken OSC escape with `monet-status idle`. The SessionEnd hook fires inside the terminal shell when Claude CLI exits (including Ctrl+C). The shell is still alive, so `monet-status` can write idle to the status file. The poll loop picks it up within ~1s.

```
- printf '\\033]0;zsh\\007'
+ ~/.monet/bin/monet-status $MONET_SESSION_ID idle
```

### 2. Poll loop: rename to `zsh [X-CLAUDE]` on idle (not ⚪)
**File**: `src/statusWatcher.ts:146-153`

When the poll loop sees `status: 'idle'`, instead of renaming to `⚪ — {title}`, rename to `zsh [X-CLAUDE]`. This makes it clear the session is dead. The white emoji idle state was confusing — it looked like the session was still alive.

```typescript
// In poll(), when building newName:
if (status.status === 'idle') {
  newName = 'zsh [X-CLAUDE]';
} else {
  const emoji = STATUS_EMOJI[status.status] || '⚪';
  newName = status.title ? `${emoji} — ${status.title}` : `${emoji} — Claude | new session`;
}
```

### 3. onDidCloseTerminal → write idle before deleting (fixes Scenario B)
**File**: `src/sessionManager.ts:42-48`

Before calling `deleteSession()` (which deletes the file), write idle to the status file first.

```typescript
vscode.window.onDidCloseTerminal(async terminal => {
  const sessionInfo = this.terminalToSession.get(terminal);
  if (sessionInfo) {
    this.terminalToSession.delete(terminal);
    await this.writeIdleToStatusFile(sessionInfo.sessionId);  // NEW
    await this.deleteSession(sessionInfo.slot, sessionInfo.sessionId);
  }
});
```

New private method `writeIdleToStatusFile(sessionId)` — read-modify-write the status file, set `status: 'idle'`, null out `processId`, atomic write. Pattern from existing `statusWatcher.writeIdleStatus()` at `src/statusWatcher.ts:319-348`.

### 4. deactivate() → sync write idle to all sessions (fixes Scenario C)
**Files**: `src/extension.ts:320-329` + `src/sessionManager.ts` (new method)

Use **synchronous** file IO in `deactivate()` — async may not complete during shutdown. This is the one justified sync IO use.

```typescript
export function deactivate() {
  if (terminalFocusDebounceTimer) clearTimeout(terminalFocusDebounceTimer);
  if (statusWatcher) statusWatcher.stop();
  if (sessionManager) sessionManager.writeIdleToAllSessionsSync();  // NEW
}
```

New method `writeIdleToAllSessionsSync()` on SessionManager — iterate sessions, sync-read each status file, set `status: 'idle'`, sync-write atomically. Keep `processId` (terminal may survive Extension Host restart).

### 5. cleanupStaleStatusFiles → also set idle (fixes Scenario D)
**File**: `src/sessionManager.ts:464` (one-line addition)

Currently only nulls `processId` for dead processes. Also set `status: 'idle'`.

```typescript
parsed.processId = undefined;
parsed.status = 'idle';  // ADD THIS LINE
parsed.updated = Date.now();
```

### 6. Staleness detection in poll loop (universal safety net)
**File**: `src/statusWatcher.ts` (inside `poll()`)

If a status file shows non-idle but `updated` timestamp is >5 min old, auto-write idle. Uses existing `this.writeIdleStatus(sessionId)`.

```typescript
const STALE_THRESHOLD_MS = 5 * 60 * 1000;
if (status.status !== 'idle' && (Date.now() - status.updated) > STALE_THRESHOLD_MS) {
  await this.writeIdleStatus(sessionId);
  status.status = 'idle';
}
```

---

## Implementation order

1. Change 1 (SessionEnd hook) — highest impact, 1-line change
2. Change 2 (idle → `zsh [X-CLAUDE]` rename) — defines the end state
3. Change 5 (cleanupStaleStatusFiles) — 1-line addition
4. Change 4 (deactivate sync write) — new method + deactivate call
5. Change 3 (onDidCloseTerminal) — new method + handler update
6. Change 6 (staleness detection) — safety net

## Files modified
- `src/hooksManager.ts` — SessionEnd hook command
- `src/statusWatcher.ts` — idle rename to `zsh [X-CLAUDE]`, staleness detection
- `src/sessionManager.ts` — writeIdleToStatusFile, writeIdleToAllSessionsSync, onDidCloseTerminal, cleanupStaleStatusFiles
- `src/extension.ts` — deactivate() cleanup

## Existing code to reuse
- `statusWatcher.writeIdleStatus()` at `src/statusWatcher.ts:319-348`
- `monet-status` script at `src/hooksInstaller.ts:18-68`

## Verification
1. `npm run compile`
2. Install .vsix in Cursor
3. Start a session → Ctrl+C → terminal should rename to `zsh [X-CLAUDE]` within ~1s
4. Close terminal tab → status file briefly shows idle before deletion
5. Reload Cursor window → stale sessions show `zsh [X-CLAUDE]`
6. Leave session 5+ min with corrupted status → auto-corrects to idle
