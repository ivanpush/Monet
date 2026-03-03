# 2026-02-28: Change Project Color command

## Summary
Added `monet.changeColor` command (Cmd+Shift+P → "Monet: Change Project Color") that lets users reassign a project's terminal color. Since VS Code has no API to recolor an existing terminal, stale terminals get a `⟲` suffix so users know to close them. New sessions automatically use the new color.

## Changes
- `src/types.ts` — Added `COLOR_DISPLAY_NAMES` map for human-readable color labels in QuickPick
- `src/projectManager.ts` — Added `userOverrideColors` set (persisted to globalState) to prevent user-chosen colors from being freed on last terminal close. New methods: `getColorIndexForProject()`, `getAllColorAssignments()`, `setColor()`. Modified `releaseColor()` to skip user overrides. Modified `clearColors()` to clear overrides.
- `src/sessionManager.ts` — Added `staleSessionIds` set (persisted to globalState) for tracking terminals with outdated colors. New methods: `markSessionsStale()`, `isSessionStale()`. Modified `deleteSession()`, `resetAllSessions()`, `clearGlobalStateSessions()` to clean up stale markers.
- `src/statusWatcher.ts` — In `poll()`, appends ` ⟲` to terminal name if session is stale (4 lines, after the `stopped` branch's `continue`)
- `src/extension.ts` — Registered `monet.changeColor` command with QuickPick UX. Shows available colors, marks current, excludes colors used by other projects.
- `package.json` — Declared `monet.changeColor` in `contributes.commands` and `commandPalette`

## Safety
- `userOverrideColors` prevents user-chosen color from being freed on last terminal close
- `staleSessionIds` persisted to globalState — survives Extension Host restarts
- `stopped` terminals (`zsh [ex-claude]`) never get the ⟲ indicator (handled by `continue` before stale check)
- Colors in use by other projects are excluded from QuickPick (no stealing)
- No-terminal color change works (setColor persists, markSessionsStale no-ops on empty session list)
- Full reset via `monet.reset` clears everything including user overrides + stale markers
- No changes to: hooks, status files on disk, PID tracking, reconnection logic
