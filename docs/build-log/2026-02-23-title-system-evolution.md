# 2026-02-23: Title System Evolution

Evolution of the terminal title system through several iterations on day 1.

---

## Title System Overhaul - Replace sendText with claude -p

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
1. `src/hooksInstaller.ts` - Complete rewrite of MONET_TITLE_CHECK_SCRIPT
2. `src/statusWatcher.ts` - Removed flag-based title system, deleted `handleNeedsTitleFlag()`
3. `src/hooksManager.ts` - Increased title-check timeout from 10 to 20

---

## Title UX Improvements - Keep Default Title Visible

**Problem:**
- When Claude starts, status file is created with empty title
- StatusWatcher renamed terminal to just emoji (e.g., `🔵`) with no text

**Fix:**
- Changed default title format to `Claude | new session`
- StatusWatcher now shows `{emoji} Claude | new session` when title is empty

**Files modified:**
- `src/sessionManager.ts` (lines 92, 146) - Initial terminal name: `⚪ Claude | new session`
- `src/statusWatcher.ts` (line 119) - Fallback when title empty

---

## Title Check Script Fixes - Stdin Reading + Recursion Guard

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

---

## /title Slash Command for Manual Title Changes

**Implementation:**

1. **New command: `monet.installSlashCommands`**
   - Added to `package.json` commands and commandPalette
   - User runs from Command Palette: "Monet: Install Slash Commands"
   - Writes slash command files to `~/.claude/commands/`

2. **New script: `~/.monet/bin/monet-title`**
   - Usage: `monet-title <position> <title>`
   - Updates ONLY the title field in status file, preserves status

3. **Slash command: `/title`**
   - Installed to `~/.claude/commands/title.md`
   - Tells Claude to run: `~/.monet/bin/monet-title $MONET_POSITION $ARGUMENTS`
   - Uses `MONET_POSITION` env var set by Monet when creating terminals

4. **MONET_POSITION env var**
   - Now set on terminal creation in `sessionManager.ts`
   - Allows slash commands to know which status file to update

**Files modified:**
- `package.json` - Added `monet.installSlashCommands` command
- `src/extension.ts` - Added `installSlashCommandsCmd` handler
- `src/sessionManager.ts` - Added `env: { MONET_POSITION: slot.toString() }` to terminal creation
- `src/hooksInstaller.ts` - Added `MONET_TITLE_SCRIPT`, updated hash and install logic
