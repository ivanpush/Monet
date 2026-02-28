# Monet Color System - Quick Reference

**Updated:** 2025-02-25

## Color Palette (10 colors)

| Index | ID | Light | Dark | Description |
|-------|-----|-------|------|-------------|
| 0 | `monet.waterLily` | #A0D8D8 | #D4F4F4 | Soft cyan - water lily reflections |
| 1 | `monet.gardenMint` | #B0E0B0 | #D8FAD8 | Soft green - garden foliage |
| 2 | `monet.roseFloral` | #D8C0D8 | #F4E0F4 | Soft pink - impressionist florals |
| 3 | `monet.sunlightGold` | #E8E4C8 | #FAF8E0 | Soft gold - sunlight on haystacks |
| 4 | `monet.skyBlue` | #B8D8E8 | #D8F0FA | Soft blue - Monet skies |
| 5 | `monet.deepWater` | #A0C8C8 | #C8E8E8 | Muted teal - deeper water |
| 6 | `monet.afternoonWarm` | #D8D0C0 | #F4ECD8 | Soft tan - afternoon warmth |
| 7 | `monet.eveningMauve` | #D0A8D8 | #E8C8F4 | Soft purple - evening tones |
| 8 | `monet.cloudWhite` | #D8D0D8 | #F0E8F0 | Soft lavender - clouds |
| 9 | `monet.sunsetCoral` | #E0B8B8 | #F8D0D0 | Soft coral - sunset glow |

## Key Data Structures

### ProjectManager (In-Memory)
```
projectColors: Map<normalized_path, slot_index>
projectTerminalCount: Map<normalized_path, terminal_count>
colorOrder: number[] (0-9, may be shuffled)
```

### GlobalState Persistence
```
monet.sessions: Record<"1"|"2"|...|"20", SessionMeta>
monet.activeProject: string (full path)
```

### Disk Persistence
```
~/.monet/status/{sessionId}.json ← SessionStatusFile
```

## Color Assignment Algorithm

```
assignColor(projectPath) → colorIndex

1. Normalize path
2. Increment projectTerminalCount[projectPath]
3. If projectPath in projectColors:
     return colorOrder[projectColors[projectPath]]
4. Else:
     slot = findNextAvailableSlot()  // Gap-fill: 0,1,2,...,9
     projectColors[projectPath] = slot
     return colorOrder[slot]

releaseColor(projectPath):
1. Decrement projectTerminalCount[projectPath]
2. If count reaches 0:
     delete projectColors[projectPath]  // Free slot
3. Else:
     keep slot (shared by multiple terminals)
```

## Session Slots

- **Total:** 20 slots (1-20)
- **Format:** `globalState['monet.sessions']["1"]`, `["2"]`, etc.
- **Assignment:** First available slot on creation
- **Release:** When last terminal for project closes

## GlobalState Keys

| Key | Type | Purpose | Lifecycle |
|-----|------|---------|-----------|
| `monet.sessions` | `Record<string, SessionMeta>` | Store all active sessions | Persist until close, clear on fresh load |
| `monet.activeProject` | `string` | Track active project | Persist across Extension Host restarts |

## Session Status File Format

```json
{
  "sessionId": "f7ee09cf",
  "project": "Monet",
  "status": "active",
  "title": "Fixing auth bug",
  "updated": 1708876543210,
  "processId": 12345,
  "projectPath": "/Users/ivanforcytebio/Projects/Monet"
}
```

## Color Assignment Examples

### Example 1: New Project First Session
```
1. createSession() for /Projects/Monet
   ├─ assignColor("/Projects/Monet")
   ├─ projectColors["/Projects/Monet"] = 0 (first available)
   ├─ colorOrder[0] = 0
   └─ → color index 0 (waterLily)

Terminal created with monet.waterLily
```

### Example 2: Multiple Terminals Same Project
```
Terminal 1: /Projects/Monet → slot 0 → count = 1
Terminal 2: /Projects/Monet → slot 0 → count = 2  (reuses color)
Terminal 3: /Projects/Demo → slot 1 → count = 1

Close Terminal 1: /Projects/Monet → count = 1 → keep slot 0
Close Terminal 2: /Projects/Monet → count = 0 → free slot 0
Close Terminal 3: /Projects/Demo → count = 0 → free slot 1

Next project /Projects/NewProj → slot 0 (gap-filled)
```

### Example 3: Shuffled Colors
```
Setting: monet.colorOrder = "shuffle"

Initial: colorOrder = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
Shuffled: colorOrder = [3, 7, 1, 9, 2, 0, 5, 8, 4, 6]

Project A → slot 0 → colorOrder[0] = 3 → sunlightGold
Project B → slot 1 → colorOrder[1] = 7 → eveningMauve
...
```

## Extension Host Restart Flow

```
Cursor closes:
  ├─ Extension Host restarts
  ├─ activation() called
  ├─ hasMonetTerminals() checks MONET_SESSION_ID env vars
  └─ If found:
       reconnectSessions() reads ~/.monet/status/*.json
       Matches terminals to saved sessionIds
       Restores color assignments
```

## Project Manager Methods

| Method | Input | Output | Side Effects |
|--------|-------|--------|--------------|
| `assignColor(path)` | project path | color index | Increments terminal count |
| `releaseColor(path)` | project path | void | May free slot |
| `getColorIndex(path)` | project path | color index | May create slot (no count increment) |
| `getThemeColor(path)` | project path | vscode.ThemeColor | — |
| `getIconPath(path)` | project path | vscode.Uri | — |
| `getCurrentProject()` | — | {name, path} | — |
| `setActiveProject(path)` | project path | Promise | Updates globalState |

## Session Manager Methods

| Method | Input | Output | Storage |
|--------|-------|--------|---------|
| `createSession(isContinue)` | boolean | Terminal | globalState + disk |
| `continueSession(slot)` | slot number | Terminal | globalState + disk |
| `deleteSession(slot, id)` | slot, sessionId | void | globalState (history kept on disk) |
| `getDeadSessions()` | — | SessionMeta[] | — |
| `getAllSessions()` | — | SessionMeta[] | — |
| `resetAllSessions()` | — | Promise | Clear globalState + disk |

## Commands

```
monet.newSession          → createSession(false)
monet.continueSession     → continueSession(slot)
monet.switchProject       → setActiveProject(path)
monet.reset               → resetAllSessions()
```

## Important Constants

```typescript
MAX_SLOTS = 20                    // Maximum concurrent sessions
MONET_DIR = ~/.monet/
STATUS_DIR = ~/.monet/status/
SESSION_ID_LENGTH = 8 chars hex   // crypto.randomUUID().slice(0,8)
```

## Ephemeral vs Persistent State

**Ephemeral (Reset on Reload):**
- projectColors map (slot assignments)
- projectTerminalCount map (terminal count per project)
- colorOrder array (if shuffled)

**Persistent (Survive Extension Host Restart):**
- globalState['monet.sessions'] (slot metadata)
- globalState['monet.activeProject'] (current project)
- ~/.monet/status/*.json (session status files)

