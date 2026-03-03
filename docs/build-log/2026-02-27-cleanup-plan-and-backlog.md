# 2026-02-27: Add session cleanup plan and backlog document

## Session cleanup plan
Added backlog item #7 (terminal state left dirty on Ctrl+C / Cursor shutdown) and full implementation plan at `docs/plans/session-cleanup.md`. Key insight: `renameWithArg` locks VS Code terminal names, making the SessionEnd hook's OSC escape useless. Plan has 6 defense-in-depth changes across 4 files. Desired end state: terminal becomes `zsh [X-CLAUDE]` on exit, not white emoji.

## Backlog document
Created `docs/BACKLOG.md` with 4 bugs + 2 improvements: workspace switch race condition, broken monet CLI, stuck status emoji, raw draft titles, redundant hook installs, missing test suite.
