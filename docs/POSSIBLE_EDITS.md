# Possible Edits

2026-02-28

---

## Reduce stale terminal flash on Cursor startup

Cursor doesn't respect `isTransient: true` on `createTerminal()`, so stale Monet terminals briefly flash before `disposeStaleTerminals()` removes them (~1 second). Two options to reduce/eliminate this:

### Option A: Earlier activation event
Change `activationEvents` in `package.json` from `"onStartupFinished"` to `"*"`. This activates Monet earlier in the startup sequence — `onStartupFinished` waits for ALL other extensions to finish first, adding unnecessary delay before cleanup runs.

**Tradeoff**: Slightly increases Cursor startup time since Monet activates before other extensions finish. Probably negligible.

### Option B: Disable Cursor's terminal persistence
Set `terminal.integrated.enablePersistentSessions: false` in Cursor user settings. This prevents Cursor from restoring ANY terminals across sessions.

**Tradeoff**: Affects all terminals, not just Monet's. If user has non-Monet terminals they want persisted, this breaks that. But if Monet is the sole terminal manager, this is the cleanest fix.

### Why `isTransient` doesn't work
Tested `isTransient: true` on `createTerminal()` — Cursor (VS Code fork) ignores this flag entirely. Terminals are still serialized and restored on next launch. Reverted.

### Why `deactivate()` disposal doesn't work
Can't dispose terminals in `deactivate()` because it also fires on Extension Host restarts (triggered by project switching via `updateWorkspaceFolders`). Would kill live terminals on every project switch.
