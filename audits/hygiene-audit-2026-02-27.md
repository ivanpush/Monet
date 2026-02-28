# Hygiene Audit — 2026-02-27

## Scope
- Audited directory: `/Users/ivanforcytebio/Projects/Monet`

## Executive Summary
- Root directory is polluted with 6+ files that are historical/design docs or outright junk (`Untitled`, `binary_joke.txt`), all tracked in git.
- `.claude/` contains 15 analysis/position markdown files committed to the repo — these are ephemeral Claude artifacts, not source.
- `src/utils.ts` is dead code (exported `execAsync`, imported by nothing).
- `monet.colorOrder` config declared in `package.json` but never read anywhere in `src/` — it's a vestigial setting.
- `hooksInstaller.ts` is a 560-line file where ~480 lines are inline string templates for 5 separate Node.js/Bash scripts — the actual TypeScript logic is ~80 lines.
- `statusWatcher.ts` has a rename mechanism (`processRenameQueue`) that calls `terminal.show(false)` to focus terminals before renaming, which triggers `onDidChangeActiveTerminal` and interacts with the workspace-switch debounce — this is a known source of the intermittent focus bug.

## What's Solid (Do Not Touch)
- **`src/` module structure**: Clean separation — 8 files, each with a single responsibility. No circular dependencies. No god file.
- **Atomic file writes** (`tmp` + `rename`) used consistently across all disk IO. Good.
- **`types.ts`**: Lean, well-typed, no bloat.
- **`hooksManager.ts`**: Clean install/remove logic with MONET_TAG for idempotent management. Just refactored (hook merging) and correct.
- **`branchIndicator.ts`**: 50 lines, does one thing. Perfect.
- **`package.json`**: Well-structured contributes section. Build scripts are minimal and correct.
- **`.gitignore`**: Covers the right patterns.
- **`tsconfig.json`**: Standard, no weird flags.

## Structural Issues

### S1: Root directory pollution — 6 tracked files that don't belong
These are committed to git and clutter the project root:
| File | What it is |
|------|-----------|
| `Untitled` | Contains literally `CLAUDE.md`. 9 bytes. Junk. |
| `binary_joke.txt` | A joke. 594 bytes. Not source code. |
| `claude-spark.svg` | Exact duplicate of `icons/claude-spark.svg` |
| `Monet Hooks Prompt.md` | Design prompt used during development. Superseded by CLAUDE.md. |
| `MONET_V0_FINAL.md` | 631-line original design spec. Historical. |
| `TODO_REMAINING.md` | 42-line old todo list. Superseded by `docs/BACKLOG.md`. |
| `BEHAVIORAL_SPEC.md` | 558-line behavioral spec. Historical reference. |

`BUILD_LOG.md` and `CLAUDE.md` are appropriate at root.

### S2: `.claude/` directory has 19 committed analysis files
15 `monet-pos-*.md` files and 4 analysis reports (`CODE_ANALYSIS_REPORT.md`, `ANALYSIS_SUMMARY.txt`, `ISSUES_QUICK_FIX.md`, `README_ANALYSIS.md`). These are ephemeral Claude session artifacts, not project documentation. They should either be gitignored or moved to `docs/archive/`.

### S3: `icons/` vs `resources/` — split icon storage
- `icons/claude-spark.svg` — 1 file
- `resources/` — 11 SVG variants of the same icon

Both directories serve the same purpose (extension assets). Code only references `resources/`. `icons/` is orphaned.

### S4: `scripts/__pycache__/` tracked or present
Python bytecode cache in `scripts/`. Should be gitignored.

## Architectural Issues

### A1: `src/utils.ts` is dead code
Exports `execAsync` (promisified `exec`). Zero imports across the entire codebase. `branchIndicator.ts` uses its own `execFileAsync` instead. Dead weight.

### A2: `monet.colorOrder` config is vestigial
Declared in `package.json` (lines 100-109) with `"fixed"` and `"shuffle"` options. Never read in any source file. `projectManager.ts` always uses random assignment (`findRandomAvailableSlot`). The setting is a lie — it does nothing.

### A3: `hooksInstaller.ts` — 480 lines of inline script strings
Five complete scripts (Node.js + Bash) embedded as template literals. The actual TypeScript orchestration is ~80 lines. This works but makes the file hard to navigate and impossible to lint/test the embedded scripts independently. The scripts themselves are solid — the issue is purely ergonomic.

### A4: `statusWatcher.ts` rename queue triggers phantom focus events
`processRenameQueue()` (line 176) calls `terminal.show(false)` then `renameWithArg` then restores focus. Each `terminal.show()` fires `onDidChangeActiveTerminal` in `extension.ts`, which runs the workspace-switch logic. During a rename burst (multiple terminals updating simultaneously), this creates phantom focus events that race with the 500ms debounce timer and the `isCreatingSession` guard. This is a contributing factor to the intermittent workspace-switch bug documented in `docs/BACKLOG.md`.

### A5: `extension.ts` — inline TreeProvider and activation logic mixed
`MonetTreeProvider` and `MonetActionItem` classes (lines 290-318) are defined inline in the entry point. Minor — only ~30 lines — but they could live in their own file if extension.ts grows further. Not urgent.

## Suggested Fixes (Not Implemented)

1. **Delete root junk files** — Remove `Untitled`, `binary_joke.txt`, `claude-spark.svg` (duplicate), `TODO_REMAINING.md` (superseded)
2. **Move historical docs** — Move `BEHAVIORAL_SPEC.md`, `MONET_V0_FINAL.md`, `Monet Hooks Prompt.md` to `docs/archive/`
3. **Gitignore `.claude/` analysis artifacts** — Add `.claude/*.md` and `.claude/*.txt` to `.gitignore`, then `git rm --cached` the 19 files
4. **Delete `src/utils.ts`** — Dead code, zero imports
5. **Remove or implement `monet.colorOrder` config** — Either delete from `package.json` or wire it up in `projectManager.ts`
6. **Delete `icons/` directory** — Orphaned, code uses `resources/`
7. **Add `__pycache__/` to `.gitignore`**
8. **Fix rename-induced phantom focus events** — Guard `onDidChangeActiveTerminal` to ignore events triggered by `statusWatcher` rename operations

## Implementation Prompts

### Fix 1: Delete root junk files

**Prompt:**
Delete these tracked files from the repo root (they are junk or duplicates): `Untitled`, `binary_joke.txt`, `claude-spark.svg`. Also delete `TODO_REMAINING.md` which is superseded by `docs/BACKLOG.md`. Use `git rm` so they're removed from tracking. Do NOT delete `BUILD_LOG.md`, `CLAUDE.md`, `package.json`, or any other root file not listed here.

### Fix 2: Move historical docs to docs/archive/

**Prompt:**
Create `docs/archive/` directory. Use `git mv` to move these files from the repo root into `docs/archive/`: `BEHAVIORAL_SPEC.md`, `MONET_V0_FINAL.md`, `Monet Hooks Prompt.md`. These are historical design documents that are no longer actively referenced. Do NOT move `CLAUDE.md` or `BUILD_LOG.md`.

### Fix 3: Gitignore .claude/ analysis artifacts

**Prompt:**
Add these patterns to `.gitignore`: `.claude/*.md`, `.claude/*.txt`. Then run `git rm --cached` on all `.claude/*.md` and `.claude/*.txt` files (there are 15 `monet-pos-*.md` files and 4 analysis reports). Do NOT touch `.claude/settings.local.json` or `.claude/worktrees/`. These are ephemeral Claude session artifacts that should never have been committed.

### Fix 4: Delete src/utils.ts

**Prompt:**
Delete `src/utils.ts`. It exports `execAsync` (promisified `exec`) but is imported by zero files in the codebase. Verify with a grep for `from './utils'` or `from "../utils"` across `src/` before deleting — it should return no results. Do NOT create a replacement or add the import elsewhere.

### Fix 5: Remove vestigial monet.colorOrder config

**Prompt:**
Remove the `monet.colorOrder` configuration entry from `package.json` (the `"monet.colorOrder"` property block inside `contributes.configuration.properties`). This setting is declared but never read by any code in `src/`. The color assignment in `projectManager.ts` always uses random selection regardless of this setting. Only remove the config declaration — do NOT change any code in `src/`.

### Fix 6: Delete orphaned icons/ directory

**Prompt:**
Delete the `icons/` directory and its contents (`icons/claude-spark.svg`). The extension code only references `resources/` for icon paths (see `projectManager.ts` line 158). The `icons/` directory contains a single SVG that is an exact duplicate of `resources/claude-spark.svg`. Use `git rm -r icons/`.

### Fix 7: Add __pycache__ to .gitignore

**Prompt:**
Add `__pycache__/` to `.gitignore`. If `scripts/__pycache__/` is tracked, run `git rm -r --cached scripts/__pycache__/`. Only touch `.gitignore` and the cached files.

### Fix 8: Guard against rename-induced phantom focus events

**Prompt:**
In `statusWatcher.ts`, add a public boolean flag `isRenaming` (it already exists as private — make it accessible or add a getter). In `extension.ts`, inside the `onDidChangeActiveTerminal` listener, add a guard that returns early (skipping workspace switch logic) if `statusWatcher.isRenaming` is true. Place this guard AFTER the branch indicator update but BEFORE the `isCreatingSession` check (around line 219). This prevents the rename queue's `terminal.show(false)` calls from triggering spurious workspace switches. Only modify the focus listener guard logic — do not change the rename queue itself.
