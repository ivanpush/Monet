# 2026-02-23: Hooks and Status System

Step 2 of initial development — session creation, colored terminals, and the hook-based status system.

## Goals
- New Session → creates colored terminal, runs `claude`
- Projects get assigned colors (cyan, green, yellow, magenta)
- Slots 1-20 for session tracking
- globalState persistence

---

## Claude Code Hooks Implementation

Replaced the instruction file approach (`.claude/monet-pos-{N}.md`) with Claude Code lifecycle hooks.

**How it works:**
- `SessionStart` hook: Maps Claude's session_id to MONET_POSITION env var, writes to `~/.monet/session-map.json`
- `PostToolUse` hook: Fires after Edit/Write/MultiEdit/Bash → writes status "coding" to `~/.monet/status/pos-{N}.json`
- `Stop` hook: Fires when Claude finishes responding → writes status "idle"

**Scripts in `~/.monet/bin/`:**
- `monet-status` - Updates status (active/idle/waiting), preserves title
- `monet-session-start` - Maps session_id to MONET_POSITION, initializes session map entry
- Uses version hash to detect when scripts need updating

**Files created:**
- `src/hooksInstaller.ts` - Contains Node.js scripts as embedded strings, installs to `~/.monet/bin/` on activation
- `src/hooksManager.ts` - Installs/removes hooks in `.claude/settings.local.json`
  - Uses `__monet__` tag to identify Monet hooks vs user hooks
  - Merges with existing settings, never overwrites user hooks
  - Removes Monet hooks when last session for a project closes

**Files modified:**
- `src/sessionManager.ts` — Added `MONET_POSITION` env var, calls `installHooks()`/`removeHooks()`
- `src/extension.ts` — Calls `installHookScripts()` on activation, made `activate()` async

**Files deleted:**
- `src/claudeInstructions.ts` - Instruction file approach replaced by hooks

**Key design decisions:**
1. Node.js scripts (not bash) - Proper JSON parsing, cross-platform
2. Atomic writes - `writeFileSync` to `.tmp`, then `renameSync` prevents corruption
3. Version hashing - Scripts auto-update when extension updates
4. Silent failures - All errors exit(0), never interrupt Claude Code
5. `__monet__` tagging - Allows hook cleanup without touching user hooks

---

## Simplified Status + LLM-Derived Titles

**Status simplification:**
- Reduced to 3 statuses: `active`, `idle`, `waiting`
- STATUS_EMOJI: 🟢 active, ⚪ idle, 🟡 waiting
- Removed: thinking, coding, testing, error, complete (overcomplicated)

**Hooks updated:**
- `PostToolUse` → status "active" (Claude is working)
- `Stop` → status "idle" (Claude finished)
- `Notification` → status "waiting" (Claude asked a question)
- `UserPromptSubmit` → injects title instruction on first prompt only

**LLM-derived titles:**
- On first user prompt, `monet-inject-title` outputs instruction to stdout
- Instruction tells Claude: "When you finish this task, name this conversation in 3-5 words and run: ~/.monet/bin/monet-title {N} '<your title>'"
- Claude runs the command after completing the task
- `monet-title` script writes title to status file (only if empty)
- Uses `.titled` flag file to prevent re-injection

**Scripts in `~/.monet/bin/`:**
- `monet-status` - Updates status (active/idle/waiting), preserves title
- `monet-inject-title` - Outputs title instruction on first prompt
- `monet-title` - Sets title in status file (one-time only)

**Files modified:**
- `src/hooksManager.ts` - Added Notification and UserPromptSubmit hooks
- `src/hooksInstaller.ts` - Added monet-inject-title and monet-title scripts
- `src/types.ts` - Simplified STATUS_EMOJI to 3 values

---

## Bug Fix - PostToolUse Hook Cleanup

**Problem:**
- Old hooks used `PostToolUse`, new hooks use `PreToolUse`
- Cleanup code only removed hooks from `['UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop']`
- `PostToolUse` was NOT in the cleanup list → stale hooks persisted with old position numbers

**Fix:**
- Added `PostToolUse` to the cleanup list in `src/hooksManager.ts`

---

## Three Bug Fixes for Session/Slot Management

**Bug 1: Orphaned sessions on activation**
- Problem: After reload, loadSessions() loads old sessions from globalState but no terminals exist. These orphaned sessions block slot 1 from being used.
- Fix: Added `clearOrphanedSessions()` called in constructor after `loadSessions()`. Clears all sessions since terminalToSlot is empty on activation.

**Bug 2: resetAllSessions not deleting all files**
- Problem: Only deleted `.json` files, left behind `.needs-title` and `.waiting-title` flags
- Fix: Changed filter from `file.endsWith('.json')` to just `file.startsWith('pos-')`

**Bug 3: Old status files not cleaned before hook install**
- Problem: When a slot is reused, old status files could cause stale data
- Fix: Added `deleteStatusFiles(slot)` helper that deletes `.json`, `.needs-title`, `.waiting-title`. Called before `installHooks()` in both `createSession()` and `continueSession()`.

**Files modified:**
- `src/sessionManager.ts` — Added `clearOrphanedSessions()`, `deleteStatusFiles()`, updated `resetAllSessions()`

---

## Removed Proposed API (onDidWriteTerminalData)

**Problem:**
- Extension failed to activate with: "Cannot read properties of undefined (reading 'onDidWriteTerminalData')"
- `vscode.window.onDidWriteTerminalData` is a proposed API, not available to normal extensions

**Fix:**
- Removed the Ctrl+C detection block that used `onDidWriteTerminalData`
- Removed `terminalDataListener` from `context.subscriptions.push()`
- Ctrl+C detection can be handled via Claude Code's Stop hook instead

**Files modified:**
- `src/extension.ts` - Removed proposed API usage
