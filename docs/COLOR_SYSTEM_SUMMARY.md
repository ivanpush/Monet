# Monet Color System - Executive Summary

**Date:** 2025-02-25

## What You Need to Know

### The System in 30 Seconds

Monet uses a **gap-filling color assignment algorithm** to assign one of 10 distinct colors to each project. When you create a new session:

1. The system checks if the project already has a color → reuse it
2. If not → find the lowest-numbered available color slot (0-9)
3. When the last terminal for a project closes → free its color slot
4. Colors are reset on reload but sessions survive via disk files

### Key Numbers

- **10 colors** in the palette (Monet-inspired soft pastels)
- **20 session slots** (supports up to 20 concurrent sessions)
- **8-char hex sessionIds** (cryptographically unique)
- **2 globalState keys** used for persistence
- **Ephemeral** color assignments (reset on startup)
- **Persistent** session metadata (survives Extension Host restarts)

---

## Current Color Assignment Logic

### How Colors Get Assigned

```
When createSession() or continueSession() is called:

1. Get current project path
2. Call projectManager.assignColor(projectPath)
   ├─ Increment terminal count for this project
   ├─ Check if project already has a color:
   │  ├─ YES → return the mapped color
   │  └─ NO → find next available slot (0,1,2,...,9)
   └─ Return color index using colorOrder[slot]

3. Create terminal with that color
4. Store session metadata in globalState + disk
```

### Gap-Filling Explained

Projects use color **slots** (0-9), not fixed colors. When a project's terminal closes:

```
BEFORE: Project A=slot0, Project B=slot2, Project C=slot1
        Slot 1 (gardenMint) is occupied

AFTER A closes: Project B=slot2, Project C=slot1
                Slot 0 is now FREE

NEXT PROJECT: Gets slot 0 (gap-filled)
              Not slot 3!
```

This ensures efficient use of the 10-color palette.

### Multiple Terminals Per Project

If you open 2 terminals for the same project:

```
Terminal 1 for /Projects/Monet → slot 0, count = 1
Terminal 2 for /Projects/Monet → slot 0, count = 2 (reuses color)
         
Close Terminal 1 → count decrements to 1 → slot stays
Close Terminal 2 → count reaches 0 → slot freed
```

---

## Data Structures at a Glance

### ProjectManager (In-Memory Only - Ephemeral)
```typescript
projectColors: Map<normalized_path, slot_index>
// Example: {"/Users/name/Projects/Monet" → 0}

projectTerminalCount: Map<normalized_path, count>
// Example: {"/Users/name/Projects/Monet" → 2}

colorOrder: number[]
// Default (fixed): [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
// Shuffled: [3, 7, 1, 9, 2, 0, 5, 8, 4, 6]
```

### GlobalState (Persistent - Survives Extension Host Restart)
```typescript
monet.sessions: {
  "1": SessionMeta,  // Slot 1 session
  "2": SessionMeta,  // Slot 2 session
  ...
  "20": SessionMeta  // Slot 20 session
}

monet.activeProject: "/Users/name/Projects/Monet"
```

### Disk (Persistent - History)
```
~/.monet/status/{sessionId}.json
  └─ SessionStatusFile with title, status, project, processId
```

---

## The 10-Color Palette

All colors are Monet-inspired soft pastels with theme variants:

| # | Color Name | Theme | Hex Values |
|---|------------|-------|-----------|
| 0 | waterLily | cyan | light:#A0D8D8 / dark:#D4F4F4 |
| 1 | gardenMint | green | light:#B0E0B0 / dark:#D8FAD8 |
| 2 | roseFloral | pink | light:#D8C0D8 / dark:#F4E0F4 |
| 3 | sunlightGold | gold | light:#E8E4C8 / dark:#FAF8E0 |
| 4 | skyBlue | blue | light:#B8D8E8 / dark:#D8F0FA |
| 5 | deepWater | teal | light:#A0C8C8 / dark:#C8E8E8 |
| 6 | afternoonWarm | tan | light:#D8D0C0 / dark:#F4ECD8 |
| 7 | eveningMauve | purple | light:#D0A8D8 / dark:#E8C8F4 |
| 8 | cloudWhite | lavender | light:#D8D0D8 / dark:#F0E8F0 |
| 9 | sunsetCoral | coral | light:#E0B8B8 / dark:#F8D0D0 |

---

## GlobalState Keys in Use

### `monet.sessions`
- **Type:** `Record<"1"|"2"|...|"20", SessionMeta>`
- **Loaded on:** Extension activation
- **Updated on:** Session create/continue, PID capture
- **Cleared on:** Fresh Cursor load (no Monet terminals detected)
- **Example:**
  ```json
  {
    "1": {
      "sessionId": "f7ee09cf",
      "position": 1,
      "projectPath": "/Users/name/Projects/Monet",
      "projectName": "Monet",
      "terminalName": "🟢 — Fixing auth bug",
      "createdAt": 1708876543210,
      "isContinue": false,
      "processId": 12345
    }
  }
  ```

### `monet.activeProject`
- **Type:** `string` (full path)
- **Purpose:** Track currently active project
- **Updated on:** Project switch, terminal focus switch
- **Priority:**
  1. In-progress switch target
  2. activeProject from globalState
  3. First workspace folder
  4. null (no project)

---

## Sessions Per Project Counting

### How It Works

**No explicit "sessions per project" counter.** Instead:

1. **projectTerminalCount** tracks active terminal count
   - Incremented: `assignColor()`
   - Decremented: `releaseColor()`
   - Used to: Decide when to free color slot

2. **To count sessions:** Filter `getAllSessions()` by projectPath
   ```typescript
   const sessionsInProject = sessions.filter(
     s => s.projectPath === targetPath
   );
   ```

3. **To check if any remain:** Use `.some()`
   ```typescript
   const hasRemaining = sessions.some(
     s => s.projectPath === projectPath
   );
   ```

---

## Reconnection & Color Restoration

### Extension Host Restart

When Cursor's Extension Host restarts:

1. **Detection:** Check if any terminal has `MONET_SESSION_ID` env var
2. **If yes:** Reconnection flow
   - Read all status files from `~/.monet/status/`
   - Match each live terminal to its sessionId
   - Restore SessionMeta from disk
   - Assign same slot (regenerate colors)
3. **If no:** Fresh load
   - Clear globalState sessions
   - Cleanup stale processIds in status files
   - Start fresh

### Why Colors Can Be Regenerated

Colors are **not persisted** - they're ephemeral. But:
- Session metadata (slot, projectPath) IS persisted
- On reconnect, `assignColor()` regenerates the color for each project
- Same project = same slot = same color (gap-filling preserves ordering)

---

## Key Methods You'll Use

### ProjectManager
```typescript
assignColor(projectPath: string): number
  → Returns actual color index (0-9)
  → Increments terminal count
  → Creates slot if needed

releaseColor(projectPath: string): void
  → Decrements terminal count
  → Frees slot when count reaches 0

getColorIndex(projectPath: string): number
  → Returns color index WITHOUT incrementing count
  → Used for queries only

getCurrentProject(): {name, path} | null
  → Gets current active project
  → Priority: switch target → activeProject → workspace

setActiveProject(path: string): Promise
  → Updates globalState['monet.activeProject']
```

### SessionManager
```typescript
createSession(isContinue: boolean): Promise<Terminal | null>
  → Creates new terminal with assigned color
  → Stores in globalState + disk

continueSession(slot: number): Promise<Terminal | null>
  → Continues dead session
  → Reuses same slot + color

deleteSession(slot: number, sessionId: string): Promise
  → Closes session
  → Releases color slot
  → Removes status file

getAllSessions(): SessionMeta[]
  → Returns all active sessions

getDeadSessions(): SessionMeta[]
  → Returns sessions with no active terminal
```

---

## Important Details

### Ephemeral vs Persistent

| What | Ephemeral | Persistent |
|------|-----------|-----------|
| projectColors map | YES | NO |
| projectTerminalCount | YES | NO |
| colorOrder (if shuffled) | YES | NO |
| globalState['monet.sessions'] | NO | YES |
| globalState['monet.activeProject'] | NO | YES |
| ~/.monet/status/*.json | NO | YES |

### When Colors Are Reset
1. Extension startup (always)
2. User runs `monet.reset` command
3. Workspace reload

### When Sessions Are Lost
1. User runs `monet.reset` command
2. Fresh Cursor load (no Monet terminals detected)
3. User deletes ~/.monet/status/ directory

---

## Configuration

### `monet.colorOrder` Setting
```json
{
  "monet.colorOrder": "fixed"    // or "shuffle"
}
```
- **fixed:** Use colors in order 0→1→2→...→9 (default, predictable)
- **shuffle:** Randomize with Fisher-Yates (each load different)

### `monet.projectsRoot` Setting
```json
{
  "monet.projectsRoot": "~/Projects"  // or any path
}
```
- Directory to scan for available projects
- Default: `~/Projects`

---

## File Locations

| File | Purpose |
|------|---------|
| `src/types.ts` | PROJECT_COLORS, interfaces |
| `src/projectManager.ts` | Color assignment logic |
| `src/sessionManager.ts` | Session tracking, slot management |
| `src/extension.ts` | Initialization, activation |
| `package.json` | Theme color definitions |
| `~/.monet/status/{sessionId}.json` | Session status on disk |

---

## Quick Testing

To verify the color assignment system works:

1. Create Session 1 for /Projects/Monet → gets color 0
2. Create Session 2 for /Projects/Demo → gets color 1
3. Create Session 3 for /Projects/Monet → reuses color 0
4. Close all sessions
5. Create Session 4 for /Projects/NewProject → gets color 0 (gap-filled)

Colors should follow gap-filling pattern, not assignment order.

