# 2026-03-01: Fix claudeSessionId race condition — use separate .csid file
**Commit:** `eb54aa2`

## Summary
`claudeSessionId` (needed for `--resume` on color change) was never surviving in the status `.json` file due to a race condition between async hooks. Moved it to a dedicated `.csid` file that `monet-status` never touches.

## Root cause
The `UserPromptSubmit` hook runs an async `;`-chain: `monet-status; monet-title-draft`. `monet-title-draft` captures `session_id` from stdin and writes `claudeSessionId` to the `.json` status file. But Claude fires `PreToolUse` almost immediately (also async), and its `monet-status` reads the `.json` before `monet-title-draft` finishes writing, then overwrites it via `{...existing, status}` — clobbering `claudeSessionId`. Evidence: zero out of eight active status files had `claudeSessionId` captured.

## Fix
Write `session_id` to `{sessionId}.csid` (a separate file) instead of into the shared `.json`. `monet-status` only reads/writes `.json`, so it can never clobber `.csid`. At refresh time, `refreshSession` reads `.csid` for the `--resume` UUID.

## Changes
- `src/hooksInstaller.ts` — `monet-title-draft` script writes `session_id` to `{sessionId}.csid` via atomic tmp+rename. Removed dead `claudeSessionId` injection into `.json`.
- `src/sessionManager.ts` — `refreshSession` reads `.csid` file for Claude UUID. `deleteStatusFiles` deletes both `.json` and `.csid`. `cleanupStaleStatusFiles` and `cleanupUnmatchedStatusFiles` both handle orphaned `.csid` files.
- `src/types.ts` — Removed `claudeSessionId` field from `SessionStatusFile` interface.

## Safety
- `monet-status` is completely untouched — no behavior change for status/title/PID tracking
- `.csid` is written atomically (tmp + rename), same pattern as all other Monet file writes
- Cleanup covers all paths: terminal close, fresh load, post-reconnect, orphaned `.csid` without matching `.json`
- Multiple sessions per project safe — each `.csid` is keyed by Monet sessionId
