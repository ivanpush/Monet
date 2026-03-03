# 2026-02-25: Color Assignment

Fixes for color assignment, gap-filling, persistence, and project listing.

---

## Fix Color Assignment + Gap-Filling

**Problem:**
- All terminals were getting the same color regardless of project
- Colors were never freed when terminals closed

**Root cause:** `getColorIndex()` was assigning colors but nothing tracked terminal count per project.

**Solution: Terminal count tracking with gap-filling**

**New data structures in ProjectManager:**
- `projectTerminalCount: Map<string, number>` — tracks how many terminals per project
- `colorOrder: number[]` — color indices (may be shuffled based on setting)

**New methods:**
- `assignColor(projectPath)` — increments count, assigns slot if new project, returns color index
- `releaseColor(projectPath)` — decrements count, frees slot when count reaches 0
- `getThemeColorByIndex(index)` — get ThemeColor from index
- `getIconPathByIndex(index)` — get icon URI from index

**Flow:**
1. `createSession()` calls `assignColor()` → increments count, returns color index
2. Terminal created with that color
3. `deleteSession()` calls `releaseColor()` → decrements count
4. If count === 0, color slot is freed for reuse by next project

**Color order setting:**
- Added `monet.colorOrder` setting in package.json: "fixed" | "shuffle"
- Fixed (default): colors assigned in order 0, 1, 2, ...
- Shuffle: Fisher-Yates shuffle on activation

**Gap-filling:**
- `findNextAvailableSlot()` returns lowest unused slot
- When project A closes all terminals, its slot becomes available

**Files modified:**
- `package.json` — Added `monet.colorOrder` and `monet.projectsRoot` settings
- `src/projectManager.ts` — Added count tracking, colorOrder, assignColor/releaseColor
- `src/sessionManager.ts` — Call assignColor in createSession, releaseColor in deleteSession

---

## Remove .git Requirement from Project Listing

**Problem:** `getAvailableProjects()` only returned directories containing `.git`. Only ~6 of many projects showed up.

**Solution:** Removed `.git` requirement. All non-hidden directories in `projectsRoot` now appear. Added `hasGit: boolean` property for future use.

**Files modified:** `src/projectManager.ts`

---

## Random Color Assignment with GlobalState Persistence

**Problem:**
- Previous gap-filling algorithm was deterministic
- Hash-based assignment had collisions
- Colors weren't persisted across project switches or freed when sessions closed

**Solution: Random assignment with session-based persistence**

1. **Random color selection:** New `findRandomAvailableSlot()` picks randomly from unused indices
2. **GlobalState persistence:** `monet.projectColors` key stores `Record<string, number>` (projectPath → colorIndex)
3. **Session-based cleanup:** When `releaseColor()` is called and count hits 0, color freed from both memory and globalState
4. **Removed shuffle logic:** Randomness comes from selection, not shuffled order

**Data flow:**
```
New Project → findRandomAvailableSlot() → assign → persistColors()
Project Switch → loadPersistedColors() already has mapping → use existing
All Sessions Cleared → releaseColor() → persistColors() → color freed
Extension Reload → loadPersistedColors() → restore active project colors
```

**Files modified:**
- `src/projectManager.ts` — Replaced deterministic with random, added persistence
