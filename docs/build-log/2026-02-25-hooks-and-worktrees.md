# 2026-02-25: Hooks and Worktrees

Hook refinements and the worktree feature (later removed in 02-26 cleanup).

---

## Add PostToolUse Hook for Accurate Status Transitions

**Problem:** After `PreToolUse` set status to "active" (🟢), there was no hook to transition back to "thinking" (🔵).

**Solution:** Added `PostToolUse` hook that sets status back to "thinking".

**Flow now (6 hooks total):**
1. `UserPromptSubmit` → thinking 🔵
2. `PreToolUse` → active 🟢
3. `PostToolUse` → thinking 🔵 *(new)*
4. `Notification` → waiting 🟡
5. `Stop` → idle ⚪
6. `Stop` (2nd) → monet-title-check

**Files modified:** `src/hooksManager.ts`

---

## Disable PreToolUse hook to reduce jitter

**Problem:** Rapid status changes (thinking→active) caused terminal title jitter.

**Solution:** Simplified hook flow:
- `UserPromptSubmit` → `active` (🟢) instead of `thinking`
- `PreToolUse` → **DISABLED** (commented out)
- 3 active states instead of 4: 🟢 active, 🟡 waiting, ⚪ idle

**Files modified:** `src/hooksManager.ts`

---

## Stale Status File Cleanup on Fresh Load

**Problem:** Old status files accumulated in `~/.monet/status/` from dead sessions.

**Solution:**
- On fresh Cursor loads (no terminals have `MONET_SESSION_ID`), run cleanup pass
- `hasMonetTerminals()` checks for `MONET_SESSION_ID` in creationOptions.env
- `cleanupStaleStatusFiles()` deletes files where `processId` exists and process is dead

**Files modified:** `src/sessionManager.ts`, `src/extension.ts`

---

## Fix PID Recycling Bug in Session Reconnection

**Problem:** PIDs get recycled by macOS. Old status files with stale PIDs could match fresh terminals.

**Solution:** Use `MONET_SESSION_ID` env var instead of PID matching. Only terminals with `MONET_SESSION_ID` are considered for reconnection. Match by sessionId directly (exact match).

**Files modified:** `src/sessionManager.ts`

---

## Git Worktree Feature (New Branch Command)

**Purpose:** Allow users to create git worktrees from the Monet menu.

**Implementation:**
1. `src/utils.ts` — Added `execAsync` helper
2. `src/projectManager.ts` — Added `Worktree` interface, `getWorktrees()`, `createWorktree()`
3. `src/extension.ts` — New Branch command with QuickPick for existing worktrees + create new

---

## Re-enable PreToolUse Hook (Fix Yellow→Green Transition)

**Problem:** After user approves a tool request, status stayed yellow. `UserPromptSubmit` only fires once. Clicking "approve" is NOT a prompt submit.

**Solution:** Re-enabled `PreToolUse` hook. Sets status to `active` (🟢) when tool starts executing, including after approval. Jitter is minimal because statusWatcher checks `terminal.name !== newName` before renaming.

**Files modified:** `src/hooksManager.ts`

---

## Simplify New Branch to Use Claude's --worktree Flag

**Problem:** Manual worktree creation via `git worktree add` triggered Extension Host reload. Terminal opened but Claude never launched.

**Solution:** Use Claude's native `--worktree` flag. `claude --worktree {name}` handles everything. No workspace switch needed.

**Changes:**
- `src/sessionManager.ts` — Added `worktreeName?` parameter, runs `claude --worktree {name}`
- `src/extension.ts` — Simplified `monet.newBranch` command
- `src/projectManager.ts` — Removed `Worktree` interface, `getWorktrees()`, `createWorktree()`

**Follow-up:** Added existing worktree picker — reads `.claude/worktrees/` directory, shows quick pick if any exist.
