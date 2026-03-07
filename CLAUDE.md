# Monet — VS Code / Cursor Extension

Multi-project AI session manager for Claude Code. Colors terminals by project, shows live status via emoji, auto-titles sessions from conversation content, and reconnects sessions after editor restarts. No webview — everything lives in the terminal.

## How It Works
- Paintcan button in terminal toolbar or panel tab (🎨) → Monet Menu → New Session / Flags / Switch Project
- `Cmd+Shift+M` opens the same menu from anywhere
- Each session gets a unique 8-char hex `sessionId` (e.g., `f7ee09cf`)
- On session creation, hooks are installed into the project's `.claude/settings.local.json`
- Hooks fire shell scripts (`~/.monet/bin/`) that write status to `~/.monet/status/{sessionId}.json`
- StatusWatcher (`fs.watch` + 1s poll fallback) reads status files and renames terminals
- Terminal name format: `{emoji} — {title}` (e.g., `🟢 — Fixing auth bug`)
- Titles come from three sources: draft (first prompt truncated), final (AI-generated on Stop), manual (`/title` slash command)
- PID stored in status file for reconnection after Extension Host restart

## Key Files
- `src/extension.ts` — entry point, registers commands + tree view, wires managers together
- `src/types.ts` — SessionMeta, SessionStatusFile, STATUS_EMOJI, PROJECT_COLORS, PROJECT_ICONS
- `src/sessionManager.ts` — creates sessions, tracks terminals, PID-based reconnection, stale terminal cleanup
- `src/projectManager.ts` — scans ~/Projects, assigns colors per project path, manages color persistence
- `src/statusWatcher.ts` — fs.watch + poll loop, renames terminals from status files, processes launch requests
- `src/hooksManager.ts` — installs/removes Claude Code hooks in project `.claude/settings.local.json`
- `src/hooksInstaller.ts` — installs `~/.monet/bin/` scripts (monet-status, monet-title, monet-title-check, monet-title-draft, monet launcher)
- `src/utils.ts` — shared utilities

## Rules
- Async IO only (`fs.promises`). Sync blocks UI thread.
- Atomic file writes: write to `.tmp`, then `fs.rename()`.
- `fs.watch` for `~/.monet/status/`. VS Code watchers unreliable outside workspace.
- try/catch everything. Never crash on bad data.
- Never touch user's CLAUDE.md.

## Status Emoji (5 states)
- 🔵 `thinking` — processing user prompt
- 🟢 `active` — using tools (also set on UserPromptSubmit to skip jitter)
- 🟡 `waiting` — needs user input/permission
- ⚪ `idle` — done, waiting for next prompt
- `stopped` — session ended (terminal renamed to `zsh [ex-claude]`)

## Session Tracking
- `sessionId`: 8-char hex from `crypto.randomUUID()`, unique per session
- `MONET_SESSION_ID` env var set on terminal creation for hooks and slash commands
- Status file: `~/.monet/status/{sessionId}.json`
- Claude session UUID stored separately in `{sessionId}.csid` to avoid race conditions
- Hooks call: `~/.monet/bin/monet-status $MONET_SESSION_ID {status}`

## Persistence
- `globalState 'monet.sessions'` → in-memory session metadata (SessionMeta map)
- `globalState 'monet.projectColors'` → project→colorIndex mappings
- `globalState 'monet.userOverrideColors'` → projects where user manually picked a color
- `globalState 'monet.activeProject'` → current project path
- `~/.monet/status/{sessionId}.json` → disk-based session state:
  - `sessionId`, `project`, `status`, `title`, `titleSource`, `updated`
  - `processId` — terminal PID for reconnection
  - `projectPath` — full path for workspace matching
- `~/.monet/status/{sessionId}.csid` — Claude's internal session UUID (for `--resume`)

## Reconnection (Extension Host Restart)
On activation, `reconnectSessions()` reads disk status files and matches to live terminals:
1. Primary: match `terminal.processId` === `statusFile.processId`
2. Two-pass: second pass at 750ms catches slow terminals
3. Post-reconnect cleanup removes unmatched status files (multi-window safe via PID checks)

## Hooks (5 events)
1. **UserPromptSubmit** → `monet-status active` + `monet-title-draft` (draft title from first prompt)
2. **PreToolUse** → `monet-status active` (yellow→green after tool approval)
3. **Notification** → `monet-status waiting` (needs input)
4. **Stop** → `monet-status idle` + `monet-title-check` (AI-generates final title via `claude -p --model haiku`)
5. **SessionEnd** → `monet-status stopped` + reset terminal name (fires in-process, works even if editor is dead)

## Colors
- 10-color Monet-inspired palette defined in `package.json` contributes.colors
- Each project gets a random available color on first session
- Colors freed when last terminal for a project closes (unless user override)
- User can change color via `Monet: Change Project Color` — option to migrate existing sessions
- Session refresh uses `--resume` with Claude session UUID from `.csid` file

## Workspace Switching
- Focusing a Monet terminal auto-switches the workspace to that session's project
- Guards prevent switching during session creation and terminal renaming
- `Switch Project` command includes "New Project" option to create folders

## Target Editor
VS Code and Cursor (VS Code fork). Install via:
```bash
code --install-extension monet-*.vsix     # VS Code
cursor --install-extension monet-*.vsix   # Cursor
```

## Build
```bash
npm run compile    # esbuild → dist/extension.js
npm run package    # vsce package → .vsix
```

## Build Log
- **Index:** `docs/build-log/INDEX.md` — read this first for prior art before any change
- **Entries:** `docs/build-log/YYYY-MM-DD-slug.md` — one file per logical change
- **Template:** `docs/build-log/_TEMPLATE.md`
- **Writing:** After every code change, create a new entry file following the template. Then prepend a row to the relevant topic section in INDEX.md. Include commit hash once committed.
- **Reading:** Before implementing, scan INDEX.md for prior art on the same subsystem. Read the specific entry files that are relevant. Don't read all entries.
- **Superseding:** When a new entry fully replaces a prior one, add `> Superseded by [YYYY-MM-DD-slug](./YYYY-MM-DD-slug.md)` at the top of the old entry.
- **Forward refs:** If a change completely rethinks a prior entry (not just builds on it), annotate that prior entry with a forward-reference.

Very important. Any time you're looking at adding features, any time you're looking at generating code, look at all the possible systems that are affected:
- Starting with the container the code is in
- Followed by the general section
- Followed by the entire file
- Followed by the entire abstract functionality  Make sure none of the systems are modified whatsoever except the intended target.Triple check your thinking each time. Unless it's obviously simple.If you're not sure, look up documentation if it's there.Give me a very short response in your planning on why this is completely safe.
-Trace agt least 10 user interaction lines to see if any conflicts or issues arise. check things like, title state, save state, pid, etc