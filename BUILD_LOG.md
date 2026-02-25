# Monet Build Log

**Started**: 2026-02-23

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
