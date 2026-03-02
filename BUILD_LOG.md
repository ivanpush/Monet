# Monet Build Log

**Started**: 2026-02-23

---

## 2026-03-02: Warn before interrupting active sessions on color change

### Problem
When a user changes project color and selects "Apply to existing sessions", `refreshSession()` disposes the old terminal immediately. If Claude is mid-response (thinking, active, or waiting for input), the output gets truncated with no warning.

### Fix
Before showing the "Apply to N sessions" QuickPick, read each session's status file via `statusWatcher.getStatus()`. If any sessions are non-idle/non-stopped, change the QuickPick description from the neutral "Migrates conversations..." to "Note: will interrupt N active tasks".

### Changes
- `src/extension.ts` — `monet.changeColor` command: insert busy-count loop before QuickPick, make `description` conditional on `busyCount`

### Safety
- Read-only: `getStatus()` is a single `fs.readFile` + JSON.parse, no writes
- No new control flow after the QuickPick — `refreshSession()`, `markSessionsStale()`, `getAllSessions()` called identically
- No changes to: statusWatcher, sessionManager, hooksManager, hooksInstaller, types, terminal lifecycle, PID tracking, `.csid` forwarding
- try/catch around each `getStatus()` call — read failures treated as idle (no false positives)

---

## 2026-03-02: Fix subprocess hooks stomping parent session state (three-for-one)

### Problem
When the Stop hook fires `monet-title-check`, it spawns `claude -p --model haiku` to generate a title. That subprocess inherits `MONET_SESSION_ID` and runs in the project directory, so it picks up `.claude/settings.local.json` hooks. The subprocess fires the full hook lifecycle (UserPromptSubmit, Stop, SessionEnd) against the **parent** session's status files, causing three distinct bugs:

1. **Terminal flips to `zsh [ex-claude]`** — subprocess `SessionEnd` writes `stopped` to parent status and prints OSC escape to rename terminal
2. **`.csid` corruption → broken `--resume` on color change** — subprocess `UserPromptSubmit` triggers `monet-title-draft`, which writes the subprocess's ephemeral `session_id` (from `--no-session-persistence`) over the parent's `.csid` file. The real conversation UUID is lost. Next color change reads the garbage UUID → `claude --resume <garbage>` → "No conversation found"
3. **Status flickers green then idle** — subprocess `UserPromptSubmit` writes `active`, then `Stop` writes `idle`, stomping the parent's real status

### Root Cause
Architecture bug: subprocess hook side effects leaking into parent session state. All three symptoms are the same class of bug — the `claude -p` subprocess sees project hooks and the parent's `MONET_SESSION_ID`.

### Fix — Three layers of isolation
1. **`cwd: os.homedir()`** on `execSync` — subprocess can't find project `.claude/settings.local.json` (no git root at `$HOME`), so project hooks don't load at all
2. **`delete subEnv.MONET_SESSION_ID`** — even if hooks somehow fire, they can't target any session (env copy only, parent process unaffected)
3. **`[ -z "$MONET_TITLE_CHECK_RUNNING" ]` guard on SessionEnd hook** — defense-in-depth, blocks this exact code path if something regresses

### Changes
- `src/hooksInstaller.ts` — `MONET_TITLE_CHECK_SCRIPT`: create isolated `subEnv` with `MONET_SESSION_ID` deleted, add `cwd: os.homedir()` to `execSync` options
- `src/hooksManager.ts` — SessionEnd hook command: prepend `[ -z "$MONET_TITLE_CHECK_RUNNING" ]` guard, remove debug `touch /tmp/monet-session-end-fired`

### Safety
- `subEnv` is a copy (`Object.assign({}, process.env, ...)`), `delete` only affects subprocess launch payload
- `cwd` change is harmless — `claude -p` only needs stdin/stdout, no project file access
- If title generation fails, behavior unchanged (try/catch exits 0, title stays as draft)
- SessionEnd guard only skips when `MONET_TITLE_CHECK_RUNNING` is set — real session exits don't have this env var
- No changes to: statusWatcher, sessionManager, projectManager, types, terminal lifecycle, other hooks

---

## 2026-03-01: Forward .csid during color change refresh (re-packaged & installed)

### Problem
When `refreshSession` creates a new terminal with `claude --resume UUID`, the `--resume` flag does NOT trigger `UserPromptSubmit` — only the user typing a new prompt does. So `monet-title-draft` never writes a `.csid` for the new session. If the user changes colors again before typing anything, the new session has no `.csid` → `refreshSession` reads `undefined` → starts a bare `claude` instead of resuming → conversation lost.

Chain: A→B reads A's `.csid` (exists) → works. B→C tries to read B's `.csid` → doesn't exist → bare `claude` → conversation lost.

### Fix
In `refreshSession()`, after creating the new session, forward the `claudeSessionId` (already read from the old `.csid`) to a new `.csid` file keyed by the new session's `sessionId`. Covers both branches: title-copy path and no-title path.

### Changes
- `src/sessionManager.ts` — `refreshSession()`: write `claudeSessionId` to `{newSessionId}.csid` via atomic tmp+rename, inside the existing `if (newSession)` blocks (lines 410-427).

### Safety
- Old `.csid` still cleaned up by `deleteStatusFiles` when `oldTerminal.dispose()` fires
- New `.csid` protected from `cleanupUnmatchedStatusFiles` (new session already in `this.sessions`)
- New `.csid` protected from `cleanupStaleStatusFiles` (matching `.json` exists — written by `createSession`)
- If user eventually types, `monet-title-draft` overwrites with same (or updated) UUID — correct either way
- Atomic write pattern consistent with all Monet file writes
- No changes to any other system: hooks, status watcher, project manager, types, terminal lifecycle

---

## 2026-03-01: Fix claudeSessionId race condition — use separate .csid file

### Summary
`claudeSessionId` (needed for `--resume` on color change) was never surviving in the status `.json` file due to a race condition between async hooks. Moved it to a dedicated `.csid` file that `monet-status` never touches.

### Root cause
The `UserPromptSubmit` hook runs an async `;`-chain: `monet-status; monet-title-draft`. `monet-title-draft` captures `session_id` from stdin and writes `claudeSessionId` to the `.json` status file. But Claude fires `PreToolUse` almost immediately (also async), and its `monet-status` reads the `.json` before `monet-title-draft` finishes writing, then overwrites it via `{...existing, status}` — clobbering `claudeSessionId`. Evidence: zero out of eight active status files had `claudeSessionId` captured.

### Fix
Write `session_id` to `{sessionId}.csid` (a separate file) instead of into the shared `.json`. `monet-status` only reads/writes `.json`, so it can never clobber `.csid`. At refresh time, `refreshSession` reads `.csid` for the `--resume` UUID.

### Changes
- `src/hooksInstaller.ts` — `monet-title-draft` script writes `session_id` to `{sessionId}.csid` via atomic tmp+rename. Removed dead `claudeSessionId` injection into `.json`.
- `src/sessionManager.ts` — `refreshSession` reads `.csid` file for Claude UUID. `deleteStatusFiles` deletes both `.json` and `.csid`. `cleanupStaleStatusFiles` and `cleanupUnmatchedStatusFiles` both handle orphaned `.csid` files.
- `src/types.ts` — Removed `claudeSessionId` field from `SessionStatusFile` interface.

### Safety
- `monet-status` is completely untouched — no behavior change for status/title/PID tracking
- `.csid` is written atomically (tmp + rename), same pattern as all other Monet file writes
- Cleanup covers all paths: terminal close, fresh load, post-reconnect, orphaned `.csid` without matching `.json`
- Multiple sessions per project safe — each `.csid` is keyed by Monet sessionId

---

## 2026-03-01: Fix status file cleanup — delete all orphans

### Summary
`cleanupStaleStatusFiles()` only deleted files with a dead `processId`. Files with **no PID at all** (most of the 80+ accumulated files) and junk filenames (`active.json`, `stopped.json`, `test1234.json`) were never cleaned up. Fixed to catch all orphan cases. Also added post-reconnect cleanup so EH restarts don't leave orphans either.

### Root cause
The original guard `if (parsed.processId && !this.isProcessAlive(parsed.processId))` skipped any file where `processId` was falsy (undefined/null). Most old status files from early testing never had a PID written.

### Changes
- `src/sessionManager.ts` — Rewrote `cleanupStaleStatusFiles()` with 3 deletion paths: (1) non-standard filenames, (2) dead PIDs, (3) no PID at all. Added `cleanupUnmatchedStatusFiles()` — runs after the second reconnectSessions() pass, deletes any status file not matched to a tracked session (with PID alive guard for multi-window safety). Updated reconnect setTimeout to chain cleanup after second pass.
- `src/extension.ts` — Updated comment to reflect new behavior (delete, not null)

### Safety
- `process.kill(pid, 0)` is a kernel-level system-wide check — multi-window safe. Window B won't delete Window A's live files.
- `cleanupUnmatchedStatusFiles` runs after the 750ms second reconnect pass — no race with late-connecting terminals
- Fresh load path unchanged: still gated by `hasMonetTerminals()` check
- All deletions use `fs.unlink` with catch — won't crash on missing files

### ~~2026-02-28: Delete stale status files instead of nulling PIDs~~
> Superseded by this entry. The original fix still only targeted files with dead PIDs.

---

## 2026-03-01: Apply color change to existing sessions

### Summary
When changing a project's color via `monet.changeColor`, the user is now asked whether to apply the new color to existing sessions. If yes, each session is migrated to a new terminal with `claude --resume <id>` (preserving the conversation) and the old terminal is disposed. No slash command needed — it's baked into the color change flow.

### How it works
1. `monet-title-draft` captures Claude's internal `session_id` from hook stdin on first prompt, stores as `claudeSessionId` in status file
2. User changes color → if existing sessions, QuickPick asks "Apply to N sessions?" or "New sessions only"
3. If apply: `sessionManager.refreshSession()` loops through each session — reads `claudeSessionId` from status file, creates new terminal with `--resume <uuid>`, copies title, disposes old terminal
4. If skip: marks sessions stale (shows `⟲` like before)

### Changes
- `src/types.ts` — Added `claudeSessionId?: string` to `SessionStatusFile`
- `src/hooksInstaller.ts` — `monet-title-draft` captures `hookData.session_id` from stdin before title guard
- `src/sessionManager.ts` — Added `refreshSession(sessionId)` method (reads status file, creates new session with `--resume`, copies title, disposes old). Added `getSessionByTerminal()`.
- `src/extension.ts` — `monet.changeColor` handler now offers QuickPick to apply to existing sessions. Removed `/refresh` slash command from `installSlashCommands`.
- `src/statusWatcher.ts` — Reverted launch request refresh fields (no longer needed, refresh handled by sessionManager directly)

### Not changed
- `projectManager.ts`, `hooksManager.ts`, `package.json`

### Safety
- `claudeSessionId` captured in `monet-title-draft` (already reads stdin) — monet-status does NOT read stdin, so pipe is intact
- Old terminal only disposed if `createSession` returned a new terminal (guard against failure)
- `createSession` completes (awaited) before dispose → new session in `sessions` map → `deleteSession` won't remove hooks
- Sessions without `claudeSessionId` (never had a prompt) get recreated fresh — no conversation to lose
- Title copied from old status file to new before old terminal disposal

---

## 2026-03-01: Remove 20-session slot limit

### Summary
Removed the artificial 1-20 slot system that capped concurrent sessions. Sessions are now keyed by their 8-char hex `sessionId` (which was already the true unique identifier on disk, in hooks, and in env vars). No session limit.

### Changes
- `src/types.ts` — Removed `position: number` from `SessionMeta` interface
- `src/sessionManager.ts` — Deleted `MAX_SLOTS`, `findNextSlot()`, `getSlotForTerminal()`, `getActiveSlots()`. Changed `sessions` Map from `Map<number, SessionMeta>` to `Map<string, SessionMeta>` keyed by sessionId. Simplified `terminalToSession` from `Map<Terminal, {slot, sessionId}>` to `Map<Terminal, string>`. `deleteSession(slot, sessionId)` → `deleteSession(sessionId)`. Simplified `loadSessions()`, `saveSessions()`, `reconnectSessions()`, and PID save block.
- `src/extension.ts` — Terminal focus handler now uses `getSessionIdForTerminal()` + `sessionId` lookup instead of `getSlotForTerminal()` + `position` lookup. Removed stale FUTURE comment about slots becoming UUIDs.

### Not changed (verified safe)
- `statusWatcher.ts` — uses `getTerminalForSession(sessionId)`, zero slot references
- `projectManager.ts` — has its own color "slots" (0-9), unrelated
- `hooksManager.ts`, `hooksInstaller.ts` — use sessionId only

### GlobalState migration
No migration code needed — `clearGlobalStateSessions()` wipes globalState on fresh loads, and `reconnectSessions()` rebuilds from disk on Extension Host restarts.

---

## 2026-02-28: Change Project Color command

### Summary
Added `monet.changeColor` command (Cmd+Shift+P → "Monet: Change Project Color") that lets users reassign a project's terminal color. Since VS Code has no API to recolor an existing terminal, stale terminals get a `⟲` suffix so users know to close them. New sessions automatically use the new color.

### Changes
- `src/types.ts` — Added `COLOR_DISPLAY_NAMES` map for human-readable color labels in QuickPick
- `src/projectManager.ts` — Added `userOverrideColors` set (persisted to globalState) to prevent user-chosen colors from being freed on last terminal close. New methods: `getColorIndexForProject()`, `getAllColorAssignments()`, `setColor()`. Modified `releaseColor()` to skip user overrides. Modified `clearColors()` to clear overrides.
- `src/sessionManager.ts` — Added `staleSessionIds` set (persisted to globalState) for tracking terminals with outdated colors. New methods: `markSessionsStale()`, `isSessionStale()`. Modified `deleteSession()`, `resetAllSessions()`, `clearGlobalStateSessions()` to clean up stale markers.
- `src/statusWatcher.ts` — In `poll()`, appends ` ⟲` to terminal name if session is stale (4 lines, after the `stopped` branch's `continue`)
- `src/extension.ts` — Registered `monet.changeColor` command with QuickPick UX. Shows available colors, marks current, excludes colors used by other projects.
- `package.json` — Declared `monet.changeColor` in `contributes.commands` and `commandPalette`

### Safety
- `userOverrideColors` prevents user-chosen color from being freed on last terminal close
- `staleSessionIds` persisted to globalState — survives Extension Host restarts
- `stopped` terminals (`zsh [ex-claude]`) never get the ⟲ indicator (handled by `continue` before stale check)
- Colors in use by other projects are excluded from QuickPick (no stealing)
- No-terminal color change works (setColor persists, markSessionsStale no-ops on empty session list)
- Full reset via `monet.reset` clears everything including user overrides + stale markers
- No changes to: hooks, status files on disk, PID tracking, reconnection logic

---

## 2026-02-28: Delete stale status files instead of nulling PIDs

### Summary
`cleanupStaleStatusFiles()` previously nulled the `processId` in orphan status files but kept them on disk "for history." No code ever reads these orphan files — no history UI exists. Changed to delete the file entirely.

### Rationale
Status files serve two purposes while a session is alive: (1) IPC channel for hooks→watcher terminal renaming, (2) PID persistence for Extension Host restart reconnection. Claude's built-in `--resume` handles Claude-side session continuity. Once the process is dead and no terminal exists, the file is dead weight.

### Changes
- `src/sessionManager.ts` — `cleanupStaleStatusFiles()`: `fs.unlink` instead of null-and-rewrite

### Safety
- Only runs on fresh Cursor loads (`hasMonetTerminals()` → false), never during EH restarts
- `isProcessAlive(pid)` check means live sessions across Cursor windows are untouched
- Watcher `poll()` catches ENOENT silently — no crash if file disappears mid-poll
- `disposeStaleTerminals()` runs before this, so PID reads for disposal are unaffected
- Scope identical to before (only files WITH processId where process is dead)

---

## 2026-02-27: Dispose stale Monet terminals on fresh Cursor launch

### Summary
When Cursor fully closes and reopens, old Monet terminals persist visually (VS Code serializes them) but are just empty shells — the original Claude sessions are gone. Added `disposeStaleTerminals()` to clean these up on activation.

### Logic
For each terminal: check if name matches Monet pattern (`{emoji} — ...` or `zsh [ex-claude]`). If yes, check if its PID matches any disk status file. If PID matches → keep it (Extension Host restart, still alive). If not → dispose it (stale zombie). Runs before `hasMonetTerminals()` check, reads disk only, modifies nothing else.

### Changes
- `src/sessionManager.ts` — added `disposeStaleTerminals()` method, imported `STATUS_EMOJI`
- `src/extension.ts` — call `disposeStaleTerminals()` before `hasMonetTerminals()` check, removed temp test command
- `package.json` — removed `monet.testDispose` command entry

### Safety
- Only touches terminals matching Monet's unique name pattern
- PID check prevents killing live terminals during Extension Host restarts
- `onDidCloseTerminal` handler is a no-op for these (not in `terminalToSession` map)
- Read-only on disk — no status files or globalState modified

---

## 2026-02-27: Stop title-generation conversations from polluting history

### Summary
Added `--no-session-persistence` flag to the `claude -p` call in `monet-title-check`. This prevents the Haiku title-generation conversations from being saved to `~/.claude/projects/` and cluttering `claude --resume` history.

### Changes
- `src/hooksInstaller.ts` — added `--no-session-persistence` to the `claude -p --model haiku` command

---

## 2026-02-27: Add session cleanup plan to backlog

### Summary
Added backlog item #7 (terminal state left dirty on Ctrl+C / Cursor shutdown) and full implementation plan at `docs/plans/session-cleanup.md`. Key insight: `renameWithArg` locks VS Code terminal names, making the SessionEnd hook's OSC escape useless. Plan has 6 defense-in-depth changes across 4 files. Desired end state: terminal becomes `zsh [X-CLAUDE]` on exit, not white emoji.

---

## 2026-02-27: Add backlog document

### Summary
Created `docs/BACKLOG.md` with 4 bugs + 2 improvements: workspace switch race condition, broken monet CLI, stuck status emoji, raw draft titles, redundant hook installs, missing test suite.

---

## 2026-02-27: Fix double hook completion messages

### Summary
Merged two-command hook groups into single shell commands so Claude Code logs one "Async hook completed" message per event instead of two.

### Changes
- `src/hooksManager.ts` — `UserPromptSubmit` hook: combined `monet-status` + `monet-title-draft` into one command with `;` separator
- `src/hooksManager.ts` — `Stop` hook: combined `monet-status` + `monet-title-check` into one command with `;` separator, kept 20s timeout for the claude -p call

---

## 2026-02-26: Cleanup + CLI launcher (remove worktrees, add monet CLI, simplify menu)

### Summary
Removed all Monet-managed worktree code (Claude Code handles worktrees natively now). Added `monet` CLI launcher for context-aware session creation from any integrated terminal. Simplified dropdown menu from 4 to 3 items. Added SessionEnd hook for clean terminal resets.

### Changes

**Feature 1: SessionEnd Hook** (`src/hooksManager.ts`)
- Added `SessionEnd` hook that emits OSC escape sequence to rename terminal back to "zsh" when Claude session ends
- Fires inside the terminal process — works even if Cursor/extension is dead

**Feature 2: Simplified Dropdown** (`src/extension.ts`, `package.json`)
- Removed `monet.newBranch` and `monet.continueSession` commands
- Added `monet.newSessionWithFlag` — input box for arbitrary claude flags (--resume, --worktree, etc.)
- Menu now: New Session, New with Flags, Change Project
- MonetTreeProvider updated to match

**Feature 3: Worktree Code Stripped**
- `src/types.ts` — Removed `worktreeName` from `SessionMeta` and `SessionStatusFile`
- `src/sessionManager.ts` — Removed `WORKTREES_DIR`, `getWorktreePath()`, `getDeadSessions()`, `continueSession()`, worktree cwd/naming logic
- `src/branchIndicator.ts` — Simplified to always use `session.projectPath`
- `src/projectManager.ts` — Removed `suppressWorktreeDiscovery()`
- `src/extension.ts` — Removed worktree suppression calls, execFile/promisify imports

**Feature 4: `monet` CLI Launcher**
- `src/hooksInstaller.ts` — New `MONET_LAUNCH_SCRIPT` bash script installed to `~/.monet/bin/monet`. Captures cwd, git root, branch, forwards args. Writes atomic JSON to `~/.monet/launch/`. Guarded by `TERM_PROGRAM=vscode`.
- `src/statusWatcher.ts` — Added launch watcher (`fs.watch` on `~/.monet/launch/`), `processLaunchRequest()` matches gitRoot to known projects, creates session with context. Stale cleanup on startup (>30s old files deleted).
- `src/sessionManager.ts` — Refactored `createSession()` from positional params to `CreateSessionOptions` object: `{ claudeArgs, cwd, projectPath, projectName }`.

### Files Changed
| File | Changes |
|------|---------|
| `src/hooksManager.ts` | SessionEnd hook |
| `src/hooksInstaller.ts` | monet launch script, version hash updated |
| `src/extension.ts` | Strip worktree code, simplify menu, add newSessionWithFlag |
| `src/sessionManager.ts` | Strip worktree code, CreateSessionOptions refactor |
| `src/branchIndicator.ts` | Strip worktree path logic |
| `src/projectManager.ts` | Remove suppressWorktreeDiscovery |
| `src/types.ts` | Remove worktreeName from interfaces |
| `src/statusWatcher.ts` | Launch watcher + processLaunchRequest |
| `package.json` | Remove newBranch/continueSession, add newSessionWithFlag |

---

## 2026-02-26: Two-phase auto-titling for sessions

### Problem
Terminal titles stay as `⚪ — Claude | new session` until the first Stop hook fires and `monet-title-check` generates an LLM title. If Claude runs a long agentic loop without stopping, the user never gets a meaningful title.

### Fix
Two-phase titling with a `titleSource` hierarchy (`draft` < `final` < `manual`):

1. **Draft title on first prompt**: New `monet-title-draft` script runs on `UserPromptSubmit`. Reads stdin JSON, extracts prompt text, smart-truncates to ~40 chars at word boundary, writes with `titleSource: "draft"`. Only fires on the first prompt (exits if title already set).
2. **Final title on Stop**: `monet-title-check` now only overwrites `draft` titles (checks `titleSource` instead of `title.length > 0`). Sets `titleSource: "final"` when writing LLM-generated title.
3. **Manual title locks**: `/title` slash command sets `titleSource: "manual"` — never overwritten by any auto-titling.

### Files Changed
- `src/types.ts` — Added `titleSource?: 'draft' | 'final' | 'manual'` to `SessionStatusFile`
- `src/hooksInstaller.ts` — New `MONET_TITLE_DRAFT_SCRIPT`, updated `monet-title-check` guard and `monet-title` to set `titleSource`, bumped script hash
- `src/hooksManager.ts` — Added `monet-title-draft` as second hook in `UserPromptSubmit` group

---

## 2026-02-26: Fix branch bleed + add Monet branch status bar item

### Problem
When a git worktree is created inside the project directory (`.claude/worktrees/`), VS Code's git extension discovers it and its branch becomes "sticky" in the SCM state. This bleeds across all terminals and projects in the same window.

### Fix
Three-part fix:
1. **Suppress VS Code git discovery**: `suppressWorktreeDiscovery()` in ProjectManager sets `git.autoRepositoryDetection` → `"openEditors"` and `git.detectWorktrees` → `false` scoped to the workspace folder. Called on activate and project switch.
2. **Monet-owned branch indicator**: New `MonetBranchIndicator` class (status bar item) shows `$(git-branch) {branchName}` for the focused Monet terminal. Runs `git -C {path} branch --show-current` using the session's effective path (worktree or project).
3. **Move worktrees out of project**: Worktrees now live at `~/.monet/worktrees/{projectName}/{name}` instead of `{project}/.claude/worktrees/`. Monet creates worktrees itself via `git worktree add` (no more `claude --worktree`).

### Files Changed
- `src/branchIndicator.ts` — **New** — Monet branch status bar item
- `src/extension.ts` — Wire branchIndicator, call `suppressWorktreeDiscovery`, update newBranch command paths
- `src/sessionManager.ts` — Worktree cwd, `getWorktreePath()`, `getSessionForTerminal()`, persist worktreeName in status file, restore on reconnect, remove `--worktree` flag
- `src/projectManager.ts` — `suppressWorktreeDiscovery()` method
- `src/types.ts` — `worktreeName` added to `SessionStatusFile`

---

## 2026-02-26: Merge Stop hooks into single group to eliminate double terminal message

### Problem
The `Stop` event had two separate HookGroups — one for `monet-status idle` and one for `monet-title-check`. Claude Code prints one "async stop hook" message per group, so users saw the hook fire twice in terminal output.

### Fix
Merged both Stop hooks into a single HookGroup with a 2-element `hooks` array. Claude Code runs hooks within a group sequentially, so `monet-status` runs first (~instant), then `monet-title-check` (up to 20s). One group = one terminal message.

### Files Changed
- `src/hooksManager.ts` — merged two `.push()` calls into one, updated comment

---

## 2026-02-26: Fix terminal focus listener swapping workspace during session creation

### Problem
After switching projects and creating a new session, the `claude` command fires into a terminal whose workspace just got swapped back to the previous project. First session works fine; breaks after switching projects.

### Root Cause
The `terminalFocusListener` has a 500ms debounce, but `createSession()` has a large async gap (~600ms+) between `createTerminal()` and `terminal.show()` (saveSessions, getPidWithRetry, writeStatusFile, installHooks). During this window, VS Code may briefly refocus a previous project's terminal, causing the debounce to fire `updateWorkspaceFolders()` back to the old project mid-creation.

### Fix
- Added `_isCreatingSession` guard flag to `SessionManager` (set true at start, false in `finally` block)
- Focus listener checks `sessionManager.isCreatingSession` and returns early during the critical window
- Applied to both `createSession()` and `continueSession()`

### Files Changed
- `src/sessionManager.ts` — `_isCreatingSession` flag + getter, try/finally in `createSession()` and `continueSession()`
- `src/extension.ts` — guard check in `terminalFocusListener`

---

## 2026-02-26: Revert sendTextWhenReady — use direct terminal.sendText()

### Problem
`claude` command stopped being sent into new Monet terminals. The `sendTextWhenReady()` wrapper relied on VS Code's shell integration API (`onDidChangeTerminalShellIntegration`), which doesn't exist in Cursor, causing the command to silently never fire.

### Fix
- Reverted `sendTextWhenReady(terminal, cmd)` back to `terminal.sendText(cmd)` in both `createSession()` and `continueSession()`
- Deleted the entire `sendTextWhenReady()` method (37 lines) — no longer used

### Files Changed
- `src/sessionManager.ts` — two call sites reverted, method deleted

---

## 2026-02-26: Fix project-switch terminal race condition

### Problem
Switching to a different project then creating a session caused garbled command delivery. User saw "Terminal 5" briefly, then the `claude` command sent before the shell was ready (conda/nvm still activating). Worked fine when staying in the same project.

### Root Cause
1. `sendTextWhenReady` used a hardcoded 500ms delay — insufficient when shell needs to activate conda/nvm in a new directory
2. `updateWorkspaceFolders()` is fire-and-forget (returns boolean, not promise) — terminal was created while VS Code was still processing the workspace change

### Fix 1: Smart shell readiness detection in `sendTextWhenReady`
- Tries `terminal.shellIntegration` first (immediate if already ready)
- Listens for `onDidChangeTerminalShellIntegration` event (fires after full shell init including conda)
- Falls back to 3s timeout with listener, 1.5s without (vs old 500ms)

### Fix 2: Wait for workspace folder change before creating terminal
- In `newSession` and `newBranch`, await `onDidChangeWorkspaceFolders` event after `updateWorkspaceFolders()` call
- 1s timeout fallback if event doesn't fire

### Files Changed
- `src/sessionManager.ts` — rewrote `sendTextWhenReady` with shell integration + fallback
- `src/extension.ts` — added workspace change wait in `newSession` and `newBranch`

---

## 2026-02-26: Fix worktree delete + command execution

### Fix 1: Use absolute path for `git worktree remove`
- Was using relative `.claude/worktrees/{name}`, now uses `path.join(worktreesDir, name)` (absolute)

### Fix 2: Add `--force` to `git worktree remove`
- Worktrees with untracked/modified files (which is always the case — `.claude/` etc.) fail without `--force`

### Fix 3: Force-delete unmerged branches
- Changed `git branch -d` to `git branch -D` so worktree branches can actually be deleted

### Fix 4: Fix command not executing in terminal
- `sendTextWhenReady` was using `onDidChangeTerminalShellIntegration` API which is unreliable in Cursor
- Shell integration event sometimes never fires, leaving command text in buffer without Enter
- Reverted to simple 500ms delay (same approach the stable build used before worktree work)

---

## 2026-02-26: Restore PID-based Reconnection + Worktree UX

### Fix 1: Show project name in worktree creation UI
- InputBox prompts now show `Worktree name for {project.name}` instead of generic text
- QuickPick placeholder shows `{project.name} — worktrees`

### Fix 2: Restore PID-based reconnection (broken by `8e6ea38`)
- `reconnectSessions()` — PID matching is primary (survives Extension Host restarts), env-var fallback second
- Matches how it worked in `8a55bbd` before the regression
- `hasMonetTerminals()` — now async, checks both env vars AND terminal PIDs against disk status files
- Prevents false "fresh load" detection that wiped sessions via `clearGlobalStateSessions()`

### Files Changed
- `src/extension.ts` — worktree UI strings, `await hasMonetTerminals()`
- `src/sessionManager.ts` — PID fallback in `reconnectSessions()`, async `hasMonetTerminals()`

---

## 2026-02-26: Fix Worktree Bugs & Double Command Firing

### Fix 1: PTY Race Condition — Double Command Firing
- Added `sendTextWhenReady()` method to `SessionManager` that feature-detects `onDidChangeTerminalShellIntegration` (VS Code 1.93+)
- Modern VS Code: waits for shell integration readiness signal, 1.5s fallback
- Cursor/older: 500ms delay after `terminal.show()`
- Replaced both `terminal.sendText()` call sites in `createSession()` and `continueSession()`

### Fix 2: Worktree Listing Bug — `fs.promises.readdir` → `fs.readdir`
- `fs` was imported from `fs/promises`, so `fs.promises` was `undefined`
- Silent throw in try/catch meant existing worktrees never appeared in picker

### Fix 3: Project Selection for New Branch
- Added project picker fallback (filtered to git repos) when no project is open
- Mirrors the pattern from `newSession` command

### Fix 4: Worktree Delete Option
- Added `$(trash) Delete: {name}` entries to worktree QuickPick
- Uses `execFile` (no shell) to prevent command injection
- Modal confirmation → `git worktree remove` → `git branch -d` (non-fatal) → success message

### Fix 5: Worktree Name in Session Metadata
- Added `worktreeName?: string` to `SessionMeta` in `types.ts`
- Stored in `createSession()` when provided
- Initial terminal name: `⚪ — Claude | {worktreeName}` instead of generic `new session`

### Files Changed
- `src/sessionManager.ts` — `sendTextWhenReady()`, worktree name in metadata + initial name
- `src/extension.ts` — `fs.readdir` fix, project picker, delete worktree action
- `src/types.ts` — `worktreeName` field on `SessionMeta`

---

## Step 1: UI Trigger (Status Bar + Keyboard)

**Status**: COMPLETE ✓

### Final Solution:
- **Status bar icon** (paintcan) in bottom-right - always visible
- **Cmd+Shift+M** keyboard shortcut - opens quick pick menu
- Quick pick shows: New Session, New Branch, Continue, Switch Project

### Journey:
1. Tried `terminal/title` menu → doesn't exist as toolbar contribution
2. Tried `view/title` with terminal when clause → didn't work
3. Tried Activity Bar panel → user didn't like sidebar clutter
4. Tried `editor/title` → only shows when file is open
5. **Final: Status bar + keyboard** → user approved

### Lessons Learned:
1. Terminal toolbar is NOT extensible via VS Code API
2. `editor/title` only shows when a file is open
3. Status bar is always visible and reliable
4. Keyboard-first (Cmd+Shift+M) is cleanest UX for power users
5. Quick pick always appears at top-center (VS Code limitation)

---

## Step 2: Session Creation + Colored Terminals

**Status**: In Progress

### Goals:
- New Session → creates colored terminal, runs `claude`
- Projects get assigned colors (cyan, green, yellow, magenta)
- Slots 1-20 for session tracking
- globalState persistence

### Actions Taken:

#### 2026-02-23: Terminal naming update
- Changed initial terminal name from just `⚪` to `⚪ new session`
- Once Claude writes a title to status file, terminal shows `{emoji} {title}` (e.g., `🟢 Refactoring PaymentProcessor`)
- No position numbers or roman numerals in terminal names
- Files changed: `src/sessionManager.ts` (lines 80, 131)

#### 2026-02-23: Claude Code Hooks Implementation
Replaced the instruction file approach (`.claude/monet-pos-{N}.md`) with Claude Code lifecycle hooks.

**How it works:**
- `SessionStart` hook: Maps Claude's session_id to MONET_POSITION env var, writes to `~/.monet/session-map.json`
- `PostToolUse` hook: Fires after Edit/Write/MultiEdit/Bash → writes status "coding" to `~/.monet/status/pos-{N}.json`
- `Stop` hook: Fires when Claude finishes responding → writes status "idle"

**Files created:**
- `src/hooksInstaller.ts` - Contains Node.js scripts as embedded strings, installs to `~/.monet/bin/` on activation
  - `monet-status` - Reads stdin JSON, looks up session in map, writes status file atomically
  - `monet-session-start` - Maps session_id to MONET_POSITION, initializes session map entry
  - Uses version hash to detect when scripts need updating
- `src/hooksManager.ts` - Installs/removes hooks in `.claude/settings.local.json`
  - Uses `__monet__` tag to identify Monet hooks vs user hooks
  - Merges with existing settings, never overwrites user hooks
  - Removes Monet hooks when last session for a project closes

**Files modified:**
- `src/sessionManager.ts`:
  - Added `MONET_POSITION` env var to terminal creation
  - Calls `installHooks()` when creating session
  - Calls `removeHooks()` when deleting last session for a project
- `src/extension.ts`:
  - Calls `installHookScripts()` on activation
  - Made `activate()` async

**Files deleted:**
- `src/claudeInstructions.ts` - Instruction file approach replaced by hooks

**Key design decisions:**
1. Node.js scripts (not bash) - Proper JSON parsing, cross-platform
2. Atomic writes - `writeFileSync` to `.tmp`, then `renameSync` prevents corruption
3. Version hashing - Scripts auto-update when extension updates
4. Silent failures - All errors exit(0), never interrupt Claude Code
5. `__monet__` tagging - Allows hook cleanup without touching user hooks

#### 2026-02-23: Simplified Status + LLM-Derived Titles

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

#### 2026-02-23: Bug Fix - PostToolUse Hook Cleanup

**Problem:**
- Old hooks used `PostToolUse`, new hooks use `PreToolUse`
- Cleanup code only removed hooks from `['UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop']`
- `PostToolUse` was NOT in the cleanup list → stale hooks persisted with old position numbers
- Result: Multiple positions in hooks (e.g., PostToolUse had position 13, everything else had position 14)

**Fix:**
- Added `PostToolUse` to the cleanup list in `src/hooksManager.ts`
- Cleanup now handles: `['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop']`

**Files modified:**
- `src/hooksManager.ts` (line 63) - Added PostToolUse to cleanup array

#### 2026-02-23: Three Bug Fixes for Session/Slot Management

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
- `src/sessionManager.ts`:
  - Added `clearOrphanedSessions()` method (lines 38-44)
  - Added `deleteStatusFiles(slot)` helper method (lines 212-226)
  - Updated `resetAllSessions()` to delete all pos-* files (line 250)
  - Call `deleteStatusFiles()` before `installHooks()` in createSession/continueSession

#### 2026-02-23: Removed Proposed API (onDidWriteTerminalData)

**Problem:**
- Extension failed to activate with: "Cannot read properties of undefined (reading 'onDidWriteTerminalData')"
- `vscode.window.onDidWriteTerminalData` is a proposed API, not available to normal extensions
- This crashed the extension before anything else could run

**Fix:**
- Removed the Ctrl+C detection block (lines 130-140) that used `onDidWriteTerminalData`
- Removed `terminalDataListener` from `context.subscriptions.push()`
- Ctrl+C detection can be handled via Claude Code's Stop hook instead

**Files modified:**
- `src/extension.ts` - Removed proposed API usage

#### 2026-02-23: Title System Overhaul - Replace sendText with claude -p

**Problem:**
- Old title system used `terminal.sendText()` to inject "Name this task in 3-5 words" directly into user's Claude session
- This was visible and janky - user saw the prompt appear in their conversation
- Required two-step flag file dance (`.needs-title` → statusWatcher sends prompt → `.waiting-title` → next Stop hook reads transcript)

**New solution:**
- `monet-title-check` script now uses `claude -p` to generate titles invisibly
- On Stop hook: reads transcript_path from stdin JSON, extracts first user message + first assistant response
- Calls: `claude -p --model haiku --tools "" --max-turns 1 "Name this coding task..."`
- Haiku generates title in ~1-2 seconds using user's existing Claude Code auth
- Title is validated (<60 chars, truncate if >8 words), stripped of quotes/punctuation
- Written atomically to status file

**Key changes:**
1. `src/hooksInstaller.ts` - Complete rewrite of MONET_TITLE_CHECK_SCRIPT:
   - Removed readline import (no longer reading line-by-line)
   - Reads stdin for hook JSON with transcript_path
   - Parses JSONL transcript, finds first user and assistant messages
   - Truncates context (200 chars user, 500 chars assistant)
   - Finds claude binary (~/.claude/local/claude or PATH)
   - Calls claude -p with haiku model
   - Validates and writes title

2. `src/statusWatcher.ts` - Removed flag-based title system:
   - Deleted `handleNeedsTitleFlag()` method entirely
   - Removed `.needs-title` flag scanning from poll() loop
   - Poll now only handles `pos-{N}.json` files

3. `src/hooksManager.ts` - Increased title-check timeout:
   - Changed from `timeout: 10` to `timeout: 20`
   - Haiku call can take a few seconds to respond
   - Hook still has `async: true` so doesn't block Claude Code

**Files modified:**
- `src/hooksInstaller.ts` - New MONET_TITLE_CHECK_SCRIPT using claude -p
- `src/statusWatcher.ts` - Removed handleNeedsTitleFlag and flag scanning
- `src/hooksManager.ts` - Timeout 10→20 for monet-title-check

**No changes needed:**
- `src/sessionManager.ts` - resetAllSessions already cleans all `pos-*` files (covers old flag files)

#### 2026-02-23: Title UX Improvements - Keep Default Title Visible

**Problem:**
- When Claude starts, status file is created with empty title
- StatusWatcher renamed terminal to just emoji (e.g., `🔵`) with no text
- Default "new session" disappeared until Haiku generated a title

**Fix:**
- Changed default title format to `Claude | new session`
- StatusWatcher now shows `{emoji} Claude | new session` when title is empty instead of just emoji
- Title stays visible throughout the session until replaced by Haiku-generated title

**Files modified:**
- `src/sessionManager.ts` (lines 92, 146) - Initial terminal name: `⚪ Claude | new session`
- `src/statusWatcher.ts` (line 119) - Fallback when title empty: `${emoji} Claude | new session`

#### 2026-02-23: Title Check Script Fixes - Stdin Reading + Recursion Guard

**Problem:**
- Complex stdin reading with fd/Buffer failed in some cases
- `claude -p` call could recursively trigger hooks → infinite loop

**Fixes synced from working `~/.monet/bin/monet-title-check`:**
1. Simplified stdin reading: `fs.readFileSync(0, 'utf8')` instead of fd/Buffer loop
2. Added recursion guard: `if (process.env.MONET_TITLE_CHECK_RUNNING === '1') process.exit(0)`
3. Pass env var to execSync: `env: { ...process.env, MONET_TITLE_CHECK_RUNNING: '1' }`
4. Removed `--tools ""` from claude command (not needed)

**Files modified:**
- `src/hooksInstaller.ts` - Updated MONET_TITLE_CHECK_SCRIPT with both fixes

#### 2026-02-23: Terminal UX - Brackets + Monet Palette

**Problem:**
- Two emojis back-to-back (sparkle icon + status emoji) looked cluttered
- Terminal colors were too dark/saturated

**Fixes:**
1. Added pipes around status emoji for visual separation:
   - Before: `🌀 🔵 Title`
   - After: `🌀 |🔵| Title`

2. Monet-inspired pastel palette using "bright" ANSI variants:
   - Light blue, pink, mint, warm yellow, sky blue...
   - Reordered icons to match

**Files modified:**
- `src/sessionManager.ts` (lines 92, 146) - Pipes: `|⚪| Claude | new session`
- `src/statusWatcher.ts` (line 119) - Format: `|${emoji}| ${title}`
- `src/types.ts` - New PROJECT_COLORS and PROJECT_ICONS order

#### 2026-02-23: Terminal Format + Color Assignment Fix

**Problem 1: Emoji format change**
- User wanted em-dash (—) between emoji and title, not pipes around emoji
- Before: `|🟢| Fixing the bug`
- After: `🟢 — Fixing the bug`

**Problem 2: Color assignment started at index 7 (coral)**
- `nextColorIndex` was calculated from highest stored value + 1
- Old project color assignments persisted in globalState even after sessions cleared
- Result: new projects got mid-palette colors instead of starting from cyan (index 0)

**Fixes:**
1. Changed terminal name format:
   - Initial: `⚪ — Claude | new session`
   - With title: `🟢 — Fixing the bug`

2. Color assignment now finds **lowest unused index**:
   - New `findNextAvailableColorIndex()` method iterates 0-9, returns first unused
   - First project always gets 0 (cyan), unless that's already assigned
   - Removed `nextColorIndex` tracking variable

3. `monet.reset` now clears `monet.projectColors` too:
   - Added `clearColors()` method to ProjectManager
   - `resetAllSessions()` calls `projectManager.clearColors()`
   - Full reset brings everything back to fresh slate

**Files modified:**
- `src/sessionManager.ts` (lines 92, 146) - Em-dash format: `⚪ — Claude | new session`
- `src/statusWatcher.ts` (line 119) - Format: `${emoji} — ${title}`
- `src/projectManager.ts`:
  - Removed `nextColorIndex` field
  - Added `findNextAvailableColorIndex()` method (lines 20-26)
  - Added `clearColors()` method (lines 34-38)
  - Updated `getColorIndex()` to use new method (line 43)
- `src/sessionManager.ts` (line 263) - Call `projectManager.clearColors()` in reset

#### 2026-02-23: Non-Persistent Colors + Monet Palette Reorder

**Problem:**
- Color assignments persisted in globalState → project kept getting coral (index 7) even after code changes
- Claude's coral/orange was appearing as first color instead of Monet pastels
- User had to manually run "Reset All Sessions" to get new color order

**Fixes:**

1. **Made colors ephemeral (non-persistent):**
   - Removed `loadColors()` and `saveColors()` from ProjectManager
   - Colors now start fresh each reload
   - First project always gets water lily blue (index 0)

2. **Reordered colors to lead with Monet palette:**
   - 0: Water lily blue (`ansiBrightCyan`)
   - 1: Mint green (`ansiBrightGreen`)
   - 2: Pink florals (`ansiBrightMagenta`)
   - 3: Pale gold (`ansiBrightYellow`)
   - 4: Sky blue (`ansiBrightBlue`)
   - ...
   - 9: Coral (`ansiRed`) - last resort

3. **Reordered icons to match:**
   - cyan → mint → rose → yellow → sky → green → peach → magenta → lavender → coral

**Files modified:**
- `src/types.ts` - Reordered PROJECT_COLORS and PROJECT_ICONS arrays
- `src/projectManager.ts` - Removed globalState persistence, simplified to in-memory Map
- `src/sessionManager.ts` (line 263) - `clearColors()` no longer async


#### 2026-02-23: Custom Semi-Transparent Monet Colors

**Request:**
- ANSI colors were too "clashy" with dark themes
- User wanted lighter, more transparent colors

**Solution:**

1. **Defined custom color contributions in package.json:**
   - Added `contributes.colors` with 10 custom Monet colors
   - Each color has 50% opacity (alpha = `80` in hex)
   - Provides both dark and light theme variants

2. **Custom color palette (all at 50% opacity):**
   | ID | Dark Theme | Description |
   |----|------------|-------------|
   | monet.waterLily | #7DD3D380 | Soft cyan - water lily reflections |
   | monet.gardenMint | #90EE9080 | Soft green - garden foliage |
   | monet.roseFloral | #DDA0DD80 | Soft pink - impressionist florals |
   | monet.sunlightGold | #F0E68C80 | Soft gold - sunlight on haystacks |
   | monet.skyBlue | #87CEEB80 | Soft blue - Monet skies |
   | monet.deepWater | #5F9EA080 | Muted teal - deeper water |
   | monet.afternoonWarm | #DEB88780 | Soft tan - afternoon warmth |
   | monet.eveningMauve | #BA55D380 | Soft purple - evening tones |
   | monet.cloudWhite | #D8BFD880 | Soft lavender - clouds |
   | monet.sunsetCoral | #F0808080 | Soft coral - sunset glow |

3. **Benefits:**
   - Colors blend better with any theme (semi-transparent)
   - Custom values give exact control over hue/saturation
   - Light theme has slightly darker variants for contrast

**Files modified:**
- `package.json` - Added `contributes.colors` with 10 custom colors
- `src/types.ts` - Changed PROJECT_COLORS from ANSI refs to custom color IDs

#### 2026-02-23: Terminal Name Format Update

**Change:**
- Updated initial terminal name format to use bullet separator before status emoji
- Format: `• ⚪ — Claude | new session`
- Structure: `[bullet] [status emoji] [em-dash] [title]`

**Files modified:**
- `src/sessionManager.ts` (lines 92, 146) - Changed format in createSession and continueSession
- `src/statusWatcher.ts` (line 119) - Changed format in poll() for terminal renaming

#### 2026-02-23: Lighter Solid Colors (No Alpha)

**Change:**
- Replaced alpha-transparent colors with lighter solid pastel colors
- Alpha channels weren't reliably rendered by Cursor/VS Code terminal tabs

**Before (with alpha):** `#7DD3D380` (50% opacity)
**After (solid pastel):** `#A8E6E6` (lighter solid)

**Updated palette:**
| ID | Dark Theme | Light Theme |
|----|------------|-------------|
| monet.waterLily | #A8E6E6 | #7CBFBF |
| monet.gardenMint | #B8F4B8 | #8FCF8F |
| monet.roseFloral | #E8C8E8 | #C8A0C8 |
| monet.sunlightGold | #F5F0C0 | #D5D0A0 |
| monet.skyBlue | #B8E0F0 | #90C0D0 |
| monet.deepWater | #9FCFCF | #7FAFAF |
| monet.afternoonWarm | #E8D8C0 | #C8B8A0 |
| monet.eveningMauve | #D8A0E8 | #B880C8 |
| monet.cloudWhite | #E8D8E8 | #C8B8C8 |
| monet.sunsetCoral | #F0B0B0 | #D09090 |

**Files modified:**
- `package.json` - Updated all 10 color definitions

#### 2026-02-23: Even Lighter Colors + Terminal Format Cleanup

**Changes:**

1. **Made colors even lighter** - pushed toward near-white pastels:
   | ID | Old Dark | New Dark |
   |----|----------|----------|
   | monet.waterLily | #A8E6E6 | #D4F4F4 |
   | monet.gardenMint | #B8F4B8 | #D8FAD8 |
   | monet.roseFloral | #E8C8E8 | #F4E0F4 |
   | monet.sunlightGold | #F5F0C0 | #FAF8E0 |
   | monet.skyBlue | #B8E0F0 | #D8F0FA |
   | monet.deepWater | #9FCFCF | #C8E8E8 |
   | monet.afternoonWarm | #E8D8C0 | #F4ECD8 |
   | monet.eveningMauve | #D8A0E8 | #E8C8F4 |
   | monet.cloudWhite | #E8D8E8 | #F0E8F0 |
   | monet.sunsetCoral | #F0B0B0 | #F8D0D0 |

2. **Removed bullet from terminal name:**
   - Before: `• ⚪ — Claude | new session`
   - After: `⚪ — Claude | new session`

3. **Terminal format now:** `{emoji} — {title}` (spaces around em-dash preserved)

**Files modified:**
- `package.json` - Lighter color values
- `src/sessionManager.ts` (lines 92, 146) - Removed bullet
- `src/statusWatcher.ts` (line 119) - Removed bullet

#### 2026-02-23: /title Slash Command for Manual Title Changes

**Request:**
- User wanted a Claude Code slash command to manually change the terminal title
- Should only update the title text, not the status emoji

**Implementation:**

1. **New command: `monet.installSlashCommands`**
   - Added to `package.json` commands and commandPalette
   - User runs from Command Palette: "Monet: Install Slash Commands"
   - Writes slash command files to `~/.claude/commands/`

2. **New script: `~/.monet/bin/monet-title`**
   - Usage: `monet-title <position> <title>`
   - Updates ONLY the title field in status file, preserves status
   - Added to `src/hooksInstaller.ts` as embedded script

3. **Slash command: `/title`**
   - Installed to `~/.claude/commands/title.md`
   - Tells Claude to run: `~/.monet/bin/monet-title $MONET_POSITION $ARGUMENTS`
   - Uses `MONET_POSITION` env var set by Monet when creating terminals

4. **MONET_POSITION env var**
   - Now set on terminal creation in `sessionManager.ts`
   - Allows slash commands to know which status file to update
   - Was already used by hooks (baked into commands), now also available in shell

**Files modified:**
- `package.json` - Added `monet.installSlashCommands` command
- `src/extension.ts` - Added `installSlashCommandsCmd` handler, imports for fs/path/os
- `src/sessionManager.ts` - Added `env: { MONET_POSITION: slot.toString() }` to terminal creation
- `src/hooksInstaller.ts` - Added `MONET_TITLE_SCRIPT`, updated hash and install logic

#### 2026-02-24: /title Auto-Generation from Conversation Context

**Request:**
- `/title some words` → sets title (already worked)
- `/title` (no args) → should auto-generate title from conversation

**Insight:**
- When `/title` runs, Claude is already IN the conversation
- No need to read transcripts - Claude has full context
- Just tell Claude to generate the title itself

**Solution:**
- Updated `~/.claude/commands/title.md` slash command
- If `$ARGUMENTS` provided → use directly (existing behavior)
- If `$ARGUMENTS` empty → Claude generates 3-5 word title from context, then calls monet-title

**Files modified:**
- `~/.claude/commands/title.md` - Added conditional for empty arguments

#### 2026-02-24: Full Behavioral Audit + Bug Discovery

**Action:**
- Created comprehensive behavioral specification document
- Traced all 14 user interactions through the codebase
- Identified 6 bugs with root causes and severity

**Output:**
- `BEHAVIORAL_SPEC.md` - Full architecture overview, data flow, interaction traces, bug registry

**Critical Bugs Found:**

1. **BUG-001: Hook Position Collision (P0)**
   - Root cause: `hooksManager.ts:63-69` removes ALL Monet hooks then adds new ones with only latest position
   - When 2+ sessions exist in same project, all sessions write to same status file
   - **This is the title bleed bug** - explains why titles appear in wrong sessions

2. **BUG-002: Sessions Lost on Reload (P1)**
   - Root cause: `sessionManager.ts:39-44` wipes all sessions on activation
   - "Continue" feature can never work across reloads

3. **BUG-003: Terminal Rename Race Condition (P1)**
   - Root cause: `renameWithArg` operates on focused terminal, not specific terminal
   - If two renames queued, focus can be corrupted → wrong terminal renamed

4. **BUG-004: Focus Restore Triggers Project Switch (P2)**
   - Root cause: Restoring focus after rename fires `onDidChangeActiveTerminal`
   - Can cause unexpected explorer flickering

5. **BUG-005: Orphaned Status Files (P2)**
   - No cleanup on startup for stale status files

6. **BUG-006: Color Assignment Instability (P2)**
   - Same project gets different colors in different windows

**Evidence Found:**
- `Monet/.claude/settings.local.json` has hooks pointing to position 3
- But status files exist for positions 1, 2, 3 - confirms hook collision bug

**Files created:**
- `BEHAVIORAL_SPEC.md`

#### 2026-02-24: Project Swap Race Condition Bugs

**Symptoms reported:**
1. Auto-title stops working after project swap
2. New sessions for new projects get the same color as previous project
3. `/title` command sometimes edits the wrong session's title

**Root cause analysis:**

**BUG-007: Race between globalState and workspace updates (P0 - CRITICAL)**
- Location: `extension.ts` L85-87, L151-155, L229-233
- `setActiveProject()` is async (writes to globalState)
- `updateWorkspaceFolders()` is sync (executes immediately)
- No synchronization between them → they can diverge
- Timeline:
  ```
  Time 0: setActiveProject('ProjectB') ← async, starts write
  Time 1: updateWorkspaceFolders(ProjectB) ← sync, executes immediately
  Time 2: createSession() calls getCurrentProject()
          → globalState.get() might still return 'ProjectA'!
  ```
- **Impact**: Session created with wrong project → wrong color, wrong hooks path, wrong cwd

**BUG-008: Terminal map staleness (P1)**
- Location: `sessionManager.ts` L204-209
- `terminalToSlot` Map entries not always cleaned on manual terminal close
- `getTerminalForSlot()` can return undefined or wrong terminal
- If slot reassigned during race, status updates rename wrong terminal
- **Impact**: `/title` command can edit wrong session's title

**BUG-009: Color Map is ephemeral (P2)**
- Location: `projectManager.ts` L9-43
- `projectColors` Map is in-memory only, not persisted
- Resets on extension reload
- During project swap race, `getColorIndex()` called with wrong project path
- Both sessions map to same project → same color index
- **Impact**: New project sessions get wrong colors

**BUG-010: getCurrentProject() unreliable during swap (P0 - CRITICAL)**
- Location: `projectManager.ts` L119-150
- Depends on globalState being in sync with workspace
- Uses `fs.existsSync()` (sync) in async context
- Returns stale data during swap window
- **Impact**: Everything downstream uses wrong project context

**Lessons learned:**
1. Never do sequential async + sync state updates without synchronization
2. Project switching must be atomic - block all operations during the swap window
3. Terminal map lookups need validation that terminal is still alive
4. Race conditions cascade: one wrong value corrupts everything downstream
5. `updateWorkspaceFolders()` is fire-and-forget - no guarantee it completes before next operation

**Planned fixes:**
1. Add `projectSwitchLock` mutex to make project switching atomic
2. Ensure `setActiveProject()` completes BEFORE `updateWorkspaceFolders()`
3. Block `createSession()` and `getCurrentProject()` during switch window
4. Add validation in `getTerminalForSlot()` to check terminal is still alive
5. Clean up `terminalToSlot` entries for dead terminals before slot lookup

#### 2026-02-24: UUID Migration - Fix Cross-Project Status Collision (BUG-001)

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

1. `src/types.ts`:
   - Added `sessionId: string` to `SessionMeta` (unique per session, never changes)
   - Changed `SessionStatusFile.position` to `SessionStatusFile.sessionId`
   - Kept `position` field in `SessionMeta` for slot limiting (1-20) and display

2. `src/sessionManager.ts`:
   - Added `import * as crypto from 'crypto'`
   - Renamed `terminalToSlot` → `terminalToSession: Map<Terminal, {slot, sessionId}>`
   - `createSession()`: Generates sessionId, uses `MONET_SESSION_ID` env var
   - `continueSession()`: Uses existing sessionId or generates new one
   - Added `getTerminalForSession(sessionId)` method
   - `resetAllSessions()`: Deletes `*.json` (not just `pos-*.json`)

3. `src/hooksManager.ts`:
   - `installHooks(projectPath, sessionId)` - now takes sessionId string
   - Hook commands use sessionId: `~/.monet/bin/monet-status ${sessionId} thinking __monet__`

4. `src/hooksInstaller.ts`:
   - All 3 scripts updated to accept sessionId string instead of parseInt position
   - Status file path: `${sessionId}.json` instead of `pos-${position}.json`
   - Validation: `if (!sessionId || sessionId.length < 6)` instead of `isNaN(position)`

5. `src/statusWatcher.ts`:
   - `poll()`: Matches `([a-f0-9]{8})\.json` pattern instead of `pos-(\d+)\.json`
   - Calls `getTerminalForSession(sessionId)` instead of `getTerminalForSlot(slot)`
   - `getStatus()` and `writeIdleStatus()` updated to use sessionId

6. `src/extension.ts`:
   - `/title` slash command updated to use `$MONET_SESSION_ID` instead of `$MONET_POSITION`

**Pre-flight Cleanup:**
- Removed all `__monet__` hooks from 11 projects' `.claude/settings.local.json`
- Deleted all `pos-*.json` files from `~/.monet/status/`
- Deleted `~/.monet/bin/.version` to force script reinstall

**What Did NOT Change:**
- `position` field still exists for slot limiting (1-20) and display ordering
- `findNextSlot()` logic unchanged
- Color assignment by project path unchanged
- `projectManager.ts` unchanged
- Terminal creation options (color, iconPath, cwd) unchanged
- `__monet__` tag for hook identification unchanged
- `removeHooks()` logic unchanged

**Verification:**
1. `npm run compile` - zero errors ✓
2. After reload, `cat ~/Projects/*/.claude/settings.local.json | grep monet-status` should show 8-char hex IDs
3. `ls ~/.monet/status/` should show UUID-named files
4. Sessions in different projects no longer share status files

#### 2026-02-24: /title Slash Command Variable Fix

**Problem:**
- `/title` slash command used `$MONET_POSITION` which was no longer set after UUID migration
- Should use `$MONET_SESSION_ID` which is set on terminal creation

**Fix:**
- Updated `~/.claude/commands/title.md` to use `$MONET_SESSION_ID`
- Updated `src/extension.ts:167-180` installSlashCommands template to match
- Improved instructions: if no args, Claude generates 3-5 word title from conversation context

**Files modified:**
- `~/.claude/commands/title.md` - `$MONET_POSITION` → `$MONET_SESSION_ID`
- `src/extension.ts` - Updated slash command template

#### 2026-02-24: Remove Terminal Liveness Checks

**Change:**
- Removed `vscode.window.terminals.includes(terminal)` validation from three methods
- These checks were causing unnecessary cleanup of map entries
- Terminal cleanup is already handled by `onDidCloseTerminal` listener

**Methods simplified:**
1. `getTerminalForSession(sessionId)` - just returns terminal from map
2. `getSlotForTerminal(terminal)` - just returns `info.slot`
3. `getSessionIdForTerminal(terminal)` - just returns `info.sessionId`

**Files modified:**
- `src/sessionManager.ts` - Removed liveness checks and cleanup blocks from all three methods

#### 2026-02-24: Belt and Suspenders - Anchor Folder + PID Reconnection

**Problem:**
- Extension Host restarts when switching projects (VS Code limitation with workspace folder changes)
- All terminal-to-session mappings lost after restart
- User had to manually reconnect sessions

**Solution: Two-pronged approach**

**Part 1: Anchor Folder (Prevention)**
- Keep `~/.monet` as workspace folder index 0 at all times
- Project folders swap at index 1 only
- Prevents Extension Host restart because folder 0 never changes
- VS Code only restarts Extension Host when ALL folders change

**Part 2: PID Reconnection (Recovery)**
- Store terminal PID in `SessionMeta.processId` field
- On activation, match live terminal PIDs to stored sessions
- Reconnect sessions even after Extension Host restart
- Double-tap: `reconnectSessions()` called immediately + after 750ms delay

**Key Changes:**

1. `src/types.ts`:
   - Added `processId?: number` to `SessionMeta` interface

2. `src/extension.ts`:
   - Added `ANCHOR_FOLDER = path.join(os.homedir(), '.monet')`
   - Added `ensureAnchorFolder()` function - ensures ~/.monet is folder 0
   - Added `swapProjectFolder()` function - swaps project at index 1 only
   - `activate()` calls `ensureAnchorFolder()` first thing
   - All 3 project switching locations updated to use `swapProjectFolder()`:
     - `newSession` command (line 143)
     - `switchProject` command (line 210)
     - Terminal focus listener (line 290)

3. `src/sessionManager.ts`:
   - Added `getPidWithRetry()` helper - retries up to 3x with 200ms delay
   - Added `reconnectSessions()` method - idempotent PID-based session recovery
   - Removed `clearOrphanedSessions()` - replaced with reconnection
   - Constructor now calls `reconnectSessions()` immediately + after 750ms
   - `createSession()` saves PID after terminal creation
   - `continueSession()` saves PID after terminal creation

**Reconnection algorithm:**
1. Get all stored sessions from globalState
2. For each live terminal, get its PID
3. Find matching session by stored `processId`
4. If found and slot not occupied by different session, restore mapping
5. Clear `processId` for sessions with no matching live terminal (non-destructive)

**Benefits:**
- Project switching no longer triggers Extension Host restart
- Sessions survive any unexpected restart via PID matching
- Non-destructive: keeps session data, only clears stale PIDs
- Idempotent: safe to call multiple times

#### 2026-02-24: Remove ensureAnchorFolder — User Manages Anchor

**Change:**
- User now manually pins `~/.monet-anchor` as workspace folder index 0
- Extension code must never add, remove, or modify index 0

**Removed:**
- `ensureAnchorFolder()` function entirely
- `ANCHOR_FOLDER` constant
- Call to `ensureAnchorFolder()` in `activate()`

**Updated:**
- `swapProjectFolder()` now assumes anchor is user-managed at index 0
- If no workspace folders exist (shouldn't happen), logs warning and returns
- Only operates on index 1+, never touches index 0

**Files modified:**
- `src/extension.ts` — Removed function, constant, and call; simplified swapProjectFolder

#### 2026-02-24: Remove Anchor Folder + Add Output Channel Logging

**Changes:**

1. **Removed anchor folder code:**
   - Deleted `swapProjectFolder()` function entirely
   - Reverted to simple `updateWorkspaceFolders(0, length, {uri})` approach
   - No more index 1+ management — just replace all folders with the new project

2. **Added VS Code Output Channel for logging:**
   - Created `const outputChannel = vscode.window.createOutputChannel('Monet')` at top of `activate()`
   - Pass `outputChannel` into `SessionManager` constructor
   - All `console.log/warn/error` calls replaced with `outputChannel.appendLine()`
   - Logs now visible in VS Code's "Output" panel under "Monet" channel

3. **PID reconnection code UNCHANGED:**
   - `getPidWithRetry()`, `reconnectSessions()`, double-call in constructor all preserved
   - `processId` field on `SessionMeta` preserved

**Files modified:**
- `src/extension.ts` — Removed swapProjectFolder, added outputChannel, updated all log calls
- `src/sessionManager.ts` — Added outputChannel constructor param, updated all log calls

#### 2026-02-24: Name+Path Fallback for Session Reconnection

**Problem:**
- PID matching can fail if VS Code assigns new PIDs after restart
- Sessions would be orphaned even though terminal names match

**Solution:**
- Added fallback matching in `reconnectSessions()` when PID match fails
- Fallback matches by `terminal.name === meta.terminalName && meta.projectPath !== undefined`
- If matched via fallback and terminal has PID, update stored `session.processId`

**Algorithm now:**
1. Try PID match first (exact)
2. If no PID match, try name+projectPath fallback
3. If matched via fallback, update stored PID for future reconnections
4. Log which method was used

**Files modified:**
- `src/sessionManager.ts` — Added name+path fallback in `reconnectSessions()`

#### 2026-02-24: Disk-Persisted PID for Reconnection (Extension Host Restart Fix)

**Problem:**
- `reconnectSessions()` tried to match terminal PIDs against `meta.processId` from VS Code workspaceState
- BUT workspaceState is wiped on every Extension Host restart
- PID matching never worked after restart because stored PIDs were gone

**Solution:**
- Persist `processId`, `terminalName`, and `projectPath` to disk in status files (`~/.monet/status/{sessionId}.json`)
- `reconnectSessions()` now reads session data from disk files instead of globalState
- Disk files survive Extension Host restarts

**Key Changes:**

1. `src/types.ts`:
   - Added `processId?: number` to `SessionStatusFile` interface
   - Added `terminalName?: string` to `SessionStatusFile` interface
   - Added `projectPath?: string` to `SessionStatusFile` interface

2. `src/sessionManager.ts`:
   - Rewrote `writeStatusFile()` method:
     - Now takes `sessionId, project, projectPath, terminalName, processId?`
     - Reads existing file first to preserve status/title from hooks
     - Writes atomically via `.tmp` + rename
   - Updated `createSession()` and `continueSession()`:
     - Call `writeStatusFile()` after getting PID to persist to disk
   - Rewrote `reconnectSessions()`:
     - Reads all `{sessionId}.json` files from STATUS_DIR
     - Matches terminals by PID first, then falls back to terminalName
     - Reconstructs `SessionMeta` from disk data
     - Assigns new slot if not found in memory
     - Updates disk file with current PID if changed

3. `src/statusWatcher.ts`:
   - Updated `writeIdleStatus()` to preserve `processId`, `terminalName`, `projectPath` when writing

**Algorithm now:**
1. On activation, read all session files from `~/.monet/status/`
2. For each live terminal, get its PID
3. Try PID match against `diskSession.processId` (most reliable)
4. Fallback: match `terminal.name === diskSession.terminalName`
5. If matched, reconstruct SessionMeta and restore mapping
6. Update disk file with current PID if it changed

**Benefits:**
- Session reconnection now works after Extension Host restarts
- Disk files are source of truth for reconnection
- globalState still used for in-session persistence, but not required for recovery

**Files modified:**
- `src/types.ts` — Added processId, terminalName, projectPath to SessionStatusFile
- `src/sessionManager.ts` — Rewrote writeStatusFile and reconnectSessions
- `src/statusWatcher.ts` — Updated writeIdleStatus to preserve new fields

#### 2026-02-24: Reconnection Test Scripts

**Purpose:**
- Automated verification and stress testing of PID-based session reconnection
- Detect regressions when changing reconnection logic

**Scripts created:**

1. `scripts/verify-reconnect.py` — Single snapshot verification
   - Lists all status files with processId, terminalName, projectPath
   - Cross-references with running terminal PIDs via `os.kill(pid, 0)`
   - Shows LIVE/DEAD/NO PID status for each session
   - Exits 1 if any active session is missing a PID
   - Usage: `./scripts/verify-reconnect.py`

2. `scripts/stress-test-reconnect.py` — Destructive stress test
   - Kills extension host N times (default: 20)
   - Each iteration:
     1. Records session IDs and PIDs from `~/.monet/status/*.json`
     2. Kills Cursor extension host: `pkill -f "extensionHost"`
     3. Waits for restart (default: 3s)
     4. Checks PIDs survived in status files
     5. Verifies no sessions were lost
     6. Validates status file structure (sessionId, project, status fields)
   - Logs to `/tmp/monet-stress-test-*.log`
   - Clear PASS/FAIL per iteration + final summary
   - Usage: `./scripts/stress-test-reconnect.py [iterations] [wait_seconds] [-y]`
   - `-y` flag skips confirmation prompt

**Note:** Originally written in bash, but macOS ships with bash 3.2 which lacks
associative arrays (`declare -A`). Rewrote in Python 3 for compatibility and
native JSON parsing.

**Files created:**
- `scripts/verify-reconnect.py`
- `scripts/stress-test-reconnect.py`

#### 2026-02-24: Remove terminalName from Status Files

**Change:**
- Removed `terminalName` field from `SessionStatusFile` interface
- Replaced terminalName-based fallback matching with projectPath matching
- Fallback now uses `terminal.shellIntegration?.cwd` or `terminal.creationOptions.cwd`

**Rationale:**
- Terminal names change frequently (emoji, title updates)
- projectPath is stable and unique per session
- Simpler data model

**Files modified:**
- `src/types.ts` — Removed `terminalName?: string` from SessionStatusFile
- `src/sessionManager.ts` — Updated writeStatusFile(), reconnectSessions() fallback
- `src/statusWatcher.ts` — Updated comments
- `scripts/verify-reconnect.py` — Shows projectPath instead of terminalName

#### 2026-02-24: CLAUDE.md Rewrite

**Purpose:**
- Sync CLAUDE.md with actual current implementation
- Remove outdated references to pos-{N}, MONET_POSITION, deleted files

**Key updates:**
- Status files: `{sessionId}.json` not `pos-{N}.json`
- Terminal name format: `{emoji} — {title}` not `{emoji} P{N}: {title}`
- Status emoji: 🔵 thinking, 🟢 active, 🟡 waiting, ⚪ idle (removed ✅ complete)
- Env var: `MONET_SESSION_ID` not `MONET_POSITION`
- Key files: Added hooksManager.ts, hooksInstaller.ts; removed nonexistent files
- Persistence: Added disk-based PID storage documentation
- Reconnection: Documented PID matching + projectPath fallback

**Files modified:**
- `CLAUDE.md`

#### 2026-02-24: Add TITLE Column to verify-reconnect.py

**Change:**
- Added TITLE column to the session status table output
- Shows `data.get('title', '')` after STATUS column
- Titles longer than 20 chars are truncated with `...`

**Files modified:**
- `scripts/verify-reconnect.py` — Added title variable, display_title truncation, updated header and data row format

#### 2026-02-24: Fix /title Command Not Executing

**Problem:**
- `/title` slash command sometimes printed the bash command instead of running it
- Root cause: Instruction said "Output ONLY the bash command" which Claude interpreted literally

**Fix:**
- Changed instruction from "Output ONLY the bash command" to "Run the bash command"
- Claude now uses Bash tool to execute instead of just printing

**Files modified:**
- `~/.claude/commands/title.md` — Changed instruction wording
- `src/extension.ts` — Updated template for future installs

#### 2026-02-25: Fix Color Assignment + Gap-Filling

**Problem:**
- All terminals were getting the same color regardless of project
- Colors were never freed when terminals closed

**Root cause:**
- `getColorIndex()` was assigning colors but nothing tracked terminal count per project
- When terminals closed, colors remained assigned forever

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
- Shuffle: Fisher-Yates shuffle on activation for random order
- Resets each workspace session (ephemeral)

**Gap-filling:**
- `findNextAvailableSlot()` returns lowest unused slot
- When project A closes all terminals, its slot (e.g., 0) becomes available
- Next new project gets slot 0, not next sequential slot

**Files modified:**
- `package.json` — Added `monet.colorOrder` and `monet.projectsRoot` settings
- `src/projectManager.ts` — Added count tracking, colorOrder, assignColor/releaseColor
- `src/sessionManager.ts` — Call assignColor in createSession/continueSession, releaseColor in deleteSession

#### 2026-02-25: Add PostToolUse Hook for Accurate Status Transitions

**Problem:**
- Status flow had a gap between tool execution and next action
- After `PreToolUse` set status to "active" (🟢), there was no hook to transition back to "thinking" (🔵)
- Terminal showed 🟢 during Claude's processing time after tool completion

**Solution:**
- Added `PostToolUse` hook that sets status back to "thinking"
- Now shows accurate real-time status:
  - 🔵 thinking → Claude processing/reasoning
  - 🟢 active → tool executing
  - 🔵 thinking → tool done, Claude processing result (NEW)
  - 🟢 active → next tool executing
  - ⚪ idle → done

**Flow now (6 hooks total):**
1. `UserPromptSubmit` → thinking 🔵
2. `PreToolUse` → active 🟢
3. `PostToolUse` → thinking 🔵 *(new)*
4. `Notification` → waiting 🟡
5. `Stop` → idle ⚪
6. `Stop` (2nd) → monet-title-check

**Files modified:**
- `src/hooksManager.ts` — Added PostToolUse to ClaudeSettings interface and installHooks()

#### 2026-02-25: Fix PID Recycling Bug in Session Reconnection

**Problem:**
- PIDs get recycled by macOS when processes exit and new ones start
- Old status files contained stale PIDs from dead sessions
- After extension reload, fresh zsh terminals could get a recycled PID
- `reconnectSessions()` would incorrectly match the plain terminal to an old session
- Result: random terminal gets wrong title/status from unrelated old session

**Root cause:**
- Line 94: `diskSessions.find(s => pid && s.processId === pid)`
- Pure PID matching with no validation that terminal actually belongs to Monet

**Solution: Use MONET_SESSION_ID env var instead of PID matching**
- When Monet creates a terminal, it sets `MONET_SESSION_ID` in the env
- This env var survives Extension Host restarts (part of terminal state)
- `reconnectSessions()` now reads `terminal.creationOptions.env.MONET_SESSION_ID`
- Only terminals with MONET_SESSION_ID are considered for reconnection
- Match by sessionId directly (exact match, no guessing)
- PID still stored in status file for recovery purposes, but not used for matching

**Algorithm now:**
1. Read all status files from disk, index by sessionId
2. For each terminal:
   - Read `MONET_SESSION_ID` from `terminal.creationOptions.env`
   - If not present → skip (not a Monet terminal)
   - If present → look up status file by sessionId (exact match)
   - Rebuild terminalToSession mapping
3. PID retrieved after match for status file updates only

**Benefits:**
- No false PID matches possible
- Plain zsh terminals with recycled PIDs are ignored entirely
- Project switch → terminals survive with MONET_SESSION_ID → reconnect works
- Fresh reload with plain terminals → no MONET_SESSION_ID → reconnect skipped

**Files modified:**
- `src/sessionManager.ts` — Replaced PID matching with MONET_SESSION_ID matching

#### 2026-02-25: Stale Status File Cleanup on Fresh Load

**Problem:**
- Old status files accumulated in `~/.monet/status/` from dead sessions
- Files contained stale PIDs from processes that no longer exist
- These orphaned files cluttered the status directory

**Solution:**
- On fresh Cursor loads (when NO terminals have `MONET_SESSION_ID` set), run cleanup pass
- Delete status files where `processId` exists and the process is dead
- Skip cleanup during Extension Host restarts (when Monet terminals are present)

**Detection logic:**
- `hasMonetTerminals()` checks if any terminal has `MONET_SESSION_ID` in creationOptions.env
- If true → Extension Host restart, skip cleanup (terminals still alive)
- If false → Fresh Cursor load, run cleanup

**Cleanup logic:**
- `cleanupStaleStatusFiles()` reads all `*.json` files in STATUS_DIR
- For each file with a `processId`, check if process is alive via `process.kill(pid, 0)`
- If process is dead, delete the file and log

**Files modified:**
- `src/sessionManager.ts` — Added `hasMonetTerminals()`, `isProcessAlive()`, `cleanupStaleStatusFiles()`
- `src/extension.ts` — Call cleanup on fresh loads after sessionManager init

#### 2026-02-25: Remove .git Requirement from Project Listing

**Problem:**
- `getAvailableProjects()` only returned directories containing `.git`
- User expected all project directories to appear in "Switch Project" menu
- Only ~6 of many projects showed up because the rest weren't git-initialized

**Solution:**
- Removed `.git` requirement from project discovery
- All non-hidden directories in `projectsRoot` now appear as projects
- Added `hasGit: boolean` property to returned project objects for future worktree features

**Files modified:**
- `src/projectManager.ts` — Updated `getAvailableProjects()` to include all directories, track hasGit property

#### 2026-02-25: Random Color Assignment with GlobalState Persistence

**Problem:**
- Previous gap-filling algorithm was deterministic (always picked lowest slot)
- Hash-based assignment had collisions
- Colors weren't persisted across project switches
- Colors weren't freed when all sessions for a project closed

**Solution: Random assignment with session-based persistence**

**Key changes:**

1. **Random color selection:**
   - New `findRandomAvailableSlot()` picks randomly from unused color indices
   - No more sequential assignment or hash-based assignment
   - If all 10 colors used, returns random color (overlap)

2. **GlobalState persistence:**
   - Added `monet.projectColors` key storing `Record<string, number>` (projectPath → colorIndex)
   - `loadPersistedColors()` loads on construction
   - `persistColors()` saves after any assignment or release

3. **Session-based cleanup:**
   - When `releaseColor()` is called and terminal count hits 0:
     - Color removed from memory map
     - Color removed from globalState persistence
     - Color becomes available for random selection

4. **Removed shuffle logic:**
   - Removed `colorOrder` array indirection
   - `projectColors` now stores actual color index (0-9), not slot index
   - Randomness comes from selection, not from shuffled order

**Data flow:**
```
New Project → findRandomAvailableSlot() → assign → persistColors()
Project Switch → loadPersistedColors() already has mapping → use existing
All Sessions Cleared → releaseColor() → persistColors() → color freed
Extension Reload → loadPersistedColors() → restore active project colors
```

**Files modified:**
- `src/projectManager.ts`:
  - Added `COLORS_STATE_KEY` constant
  - Added `loadPersistedColors()` and `persistColors()` methods
  - Replaced `findNextAvailableSlot()` with `findRandomAvailableSlot()`
  - Updated `assignColor()` to persist after assignment
  - Updated `releaseColor()` to persist after freeing
  - Updated `clearColors()` to clear persistence
  - Removed `colorOrder` array (no longer needed)


#### 2026-02-25: Disable PreToolUse hook to reduce jitter

**Problem:** Rapid status changes (thinking→active) caused terminal title jitter.

**Solution:** Simplified hook flow:
- `UserPromptSubmit` → `active` (🟢 green) instead of `thinking`
- `PreToolUse` → **DISABLED** (commented out)
- `Notification` → `waiting` (🟡 yellow) - unchanged
- `Stop` → `idle` (⚪ white) - unchanged

**Result:** 3 active states instead of 4:
- 🟢 active — Claude is processing (user prompt submitted)
- 🟡 waiting — needs user input/permission
- ⚪ idle — done

**Future:** Re-enable PreToolUse with thinking (🔵) when jitter is resolved.

**Files modified:**
- `src/hooksManager.ts`: Changed UserPromptSubmit to "active", commented out PreToolUse block

#### 2026-02-25: Git Worktree Feature (New Branch Command)

**Purpose:**
- Allow users to create git worktrees from the Monet menu
- Click "New Branch" → shows existing worktrees + option to create new

**Implementation:**

1. **New `src/utils.ts` file:**
   - Added `execAsync` helper (promisified `exec`)

2. **ProjectManager additions (`src/projectManager.ts`):**
   - Added `Worktree` interface: `{ path, branch, isMain }`
   - Added `getWorktrees()`: runs `git worktree list --porcelain`, parses output
   - Added `createWorktree(branchName)`: runs `git worktree add -b <branch> <path>`
   - Worktree path: `../{ProjectName}-{branch-name}/` (slashes → dashes)
   - Falls back to existing branch if `-b` fails (branch already exists)

3. **New Branch command (`src/extension.ts`):**
   - Quick pick shows:
     - `$(add) New Branch...` → prompts for name → creates worktree → opens → starts Claude
     - `$(folder) {branch}` → switches to existing worktree → starts Claude
   - Excludes main worktree and current folder from list
   - Input validation: no empty names, no spaces

**Files created:**
- `src/utils.ts`

**Files modified:**
- `src/projectManager.ts` — Added Worktree interface, getWorktrees(), createWorktree()
- `src/extension.ts` — Replaced stub newBranch command with full implementation

#### 2026-02-25: Re-enable PreToolUse Hook (Fix Yellow→Green Transition)

**Problem:**
- After user approves a tool request, status stayed yellow instead of transitioning to green
- `UserPromptSubmit` only fires once at start of conversation
- Clicking "approve" on tool permission is NOT a prompt submit — it's just a continue signal
- No hook fired between `Notification` (yellow) and tool execution

**Solution:**
- Re-enabled `PreToolUse` hook that was previously commented out
- `PreToolUse` fires when Claude starts executing a tool (after user approval)
- Sets status to `active` (🟢 green)

**Flow now (5 hooks):**
1. `UserPromptSubmit` → active 🟢 (user sends prompt)
2. `PreToolUse` → active 🟢 (tool starts, including after approval)
3. `Notification` → waiting 🟡 (needs permission)
4. `Stop` → idle ⚪ (done)
5. `Stop` (2nd) → monet-title-check

**Why jitter is minimal:**
- statusWatcher checks `terminal.name !== newName` before renaming
- If already green, repeated PreToolUse calls don't trigger extra renames
- Only actual state changes (yellow→green) cause terminal rename

**Files modified:**
- `src/hooksManager.ts` — Uncommented PreToolUse hook, updated header comment

#### 2026-02-25: Simplify New Branch to Use Claude's --worktree Flag

**Problem:**
- "New Branch" command manually created git worktrees via `git worktree add`
- Then called `updateWorkspaceFolders()` which triggered Extension Host reload
- `createSession()` after workspace switch never ran (or ran in dying context)
- Result: terminal opened but Claude never launched, wrong color assigned

**Solution:**
- Use Claude's native `--worktree` flag instead of manual worktree management
- `claude --worktree {name}` handles everything: creates worktree, launches Claude inside it
- No workspace switch needed → no Extension Host reload

**Changes:**

1. **`src/sessionManager.ts`:**
   - Added `worktreeName?: string` parameter to `createSession()`
   - If provided, runs `claude --worktree {name}` instead of plain `claude`
   - Can combine with `isContinue` flag: `claude --worktree foo -c`

2. **`src/extension.ts`:**
   - Simplified `monet.newBranch` command to just prompt for name
   - Removed `projectManager.getWorktrees()` call
   - Removed `projectManager.createWorktree()` call
   - Removed `updateWorkspaceFolders()` call (the culprit)
   - Now just calls `sessionManager.createSession(false, worktreeName)`

3. **`src/projectManager.ts`:**
   - Removed `Worktree` interface
   - Removed `getWorktrees()` method
   - Removed `createWorktree()` method
   - Removed unused `execAsync` import

**Cleanup:**
- Deleted test worktree at `/Users/ivanforcytebio/Projects/Monet-test-branch`
- Deleted test branch `test-branch`

**Files modified:**
- `src/sessionManager.ts` — Added worktreeName parameter to createSession
- `src/extension.ts` — Simplified newBranch command
- `src/projectManager.ts` — Removed worktree methods and interface

**Follow-up: Added existing worktree picker**
- Reads `.claude/worktrees/` directory for existing worktrees
- Shows quick pick if any exist: "New Worktree..." + list of existing
- If no existing worktrees, goes straight to input box
- Selecting existing worktree runs `claude --worktree {name}` to resume
