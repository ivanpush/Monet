# Monet — VS Code Extension

Terminal-native AI session manager. No webview, no panel. Colors terminals by project, auto-renames them from agent status files, switches explorer on terminal focus change.

## How It Works
- Paintcan button in terminal toolbar → New Session / New Branch / Continue
- Project switcher button → sets active project, explorer follows
- Agent writes `~/.monet/status/pos-{N}.json` → poll loop renames terminal to `🟢 P{N}: {title}`
- Click terminal → `onDidChangeActiveTerminal` → `revealInExplorer` to that project
- Worktrees via `execFile('git', ['worktree', 'add', ...])` for branch sessions

## Key Files
`src/extension.ts` entry, registers commands + poll loop
`src/types.ts` SessionStatusFile, SessionMeta, STATUS_EMOJI
`src/sessionManager.ts` slots 1-20, globalState persistence
`src/projectManager.ts` scans projects root dir, assigns colors, manages active project
`src/statusWatcher.ts` fs.watch on ~/.monet/status/
`src/terminalRenamer.ts` poll loop: status → rename terminals
`src/worktreeManager.ts` git worktree via execFile
`src/claudeInstructions.ts` writes .claude/monet-pos-{N}.md

## Rules
- Async IO only (`fs.promises`). Sync blocks UI thread.
- `execFile()` + args arrays for git. Never `exec()` strings.
- Never touch user's CLAUDE.md. Only `.claude/monet-pos-{N}.md`.
- `fs.watch` for ~/.monet/. VS Code watchers unreliable outside workspace.
- try/catch everything. Never crash on bad data.
- Terminal name format: `{emoji} P{N}: {title}` — parsed by regex, don't change.

## Colors
1st folder: `terminal.ansiCyan` | 2nd: `terminal.ansiGreen` | 3rd: `terminal.ansiYellow` | 4th: `terminal.ansiMagenta`

## Status Emoji
🟢 thinking/coding/testing | 🟡 waiting | 🔴 error | ⚪ idle | ✅ complete

## Project Discovery
Setting `monet.projectsRoot` (default `~/Projects`). Scans subfolders as available projects. When a project is selected, Monet silently adds it to the workspace via `updateWorkspaceFolders()` so explorer can show it. No manual workspace setup required.

## Persistence
`globalState 'monet.sessions'` → slot assignments
`globalState 'monet.activeProject'` → current project
`~/.monet/status/pos-{N}.json` → agent state (status, title, files)

## Target Editor
Building for Cursor first (VS Code fork). Test in Cursor, not VS Code. Install via `cursor --install-extension monet-0.1.0.vsix` or Extensions: Install from VSIX.

## Full spec: MONET_V0_FINAL.md


Don't forget to add to the fucking build log any time you make any changes.
