# Monet VS Code Extension: Color Assignment System Analysis

**Created:** 2025-02-25

## Current Architecture Overview

The Monet extension uses a **gap-filling color assignment algorithm** that manages terminal colors across projects. Colors are ephemeral (reset on reload) and assigned using a slot-based system with configurable ordering (fixed or shuffled).

---

## 1. Color Palette Definition

### Source: `src/types.ts` (lines 12-37)

**PROJECT_COLORS Array** (10 colors):
```typescript
export const PROJECT_COLORS = [
  'monet.waterLily',      // Soft cyan - water lily reflections
  'monet.gardenMint',     // Soft green - garden foliage
  'monet.roseFloral',     // Soft pink - impressionist florals
  'monet.sunlightGold',   // Soft gold - sunlight on haystacks
  'monet.skyBlue',        // Soft blue - Monet skies
  'monet.deepWater',      // Muted teal - deeper water
  'monet.afternoonWarm',  // Soft tan - afternoon warmth
  'monet.eveningMauve',   // Soft purple - evening tones
  'monet.cloudWhite',     // Soft lavender - clouds
  'monet.sunsetCoral'     // Soft coral - sunset glow
] as const;
```

**PROJECT_ICONS Array** (10 icons, 1:1 mapped to colors):
- `claude-spark-cyan.svg` → waterLily
- `claude-spark-mint.svg` → gardenMint
- `claude-spark-rose.svg` → roseFloral
- `claude-spark-yellow.svg` → sunlightGold
- `claude-spark-sky.svg` → skyBlue
- `claude-spark-green.svg` → deepWater
- `claude-spark-peach.svg` → afternoonWarm
- `claude-spark-magenta.svg` → eveningMauve
- `claude-spark-lavender.svg` → cloudWhite
- `claude-spark-coral.svg` → sunsetCoral

### Theme Colors: `package.json` (lines 123-134)

Each color has dark and light theme variants:
```json
{
  "id": "monet.waterLily",
  "description": "Soft cyan - water lily reflections",
  "defaults": { "dark": "#D4F4F4", "light": "#A0D8D8" }
}
// ... 9 more colors
```

---

## 2. Color Assignment Logic

### Source: `src/projectManager.ts`

#### Key Data Structures (lines 10-16)

```typescript
// projectPath → colorIndex (slot in colorOrder)
private projectColors: Map<string, number> = new Map();

// projectPath → number of terminals using this project
private projectTerminalCount: Map<string, number> = new Map();

// Color order: indices into PROJECT_COLORS array (may be shuffled)
private colorOrder: number[];
```

#### Initialization (lines 22-37)

The color order is determined at construction time based on `monet.colorOrder` setting:

**Fixed Order (Default):**
```
colorOrder = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
Direct mapping: project_N gets PROJECT_COLORS[N]
```

**Shuffled Order:**
```
Uses Fisher-Yates shuffle to randomize indices
colorOrder = [shuffled indices]
Applied at Extension startup, reset on reload
```

#### Gap-Filling Algorithm: `assignColor()` (lines 68-86)

**Purpose:** Assign a color to a project when creating a new terminal

**Logic:**
1. Normalize project path (cross-platform consistency)
2. Increment terminal count for this project
3. Check if project already has a color slot:
   - If yes: return the mapped color (reuse for multiple terminals)
   - If no: find next available slot and assign
4. Return actual color index using `colorOrder[slot]`

```typescript
assignColor(projectPath: string): number {
  const normalized = path.normalize(projectPath);
  
  // Increment terminal count
  const currentCount = this.projectTerminalCount.get(normalized) || 0;
  this.projectTerminalCount.set(normalized, currentCount + 1);
  
  // If already has a color slot, return the mapped color
  if (this.projectColors.has(normalized)) {
    const slot = this.projectColors.get(normalized)!;
    return this.colorOrder[slot];
  }
  
  // Assign next available slot
  const slot = this.findNextAvailableSlot();
  this.projectColors.set(normalized, slot);
  return this.colorOrder[slot];
}
```

#### Gap-Filling: `findNextAvailableSlot()` (lines 52-59)

**Purpose:** Find the lowest numbered unused slot (fills gaps when projects are removed)

**Logic:**
- Iterate slots 0-9 sequentially
- Return first slot not in `usedSlots` set
- If all slots used: wrap to 0 (recycle)

```typescript
private findNextAvailableSlot(): number {
  const usedSlots = new Set(this.projectColors.values());
  for (let i = 0; i < PROJECT_COLORS.length; i++) {
    if (!usedSlots.has(i)) return i;
  }
  return 0; // All used, wrap around
}
```

**Example:**
- Project A: slot 0 (waterLily)
- Project C: slot 2 (roseFloral)
- Project B: slot 1 (gardenMint)
- **Project D gets:** slot 0 (gap-filled after A closes)

#### Color Release: `releaseColor()` (lines 88-102)

**Purpose:** Free a color slot when a terminal closes

**Logic:**
1. Decrement terminal count for project
2. If count reaches 0: delete project entry (free slot)
3. If count > 0: keep the slot (multiple terminals for same project)

```typescript
releaseColor(projectPath: string): void {
  const normalized = path.normalize(projectPath);
  const currentCount = this.projectTerminalCount.get(normalized) || 0;
  
  if (currentCount <= 1) {
    // Last terminal for this project - free the color
    this.projectTerminalCount.delete(normalized);
    this.projectColors.delete(normalized);
  } else {
    // Decrement count
    this.projectTerminalCount.set(normalized, currentCount - 1);
  }
}
```

#### Color Lookup: `getColorIndex()` (lines 106-118)

**Purpose:** Get color for a project without incrementing count (for queries)

**Logic:**
- If project already assigned: return mapped color
- If not assigned: assign lowest available slot (for consistency)
- Note: Does NOT increment terminal count

---

## 3. Session Tracking & Storage

### Data Structures

#### SessionMeta (types.ts, lines 40-49)
```typescript
export interface SessionMeta {
  sessionId: string;         // Unique 8-char hex ID (never changes)
  position: number;          // Slot 1-20 (for display/ordering)
  projectPath: string;       // Full path to project
  projectName: string;       // Display name
  terminalName: string;      // Current terminal name
  createdAt: number;         // Timestamp
  isContinue: boolean;       // Was started with -c flag
  processId?: number;        // Terminal PID for reconnection
}
```

#### SessionStatusFile (types.ts, lines 52-61)
```typescript
export interface SessionStatusFile {
  sessionId: string;         // Unique session ID
  project: string;           // Project name
  status: keyof typeof STATUS_EMOJI;  // thinking|active|waiting|idle
  title: string;             // What agent is working on
  error?: string;            // Error message
  updated: number;           // Timestamp
  processId?: number;        // Terminal PID for reconnection
  projectPath?: string;      // Full project path for reconnection
}
```

#### Session Slot System (sessionManager.ts)

**Max Slots:** 20 (constant MAX_SLOTS)

**Storage:**
- In-memory: `Map<slot_number, SessionMeta>`
- Persistence: `globalState['monet.sessions']` → Record<slot_string, SessionMeta>
- On-disk: `~/.monet/status/{sessionId}.json` → SessionStatusFile

---

## 4. GlobalState Usage

### Persisted State Keys

#### `monet.sessions` (sessionManager.ts, lines 165-172)
**Type:** `Record<string, SessionMeta>`

**Storage Format:**
```json
{
  "1": {
    "sessionId": "f7ee09cf",
    "position": 1,
    "projectPath": "/Users/ivanforcytebio/Projects/Monet",
    "projectName": "Monet",
    "terminalName": "🟢 — Fixing auth bug",
    "createdAt": 1708876543210,
    "isContinue": false,
    "processId": 12345
  },
  "2": { ... }
}
```

**Lifecycle:**
- Loaded on activation: `loadSessions()`
- Updated on: session create, session continue, PID capture
- Cleared on: fresh load (no Monet terminals detected)
- Reset on: `monet.reset` command

#### `monet.activeProject` (projectManager.ts, lines 217, 261)
**Type:** `string` (full path)

**Purpose:** Track currently active project for workspace switching

**Lifecycle:**
- Read on: `getCurrentProject()` (priority 2 after in-progress switch)
- Updated on: `setActiveProject()` (project switch or terminal focus)
- Survives: Extension Host restarts

**Priority Order** (projectManager.ts, lines 206-246):
1. `switchingToProject` (in-progress async update)
2. `monet.activeProject` from globalState
3. First workspace folder
4. null (no project available)

---

## 5. Projects Per Session Counting

### Counting Logic

#### Per-Project Terminal Count (projectManager.ts)
```typescript
// Track when assignColor() is called
projectTerminalCount: Map<string, number>
```

- Incremented: `assignColor()` → each new terminal
- Decremented: `releaseColor()` → each closed terminal
- Used for: Determining when to free color slot

#### Per-Project Session Count
No explicit per-project session count maintained. Instead:

**Count all sessions for a project:**
```typescript
// From sessionManager.ts line 425-426
const remainingInProject = Array.from(this.sessions.values())
  .some(s => s.projectPath === projectPath);
```

**Get all sessions:** `getAllSessions()` returns all SessionMeta

---

## 6. Color Assignment Flow in Practice

### Scenario: New Session Creation

```
1. User clicks "New Session" → createSession()
   ↓
2. Project determined: projectManager.getCurrentProject()
   ↓
3. Color assigned: projectManager.assignColor(projectPath)
   - Normalizes path
   - Increments projectTerminalCount[projectPath]
   - Finds next available slot via findNextAvailableSlot()
   - Returns actual color index
   ↓
4. Terminal created with:
   - color: getThemeColorByIndex(colorIndex)
   - icon: getIconPathByIndex(colorIndex)
   - env: { MONET_SESSION_ID: sessionId }
   ↓
5. Session metadata stored:
   - globalState['monet.sessions'][slot] = SessionMeta
   - Disk: ~/.monet/status/{sessionId}.json = SessionStatusFile
   ↓
6. Hooks installed: ~/.monet/bin/monet-status, monet-title
```

### Scenario: Terminal Closes

```
1. onDidCloseTerminal event fired
   ↓
2. sessionManager.deleteSession(slot, sessionId)
   ↓
3. projectManager.releaseColor(projectPath)
   - Decrement terminal count
   - Free slot if count reaches 0
   ↓
4. Remove status file: ~/.monet/status/{sessionId}.json
   ↓
5. Remove hooks if no sessions left in project
```

### Scenario: Multiple Terminals Same Project

```
1. Session 1 created for /Projects/Monet
   → assignColor() → slot 0 assigned → waterLily
   → projectTerminalCount[/Projects/Monet] = 1
   
2. Session 2 created for /Projects/Monet
   → assignColor() → slot 0 already assigned → return waterLily
   → projectTerminalCount[/Projects/Monet] = 2
   
3. Session 1 terminal closed
   → releaseColor() → count decrements to 1 → keep slot
   
4. Session 2 terminal closed
   → releaseColor() → count reaches 0 → free slot 0
   → Next project gets slot 0
```

---

## 7. Reconnection System

### Extension Host Restart Detection

**Source:** sessionManager.ts, lines 32-42 (extension.ts)

```typescript
if (!sessionManager.hasMonetTerminals()) {
  // Fresh load: clear globalState, cleanup stale files
  await sessionManager.clearGlobalStateSessions();
  await sessionManager.cleanupStaleStatusFiles();
} else {
  // Extension Host restart: preserve state
  await sessionManager.reconnectSessions();
}
```

**Method:** `hasMonetTerminals()` checks for MONET_SESSION_ID env var

### PID-Based Reconnection

**Source:** sessionManager.ts, lines 60-162

**Logic:**
1. Read all status files from ~/.monet/status/
2. For each active terminal with MONET_SESSION_ID:
   - Look up disk status file by sessionId
   - Reconstruct SessionMeta from disk
   - Assign slot and restore color
   - Update PID in status file if changed

**Why It Works:**
- Status files persist across Extension Host restarts
- sessionId env var is set on terminal creation
- PID stored in both globalState and disk
- Color assignments are ephemeral (regenerated on startup)

---

## 8. Complete Data Flow Diagram

```
┌─────────────────────────────────────────────────────────┐
│  User clicks "New Session"                              │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ↓
┌─────────────────────────────────────────────────────────┐
│  projectManager.getCurrentProject()                      │
│  Priority: switch target → activeProject → workspace    │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ↓
┌─────────────────────────────────────────────────────────┐
│  projectManager.assignColor(projectPath)                │
│  ├─ Normalize path                                       │
│  ├─ Increment projectTerminalCount                      │
│  ├─ Check projectColors map                             │
│  ├─ If new: findNextAvailableSlot() → gap-fill         │
│  └─ Return colorIndex via colorOrder[]                  │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ↓
┌─────────────────────────────────────────────────────────┐
│  vscode.window.createTerminal()                         │
│  ├─ color: getThemeColorByIndex(colorIndex)            │
│  ├─ icon: getIconPathByIndex(colorIndex)               │
│  └─ env: { MONET_SESSION_ID: "f7ee09cf" }              │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ↓
┌─────────────────────────────────────────────────────────┐
│  Save to Storage (dual persistence)                     │
│  ├─ In-memory: sessions.set(slot, SessionMeta)         │
│  ├─ GlobalState: 'monet.sessions' → Record<>           │
│  └─ Disk: ~/.monet/status/{sessionId}.json             │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ↓
┌─────────────────────────────────────────────────────────┐
│  Install Hooks                                          │
│  ├─ ~/.monet/bin/monet-status {sessionId} {status}     │
│  └─ ~/.monet/bin/monet-title {sessionId} {title}       │
└─────────────────────────────────────────────────────────┘
```

---

## 9. Summary: Key Architectural Points

| Aspect | Implementation |
|--------|-----------------|
| **Color Assignment** | Gap-filling algorithm with slot-based mapping |
| **Available Colors** | 10 distinct Monet-inspired palette colors |
| **Color Persistence** | Ephemeral (reset on reload, regenerated on startup) |
| **Session Slots** | 1-20 (supports up to 20 concurrent sessions) |
| **Session Tracking** | In-memory Map + globalState persistence + disk files |
| **Project-to-Color** | `projectColors: Map<path, slot>` |
| **Terminals Per Project** | Tracked via `projectTerminalCount` map |
| **GlobalState Keys** | `monet.sessions`, `monet.activeProject` |
| **Status Storage** | `~/.monet/status/{sessionId}.json` (SessionStatusFile) |
| **Reconnection** | PID-based via MONET_SESSION_ID env var |
| **Max Sessions** | 20 (MAX_SLOTS constant) |
| **Session IDs** | 8-char hex (crypto.randomUUID slice) |

---

## 10. Integration Points

### When Color Assignment Happens
1. **New Session**: `createSession()` → `assignColor()`
2. **Continue Session**: `continueSession()` → `assignColor()`
3. **Terminal Close**: `onDidCloseTerminal` → `releaseColor()`

### When Colors Are Reset
1. **Extension Startup** (if fresh load)
2. **User runs `monet.reset` command** → `resetAllSessions()`
3. **Workspace reload** → color order regenerated

### When Sessions Are Synced
1. **Creation**: globalState + disk
2. **PID Capture**: globalState + disk
3. **Terminal Close**: globalState only (status file kept for history)
4. **Extension Host Restart**: disk → globalState + in-memory

---

## File References

- **Color definitions**: `/Users/ivanforcytebio/Projects/Monet/src/types.ts` (lines 12-37)
- **Color assignment**: `/Users/ivanforcytebio/Projects/Monet/src/projectManager.ts` (lines 68-118)
- **Session tracking**: `/Users/ivanforcytebio/Projects/Monet/src/sessionManager.ts` (lines 14-40, 164-172)
- **GlobalState usage**: `/Users/ivanforcytebio/Projects/Monet/src/extension.ts` (lines 32-42, 167-168, 248)
- **Theme colors**: `/Users/ivanforcytebio/Projects/Monet/package.json` (lines 123-134)

