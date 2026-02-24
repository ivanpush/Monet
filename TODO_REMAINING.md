# Monet — Still To Build

*Updated: 2026-02-24*

## 1. Fix Continue (don't wipe sessions on launch)

**Current bug**: Extension clears orphaned sessions on activation → nothing to continue

**Fix**:
- Keep dead sessions in globalState, mark as `dead: true` instead of deleting
- Continue UI: Show dead sessions in quick pick, sorted by most recent
- Cleanup strategy: Keep last 20 continuable sessions, delete older ones

---

## 2. Switch from Positions to UUIDs

**Why**: Positions (1-20) collide if multiple Cursor windows run simultaneously

**Change**:
- `MONET_POSITION=1` → `MONET_SESSION=<uuid>`
- `~/.monet/status/pos-1.json` → `~/.monet/status/<uuid>.json`
- Remove 20-slot limit (cleanup by age/count instead)

**Impact**: Terminal names already don't show position, so no UX change

---

## 3. Worktrees (when ready)

- Claude Code has native worktree support
- Each worktree = separate directory = separate conversation history
- `claude --continue` in worktree resumes *that* worktree's conversation
- Monet just needs to: create worktree → create session pointing to it

---

## Priority Order

1. Continue fix (most impactful, currently broken)
2. UUIDs (prevents multi-window bugs)
3. Worktrees (nice-to-have)
