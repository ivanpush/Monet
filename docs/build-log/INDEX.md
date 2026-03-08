# Monet Build Log

**Started**: 2026-02-23 | [Entry template](./_TEMPLATE.md)

## Color System
| Date | Entry | Summary | Commit |
|------|-------|---------|--------|
| 03-02 | [active-session-warnings](./2026-03-02-active-session-warnings.md) | Warn before interrupting active sessions on color change | `eb54aa2` |
| 03-01 | [color-change-apply](./2026-03-01-color-change-apply.md) | Apply color change to existing sessions via --resume | — |
| 02-28 | [change-color-command](./2026-02-28-change-color-command.md) | Add Change Project Color command + stale marker | — |
| 02-28 | [stale-status-delete](./2026-02-28-stale-status-delete.md) | ~~Delete stale status files~~ (superseded by orphan-status-cleanup) | — |
| 02-25 | [color-assignment](./2026-02-25-color-assignment.md) | Fix color assignment, gap-filling, random + persistence | — |
| 02-23 | [terminal-ux-and-colors](./2026-02-23-terminal-ux-and-colors.md) | Terminal format iterations + Monet color palette | — |

## Hooks & Subprocess Isolation
| Date | Entry | Summary | Commit |
|------|-------|---------|--------|
| 03-07 | [late-hook-race-guards](./2026-03-07-late-hook-race-guards.md) | Guard idle from late async Notification/PreToolUse overwrites | — |
| 03-02 | [subprocess-hook-isolation](./2026-03-02-subprocess-hook-isolation.md) | Fix subprocess hooks stomping parent session state | `eb54aa2` |
| 02-27 | [fix-double-hook-messages](./2026-02-27-fix-double-hook-messages.md) | Merge hook groups to eliminate double terminal messages | — |
| 02-26 | [merge-stop-hooks](./2026-02-26-merge-stop-hooks.md) | Merge Stop hooks into single group | — |
| 02-26 | [cleanup-cli-launcher](./2026-02-26-cleanup-cli-launcher.md) | SessionEnd hook + CLI launcher + worktree removal | — |
| 02-25 | [hooks-and-worktrees](./2026-02-25-hooks-and-worktrees.md) | PreToolUse/PostToolUse hook iterations | — |
| 02-23 | [hooks-and-status-system](./2026-02-23-hooks-and-status-system.md) | Initial Claude Code hooks implementation | — |

## Session Lifecycle
| Date | Entry | Summary | Commit |
|------|-------|---------|--------|
| 03-02 | [stopped-terminal-state](./2026-03-02-stopped-terminal-state.md) | Make `stopped` a one-way terminal state, guard all write paths | — |
| 03-01 | [csid-forwarding](./2026-03-01-csid-forwarding.md) | Forward .csid during color change refresh | `eb54aa2` |
| 03-01 | [csid-race-condition](./2026-03-01-csid-race-condition.md) | Fix claudeSessionId race — use separate .csid file | `eb54aa2` |
| 03-01 | [remove-slot-limit](./2026-03-01-remove-slot-limit.md) | Remove 20-session slot limit, key by sessionId | — |
| 02-24 | [uuid-migration](./2026-02-24-uuid-migration.md) | Replace integer slots with 8-char hex session IDs | — |
| 02-24 | [misc-fixes](./2026-02-24-misc-fixes.md) | Behavioral audit, race conditions, liveness checks | — |

## Terminal UX & Titling
| Date | Entry | Summary | Commit |
|------|-------|---------|--------|
| 02-27 | [title-no-persistence](./2026-02-27-title-no-persistence.md) | Stop title-generation conversations from polluting history | — |
| 02-26 | [auto-titling-two-phase](./2026-02-26-auto-titling-two-phase.md) | Two-phase auto-titling (draft on prompt, final on stop) | — |
| 02-23 | [title-system-evolution](./2026-02-23-title-system-evolution.md) | Title system iterations: sendText → claude -p → /title | — |
| 02-23 | [step1-ui-trigger](./2026-02-23-step1-ui-trigger.md) | UI trigger: status bar + Cmd+Shift+M keyboard shortcut | — |

## Reconnection & Cleanup
| Date | Entry | Summary | Commit |
|------|-------|---------|--------|
| 03-01 | [orphan-status-cleanup](./2026-03-01-orphan-status-cleanup.md) | Delete all orphan status files (no PID, junk names) | — |
| 02-27 | [dispose-stale-terminals](./2026-02-27-dispose-stale-terminals.md) | Dispose stale Monet terminals on fresh Cursor launch | — |
| 02-26 | [pid-reconnection-worktree-ux](./2026-02-26-pid-reconnection-worktree-ux.md) | Restore PID reconnection + worktree UX | — |
| 02-26 | [revert-send-text-ready](./2026-02-26-revert-send-text-ready.md) | Revert sendTextWhenReady — use direct terminal.sendText() | — |
| 02-24 | [reconnection-system](./2026-02-24-reconnection-system.md) | Anchor folder → PID matching → disk persistence | — |

## Worktrees (removed)
| Date | Entry | Summary | Commit |
|------|-------|---------|--------|
| 02-26 | [branch-bleed-fix](./2026-02-26-branch-bleed-fix.md) | Fix branch bleed + Monet branch status bar item | — |
| 02-26 | [worktree-delete-fix](./2026-02-26-worktree-delete-fix.md) | Fix worktree delete + command execution | — |
| 02-26 | [worktree-bugs-double-command](./2026-02-26-worktree-bugs-double-command.md) | Fix worktree bugs & double command firing | — |
| 02-25 | [hooks-and-worktrees](./2026-02-25-hooks-and-worktrees.md) | Git worktree feature (worktree part) | — |

## Project & Workspace
| Date | Entry | Summary | Commit |
|------|-------|---------|--------|
| 03-07 | [rename-workspace-switch](./2026-03-07-rename-workspace-switch.md) | Fix rename-triggered workspace switch to wrong project | — |
| 02-26 | [terminal-focus-race](./2026-02-26-terminal-focus-race.md) | Fix terminal focus listener swapping workspace mid-creation | — |
| 02-26 | [project-switch-race](./2026-02-26-project-switch-race.md) | Fix project-switch terminal race condition | — |
| 02-26 | [cleanup-cli-launcher](./2026-02-26-cleanup-cli-launcher.md) | CLI launcher + simplified menu (also in Hooks) | — |

## Docs & Infra
| Date | Entry | Summary | Commit |
|------|-------|---------|--------|
| 02-27 | [cleanup-plan-and-backlog](./2026-02-27-cleanup-plan-and-backlog.md) | Add session cleanup plan + backlog document | — |
| 02-24 | [misc-fixes](./2026-02-24-misc-fixes.md) | Behavioral audit, CLAUDE.md rewrite, test scripts (also in Session Lifecycle) | — |
