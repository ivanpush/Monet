# 2026-02-27: Stop title-generation conversations from polluting history

## Summary
Added `--no-session-persistence` flag to the `claude -p` call in `monet-title-check`. This prevents the Haiku title-generation conversations from being saved to `~/.claude/projects/` and cluttering `claude --resume` history.

## Changes
- `src/hooksInstaller.ts` — added `--no-session-persistence` to the `claude -p --model haiku` command
