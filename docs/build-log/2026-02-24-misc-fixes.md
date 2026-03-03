# 2026-02-24: Misc Fixes

Collection of bug discoveries, audits, and small fixes from Feb 24.

---

## Full Behavioral Audit + Bug Discovery

Created comprehensive behavioral specification document (`BEHAVIORAL_SPEC.md`). Traced all 14 user interactions through the codebase. Identified 6 bugs with root causes and severity:

1. **BUG-001: Hook Position Collision (P0)** — `hooksManager.ts` removes ALL Monet hooks then adds new ones with only latest position. When 2+ sessions exist in same project, all sessions write to same status file. **This is the title bleed bug.**
2. **BUG-002: Sessions Lost on Reload (P1)** — `sessionManager.ts` wipes all sessions on activation. "Continue" feature can never work across reloads.
3. **BUG-003: Terminal Rename Race Condition (P1)** — `renameWithArg` operates on focused terminal, not specific terminal.
4. **BUG-004: Focus Restore Triggers Project Switch (P2)** — Restoring focus after rename fires `onDidChangeActiveTerminal`.
5. **BUG-005: Orphaned Status Files (P2)** — No cleanup on startup for stale status files.
6. **BUG-006: Color Assignment Instability (P2)** — Same project gets different colors in different windows.

---

## Project Swap Race Condition Bugs

**Symptoms:** Auto-title stops working after project swap, new sessions get same color, `/title` edits wrong session.

**Bugs found:**
- **BUG-007: Race between globalState and workspace updates (P0)** — `setActiveProject()` is async, `updateWorkspaceFolders()` is sync, no synchronization
- **BUG-008: Terminal map staleness (P1)** — `terminalToSlot` Map entries not always cleaned
- **BUG-009: Color Map is ephemeral (P2)** — `projectColors` resets on reload
- **BUG-010: getCurrentProject() unreliable during swap (P0)** — Returns stale data during swap window

**Lessons:** Never do sequential async + sync state updates without synchronization. Project switching must be atomic.

---

## Remove Terminal Liveness Checks

Removed `vscode.window.terminals.includes(terminal)` validation from `getTerminalForSession()`, `getSlotForTerminal()`, `getSessionIdForTerminal()`. These checks were causing unnecessary cleanup — terminal cleanup is already handled by `onDidCloseTerminal` listener.

**Files modified:** `src/sessionManager.ts`

---

## Reconnection Test Scripts

Created automated verification and stress testing for PID-based session reconnection:

1. `scripts/verify-reconnect.py` — Single snapshot verification. Lists all status files, cross-references with running terminal PIDs.
2. `scripts/stress-test-reconnect.py` — Kills extension host N times, checks PIDs survived, validates no sessions lost. Originally bash, rewritten in Python 3 for macOS compatibility.

---

## CLAUDE.md Rewrite

Synced CLAUDE.md with actual current implementation. Key updates:
- Status files: `{sessionId}.json` not `pos-{N}.json`
- Terminal name format: `{emoji} — {title}` not `{emoji} P{N}: {title}`
- Env var: `MONET_SESSION_ID` not `MONET_POSITION`
- Added hooksManager.ts, hooksInstaller.ts to key files

---

## Add TITLE Column to verify-reconnect.py

Added TITLE column to the session status table output. Shows `data.get('title', '')` after STATUS column, truncated to 20 chars.

**Files modified:** `scripts/verify-reconnect.py`

---

## Fix /title Command Not Executing

**Problem:** `/title` sometimes printed the bash command instead of running it. Root cause: Instruction said "Output ONLY the bash command" which Claude interpreted literally.

**Fix:** Changed instruction from "Output ONLY the bash command" to "Run the bash command". Claude now uses Bash tool to execute.

**Files modified:** `~/.claude/commands/title.md`, `src/extension.ts`
