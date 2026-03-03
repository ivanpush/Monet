# 2026-02-26: Fix branch bleed + add Monet branch status bar item

## Problem
When a git worktree is created inside the project directory (`.claude/worktrees/`), VS Code's git extension discovers it and its branch becomes "sticky" in the SCM state. This bleeds across all terminals and projects in the same window.

## Fix
Three-part fix:
1. **Suppress VS Code git discovery**: `suppressWorktreeDiscovery()` in ProjectManager sets `git.autoRepositoryDetection` → `"openEditors"` and `git.detectWorktrees` → `false` scoped to the workspace folder. Called on activate and project switch.
2. **Monet-owned branch indicator**: New `MonetBranchIndicator` class (status bar item) shows `$(git-branch) {branchName}` for the focused Monet terminal. Runs `git -C {path} branch --show-current` using the session's effective path (worktree or project).
3. **Move worktrees out of project**: Worktrees now live at `~/.monet/worktrees/{projectName}/{name}` instead of `{project}/.claude/worktrees/`. Monet creates worktrees itself via `git worktree add` (no more `claude --worktree`).

## Files Changed
- `src/branchIndicator.ts` — **New** — Monet branch status bar item
- `src/extension.ts` — Wire branchIndicator, call `suppressWorktreeDiscovery`, update newBranch command paths
- `src/sessionManager.ts` — Worktree cwd, `getWorktreePath()`, `getSessionForTerminal()`, persist worktreeName in status file, restore on reconnect, remove `--worktree` flag
- `src/projectManager.ts` — `suppressWorktreeDiscovery()` method
- `src/types.ts` — `worktreeName` added to `SessionStatusFile`
