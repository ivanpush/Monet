# Monet — VS Code Extension

Terminal-native AI session manager. No webview, no panel. Colors terminals by project, auto-renames them from agent status files, reconnects sessions after Extension Host restarts.

## How It Works
- Paintcan button in terminal toolbar → New Session / Continue
- Each session gets unique 8-char hex `sessionId` (e.g., `f7ee09cf`)
- Hooks baked into `.claude/settings.local.json` update status on Claude events
- Agent writes `~/.monet/status/{sessionId}.json` → poll loop renames terminal
- Terminal name format: `{emoji} — {title}` (e.g., `🟢 — Fixing auth bug`)
- PID stored in status file for reconnection after Extension Host restart

## Key Files
- `src/extension.ts` — entry point, registers commands, activates managers
- `src/types.ts` — SessionMeta, SessionStatusFile, STATUS_EMOJI, PROJECT_COLORS
- `src/sessionManager.ts` — creates sessions, tracks terminals, PID-based reconnection
- `src/projectManager.ts` — scans ~/Projects, assigns colors per project path
- `src/statusWatcher.ts` — fs.watch + poll loop, renames terminals from status files
- `src/hooksManager.ts` — installs/removes Claude Code hooks in project settings
- `src/hooksInstaller.ts` — installs ~/.monet/bin scripts (monet-status, monet-title)

## Rules
- Async IO only (`fs.promises`). Sync blocks UI thread.
- Atomic file writes: write to `.tmp`, then `fs.rename()`.
- `fs.watch` for ~/.monet/status/. VS Code watchers unreliable outside workspace.
- try/catch everything. Never crash on bad data.
- Never touch user's CLAUDE.md.

## Status Emoji (4 states)
- 🔵 `thinking` — processing user prompt
- 🟢 `active` — using tools
- 🟡 `waiting` — needs user input/permission
- ⚪ `idle` — done, waiting for next prompt

## Session Tracking
- `sessionId`: 8-char hex UUID, unique per session, never changes
- `MONET_SESSION_ID` env var set on terminal creation for slash commands
- Status file: `~/.monet/status/{sessionId}.json`
- Hooks: `~/.monet/bin/monet-status {sessionId} {status}`
- Slots 1-20 used internally for limiting concurrent sessions

## Persistence
- `globalState 'monet.sessions'` → in-memory session metadata
- `~/.monet/status/{sessionId}.json` → disk-based session state:
  - `sessionId`, `project`, `status`, `title`, `updated`
  - `processId` — terminal PID for reconnection
  - `projectPath` — full path for fallback matching

## Reconnection (Extension Host Restart)
On activation, `reconnectSessions()` reads disk status files and matches to live terminals:
1. Primary: match `terminal.processId` === `statusFile.processId`
2. Fallback: match `terminal.cwd` === `statusFile.projectPath`

## Colors
Custom Monet palette defined in `package.json` contributes.colors:
`monet.waterLily`, `monet.gardenMint`, `monet.roseFloral`, `monet.sunlightGold`, etc.
Each project path gets assigned next available color index.

## Target Editor
Building for Cursor (VS Code fork). Install via `cursor --install-extension monet-*.vsix`.

## Build
```bash
npm run compile    # esbuild → dist/extension.js
npm run package    # vsce package → .vsix
```

---
**Always add to BUILD_LOG.md when making changes.**
