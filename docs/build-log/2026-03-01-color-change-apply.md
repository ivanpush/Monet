# 2026-03-01: Apply color change to existing sessions

## Summary
When changing a project's color via `monet.changeColor`, the user is now asked whether to apply the new color to existing sessions. If yes, each session is migrated to a new terminal with `claude --resume <id>` (preserving the conversation) and the old terminal is disposed. No slash command needed — it's baked into the color change flow.

## How it works
1. `monet-title-draft` captures Claude's internal `session_id` from hook stdin on first prompt, stores as `claudeSessionId` in status file
2. User changes color → if existing sessions, QuickPick asks "Apply to N sessions?" or "New sessions only"
3. If apply: `sessionManager.refreshSession()` loops through each session — reads `claudeSessionId` from status file, creates new terminal with `--resume <uuid>`, copies title, disposes old terminal
4. If skip: marks sessions stale (shows `⟲` like before)

## Changes
- `src/types.ts` — Added `claudeSessionId?: string` to `SessionStatusFile`
- `src/hooksInstaller.ts` — `monet-title-draft` captures `hookData.session_id` from stdin before title guard
- `src/sessionManager.ts` — Added `refreshSession(sessionId)` method (reads status file, creates new session with `--resume`, copies title, disposes old). Added `getSessionByTerminal()`.
- `src/extension.ts` — `monet.changeColor` handler now offers QuickPick to apply to existing sessions. Removed `/refresh` slash command from `installSlashCommands`.
- `src/statusWatcher.ts` — Reverted launch request refresh fields (no longer needed, refresh handled by sessionManager directly)

## Not changed
- `projectManager.ts`, `hooksManager.ts`, `package.json`

## Safety
- `claudeSessionId` captured in `monet-title-draft` (already reads stdin) — monet-status does NOT read stdin, so pipe is intact
- Old terminal only disposed if `createSession` returned a new terminal (guard against failure)
- `createSession` completes (awaited) before dispose → new session in `sessions` map → `deleteSession` won't remove hooks
- Sessions without `claudeSessionId` (never had a prompt) get recreated fresh — no conversation to lose
- Title copied from old status file to new before old terminal disposal
