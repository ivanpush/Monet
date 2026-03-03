# 2026-02-27: Fix double hook completion messages

## Summary
Merged two-command hook groups into single shell commands so Claude Code logs one "Async hook completed" message per event instead of two.

## Changes
- `src/hooksManager.ts` — `UserPromptSubmit` hook: combined `monet-status` + `monet-title-draft` into one command with `;` separator
- `src/hooksManager.ts` — `Stop` hook: combined `monet-status` + `monet-title-check` into one command with `;` separator, kept 20s timeout for the claude -p call
