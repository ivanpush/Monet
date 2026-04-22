# 2026-03-07: Docs cleanup + pre-launch audit
**Commit:** —

## Problem
Root directory cluttered with stale/design docs. `thinking` status (blue emoji) defined but never written by any hook. No consolidated audit of security, code health, or platform requirements before launch.

## Fix
1. Removed `thinking` (blue emoji) from CLAUDE.md and README.md — no hook writes it, it just confused the status table
2. Reorganized docs:
   - `docs/archive/` — stale files: `BUILD_LOG.old.md`, `TODO_REMAINING.md`, `codex-concerns.md`, `POSSIBLE_EDITS.md`
   - `docs/design/` — specs: `BEHAVIORAL_SPEC.md`, `MONET_V0_FINAL.md`, `hooks-spec.md`, `monet_color_system_analysis.md`
   - `docs/plans/` — added `pre-launch-audit.md` (consolidated security, health, platform findings)
3. Noted `utils.ts` as unused in CLAUDE.md key files section

## Changes
- `CLAUDE.md` — removed thinking status, updated utils.ts description
- `README.md` — removed thinking row from status table
- Root `.md` files — moved to `docs/archive/`, `docs/design/`, `docs/plans/`
- `docs/plans/pre-launch-audit.md` — new file with P0-P3 prioritized fix list

## Safety
- No code changes. Documentation only.
- Root `CLAUDE.md`, `README.md`, `docs/build-log/`, `docs/BACKLOG.md` untouched structurally
