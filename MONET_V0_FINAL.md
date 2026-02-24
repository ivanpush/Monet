# MONET V0 — Terminal-Native

## Target Editor

Cursor first. It's a VS Code fork — same extension API, same .vsix format, but behavior can differ. All development and testing in Cursor. F5 debug launches Cursor's Extension Dev Host. Install: `cursor --install-extension monet-0.1.0.vsix`.

Known Cursor differences to watch for:
- `workbench.action.terminal.focus` may behave differently
- `revealInExplorer` may need fallback
- `terminal/title` menu may render differently
- Test every step in Cursor, not VS Code

## What It Is

Invisible extension that makes the VS Code Terminal tab smart. No custom panel, no webview, no CSS. Just colored terminals that auto-rename based on what the AI agent is doing, with one-click project switching.

## What The User Sees

```
Terminal list:
  🟢 P1: Refactoring PaymentProcessor    [cyan icon]
  🟡 P2: Fix nav scroll behavior         [green icon]
  🔴 P3: Auth test fixtures              [cyan icon]

Terminal toolbar:
  [paintcan ▾]  [backend-api ▾]  [+ split] [trash] ...
   session       active project
   actions       switcher
```

## Features

1. **Paintcan button** — dropdown: New Session, New Branch, Continue
2. **Project switcher** — dropdown showing workspace folders, sets the active project
3. **Colored terminals** — icon color = project identity, set at creation
4. **Auto-renaming** — agent writes status file → Monet renames terminal: `🟢 P1: {title}`
5. **Explorer follows** — click a terminal from a different project, explorer switches
6. **Worktrees** — "New Branch" creates a git worktree for isolated work
7. **Hidden temp files** — instruction files excluded from explorer

## UX Flow

### Paintcan Button (session actions, targets active project)
```
[paintcan ▾]
├── New Session     → spawns claude in active project dir
├── New Branch      → creates worktree, spawns claude there
└── Continue        → spawns claude -c in active project dir
```

All three target whatever project is currently "active." No project picker every time.

### Project Discovery (scans a root directory)

Monet doesn't require workspace setup. On first activation, it asks for a "projects root" — a directory where your projects live (e.g. `~/Projects/`). It scans that directory and every subfolder is an available project.

Setting: `monet.projectsRoot` — defaults to `~/Projects`. Configurable in VS Code settings.

```
Paintcan → New Session:
  Select project:
    backend-api          ← ~/Projects/backend-api/
    frontend             ← ~/Projects/frontend/
    jobs-worker          ← ~/Projects/jobs-worker/
    marketing-site       ← ~/Projects/marketing-site/
    [Browse other...]    ← file dialog fallback
```

When you pick a project:
1. If it's not already a workspace folder, Monet silently adds it via `updateWorkspaceFolders()`
2. Terminal is created with `cwd` = that project path
3. Explorer shows it automatically

Colors are assigned in the order projects are first used (persisted in globalState).

### Project Switcher Button (change active project)

Second toolbar button shows the active project name. Click it → same project list from the root scan. Selecting switches explorer to that project. New sessions will default to this project until changed.

## API Used

| Feature | API |
|---------|-----|
| Paintcan button | `contributes.menus` → `terminal/title` |
| Project switcher | `contributes.menus` → `terminal/title` (second button) |
| Colored terminals | `createTerminal({ color: new ThemeColor(...) })` |
| Auto-rename | `workbench.action.terminal.renameWithArg` + `{ name }` |
| Explorer switch | `revealInExplorer` |
| Worktrees | `execFile('git', ['worktree', 'add', ...])` |
| Focus detection | `onDidChangeActiveTerminal` |
| Persistence | `context.globalState` |

## Architecture

```
monet/
├── package.json
├── src/
│   ├── extension.ts          # Entry: registers commands, starts poll loop
│   ├── types.ts              # SessionStatusFile, SessionMeta, STATUS_EMOJI
│   ├── sessionManager.ts     # Slots 1-20, globalState persistence
│   ├── projectManager.ts     # Scans projects root, color assignment, active project
│   ├── statusWatcher.ts      # fs.watch ~/.monet/status/, reads pos-*.json
│   ├── terminalRenamer.ts    # Poll loop: status changes → rename terminals
│   ├── worktreeManager.ts    # git worktree add/remove via execFile
│   └── claudeInstructions.ts # Writes .claude/monet-pos-{N}.md
└── resources/
    └── monet-icon.svg
```

## Status File Format

Each agent writes its own file at `~/.monet/status/pos-{N}.json`:

```json
{
  "position": 1,
  "project": "backend-api",
  "status": "coding",
  "title": "Refactoring PaymentProcessor",
  "branch": null,
  "worktreePath": null,
  "filesModified": ["payment/processor.ts"],
  "error": null,
  "updated": "2026-02-22T21:45:03Z"
}
```

## Status → Terminal Name

| Status | Emoji | Example |
|--------|-------|---------|
| thinking / coding / testing | 🟢 | 🟢 P1: Refactoring PaymentProcessor |
| waiting | 🟡 | 🟡 P1: Waiting for user input |
| error | 🔴 | 🔴 P1: TypeError in processor.ts |
| idle | ⚪ | ⚪ P1: fix auth bug |
| complete | ✅ | ✅ P1: PaymentProcessor refactored |

## Project → Color

| Slot | ThemeColor | Typical |
|------|-----------|---------|
| 1st folder | terminal.ansiCyan | backend |
| 2nd folder | terminal.ansiGreen | frontend |
| 3rd folder | terminal.ansiYellow | jobs |
| 4th folder | terminal.ansiMagenta | — |

## Rules

- All file IO: `fs.promises` (async). Never sync.
- All git: `execFile()` with args arrays. Never `exec()` strings.
- Never touch user's CLAUDE.md. Only `.claude/monet-pos-{N}.md`.
- `fs.watch` for `~/.monet/`. Not VS Code watchers.
- try/catch everything. Never crash on bad data.

---

# BUILD PROMPTS

One step at a time. Verify before moving on.

---

## STEP 1: Scaffold + Two Toolbar Buttons (30 min)

```
Build a VS Code extension called "monet" using yo code (TypeScript, esbuild).

In package.json set engines.vscode "^1.85.0" and add this contributes section:

{
  "commands": [
    {
      "command": "monet.sessionMenu",
      "title": "Monet: Session Menu",
      "icon": "$(paintcan)"
    },
    {
      "command": "monet.switchProject",
      "title": "Monet: Switch Project",
      "icon": "$(window)"
    }
  ],
  "menus": {
    "terminal/title": [
      { "command": "monet.sessionMenu", "group": "navigation@-2" },
      { "command": "monet.switchProject", "group": "navigation@-1" }
    ]
  }
}

"activationEvents": ["onStartupFinished"]

In extension.ts register both commands:

monet.sessionMenu: show quick pick with 3 options:
  - "$(add) New Session"
  - "$(git-branch) New Branch"  
  - "$(debug-continue) Continue"
  For now, all three just show vscode.window.showInformationMessage("Selected: " + picked.label)

monet.switchProject: show quick pick listing workspace folder names.
  For now just show info message with selected folder name.

VERIFY: F5 → Extension Dev Host → open Terminal tab. Two new icons must appear in the terminal toolbar: paintcan and window icon. Paintcan shows 3 options. Window shows workspace folders. Both show info messages on selection.
```

---

## STEP 2: Session Creation + Colored Terminals (1 hour)

```
Make the paintcan "New Session" actually create terminals.

Create src/types.ts:

export interface SessionMeta {
  position: number;
  projectName: string;
  projectPath: string;
  sessionName: string;
  color: string;
  worktreePath: string | null;
  branch: string | null;
}

export interface SessionStatusFile {
  position: number;
  project: string;
  status: 'thinking' | 'coding' | 'testing' | 'waiting' | 'error' | 'idle' | 'complete';
  title: string;
  branch: string | null;
  worktreePath: string | null;
  filesModified: string[];
  error: string | null;
  updated: string;
}

export const STATUS_EMOJI: Record<string, string> = {
  thinking: '🟢', coding: '🟢', testing: '🟢',
  waiting: '🟡', error: '🔴',
  idle: '⚪', complete: '✅',
};

Create src/projectManager.ts:

import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';

const COLORS = [
  'terminal.ansiCyan', 'terminal.ansiGreen', 'terminal.ansiYellow',
  'terminal.ansiMagenta', 'terminal.ansiBlue', 'terminal.ansiRed',
];

Class ProjectManager:
  constructor(context):
    - Read active project from globalState 'monet.activeProject'
    - Read color assignments from globalState 'monet.projectColors' (Map<string, string>)
    - Read projects root from config: vscode.workspace.getConfiguration('monet').get('projectsRoot')
    - Default projectsRoot to path.join(os.homedir(), 'Projects')

  async getProjects(): Promise<{ name, path, color }[]>
    - Read projectsRoot directory with fsp.readdir (withFileTypes: true)
    - Filter to directories only, skip hidden (starting with '.')
    - Sort alphabetically
    - Map each to { name: dir.name, path: full path, color: assigned color }
    - Assign colors on first use, persist to globalState

  getActive(): { name, path, color } — current active project
  setActive(name): saves to globalState
  getColorFor(name): returns ThemeColor string, assigns new one if first time seen

  async ensureInWorkspace(projectPath):
    - Check if projectPath is already in vscode.workspace.workspaceFolders
    - If not, add it via vscode.workspace.updateWorkspaceFolders()
    - This makes it visible in the explorer without user doing File → Add Folder

Also register the config in package.json contributes:

"configuration": {
  "title": "Monet",
  "properties": {
    "monet.projectsRoot": {
      "type": "string",
      "default": "~/Projects",
      "description": "Directory containing your projects. Each subfolder is a project."
    }
  }
}

Create src/sessionManager.ts:

Class SessionManager:
  - constructor(context): reads sessions from globalState 'monet.sessions'
  - allocate(meta: Omit<SessionMeta, 'position'>): picks lowest free slot 1-20, saves, returns position
  - free(position): removes, saves
  - get(position): returns SessionMeta | undefined
  - getAll(): returns all
  - findByTerminalName(name): parses "P{N}:" from name, returns session
  - Private: persist() writes to globalState

Now wire the commands:

monet.sessionMenu → quick pick → user picks "New Session":
  1. const projects = await projectManager.getProjects()
  2. Show quick pick listing project names (+ "[Browse other...]" at bottom)
  3. If "Browse other" selected: show file dialog, use that folder
  4. Input box: "Session name?" with placeholder "e.g. fix auth bug"
  5. If cancelled, return
  6. Allocate slot
  7. Ensure project is in workspace: projectManager.ensureInWorkspace(project.path)
  8. Create terminal:
     vscode.window.createTerminal({
       name: `⚪ P${pos}: ${name}`,
       cwd: project.path,
       color: new vscode.ThemeColor(project.color),
     })
  9. terminal.sendText('claude')
  10. terminal.show()
  11. Set as active project

monet.sessionMenu → "Continue":
  Same but terminal.sendText('claude -c')

monet.switchProject:
  1. const projects = await projectManager.getProjects()
  2. Show quick pick of projects, mark active with ✓
  3. Set new active project
  4. Ensure it's in workspace
  5. Switch explorer: vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(project.path))

VERIFY:
1. F5 with a multi-folder workspace
2. Click paintcan → New Session → type "fix auth" → terminal appears as "⚪ P1: fix auth" with colored icon
3. Click paintcan → Continue → type name → terminal runs "claude -c"
4. Click project switcher → pick different project → explorer scrolls to it
5. Create session in 2nd project → different colored icon
```

---

## STEP 3: Status Watcher + Auto-Rename (1-2 hours)

```
The core feature. Agent updates a JSON file, terminal name updates automatically.

Create src/statusWatcher.ts:

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SessionStatusFile } from './types';

const STATUS_DIR = path.join(os.homedir(), '.monet', 'status');

Class StatusWatcher:
  private watcher: fs.FSWatcher | null
  private cache: Map<number, SessionStatusFile>

  constructor():
    fs.mkdirSync(STATUS_DIR, { recursive: true })
    this.startWatching()

  startWatching():
    this.watcher = fs.watch(STATUS_DIR, (event, filename) => {
      if (filename?.startsWith('pos-') && filename.endsWith('.json')) {
        this.readOne(filename) // don't re-read everything, just the changed file
      }
    })

  async readOne(filename):
    try {
      const content = await fsp.readFile(path.join(STATUS_DIR, filename), 'utf-8')
      const data: SessionStatusFile = JSON.parse(content)
      this.cache.set(data.position, data)
    } catch { /* skip bad files */ }

  async readAll(): Map<number, SessionStatusFile>
    // reads all pos-*.json, populates cache, returns it

  get(position): SessionStatusFile | undefined
    return this.cache.get(position)

  async writeInitial(position, project, name):
    // writes a new pos-{N}.json with status: idle
    const entry = { position, project, status: 'idle', title: name, ... }
    await fsp.writeFile(
      path.join(STATUS_DIR, `pos-${position}.json`),
      JSON.stringify(entry, null, 2)
    )

  async remove(position):
    try { await fsp.unlink(path.join(STATUS_DIR, `pos-${position}.json`)) } catch {}

  dispose(): this.watcher?.close()

Create src/claudeInstructions.ts:

async writeInstructionFile(workingDir, position, projectName, branch, worktreePath):
  Writes {workingDir}/.claude/monet-pos-{position}.md with instructions telling the agent:
  - You are Monet Position {N} in project {name}
  - Update ~/.monet/status/pos-{N}.json when your state changes
  - Valid statuses: thinking, coding, testing, waiting, error, idle, complete
  - Include error handling: 3 errors → set error status and stop
  - Example JSON with "<current ISO timestamp>" placeholder

  Use fsp.mkdir for .claude dir, fsp.writeFile for the file.
  NEVER touch CLAUDE.md.

async removeInstructionFile(workingDir, position):
  Delete {workingDir}/.claude/monet-pos-{position}.md

Create src/terminalRenamer.ts:

Class TerminalRenamer:
  private nameCache: Map<number, string>

  constructor(statusWatcher, sessionManager)

  startPolling():
    setInterval(() => this.poll(), 2000)

  async poll():
    const statuses = await this.statusWatcher.readAll()
    for (const [position, status] of statuses) {
      const emoji = STATUS_EMOJI[status.status] || '⚪'
      const newName = `${emoji} P${position}: ${status.title}`
      if (this.nameCache.get(position) === newName) continue
      this.nameCache.set(position, newName)

      // Find matching terminal
      const terminal = vscode.window.terminals.find(t => 
        t.name.includes(`P${position}:`)
      )
      if (!terminal) continue

      // Rename: focus it, rename, restore focus
      const previousTerminal = vscode.window.activeTerminal
      terminal.show(false)
      await vscode.commands.executeCommand(
        'workbench.action.terminal.renameWithArg',
        { name: newName }
      )
      // Restore previous terminal focus if different
      if (previousTerminal && previousTerminal !== terminal) {
        previousTerminal.show(false)
      }
    }

Update the New Session flow to also:
  - Call statusWatcher.writeInitial(position, project.name, sessionName)
  - Call claudeInstructions.writeInstructionFile(project.path, position, ...)

VERIFY:
1. Create a session via paintcan
2. Terminal shows "⚪ P1: fix auth"
3. Open a text editor and create ~/.monet/status/pos-1.json with:
   {"position":1,"project":"test","status":"coding","title":"Fixing the auth bug","branch":null,"worktreePath":null,"filesModified":[],"error":null,"updated":"2026-02-23T00:00:00Z"}
4. Wait 2-4 seconds. Terminal name MUST change to "🟢 P1: Fixing the auth bug"
5. Edit the file: change status to "error" → name must become "🔴 P1: Fixing the auth bug"
6. Edit title to "Stuck on test failure" → name must update

If renameWithArg pops up an input box instead of renaming silently, that means it needs the terminal to be focused first. Adjust the poll() to handle this. If it truly can't be done silently, fall back to killing and recreating the terminal with the new name (use claude -c to resume).
```

---

## STEP 4: Explorer Auto-Switch (30 min)

```
When user clicks a Monet terminal, switch explorer to that project and update the active project.

In extension.ts, add:

vscode.window.onDidChangeActiveTerminal(async (terminal) => {
  if (!terminal) return;
  
  const match = terminal.name.match(/P(\d+):/);
  if (!match) return; // not a Monet terminal, ignore
  
  const position = parseInt(match[1]);
  const session = sessionManager.get(position);
  if (!session) return;
  
  // Update active project
  const projectPath = session.worktreePath || session.projectPath;
  projectManager.setActive(session.projectName);
  
  // Switch explorer
  try {
    await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(projectPath));
  } catch {
    try {
      await vscode.commands.executeCommand('workbench.view.explorer');
    } catch {}
  }
});

VERIFY: Open 2+ workspace folders. Create sessions in different projects. Click between terminals. Explorer must switch to the correct project each time. The project switcher button should reflect the new active project.
```

---

## STEP 5: Worktrees + File Hiding (1-2 hours)

```
"New Branch" creates a git worktree. Hide temp files from explorer.

Create src/worktreeManager.ts:

import { execFile } from 'child_process';

ALL functions return Promises. ALL use execFile with args arrays. NEVER exec().

slugify(name: string): string
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30)

getWorktreePath(position: number, slug: string): string
  path.join(os.homedir(), '.monet', 'worktrees', `pos-${position}-${slug}-${YYYYMMDD}`)

async validateBranch(name: string): Promise<boolean>
  execFile('git', ['check-ref-format', '--branch', name])

async createWorktree(projectPath, wtPath, branch): Promise<void>
  execFile('git', ['-C', projectPath, 'worktree', 'add', wtPath, '-b', branch])

async removeWorktree(projectPath, wtPath): Promise<void>
  execFile('git', ['-C', projectPath, 'worktree', 'remove', wtPath, '--force'])

async deleteBranch(projectPath, branch): Promise<void>
  execFile('git', ['-C', projectPath, 'branch', '-D', branch])

Wire "New Branch" in the session menu:
1. Get active project
2. Input box: session name
3. Generate branch: monet/pos-{N}/{slug}
4. Input box: branch name (pre-filled, user can edit)
5. Validate branch name
6. Create worktree at ~/.monet/worktrees/pos-{N}-{slug}-{date}/
7. Allocate slot, write status file, write instruction file into WORKTREE dir
8. Create terminal with cwd = worktree path
9. terminal.sendText('claude')

HIDE FILES:

On activation, update workspace files.exclude:

const config = vscode.workspace.getConfiguration('files');
const excludes = config.get<Record<string, boolean>>('exclude') || {};
let changed = false;
if (!excludes['**/.claude/monet-pos-*.md']) {
  excludes['**/.claude/monet-pos-*.md'] = true;
  changed = true;
}
if (changed) {
  await config.update('exclude', excludes, vscode.ConfigurationTarget.Workspace);
}

CLEANUP on session delete (add a delete option to the session menu or handle terminal close):
- When terminal closes: mark session idle (update name to ⚪)
- To fully delete: remove status file, remove instruction file, free slot
- If worktree: offer to remove worktree + delete branch

Listen for terminal close:
vscode.window.onDidCloseTerminal((terminal) => {
  const match = terminal.name.match(/P(\d+):/);
  if (!match) return;
  const position = parseInt(match[1]);
  // Update name cache to idle
  nameCache.set(position, `⚪ P${position}: ${sessionManager.get(position)?.sessionName || 'closed'}`);
});

VERIFY:
1. Paintcan → New Branch → name + branch → worktree created at ~/.monet/worktrees/
2. Terminal opens in the worktree directory
3. .claude/monet-pos-{N}.md files do NOT show in explorer
4. Close a terminal → next poll shows ⚪ status
```

---

## STEP 6: Restart Recovery + Edge Cases (30 min)

```
Handle VS Code restart and weird states.

On extension activate:
1. Read sessionManager from globalState (has all slot assignments)
2. Read statusWatcher (has all status files on disk)
3. For each session in globalState:
   - Check if a matching terminal exists (by name pattern P{N}:)
   - If no terminal: the session is dead. Leave it in globalState so the user 
     can "Continue" it later. The status file still has the last known state.
4. Start the rename poll loop — it will skip sessions with no matching terminal

When user picks "Continue" from paintcan:
  - Show quick pick of existing dead sessions (have slot but no terminal)
  - OR create new session with claude -c
  - Reuse the existing slot number

Edge cases to handle:
- Corrupted status JSON → skip, log, don't crash
- Missing ~/.monet/status/ dir → create it
- No workspace folders → show error on paintcan click
- Terminal killed externally → onDidCloseTerminal handles it
- Slot exhaustion (20 sessions) → show error message

VERIFY:
1. Create 2 sessions. Close VS Code entirely. Reopen.
2. Sessions should be in globalState. Status files on disk.
3. Paintcan → Continue → should offer to resume a previous session
4. Write garbage to a pos-*.json file → extension doesn't crash
```

---

## GLOBAL RULES (apply to all steps)

```
- fs.promises for all file IO. Never sync.
- execFile() for git. Never exec() with strings.
- Never touch CLAUDE.md. Only .claude/monet-pos-{N}.md.
- fs.watch for ~/.monet/. Not VS Code watchers.
- try/catch everything. Log errors, never crash.
- Terminal names: "{emoji} P{N}: {title}" — this format is parsed by regex, don't change it.
- Active project persisted in globalState under 'monet.activeProject'.
- Sessions persisted in globalState under 'monet.sessions'.
```
