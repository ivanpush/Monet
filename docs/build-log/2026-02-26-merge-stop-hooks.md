# 2026-02-26: Merge Stop hooks into single group to eliminate double terminal message

## Problem
The `Stop` event had two separate HookGroups — one for `monet-status idle` and one for `monet-title-check`. Claude Code prints one "async stop hook" message per group, so users saw the hook fire twice in terminal output.

## Fix
Merged both Stop hooks into a single HookGroup with a 2-element `hooks` array. Claude Code runs hooks within a group sequentially, so `monet-status` runs first (~instant), then `monet-title-check` (up to 20s). One group = one terminal message.

## Files Changed
- `src/hooksManager.ts` — merged two `.push()` calls into one, updated comment
