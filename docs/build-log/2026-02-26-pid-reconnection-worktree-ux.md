# 2026-02-26: Restore PID-based Reconnection + Worktree UX

## Fix 1: Show project name in worktree creation UI
- InputBox prompts now show `Worktree name for {project.name}` instead of generic text
- QuickPick placeholder shows `{project.name} — worktrees`

## Fix 2: Restore PID-based reconnection (broken by `8e6ea38`)
- `reconnectSessions()` — PID matching is primary (survives Extension Host restarts), env-var fallback second
- Matches how it worked in `8a55bbd` before the regression
- `hasMonetTerminals()` — now async, checks both env vars AND terminal PIDs against disk status files
- Prevents false "fresh load" detection that wiped sessions via `clearGlobalStateSessions()`

## Files Changed
- `src/extension.ts` — worktree UI strings, `await hasMonetTerminals()`
- `src/sessionManager.ts` — PID fallback in `reconnectSessions()`, async `hasMonetTerminals()`
