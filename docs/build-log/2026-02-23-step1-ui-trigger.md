# Step 1: UI Trigger (Status Bar + Keyboard)

**Status**: COMPLETE

## Final Solution:
- **Status bar icon** (paintcan) in bottom-right - always visible
- **Cmd+Shift+M** keyboard shortcut - opens quick pick menu
- Quick pick shows: New Session, New Branch, Continue, Switch Project

## Journey:
1. Tried `terminal/title` menu → doesn't exist as toolbar contribution
2. Tried `view/title` with terminal when clause → didn't work
3. Tried Activity Bar panel → user didn't like sidebar clutter
4. Tried `editor/title` → only shows when file is open
5. **Final: Status bar + keyboard** → user approved

## Lessons Learned:
1. Terminal toolbar is NOT extensible via VS Code API
2. `editor/title` only shows when a file is open
3. Status bar is always visible and reliable
4. Keyboard-first (Cmd+Shift+M) is cleanest UX for power users
5. Quick pick always appears at top-center (VS Code limitation)
