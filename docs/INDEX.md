# Monet Color System Documentation Index

**Last Updated:** 2025-02-25

This directory contains comprehensive documentation of the Monet VS Code Extension's color assignment and session tracking system.

## Quick Start

Start here based on what you need:

- **Just need a quick overview?** → Read `COLOR_SYSTEM_SUMMARY.md` (10 min)
- **Building a feature?** → Reference `QUICK_REFERENCE.md` (lookup tables & code snippets)
- **Deep dive into architecture?** → Read `monet_color_system_analysis.md` (comprehensive technical reference)

---

## Document Guide

### 1. COLOR_SYSTEM_SUMMARY.md
**Purpose:** Executive summary for understanding the color system quickly

**Contents:**
- System overview in 30 seconds
- Key numbers and constants
- How color assignment works
- Gap-filling algorithm explained
- Data structures overview
- GlobalState keys
- Reconnection mechanism
- Configuration options

**Best For:**
- Getting up to speed quickly
- Understanding the big picture
- Explaining the system to others
- Quick reference during development

**Length:** 339 lines (9 KB)

---

### 2. QUICK_REFERENCE.md
**Purpose:** Lookup tables, code snippets, and API reference

**Contents:**
- Color palette table (10 colors with hex values)
- Key data structures
- Color assignment algorithm pseudocode
- Session slots overview
- GlobalState keys table
- Session status file format (JSON)
- Color assignment examples
- Method signatures and side effects
- Commands list
- Constants
- Ephemeral vs persistent state

**Best For:**
- Quick lookups during coding
- Copy-paste code snippets
- Understanding data flow
- API reference
- Examples of common scenarios

**Length:** 193 lines (6 KB)

---

### 3. monet_color_system_analysis.md
**Purpose:** Comprehensive technical reference covering all aspects of the system

**Contents:**
- Architecture overview
- Complete color palette definition (from types.ts and package.json)
- Color assignment logic in detail
  - Key data structures
  - Initialization (fixed vs shuffled)
  - Gap-filling algorithm
  - Color release mechanism
  - Color lookup
- Session tracking and storage
  - SessionMeta interface
  - SessionStatusFile interface
  - Session slot system
- GlobalState usage
  - monet.sessions key
  - monet.activeProject key
- Projects per session counting
- Color assignment flow
  - New session creation
  - Terminal closure
  - Multiple terminals per project
- Reconnection system
  - Extension Host restart detection
  - PID-based reconnection
- Complete data flow diagram
- Integration points
- File references

**Best For:**
- Understanding the complete system
- Making architectural changes
- Debugging complex issues
- Understanding tradeoffs
- Full context for major refactors

**Length:** 502 lines (17 KB)

---

## System Overview

### The Color System in Brief

```
ProjectManager (in-memory, ephemeral)
├─ projectColors: Map<path, slot>
├─ projectTerminalCount: Map<path, count>
└─ colorOrder: number[] (maybe shuffled)
    ↓
    assignColor(path) uses gap-filling algorithm
    ↓
SESSION_INDEX

GlobalState (persistent, survives restart)
├─ monet.sessions: Record<slot, SessionMeta>
└─ monet.activeProject: string

Disk (persistent, history)
└─ ~/.monet/status/{sessionId}.json
```

### Key Concepts

**Gap-Filling:** Projects are assigned to slots (0-9) in order of assignment. When a project's last terminal closes, its slot is freed. Next project takes the lowest available slot (gap). This avoids slot fragmentation.

**Ephemeral Colors:** Color assignments are regenerated on startup based on persistent session metadata. Same project → same slot → same color.

**Dual Persistence:** Sessions stored in both globalState (fast, session lifetime) and disk (history, survives Cursor restarts).

---

## File Location Reference

### Source Code (What Implements This)
- `src/types.ts` - Color definitions, interfaces
- `src/projectManager.ts` - Color assignment logic
- `src/sessionManager.ts` - Session tracking
- `src/extension.ts` - Initialization
- `package.json` - Theme colors

### Storage Locations
- `globalState['monet.sessions']` - In-memory + persisted
- `globalState['monet.activeProject']` - Currently active project
- `~/.monet/status/{sessionId}.json` - Session history

---

## Key Questions Answered

### How Many Colors Are Available?
**10 colors** in the palette (waterLily, gardenMint, roseFloral, sunlightGold, skyBlue, deepWater, afternoonWarm, eveningMauve, cloudWhite, sunsetCoral)

### How Many Sessions Can Run Concurrently?
**20 sessions** (slots 1-20)

### What Happens When I Close a Terminal?
Terminal removed, its color slot freed if no other terminals use that project. Next project gets that slot (gap-filling).

### Do Colors Persist Across Cursor Restarts?
**No**, colors are ephemeral. But sessions survive via globalState + disk files. Colors regenerate on startup.

### How Does the System Know Which Session is Which After a Crash?
Via `MONET_SESSION_ID` environment variable set on terminal creation. On restart, terminals are matched to saved session files by ID.

### What If I Have 2 Terminals for the Same Project?
They share the same color slot. Color only freed when BOTH are closed.

### What Is the Priority for "Current Project"?
1. In-progress switch target (synchronously set)
2. globalState['monet.activeProject']
3. First workspace folder
4. null (no project)

### When Are Colors Reset?
On Extension startup, user `monet.reset` command, or workspace reload.

---

## Architecture Decisions

### Why Gap-Filling Instead of Round-Robin?
Gap-filling ensures efficient use of the 10-color palette. With round-robin, if projects 0,1,2 are open then 0,1 close, project 3 would get slot 2 (gap). With round-robin, it might wrap to 0 again, potentially reusing colors prematurely.

### Why Are Colors Ephemeral?
Simplicity. SessionMeta is stored (which includes projectPath + slot). On reconnect, regenerating colors is deterministic and avoids edge cases of persisting color order across updates.

### Why Dual Persistence (globalState + Disk)?
- **globalState:** Fast access during session lifetime, clears on fresh load (prevents stale slots)
- **Disk:** Survives Extension Host restarts, provides history for "Continue" feature

### Why Session Slots Instead of UUIDs?
Current system supports up to 20 concurrent sessions (1-20 slots). For multiple Cursor windows (future), will switch to UUIDs. Slots provide deterministic ordering for UI.

---

## Common Development Tasks

### Adding a New Color
1. Add to PROJECT_COLORS array in `src/types.ts`
2. Add to PROJECT_ICONS array in `src/types.ts`
3. Add to package.json contributes.colors
4. Increment index in all three places in sync

### Changing Color Assignment Algorithm
Edit `ProjectManager.findNextAvailableSlot()` and `assignColor()`

### Debugging Color Assignment
Check:
- `projectManager.projectColors` map
- `projectManager.projectTerminalCount` map
- `globalState['monet.sessions']` values
- `~/.monet/status/*.json` files

### Tracking Sessions Per Project
Filter `sessionManager.getAllSessions()` by projectPath:
```typescript
const projectSessions = sessionManager
  .getAllSessions()
  .filter(s => s.projectPath === targetPath);
```

---

## Testing Checklist

- [ ] Create session for project A → gets color 0
- [ ] Create session for project B → gets color 1
- [ ] Create 2nd session for project A → reuses color 0
- [ ] Close session 1 for project A → count decrements
- [ ] Close session 2 for project A → color slot freed
- [ ] Create session for project C → gets color 0 (gap-filled)
- [ ] Restart Cursor → sessions restore with same colors
- [ ] Run monet.reset → all sessions cleared, colors reset

---

## Related Documentation

- **Parent:** `/Users/ivanforcytebio/Projects/Monet/CLAUDE.md` - Project rules
- **Sibling:** `/Users/ivanforcytebio/.claude/CLAUDE.md` - Global developer rules
- **Build Log:** `/Users/ivanforcytebio/Projects/Monet/BUILD_LOG.md` - Change history

---

## How to Update This Documentation

When making changes to the color system:

1. Update the relevant document(s):
   - CODE changes → update `monet_color_system_analysis.md`
   - API changes → update `QUICK_REFERENCE.md`
   - Conceptual changes → update `COLOR_SYSTEM_SUMMARY.md`

2. Update this INDEX.md with new decisions/questions/tasks

3. Update BUILD_LOG.md in project root

4. Document in code comments (inline)

---

## Questions?

Refer to the comprehensive analysis (`monet_color_system_analysis.md`) for detailed answers, or the quick reference for API signatures and examples.

