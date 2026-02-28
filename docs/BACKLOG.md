# Monet Backlog

> Created: 2026-02-27

Four real issues + three improvements.

---

## 1. Terminal focus → workspace switch is unreliable

**What happens**: Switching between Monet terminals sometimes doesn't swap the workspace folder. Project C doesn't "light up" — you have to click away and come back.

**Root cause**: `extension.ts:221` — the `isCreatingSession` guard in the terminal focus listener. When `createSession()` runs, it sets `_isCreatingSession = true`, then calls `terminal.show()` which triggers the focus event. The guard sees `isCreatingSession = true` and skips the workspace switch. By the time `finally` clears the flag, the focus event already fired and was ignored.

**Secondary**: The 500ms debounce collapses rapid A→B→C clicks. If C's event was skipped by the guard, nothing fires.

**Fix**: After `createSession()` completes (in the `finally` block or right after), explicitly call `updateWorkspaceFolders()` for the new session's project. Don't rely on the focus listener to catch it.

**Files**: `src/extension.ts:203-259`, `src/sessionManager.ts:178-267`

---

## 2. Monet CLI (`~/.monet/bin/monet`) doesn't work

**What happens**: The `monet` command is supposed to launch sessions from any integrated terminal. It doesn't work at all.

**Failure modes**:
- `~/.monet/bin` is not on PATH — user can't invoke `monet`
- `TERM_PROGRAM` guard blocks it outside VS Code integrated terminals
- Launch watcher (`statusWatcher.ts:212`) uses `fs.watch` with NO fallback poll (status watcher has a fallback, launch watcher doesn't)
- If project doesn't match `getAvailableProjects()`, session creation silently fails with no user feedback
- No error logging or feedback to the user at any point

**The bigger vision**: User wants `monet` to be a standalone wrapper around `claude` that works in iTerm2/system terminals too — with AppleScript for new windows, iTerm2 profile switching for colors, project registry at `~/.monet/projects.json`, and a session-end summary block. Current implementation is VS Code-only and broken.

**Fix (minimum viable)**: Add `~/.monet/bin` to PATH via shell profile, add fallback poll for launch dir, add error logging. The full iTerm2 vision is a separate project.

**Files**: `src/hooksInstaller.ts:444-484` (script), `src/statusWatcher.ts:212-282` (watcher)

---

## 3. Status emoji gets stuck (yellow/green, never goes white)

**What happens**: Terminal emoji stays at 🟡 (waiting) or 🟢 (active) and never transitions to ⚪ (idle). User has to manually check if Claude is done.

**Root causes** (ranked by likelihood):

1. **Ctrl+C doesn't trigger Stop hook** — When user presses Ctrl+C, Claude process dies but Claude Code may not fire the Stop hook. `onDidCloseTerminal` handler (`sessionManager.ts:42-48`) deletes the session but never writes `idle` to the status file. Emoji stays frozen.

2. **monet-title-check hangs** — The Stop hook runs `monet-status idle; monet-title-check`. If `claude -p --model haiku` (`hooksInstaller.ts:296`) hangs or times out (15s timeout inside a 20s hook timeout), the entire hook gets killed. The `monet-status idle` write may have succeeded but the file could be mid-write from title-check, leaving corrupted JSON that the poll loop silently skips.

3. **Race condition in concurrent writes** — Both `monet-status` and `monet-title-check` read-modify-write the same status file without locking. If title-check reads the file before monet-status writes `idle`, then title-check writes back the old `active` status with the new title — overwriting the idle status.

4. **$MONET_SESSION_ID lost on Extension Host restart** — After restart, env var is gone. Hooks fire but `monet-status` gets empty sessionId, silently exits (`hooksInstaller.ts:30-32`). Status file never updated.

5. **All scripts exit 0 on failure** — Every catch block does `process.exit(0)`. Claude Code thinks the hook succeeded. No way to detect failures.

**Fix**:
- Write `idle` status in `onDidCloseTerminal` handler (covers Ctrl+C and terminal close)
- Separate monet-status and monet-title-check so title-check can't corrupt the status write
- Add file locking or make title-check preserve the current `status` field when writing
- Add a staleness timeout in the poll loop (if status file hasn't been updated in >5 min and session terminal is gone, force idle)

**Files**: `src/sessionManager.ts:42-48`, `src/hooksInstaller.ts:18-68,149-340`, `src/statusWatcher.ts:122-161`, `src/hooksManager.ts:115-126`

---

## 4. Draft title is raw user text — could be smarter

**What happens**: First prompt becomes the draft title via `monet-title-draft`. It's just truncated at 40 chars: `"fix the bug in src/components/auth/..."`. Feels like a raw copy-paste, not a title.

**What's possible without LLM** (must be instant, runs on every prompt):
- Strip discourse openers: "can you", "please", "I want to", "help me"
- Strip action prefixes: "fix:", "add:", "implement:"
- Remove file paths (`src/foo/bar.ts`) and backtick code blocks
- Handle slash commands: `/code review auth.tsx` → `"code review: auth.tsx"`
- Remove trailing `?`

**The draft gets replaced** by the LLM-generated final title on Stop anyway (`titleSource: 'draft'` → `'final'`), so aggressive abbreviation is fine.

**Files**: `src/hooksInstaller.ts:353-435` (MONET_TITLE_DRAFT_SCRIPT)

---

## 5. Hooks reinstalled on every session create

**What happens**: `installHooks()` writes to `.claude/settings.local.json` on every `createSession()` call (`sessionManager.ts:257`), even if hooks are already present and current.

**Impact**: Unnecessary disk writes, potential for conflicts if user edits the file manually, and wasted time on every session start.

**Fix**: Check if Monet hooks are already present and match current version before writing. Similar to how `hooksInstaller.ts` uses a version hash for the bin scripts.

**Files**: `src/hooksManager.ts:39-148`, `src/sessionManager.ts:257`

---

## 6. No test suite

**What's possible**: Unit tests with vitest for pure logic (color assignment, slot finding, status file parsing, title truncation regex). Integration tests would need VS Code extension test harness which is heavier but doable.

**Start with**: projectManager color logic, monet-title-draft regex, status file read/write, hook installation idempotency.

**Files**: Need to create `src/__tests__/` or `test/` directory, add vitest to devDependencies.

---

## 7. No cleanup on exit — terminal state left dirty after Ctrl+C or Cursor shutdown

**What happens**: When Ctrl+C kills Claude Code, or Cursor closes/restarts, terminals are left dirty — emoji stuck at 🟢/🟡, terminal name frozen, status files stale on disk.

**Four failure scenarios**:

1. **Ctrl+C kills Claude** (terminal stays alive, `onDidCloseTerminal` does NOT fire) — The `SessionEnd` hook fires inside the shell, but it runs `printf '\033]0;zsh\007'` which does nothing because `renameWithArg` locks the terminal name in VS Code. OSC escape sequences are ignored after VS Code's API has set the name.

2. **User closes terminal tab** — `onDidCloseTerminal` fires, calls `deleteSession()` which immediately deletes the status file. Never writes idle first. Terminal is already gone so renaming is impossible.

3. **Cursor window closes** — `deactivate()` fires but only stops the status watcher. Does NOT write idle to any status files or rename terminals.

4. **Cursor crash / force-quit** — Nothing fires. Status files left with stale `active`/`waiting` state. `cleanupStaleStatusFiles()` on next fresh load only nulls processIds, doesn't set status to idle.

**Desired behavior on Ctrl+C / session end**: Terminal name should become `zsh [X-CLAUDE]` — strip the Monet emoji/title, show the shell name with a dead-session marker. NOT white emoji idle.

**Fix (6 changes, defense in depth)**:

1. **SessionEnd hook** (`hooksManager.ts:128-138`): Replace broken OSC escape with `monet-status idle`. The hook fires in the shell after Claude exits, can write to the status file. Poll loop picks it up within ~1s and renames terminal.

2. **onDidCloseTerminal** (`sessionManager.ts:42-48`): Write idle to status file BEFORE calling `deleteSession()` which deletes it.

3. **deactivate()** (`extension.ts:320-329`): Use **synchronous** file IO to write idle to all active session status files. Async may not complete during shutdown. This is the one justified sync IO use.

4. **cleanupStaleStatusFiles** (`sessionManager.ts:464`): Also set `status: 'idle'` when nulling dead processIds. One-line addition.

5. **Staleness detection** (`statusWatcher.ts` poll loop): If a status file shows non-idle but `updated` is >5 min old, auto-write idle. Universal safety net.

6. **Terminal rename on exit**: The poll loop already handles renaming when status changes to idle. The real question is what the terminal name should become — `zsh [X-CLAUDE]` instead of `⚪ — {title}`.

**Files**: `src/hooksManager.ts:128-138`, `src/sessionManager.ts:42-48,365-388,452-480`, `src/extension.ts:320-329`, `src/statusWatcher.ts:122-161,319-348`

**Plan**: See `docs/plans/session-cleanup.md` for full implementation plan.
