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
