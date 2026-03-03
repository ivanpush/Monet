# 2026-03-02: Fix subprocess hooks stomping parent session state (three-for-one)
**Commit:** `eb54aa2`

## Problem
When the Stop hook fires `monet-title-check`, it spawns `claude -p --model haiku` to generate a title. That subprocess inherits `MONET_SESSION_ID` and runs in the project directory, so it picks up `.claude/settings.local.json` hooks. The subprocess fires the full hook lifecycle (UserPromptSubmit, Stop, SessionEnd) against the **parent** session's status files, causing three distinct bugs:

1. **Terminal flips to `zsh [ex-claude]`** — subprocess `SessionEnd` writes `stopped` to parent status and prints OSC escape to rename terminal
2. **`.csid` corruption → broken `--resume` on color change** — subprocess `UserPromptSubmit` triggers `monet-title-draft`, which writes the subprocess's ephemeral `session_id` (from `--no-session-persistence`) over the parent's `.csid` file. The real conversation UUID is lost. Next color change reads the garbage UUID → `claude --resume <garbage>` → "No conversation found"
3. **Status flickers green then idle** — subprocess `UserPromptSubmit` writes `active`, then `Stop` writes `idle`, stomping the parent's real status

## Root Cause
Architecture bug: subprocess hook side effects leaking into parent session state. All three symptoms are the same class of bug — the `claude -p` subprocess sees project hooks and the parent's `MONET_SESSION_ID`.

## Fix — Three layers of isolation
1. **`cwd: os.homedir()`** on `execSync` — subprocess can't find project `.claude/settings.local.json` (no git root at `$HOME`), so project hooks don't load at all
2. **`delete subEnv.MONET_SESSION_ID`** — even if hooks somehow fire, they can't target any session (env copy only, parent process unaffected)
3. **`[ -z "$MONET_TITLE_CHECK_RUNNING" ]` guard on SessionEnd hook** — defense-in-depth, blocks this exact code path if something regresses

## Changes
- `src/hooksInstaller.ts` — `MONET_TITLE_CHECK_SCRIPT`: create isolated `subEnv` with `MONET_SESSION_ID` deleted, add `cwd: os.homedir()` to `execSync` options
- `src/hooksManager.ts` — SessionEnd hook command: prepend `[ -z "$MONET_TITLE_CHECK_RUNNING" ]` guard, remove debug `touch /tmp/monet-session-end-fired`

## Safety
- `subEnv` is a copy (`Object.assign({}, process.env, ...)`), `delete` only affects subprocess launch payload
- `cwd` change is harmless — `claude -p` only needs stdin/stdout, no project file access
- If title generation fails, behavior unchanged (try/catch exits 0, title stays as draft)
- SessionEnd guard only skips when `MONET_TITLE_CHECK_RUNNING` is set — real session exits don't have this env var
- No changes to: statusWatcher, sessionManager, projectManager, types, terminal lifecycle, other hooks
