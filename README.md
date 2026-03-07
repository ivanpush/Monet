# Monet

Multi-project session manager for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) in VS Code and Cursor. Color-codes terminals by project, shows live agent status, auto-titles sessions, and survives editor restarts.

No webview, no sidebar clutter — everything lives in the terminal.

![status](https://img.shields.io/badge/status-beta-blue)

## Features

### Project Colors
Each project gets its own color from a 10-color Monet-inspired palette (Water Lily, Garden Mint, Rose Floral, Sunlight Gold, etc.). Terminals and their icons are tinted so you can tell at a glance which project a session belongs to. Colors are assigned automatically and persist across sessions. You can also pick a specific color per project.

### Live Status Indicators
Terminal names update in real time to show what Claude is doing:

| Emoji | Status | Meaning |
|-------|--------|---------|
| 🟢 | Active | Claude is working — using tools or processing |
| 🟡 | Waiting | Needs your input or tool approval |
| ⚪ | Idle | Done, waiting for next prompt |
| 🔵 | Thinking | Processing your prompt |

### Auto-Titling
Sessions are titled automatically in two phases:
1. **Draft** — your first prompt is truncated to ~40 chars and shown immediately
2. **Final** — when Claude finishes, a fast model generates a 3-5 word summary

You can also set titles manually with the `/title` slash command:
```
/title Fix auth token refresh
```

### Multi-Project Workspace Switching
Run sessions across multiple projects simultaneously. Clicking a terminal automatically switches the VS Code workspace to that session's project. Create new projects directly from the Switch Project menu.

### Session Reconnection
Sessions survive Extension Host restarts (common in VS Code/Cursor). On reload, Monet matches live terminals to session state via PID and restores names, colors, and status tracking. Stale terminals from previous editor sessions are automatically cleaned up.

### Session Refresh on Color Change
When you change a project's color, Monet can migrate existing sessions — it creates new terminals with the updated color and uses `claude --resume` to continue the conversation seamlessly.

## Getting Started

### Install

```bash
# Build from source
npm install
npm run compile
npm run package

# Install the .vsix
code --install-extension monet-0.1.0.vsix     # VS Code
cursor --install-extension monet-0.1.0.vsix   # Cursor
```

### First Use

1. Open a project folder (or set `monet.projectsRoot` in settings — defaults to `~/Projects`)
2. Click the paintcan icon in the terminal toolbar, or press `Cmd+Shift+M`
3. Select **New Session** — a colored terminal opens and runs `claude`
4. Install slash commands: `Cmd+Shift+P` → "Monet: Install Slash Commands"

### Commands

| Command | Description |
|---------|-------------|
| `Monet: Monet Menu` | Main menu — new session, flags, switch project |
| `Monet: New Session` | Start a new Claude session in the current project |
| `Monet: New Session with Flags` | Start with flags (e.g., `--resume`, `--worktree`) |
| `Monet: Switch Project` | Change active project or create a new one |
| `Monet: Change Project Color` | Pick a different color for the current project |
| `Monet: Install Slash Commands` | Install `/title` to `~/.claude/commands/` |
| `Monet: Reset All Sessions` | Clear all session state and color assignments |

### Keyboard Shortcut

`Cmd+Shift+M` (macOS) / `Ctrl+Shift+M` (Windows/Linux) — opens the Monet Menu.

## How It Works

Monet uses Claude Code's [hook system](https://docs.anthropic.com/en/docs/claude-code/hooks) to track agent state. When you create a session:

1. A terminal is created with a unique session ID, project color, and matching icon
2. Hooks are installed into the project's `.claude/settings.local.json`
3. As Claude works, hooks fire shell scripts that write status to `~/.monet/status/{sessionId}.json`
4. A file watcher polls these status files and renames terminals in real time
5. On session end, the terminal is renamed to `zsh [ex-claude]` and state is cleaned up

All state lives in `~/.monet/` — status files, hook scripts, and launch requests. Nothing is stored in your project directory except the hooks in `.claude/settings.local.json` (which are cleaned up when the last session for a project closes).

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `monet.projectsRoot` | `~/Projects` | Root directory to scan for projects |
| `monet.colorOrder` | `fixed` | `fixed` or `shuffle` — how colors are assigned to projects |

## Requirements

- VS Code 1.85+ or Cursor
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Node.js (for hook scripts)

## License

MIT
