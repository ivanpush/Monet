# 2026-02-24: UUID Migration

Migration from integer slot-based status files to unique 8-char hex session IDs, plus related /title fixes.

---

## /title Auto-Generation from Conversation Context

**Request:**
- `/title some words` → sets title (already worked)
- `/title` (no args) → should auto-generate title from conversation

**Insight:** When `/title` runs, Claude is already IN the conversation. No need to read transcripts — Claude has full context. Just tell Claude to generate the title itself.

**Solution:**
- Updated `~/.claude/commands/title.md` slash command
- If `$ARGUMENTS` provided → use directly (existing behavior)
- If `$ARGUMENTS` empty → Claude generates 3-5 word title from context, then calls monet-title

---

## UUID Migration - Fix Cross-Project Status Collision (BUG-001)

**Problem:**
- Multiple projects had the same integer slot (e.g., `monet-status 1`) baked into their hooks
- All sessions with slot 1 wrote to the same `pos-1.json` file, causing title/status contamination across projects
- Running `grep -h "monet-status" ~/Projects/*/.claude/settings.local.json` showed 11 projects all with `monet-status 1`

**Solution:**
- Replace integer slot-based status files with unique 8-char hex session IDs
- Each session gets a UUID generated via `crypto.randomUUID().replace(/-/g, '').slice(0, 8)`
- Status files now named `{sessionId}.json` instead of `pos-{slot}.json`
- Hook commands now use sessionId: `monet-status abc12def thinking` instead of `monet-status 1 thinking`

**Key Changes:**

1. `src/types.ts` — Added `sessionId: string` to `SessionMeta`, changed `SessionStatusFile.position` to `.sessionId`
2. `src/sessionManager.ts` — Renamed `terminalToSlot` → `terminalToSession`, generates sessionId, uses `MONET_SESSION_ID` env var
3. `src/hooksManager.ts` — `installHooks(projectPath, sessionId)` now takes sessionId
4. `src/hooksInstaller.ts` — All 3 scripts updated to accept sessionId
5. `src/statusWatcher.ts` — `poll()` matches `([a-f0-9]{8})\.json` pattern
6. `src/extension.ts` — `/title` slash command updated to use `$MONET_SESSION_ID`

**What Did NOT Change:**
- `position` field still exists for slot limiting (1-20)
- `findNextSlot()` logic unchanged
- Color assignment, `projectManager.ts`, terminal creation options unchanged
- `__monet__` tagging, `removeHooks()` logic unchanged

---

## /title Slash Command Variable Fix

**Problem:** `/title` slash command used `$MONET_POSITION` which was no longer set after UUID migration.

**Fix:**
- Updated `~/.claude/commands/title.md` to use `$MONET_SESSION_ID`
- Updated `src/extension.ts` installSlashCommands template to match
- Improved instructions: if no args, Claude generates 3-5 word title from conversation context
