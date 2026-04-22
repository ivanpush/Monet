# PROMPT: Implement Claude Code Hooks for Status Updates

Delete the instruction file approach entirely. Remove claudeInstructions.ts and all references to .claude/monet-pos-{N}.md files. We're using Claude Code hooks instead.

## How It Works

Claude Code has lifecycle hooks that fire shell commands at specific moments. We use three:
- **PostToolUse** — fires after Claude uses any tool (Edit, Write, Bash, etc). This means Claude is actively working.
- **Stop** — fires when Claude finishes responding. This means Claude went idle.
- **SessionStart** — fires when Claude Code session begins.

Monet writes these hooks into the project's `.claude/settings.local.json`. The hooks call a small script that writes the status file.

## What To Build

### 1. Create the status updater script: `~/.monet/bin/monet-status`

This is a bash script. Make it executable. It does one thing: reads stdin (JSON from Claude Code), extracts the session_id, looks up which Monet position that session belongs to, and writes the status file.

```bash
#!/usr/bin/env bash
# Usage: monet-status <status> [title]
# Reads Claude Code hook JSON from stdin

STATUS="${1:-idle}"
TITLE="${2:-}"

# Read stdin (Claude Code sends JSON with session_id, tool_name, etc)
INPUT=$(cat)

# Extract session_id from the JSON
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$SESSION_ID" ]; then
  exit 0  # No session ID, skip silently
fi

# Look up which Monet position this session belongs to
MAP_FILE="$HOME/.monet/session-map.json"
if [ ! -f "$MAP_FILE" ]; then
  exit 0
fi

# Extract position for this session_id from the map
POSITION=$(cat "$MAP_FILE" | grep -o "\"${SESSION_ID}\":[0-9]*" | cut -d':' -f2)

if [ -z "$POSITION" ]; then
  exit 0  # Unknown session, skip
fi

# Get project name from map (optional, best effort)
PROJECT=$(cat "$MAP_FILE" | grep -o "\"pos_${POSITION}_project\":\"[^\"]*\"" | cut -d'"' -f4)

# Write status file
STATUS_FILE="$HOME/.monet/status/pos-${POSITION}.json"
mkdir -p "$HOME/.monet/status"

cat > "$STATUS_FILE" << STATUSJSON
{
  "position": ${POSITION},
  "project": "${PROJECT:-unknown}",
  "status": "${STATUS}",
  "title": "${TITLE:-}",
  "error": null,
  "updated": $(date +%s%3N)
}
STATUSJSON

exit 0
```

This script must NEVER fail loudly. Every error path exits 0 silently. A broken status script must never interrupt Claude Code.

### 2. Create the session map: `~/.monet/session-map.json`

When Monet creates a session and the terminal starts Claude Code, we don't know the session_id yet. But Claude Code's SessionStart hook will fire and send us the session_id. So:

- On terminal creation, write a TEMPORARY marker: `~/.monet/pending/{terminalPid}` containing the position number
- The SessionStart hook reads stdin, gets session_id, finds the pending marker, and writes the mapping to session-map.json
- OR simpler: Monet sets env var MONET_POSITION on the terminal. SessionStart hook reads both stdin (for session_id) AND the env var, then writes the mapping.

Actually, simplest approach: use the env var for the initial mapping, then session_id for all subsequent hooks.

In sessionManager when creating terminal:
```typescript
const terminal = vscode.window.createTerminal({
  name: '⚪ new session',
  cwd: project.path,
  color: new vscode.ThemeColor(project.color),
  env: { MONET_POSITION: String(position) }  // Claude Code inherits this
});
```

Then the SessionStart hook does:
```bash
#!/usr/bin/env bash
# monet-session-start: Maps session_id to MONET_POSITION
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)
POSITION="${MONET_POSITION}"

if [ -z "$SESSION_ID" ] || [ -z "$POSITION" ]; then
  exit 0
fi

MAP_FILE="$HOME/.monet/session-map.json"
mkdir -p "$HOME/.monet"

# Read existing map or create empty
if [ -f "$MAP_FILE" ]; then
  MAP=$(cat "$MAP_FILE")
else
  MAP="{}"
fi

# Add this mapping using node (safe JSON manipulation)
node -e "
  const fs = require('fs');
  const map = JSON.parse(fs.readFileSync('$MAP_FILE', 'utf8').trim() || '{}');
  map['$SESSION_ID'] = $POSITION;
  map['pos_${POSITION}_project'] = process.env.PWD?.split('/').pop() || 'unknown';
  fs.writeFileSync('$MAP_FILE', JSON.stringify(map, null, 2));
" 2>/dev/null

# Also write initial status
~/.monet/bin/monet-status thinking "starting up"

exit 0
```

### 3. Write hooks to `.claude/settings.local.json`

When Monet creates a session, it MERGES hooks into the project's `.claude/settings.local.json`. It does NOT overwrite.

```typescript
// In sessionManager, after creating terminal:

async function installHooks(projectPath: string): Promise<void> {
  const settingsPath = path.join(projectPath, '.claude', 'settings.local.json');
  
  // Read existing settings or create empty
  let settings: any = {};
  try {
    const content = await fsp.readFile(settingsPath, 'utf-8');
    settings = JSON.parse(content);
  } catch { /* file doesn't exist yet */ }
  
  // Ensure hooks structure exists
  if (!settings.hooks) settings.hooks = {};
  
  // Add Monet hooks (tagged with __monet__ in command for identification)
  const monetTag = '__monet__';
  
  // Remove any existing Monet hooks first
  for (const event of ['PostToolUse', 'Stop', 'SessionStart']) {
    if (settings.hooks[event]) {
      settings.hooks[event] = settings.hooks[event].filter(
        (group: any) => !JSON.stringify(group).includes(monetTag)
      );
    }
  }
  
  // Add fresh Monet hooks
  if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
  settings.hooks.PostToolUse.push({
    matcher: 'Edit|Write|MultiEdit|Bash',
    hooks: [{
      type: 'command',
      command: `~/.monet/bin/monet-status coding ${monetTag}`,
      async: true,
      timeout: 5
    }]
  });
  
  if (!settings.hooks.Stop) settings.hooks.Stop = [];
  settings.hooks.Stop.push({
    hooks: [{
      type: 'command',
      command: `~/.monet/bin/monet-status idle ${monetTag}`,
      timeout: 5
    }]
  });
  
  if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
  settings.hooks.SessionStart.push({
    hooks: [{
      type: 'command',
      command: `~/.monet/bin/monet-session-start ${monetTag}`,
      timeout: 10
    }]
  });
  
  // Write back
  await fsp.mkdir(path.join(projectPath, '.claude'), { recursive: true });
  await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2));
}
```

### 4. For the title: Use a Stop hook with type "prompt"

Add a second Stop hook that asks Claude to name what it just did:

```json
{
  "hooks": [{
    "type": "prompt",
    "prompt": "Output ONLY a 3-6 word summary of what you just did. No punctuation, no explanation. Examples: refactoring payment processor, fixing auth tests, adding rate limiter",
    "timeout": 10
  }]
}
```

The prompt hook response gets piped into a command hook that writes it as the title. Actually — prompt hooks return to Claude, they don't pipe to commands. So instead:

Use the Stop hook command to extract a title from the last tool activity. The stdin JSON contains context about what happened. Parse it and generate a title from the tool name + file path:

```bash
# In monet-status, when called with "idle" (Stop event):
# Try to generate a title from the last activity
if [ "$STATUS" = "idle" ] && [ -n "$INPUT" ]; then
  TOOL=$(echo "$INPUT" | grep -o '"tool_name":"[^"]*"' | tail -1 | cut -d'"' -f4)
  FILE=$(echo "$INPUT" | grep -o '"file_path":"[^"]*"' | tail -1 | cut -d'"' -f4)
  if [ -n "$FILE" ]; then
    BASENAME=$(basename "$FILE")
    TITLE="edited ${BASENAME}"
  fi
fi
```

This is a rough heuristic. The real title will come later when we add the prompt-type hook for summarization.

### 5. Clean up hooks on session delete

When all Monet sessions in a project are closed, remove Monet hooks from `.claude/settings.local.json`:

```typescript
async function removeHooks(projectPath: string): Promise<void> {
  const settingsPath = path.join(projectPath, '.claude', 'settings.local.json');
  try {
    const content = await fsp.readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(content);
    if (!settings.hooks) return;
    
    const monetTag = '__monet__';
    for (const event of Object.keys(settings.hooks)) {
      settings.hooks[event] = settings.hooks[event].filter(
        (group: any) => !JSON.stringify(group).includes(monetTag)
      );
      if (settings.hooks[event].length === 0) delete settings.hooks[event];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    
    await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2));
  } catch { /* file doesn't exist, nothing to clean */ }
}
```

### 6. Install the scripts on extension activation

On first activation, Monet creates:
- `~/.monet/bin/monet-status` (chmod +x)
- `~/.monet/bin/monet-session-start` (chmod +x)
- `~/.monet/session-map.json` (empty {})
- `~/.monet/status/` directory

### Summary of changes:
- DELETE: claudeInstructions.ts, all monet-pos-{N}.md references
- CREATE: Script installer (writes bash scripts to ~/.monet/bin/)
- CREATE: Hook installer (merges hooks into .claude/settings.local.json)
- MODIFY: sessionManager — set MONET_POSITION env var on terminal, call installHooks on create, removeHooks on delete
- MODIFY: statusWatcher — no changes needed, it already reads pos-{N}.json files

Test by creating a session, then check:
1. ~/.monet/bin/monet-status exists and is executable
2. .claude/settings.local.json has Monet hooks
3. Start Claude Code in the terminal, give it a task
4. Check ~/.monet/status/pos-{N}.json updates as Claude works
5. Terminal name should update via the poll loop