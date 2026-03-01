# Codex Concerns

Generated from a read-only interaction-trace review of Monet (no code changes).

## 1. Double-trigger `New Session` quickly (race on slot allocation)
- Interaction: user hits keybinding twice fast, or `monet` launch file and UI command both create sessions at same time.
- Weird outcome: both calls can choose the same free slot before either persists; then one slot points to the wrong session, and closing one terminal can delete metadata/color for the other.
- Code path: `src/sessionManager.ts:199`, `src/sessionManager.ts:238`, `src/sessionManager.ts:42`, `src/sessionManager.ts:358`

## 2. `Reset All Sessions` while terminals are still open
- Interaction: user runs `Monet: Reset All Sessions` with active Claude terminals.
- Weird outcome: in-memory mappings are nuked but terminals/hook processes keep running; status files come back, watcher says “NOT FOUND”, names stop updating, and close events no longer clean up because map entries were erased.
- Code path: `src/extension.ts:137`, `src/sessionManager.ts:484`, `src/statusWatcher.ts:137`, `src/statusWatcher.ts:138`

## 3. Rename queue causes phantom terminal-focus workspace switching
- Interaction: statuses update quickly across sessions, rename queue runs repeatedly.
- Weird outcome: rename flow temporarily focuses terminals; active-terminal listener interprets that as real user focus and swaps workspace/project unexpectedly.
- Code path: `src/statusWatcher.ts:191`, `src/statusWatcher.ts:195`, `src/extension.ts:199`, `src/extension.ts:246`

## 4. Startup misclassification -> live terminals become unmanaged
- Interaction: Cursor starts, live terminals exist, but early PID lookups are not ready.
- Weird outcome: `hasMonetTerminals()` can return false too early, clears persisted sessions, and if reconnect doesn’t recover all terminals, those sessions lose Monet lifecycle tracking.
- Code path: `src/extension.ts:32`, `src/sessionManager.ts:420`, `src/sessionManager.ts:475`, `src/sessionManager.ts:73`

## 5. After restart, color count state is inconsistent
- Interaction: multiple terminals same project survive/reconnect after extension host restart, then user closes one and opens another.
- Weird outcome: terminal count map is never reconstructed, so first close can free project color too early; next session for same project can get a different color while another session is still open.
- Code path: `src/projectManager.ts:14`, `src/projectManager.ts:24`, `src/projectManager.ts:117`, `src/sessionManager.ts:148`

## 6. Launch from nested/similar folder picks wrong project
- Interaction: user runs `monet` from a path where multiple configured projects share prefixes.
- Weird outcome: fallback match uses `startsWith`, so wrong project can be attached and workspace/color metadata drift from the actual working dir.
- Code path: `src/statusWatcher.ts:257`, `src/statusWatcher.ts:259`, `src/projectManager.ts:225`

## 7. Close cleanup can remove hooks too early when session map is partial
- Interaction: reconnect only restores some sessions, then user closes one mapped terminal.
- Weird outcome: hook removal checks only current in-memory sessions; if map is incomplete, it can remove project hooks even though other live Claude terminals still exist in that project.
- Code path: `src/sessionManager.ts:372`, `src/sessionManager.ts:378`, `src/hooksManager.ts:152`

## 8. `Switch Project` cancel still yanks terminal focus
- Interaction: user opens project picker and cancels.
- Weird outcome: command still forces terminal focus, which feels like random UI jump and can chain into other focus-driven behaviors.
- Code path: `src/extension.ts:155`, `src/extension.ts:162`

## 9. Concurrent writes to `.claude/settings.local.json` can drop changes
- Interaction: user edits hooks file or another process edits it while Monet creates a session.
- Weird outcome: read-modify-write without file lock means last writer wins; intervening hook edits can be silently lost.
- Code path: `src/hooksManager.ts:50`, `src/hooksManager.ts:140`

## 10. `SessionManager` terminal-close listener isn’t registered in extension subscriptions
- Interaction: extension reload edge cases.
- Weird outcome: listener lifecycle is less explicit; potential duplicate listener behavior across unusual reload patterns can lead to duplicate delete attempts.
- Code path: `src/sessionManager.ts:42`, `src/extension.ts:254`
