# 2026-02-26: Fix worktree delete + command execution

## Fix 1: Use absolute path for `git worktree remove`
- Was using relative `.claude/worktrees/{name}`, now uses `path.join(worktreesDir, name)` (absolute)

## Fix 2: Add `--force` to `git worktree remove`
- Worktrees with untracked/modified files (which is always the case — `.claude/` etc.) fail without `--force`

## Fix 3: Force-delete unmerged branches
- Changed `git branch -d` to `git branch -D` so worktree branches can actually be deleted

## Fix 4: Fix command not executing in terminal
- `sendTextWhenReady` was using `onDidChangeTerminalShellIntegration` API which is unreliable in Cursor
- Shell integration event sometimes never fires, leaving command text in buffer without Enter
- Reverted to simple 500ms delay (same approach the stable build used before worktree work)
