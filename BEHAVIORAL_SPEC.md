# Monet Behavioral Spec

**Generated**: 2026-02-24

---

## Architecture Overview

### State Locations

| Location | Data | Lifetime |
|----------|------|----------|
| `globalState('monet.sessions')` | `Map<slot, SessionMeta>` | Persists across reloads |
| `globalState('monet.activeProject')` | Project path string | Persists across reloads |
| `~/.monet/status/pos-{N}.json` | Status, title, project, timestamp | Written by hooks, deleted on terminal close |
| `{project}/.claude/settings.local.json` | Claude Code hooks with baked-in position | Written on session create, removed when last session for project closes |
| In-memory `terminalToSlot` Map | `Map<Terminal, slot>` | Lost on extension reload |
| In-memory `projectColors` Map | `Map<projectPath, colorIndex>` | Lost on extension reload |

### Data Flow

```
User Action
    ↓
extension.ts (command handler)
    ↓
sessionManager.createSession()
    ├── Finds next slot (1-20)
    ├── Creates terminal with MONET_POSITION env var
    ├── Writes to globalState
    ├── Calls installHooks() → writes .claude/settings.local.json
    └── Runs `claude` in terminal

Claude Code runs
    ↓
Hook fires (UserPromptSubmit/PreToolUse/Stop/etc)
    ↓
~/.monet/bin/monet-status <position> <status>
    ↓
Writes ~/.monet/status/pos-{N}.json

StatusWatcher polls (fs.watch + 1s fallback)
    ↓
Reads pos-{N}.json files
    ↓
Calls sessionManager.getTerminalForSlot(slot)
    ↓
Queues rename via workbench.action.terminal.renameWithArg
```

---

## Interaction Traces

### 1. Extension Activates

**Trigger**: Cursor opens or window reloads

**Code Path**:
```
activate() [extension.ts:17]
  ├── new ProjectManager(context) [extension.ts:21]
  │     └── No persistence loaded, projectColors = empty Map
  ├── new SessionManager(context, projectManager) [extension.ts:22]
  │     ├── loadSessions() [sessionManager.ts:55] - reads globalState
  │     ├── ensureDirectories() [sessionManager.ts:46] - creates ~/.monet/status/
  │     ├── clearOrphanedSessions() [sessionManager.ts:39]
  │     │     └── sessions.clear() - DELETES ALL SESSIONS FROM GLOBALSTATE
  │     └── Registers onDidCloseTerminal listener [sessionManager.ts:29]
  ├── new StatusWatcher() [extension.ts:23]
  ├── Registers TreeView [extension.ts:27-30]
  ├── Registers all commands [extension.ts:33-250]
  ├── installHookScripts() [extension.ts:255] - writes ~/.monet/bin/monet-*
  └── statusWatcher.start() [extension.ts:261]
        ├── startWatcher() - fs.watch on ~/.monet/status/
        ├── startFallbackPoll() - setInterval 1000ms
        └── poll() - initial scan
```

**Critical Issue**: `clearOrphanedSessions()` at line 39-44 wipes ALL sessions on every activation because `terminalToSlot` is empty (terminals don't survive reload). This means:
- Sessions are never truly persisted across reloads
- The "Continue" feature can only work within a single window session

---

### 2. User Runs "New Session" (No Active Project)

**Trigger**: Command palette → "Monet: New Session" with no project set

**Code Path**:
```
monet.newSession handler [extension.ts:63]
  ├── projectManager.getCurrentProject() [projectManager.ts:119]
  │     ├── Check globalState('monet.activeProject') → null
  │     └── Check workspaceFolders[0] → null (or returns folder)
  │     └── Returns null
  ├── projectManager.getAvailableProjects() [projectManager.ts:77]
  │     ├── getProjectsRoot() → ~/Projects (default)
  │     └── Scans for directories with .git
  ├── showQuickPick() - user selects project
  ├── projectManager.setActiveProject(path) [projectManager.ts:153]
  │     └── globalState.update('monet.activeProject', path)
  ├── updateWorkspaceFolders(0, length, { uri }) [extension.ts:87]
  │     └── REPLACES all workspace folders with selected project
  └── sessionManager.createSession(false) [sessionManager.ts:77]
        └── (see trace #3)
```

**Issue**: No listener for `onDidChangeWorkspaceFolders`. If workspace swap fails or is slow, subsequent code may have stale state.

---

### 3. User Runs "New Session" (Project Already Active)

**Trigger**: Command palette → "Monet: New Session" with active project

**Code Path**:
```
monet.newSession handler [extension.ts:63]
  ├── projectManager.getCurrentProject() → { name, path }
  └── sessionManager.createSession(false) [sessionManager.ts:77]
        ├── findNextSlot() [sessionManager.ts:67]
        │     └── Iterates 1-20, returns first not in sessions Map
        ├── projectManager.getThemeColor(path) [projectManager.ts:46]
        │     └── getColorIndex() - assigns or retrieves color
        ├── vscode.window.createTerminal({
        │     name: '⚪ — Claude | new session',
        │     cwd: project.path,
        │     color: ThemeColor,
        │     env: { MONET_POSITION: slot.toString() }  // <-- KEY
        │   })
        ├── sessions.set(slot, SessionMeta)
        ├── terminalToSlot.set(terminal, slot)
        ├── saveSessions() → globalState update
        ├── deleteStatusFiles(slot) [sessionManager.ts:223]
        │     └── Deletes pos-{N}.json, .needs-title, .waiting-title
        ├── installHooks(project.path, slot) [hooksManager.ts:39]  // <-- BUG SOURCE
        │     ├── Read existing settings.local.json
        │     ├── REMOVE all __monet__ hooks (all positions!)
        │     └── ADD hooks with THIS slot number only
        ├── terminal.show()
        └── terminal.sendText('claude')
```

**CRITICAL BUG - Hook Position Collision**:
- `installHooks()` at line 63-69 removes ALL Monet hooks then adds new ones
- If Project A has sessions at slots 1 and 3:
  - Session 1 created → hooks point to position 1
  - Session 3 created → hooks OVERWRITTEN to point to position 3
  - Now BOTH sessions fire hooks to position 3!
- **Evidence**: Current `Monet/.claude/settings.local.json` shows position 3, but status files exist for positions 1, 2, 3

---

### 4. User Runs "Switch Project"

**Trigger**: Command palette → "Monet: Switch Project"

**Code Path**:
```
monet.switchProject handler [extension.ts:136]
  ├── projectManager.getAvailableProjects()
  ├── showQuickPick() - user selects
  ├── projectManager.setActiveProject(path)
  │     └── globalState.update('monet.activeProject', path)
  ├── updateWorkspaceFolders(0, length, { uri })
  │     └── Replaces workspace with selected project
  └── workbench.action.terminal.focus
```

**Issue**: No validation that the selected project has any active sessions. Switching project doesn't affect running terminals.

---

### 5. User Clicks Terminal from Different Project

**Trigger**: Click terminal associated with project B while project A is shown in explorer

**Code Path**:
```
onDidChangeActiveTerminal listener [extension.ts:191]
  ├── Clear terminalFocusDebounceTimer if pending
  ├── sessionManager.getSlotForTerminal(terminal) [sessionManager.ts:213]
  │     └── Returns terminalToSlot.get(terminal) or null
  ├── sessionManager.getAllSessions()
  ├── Find session where position === slot
  ├── Get session.projectPath
  ├── Compare with workspaceFolders[0].uri.fsPath
  ├── If different, setTimeout 500ms debounce:
  │     ├── projectManager.setActiveProject(projectPath)
  │     └── updateWorkspaceFolders() - swap explorer
```

**Race Condition**: 500ms debounce can cause stale switches if user rapidly clicks terminals.

---

### 6. Claude Code Starts (UserPromptSubmit Hook)

**Trigger**: User sends prompt in Claude Code

**Code Path**:
```
Claude Code reads .claude/settings.local.json
  └── hooks.UserPromptSubmit[0].hooks[0].command fires

~/.monet/bin/monet-status <position> thinking [monet-status script]
  ├── Parse args, filter __monet__
  ├── Read existing ~/.monet/status/pos-{N}.json (preserve title)
  ├── Update status='thinking', updated=Date.now()
  └── Atomic write: .tmp → rename

StatusWatcher.poll() triggers [statusWatcher.ts:95]
  ├── fs.readdir(STATUS_DIR)
  ├── For each pos-{N}.json:
  │     ├── Parse slot from filename
  │     ├── sessionManager.getTerminalForSlot(slot)
  │     ├── If terminal exists and name different:
  │     │     └── queueRename(terminal, newName)
```

**Bug**: If hooks point to wrong position (see Bug #3), status is written to wrong slot.

---

### 7. Claude Code Uses Tool (PreToolUse Hook)

**Trigger**: Claude about to execute a tool

**Code Path**:
```
Claude Code fires hooks.PreToolUse[0].hooks[0].command

~/.monet/bin/monet-status <position> active
  └── Same as #6, but status='active'
```

---

### 8. Claude Code Finishes (Stop Hook)

**Trigger**: Claude stops responding

**Code Path**:
```
Claude Code fires Stop hooks (TWO hooks):

HOOK 1: ~/.monet/bin/monet-status <position> idle
  └── Sets status='idle'

HOOK 2: ~/.monet/bin/monet-title-check <position> [monet-title-check script]
  ├── Check MONET_TITLE_CHECK_RUNNING env (recursion guard)
  ├── Read pos-{N}.json
  ├── If title already set → exit (title is set once)
  ├── Read stdin for hook JSON (contains transcript_path)
  ├── Read JSONL transcript
  ├── Extract first user message + first assistant response
  ├── Truncate (200/500 chars)
  ├── execSync('claude -p --model haiku --max-turns 1 <prompt>')
  │     └── With MONET_TITLE_CHECK_RUNNING=1 env
  ├── Validate output (<60 chars, <8 words)
  ├── Strip quotes/punctuation
  └── Atomic write title to pos-{N}.json
```

**Issue**: Title generation can take 15s. During this time, status file may be in inconsistent state.

---

### 9. StatusWatcher Detects Changed File

**Trigger**: fs.watch or 1s poll detects change in ~/.monet/status/

**Code Path**:
```
fsSync.watch callback or setInterval [statusWatcher.ts:66-91]
  └── Debounce 100ms, then poll()

poll() [statusWatcher.ts:95]
  ├── fs.readdir(STATUS_DIR)
  ├── For each file matching /^pos-(\d+)\.json$/:
  │     ├── slot = parseInt(match[1])
  │     ├── terminal = sessionManager.getTerminalForSlot(slot)
  │     ├── If no terminal → skip (stale file)
  │     ├── fs.readFile + JSON.parse
  │     ├── Build newName = `${emoji} — ${title}`
  │     ├── If terminal.name !== newName:
  │     │     └── queueRename(terminal, newName)

queueRename(terminal, newName) [statusWatcher.ts:135]
  ├── Check if already queued for this terminal
  │     └── If yes, update newName (latest wins)
  ├── Push to renameQueue
  └── processRenameQueue()

processRenameQueue() [statusWatcher.ts:147]
  ├── If isRenaming → return (one at a time)
  ├── isRenaming = true
  ├── Shift item from queue
  ├── Save originalActive = vscode.window.activeTerminal
  ├── terminal.show(false)  // Focus without revealing
  ├── await 50ms
  ├── executeCommand('workbench.action.terminal.renameWithArg', { name })
  ├── If originalActive !== terminal:
  │     └── originalActive.show(false)  // Restore focus
  ├── isRenaming = false
  └── If queue not empty, setTimeout 100ms → processRenameQueue()
```

**CRITICAL BUG - Terminal Rename Race Condition**:
- `workbench.action.terminal.renameWithArg` renames the FOCUSED terminal
- `terminal.show(false)` should focus it, but:
  - 50ms delay may not be enough for VS Code to process focus
  - Another rename queued during the 50ms could corrupt state
  - Restoring `originalActive.show(false)` triggers `onDidChangeActiveTerminal`
  - This fires the 500ms debounce for project switching!

**Scenario**:
1. Status files for slots 1 and 2 both change
2. `queueRename(terminal1, name1)` called
3. `queueRename(terminal2, name2)` called
4. `processRenameQueue()` starts for terminal1
5. `terminal1.show(false)` - focuses terminal1
6. 50ms wait
7. `renameWithArg` - renames focused terminal (should be terminal1)
8. `originalActive.show(false)` - focuses back
9. This triggers `onDidChangeActiveTerminal`!
10. Project switch debounce starts
11. 100ms later, `processRenameQueue()` for terminal2
12. But now focus state might be corrupted

---

### 10. User Closes Terminal

**Trigger**: User closes a Monet terminal

**Code Path**:
```
vscode.window.onDidCloseTerminal listener [sessionManager.ts:29]
  ├── slot = terminalToSlot.get(terminal)
  ├── If slot undefined → not a Monet terminal, return
  ├── terminalToSlot.delete(terminal)
  └── deleteSession(slot) [sessionManager.ts:239]
        ├── session = sessions.get(slot)
        ├── projectPath = session?.projectPath
        ├── sessions.delete(slot)
        ├── saveSessions() → globalState update
        ├── deleteStatusFiles(slot)
        │     └── Unlink pos-{N}.json, .needs-title, .waiting-title
        └── If no remaining sessions for projectPath:
              └── removeHooks(projectPath) [hooksManager.ts:149]
                    ├── Read settings.local.json
                    ├── Filter out __monet__ hooks
                    └── Write back (or delete hooks key if empty)
```

**Race Condition - Stale Status File**:
- `poll()` runs every 1 second
- If poll runs AFTER terminal close event but BEFORE `deleteStatusFiles()`:
  - `getTerminalForSlot(slot)` returns undefined (terminal deleted from map)
  - But status file still exists
  - Poll skips it (correct behavior)
- If poll runs BEFORE terminal close event:
  - May try to rename a terminal that's about to close
  - `terminal.show(false)` on closed terminal = ?

---

### 11. User Runs "Continue Session"

**Trigger**: Command palette → "Monet: Continue"

**Code Path**:
```
monet.continueSession handler [extension.ts:103]
  ├── sessionManager.getDeadSessions() [sessionManager.ts:134]
  │     ├── activeSlots = Set(terminalToSlot.values())
  │     └── Filter sessions where position NOT in activeSlots
  ├── showQuickPick() - user selects
  └── sessionManager.continueSession(slot) [sessionManager.ts:140]
        ├── session = sessions.get(slot)
        ├── Create terminal with SAME slot, env MONET_POSITION
        ├── terminalToSlot.set(terminal, slot)
        ├── deleteStatusFiles(slot) - clean slate
        ├── installHooks(session.projectPath, slot)
        ├── terminal.show()
        └── terminal.sendText('claude -c')
```

**Issue**: `getDeadSessions()` returns empty because `clearOrphanedSessions()` wipes all sessions on activation. Continue only works if terminal was closed during current window session.

---

### 12. Two Sessions in Different Projects

**Trigger**: Project A session at slot 1, Project B session at slot 2, both active

**Analysis**:
- Each project has its own `.claude/settings.local.json`
- Hooks for Project A point to position 1
- Hooks for Project B point to position 2
- Status files are correctly separated: pos-1.json and pos-2.json
- **This case works correctly** (no bug)

**BUT**: Two sessions in SAME project → hooks collision (see Bug #3)

---

### 13. Extension Reloads While Sessions Open

**Trigger**: Developer reload or VS Code restart

**Code Path**:
```
deactivate() [extension.ts:299]
  ├── clearTimeout(terminalFocusDebounceTimer)
  └── statusWatcher.stop()

// VS Code restarts

activate() [extension.ts:17]
  └── clearOrphanedSessions() [sessionManager.ts:39]
        └── sessions.clear() - ALL SESSION DATA LOST
```

**Critical Issue**:
- `terminalToSlot` Map is lost (in-memory)
- `sessions` Map is cleared because no terminals are tracked
- Status files remain on disk but are orphaned
- Hooks remain in project settings.local.json but are orphaned
- On next session create, hooks are overwritten (good)
- But status files may be stale until overwritten or manually deleted

---

## Bug Registry

### BUG-001: Hook Position Collision (P0)

**Trigger**: Create two sessions in the same project

**Root Cause**: `hooksManager.ts:63-69` removes ALL Monet hooks then adds new ones with only the latest position.

**Symptom**: All sessions in a project write to the same status file. Title changes in one session appear in another.

**Evidence**: `Monet/.claude/settings.local.json` shows position 3, but there are sessions at positions 1, 2, 3.

**Fix**: Accumulate hooks instead of replacing. Track positions per project.

---

### BUG-002: Sessions Lost on Reload (P1)

**Trigger**: Reload VS Code window

**Root Cause**: `sessionManager.ts:39-44` calls `clearOrphanedSessions()` which wipes all sessions because `terminalToSlot` is empty after reload.

**Symptom**: "Continue" feature never works across reloads.

**Fix**: Don't clear sessions on activation. Instead, validate sessions against existing terminals or mark them as recoverable.

---

### BUG-003: Terminal Rename Race Condition (P1)

**Trigger**: Two status files change at similar times

**Root Cause**: `statusWatcher.ts:162-166` uses `terminal.show(false)` then `renameWithArg`, but `renameWithArg` operates on focused terminal, not a specific terminal reference.

**Symptom**: Wrong terminal gets renamed. Title from session A appears on session B.

**Fix**: Use VS Code terminal API directly if available, or implement a terminal-specific rename workaround.

---

### BUG-004: Focus Restore Triggers Project Switch (P2)

**Trigger**: Status watcher renames a terminal

**Root Cause**: `statusWatcher.ts:169-171` restores focus to originalActive, which fires `onDidChangeActiveTerminal`, which triggers the 500ms project switch debounce.

**Symptom**: Explorer may flicker or switch unexpectedly during renames.

**Fix**: Add flag to suppress project switch during rename operations.

---

### BUG-005: Orphaned Status Files (P2)

**Trigger**: Extension crashes or force quit

**Root Cause**: No cleanup mechanism for status files on startup.

**Symptom**: Stale status files remain forever in ~/.monet/status/

**Fix**: On activation, delete status files that don't correspond to any session.

---

### BUG-006: Color Assignment Instability (P2)

**Trigger**: Open two Cursor windows

**Root Cause**: `projectManager.ts:13` says "No persistence - colors start fresh each session". Colors are assigned by insertion order.

**Symptom**: Same project gets different colors in different windows.

**Fix**: Persist color assignments to globalState, or hash project path to determine color.

---

## Recommended Fixes (Priority Order)

### P0 - Stop the Bleeding

1. **Fix Hook Position Collision (BUG-001)**
   - Change `installHooks()` to track multiple positions per project
   - Structure: `hooks.UserPromptSubmit = [ { matcher: position1 }, { matcher: position2 } ]`
   - Or: Use a single generic hook that reads $MONET_POSITION from env

### P1 - Core Functionality

2. **Fix Session Persistence (BUG-002)**
   - Remove `clearOrphanedSessions()` or make it smarter
   - On activation, mark sessions as "orphaned" but don't delete
   - Allow recovery via "Continue" even across reloads

3. **Fix Terminal Rename (BUG-003)**
   - Investigate VS Code terminal rename API
   - If no API exists, add mutex and longer delays
   - Consider alternative: update terminal title via escape codes in the terminal itself

### P2 - Polish

4. **Suppress Project Switch During Rename (BUG-004)**
5. **Clean Up Orphaned Status Files (BUG-005)**
6. **Persist Color Assignments (BUG-006)**

---

## Key Questions Answered

**1. Can `workbench.action.terminal.renameWithArg` rename the wrong terminal?**
YES. It renames the FOCUSED terminal. If focus state is corrupted (rapid switches, async timing), wrong terminal gets renamed.

**2. Is there any path where `pos-1.json` gets written by a hook from a different project?**
NO for different projects (each project has its own settings.local.json).
YES for same project with multiple sessions (BUG-001).

**3. When `updateWorkspaceFolders` fires, does Monet react?**
NO. There is no `onDidChangeWorkspaceFolders` listener.

**4. Are hook commands deduplicated?**
YES. `installHooks()` removes all `__monet__` hooks before adding new ones. But this causes BUG-001.

**5. Window where statusWatcher tries to rename dead terminal?**
YES. Between `onDidCloseTerminal` fire and `deleteStatusFiles()` completion, poll may read stale file. But `getTerminalForSlot()` returns undefined, so rename is skipped (correct).
