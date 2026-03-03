# 2026-02-26: Two-phase auto-titling for sessions

## Problem
Terminal titles stay as `⚪ — Claude | new session` until the first Stop hook fires and `monet-title-check` generates an LLM title. If Claude runs a long agentic loop without stopping, the user never gets a meaningful title.

## Fix
Two-phase titling with a `titleSource` hierarchy (`draft` < `final` < `manual`):

1. **Draft title on first prompt**: New `monet-title-draft` script runs on `UserPromptSubmit`. Reads stdin JSON, extracts prompt text, smart-truncates to ~40 chars at word boundary, writes with `titleSource: "draft"`. Only fires on the first prompt (exits if title already set).
2. **Final title on Stop**: `monet-title-check` now only overwrites `draft` titles (checks `titleSource` instead of `title.length > 0`). Sets `titleSource: "final"` when writing LLM-generated title.
3. **Manual title locks**: `/title` slash command sets `titleSource: "manual"` — never overwritten by any auto-titling.

## Files Changed
- `src/types.ts` — Added `titleSource?: 'draft' | 'final' | 'manual'` to `SessionStatusFile`
- `src/hooksInstaller.ts` — New `MONET_TITLE_DRAFT_SCRIPT`, updated `monet-title-check` guard and `monet-title` to set `titleSource`, bumped script hash
- `src/hooksManager.ts` — Added `monet-title-draft` as second hook in `UserPromptSubmit` group
