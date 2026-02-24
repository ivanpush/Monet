# Monet VS Code Extension - Comprehensive Code Analysis Report

**Date:** February 23, 2026  
**Analysis Focus:** TypeScript source files, configuration, error handling, async/await patterns, type safety

---

## CRITICAL ISSUES

### 1. Missing `await` on Async Save Operation (BLOCKING BUG)
**File:** `/Users/ivanforcytebio/Projects/Monet/src/projectManager.ts`  
**Line:** 43  
**Severity:** CRITICAL

The `saveColors()` method is async but is called without `await`:

```typescript
// Line 43
this.saveColors();  // ❌ MISSING AWAIT - fire and forget
```

This should be:
```typescript
await this.saveColors();
```

**Impact:** Color assignments may not persist to globalState. If extension crashes before the promise resolves, color mappings are lost.

**Location in context:**
```typescript
// getColorIndex() line 32-46
getColorIndex(projectPath: string): number {
  const normalized = path.normalize(projectPath);

  if (this.projectColors.has(normalized)) {
    return this.projectColors.get(normalized)!;
  }

  // Assign next color
  const colorIndex = this.nextColorIndex;
  this.projectColors.set(normalized, colorIndex);
  this.nextColorIndex = (this.nextColorIndex + 1) % PROJECT_COLORS.length;
  this.saveColors();  // ❌ BUG HERE - should be await
  
  return colorIndex;
}
```

---

## HIGH PRIORITY ISSUES

### 2. Synchronous File Operations in Hook Scripts (Embedded Node.js)
**File:** `/Users/ivanforcytebio/Projects/Monet/src/hooksInstaller.ts`  
**Lines:** 68, 93, 105, 106, 191, 199, 208, 210, 211, 214  
**Severity:** HIGH

The embedded Node.js scripts use synchronous file operations (`readFileSync`, `writeFileSync`, `mkdirSync`, `renameSync`) in scripts that are executed as hooks during Claude Code's runtime:

**MONET_STATUS_SCRIPT (lines 68, 93, 105-106):**
```javascript
// Line 68
const existing = JSON.parse(fs.readFileSync(statusFile, 'utf8'));

// Line 93
fs.mkdirSync(statusDir, { recursive: true });

// Line 105-106
fs.writeFileSync(tmpFile, JSON.stringify(statusData, null, 2));
fs.renameSync(tmpFile, statusFile);
```

**MONET_TITLE_SCRIPT (lines 191, 199, 208, 210-211, 214):**
```javascript
// Line 191
statusData = JSON.parse(fs.readFileSync(statusFile, 'utf8'));

// Line 199
fs.writeFileSync(flagFile, '');

// Line 208
fs.mkdirSync(statusDir, { recursive: true });

// Line 210-211
fs.writeFileSync(tmpFile, JSON.stringify(statusData, null, 2));
fs.renameSync(tmpFile, statusFile);

// Line 214
fs.writeFileSync(flagFile, '');
```

**Impact:** These hooks are called synchronously within Claude Code's execution flow. While they intentionally use sync operations (for safety and simplicity), they could block Claude's event loop during large file operations or on slow filesystems.

**Note:** The comment on lines 110-111 indicates this is intentional ("Never fail loudly - exit silently on any error"), but it's worth monitoring for timeout issues.

---

### 3. Unused/Dead Code - ROMAN_NUMERALS and ROMAN_REGEX
**File:** `/Users/ivanforcytebio/Projects/Monet/src/types.ts`  
**Lines:** 10-21  
**Severity:** HIGH

The following code appears to be vestigial from an older design iteration:

```typescript
// Roman numeral conversion (1-20)
const ROMAN_NUMERALS = [
  '', 'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x',
  'xi', 'xii', 'xiii', 'xiv', 'xv', 'xvi', 'xvii', 'xviii', 'xix', 'xx'
];

export function toRoman(n: number): string {
  if (n < 1 || n > 20) return String(n);
  return ROMAN_NUMERALS[n];
}

// Regex to match roman numerals in terminal names (title is optional)
export const ROMAN_REGEX = /^(.+) (i{1,3}|iv|v|vi{0,3}|ix|x{1,2}|xi{1,3}|xiv|xv|xvi{0,3}|xix|xx):(.*)$/;
```

**Verification:** Search shows `toRoman`, `ROMAN_NUMERALS`, and `ROMAN_REGEX` are exported but never imported or used anywhere in the codebase.

**Impact:** Code bloat. The current design uses emoji + title directly (e.g., `🟢 Refactoring PaymentProcessor`), not position numbers.

**Recommendation:** Remove this dead code.

---

### 4. Type Assertion Without Safety Check
**File:** `/Users/ivanforcytebio/Projects/Monet/src/sessionManager.ts`  
**Line:** 163  
**Severity:** HIGH

```typescript
status: status as SessionStatusFile['status'],
```

The `status` parameter is typed as `string` but is cast to `SessionStatusFile['status']` without validation:

```typescript
// Line 158
private async writeStatusFile(slot: number, project: string, status: string, title: string, error?: string) {
  const statusFile = path.join(STATUS_DIR, `pos-${slot}.json`);
  const content: SessionStatusFile = {
    position: slot,
    project,
    status: status as SessionStatusFile['status'],  // ❌ No validation
    title,
    updated: Date.now()
  };
```

**Valid values** per `types.ts`:
```typescript
export const STATUS_EMOJI: Record<string, string> = {
  active: '🟢',
  idle: '⚪',
  waiting: '🟡'
};

status: keyof typeof STATUS_EMOJI;
```

**Callers:** `writeStatusFile()` is never called in the codebase. It appears to be dead code.

**Impact:** If this method is ever used with an invalid status value, the type system won't catch it.

---

## MODERATE ISSUES

### 5. Empty Array Edge Case in projectManager.ts
**File:** `/Users/ivanforcytebio/Projects/Monet/src/projectManager.ts`  
**Line:** 19  
**Severity:** MODERATE

```typescript
this.nextColorIndex = Math.max(0, ...Array.from(this.projectColors.values())) + 1;
```

When `projectColors` is empty (first run):
- `Array.from(this.projectColors.values())` returns `[]`
- `Math.max(0, ...[])` returns `0` (because of the first argument `0`)
- `nextColorIndex = 0 + 1 = 1`

This is actually correct (colors are 0-indexed, so starting at 1 is fine), but it's a subtle edge case. If the explicit `0` argument were removed, it would break:

```typescript
// ❌ Wrong - would be -Infinity on empty array
Math.max(...Array.from(this.projectColors.values())) + 1

// ✓ Correct - has fallback
Math.max(0, ...Array.from(this.projectColors.values())) + 1
```

**Impact:** None currently (code is correct), but it's fragile. A comment would help.

---

### 6. Hook Filtering Logic Uses JSON.stringify String Search
**File:** `/Users/ivanforcytebio/Projects/Monet/src/hooksManager.ts`  
**Lines:** 57, 143  
**Severity:** MODERATE

```typescript
// Lines 56-59
if (settings.hooks[event]) {
  settings.hooks[event] = settings.hooks[event]!.filter(
    (group: HookGroup) => !JSON.stringify(group).includes(MONET_TAG)
  );
}
```

This is a brittle approach:
- If `__monet__` appears anywhere in the JSON (e.g., in a comment or user's hook name), it will be matched
- The spread operator on entire object means a regex match on the serialized string

**Example that would break:**
```json
{
  "hooks": {
    "PostToolUse": [
      {
        "hooks": [{
          "command": "echo 'running monet-status'"  // ← Contains "monet" substring!
        }]
      }
    ]
  }
}
```

**Better approach:** Explicitly check the `command` field:

```typescript
(group: HookGroup) => !group.hooks?.some(h => h.command?.includes(MONET_TAG))
```

**Impact:** Low risk in practice (user hooks unlikely to contain `__monet__`), but not ideal for production.

---

### 7. Status Emoji Definition Mismatch with Spec
**File:** `/Users/ivanforcytebio/Projects/Monet/src/types.ts`  
**Lines:** 3-7  
**Severity:** MODERATE

The current implementation defines 3 statuses:
```typescript
export const STATUS_EMOJI: Record<string, string> = {
  active: '🟢',
  idle: '⚪',
  waiting: '🟡'
};
```

However, `SessionStatusFile` includes an `error?` field (line 67) and the spec mentions error emoji (🔴) and complete emoji (✅):

From `MONET_V0_FINAL.md` lines 22-23:
```
🟢 P1: Refactoring PaymentProcessor    [active]
🔴 P3: Auth test fixtures              [error]
```

The current implementation doesn't support error or complete statuses, even though:
1. The interface has an `error?` field
2. The BUILD_LOG mentions simplified statuses
3. But there's no error emoji defined

**Impact:** If hooks try to set status to `'error'` or `'complete'`, the emoji will be undefined and fall back to `'⚪'` (line 77 in statusWatcher.ts):

```typescript
const emoji = STATUS_EMOJI[status.status] || '⚪';
```

---

### 8. Missing Error Status Symbol in Terminal Names
**File:** `/Users/ivanforcytebio/Projects/Monet/src/statusWatcher.ts`  
**Line:** 77  
**Severity:** MODERATE

**Current behavior:**
```typescript
const emoji = STATUS_EMOJI[status.status] || '⚪';
```

If a status isn't in `STATUS_EMOJI`, it silently falls back to `'⚪'` (idle). This masks bugs. Better to:

```typescript
if (!STATUS_EMOJI[status.status]) {
  console.warn(`Unknown status: ${status.status}`);
}
const emoji = STATUS_EMOJI[status.status] || '⚪';
```

---

## LOW PRIORITY ISSUES

### 9. Loose Equality in Hook Script Filtering
**File:** `/Users/ivanforcytebio/Projects/Monet/src/hooksManager.ts`  
**Lines:** 57, 143  
**Severity:** LOW

Uses `!==` correctly (strict comparison), but for consistency with modern TypeScript practices, this is fine.

---

### 10. Incomplete "New Branch" Feature
**File:** `/Users/ivanforcytebio/Projects/Monet/src/extension.ts`  
**Lines:** 64-67  
**Severity:** LOW

The `newBranch` command is a placeholder:

```typescript
const newBranchCmd = vscode.commands.registerCommand('monet.newBranch', async () => {
  vscode.window.showInformationMessage('Monet: New Branch (coming in Step 5 - worktrees)');
  vscode.commands.executeCommand('workbench.action.terminal.focus');
});
```

This is noted in BUILD_LOG.md as Step 5 (worktrees). Not a bug, but a feature gap.

---

### 11. No Null Check After Promise Rejection in installHookScripts
**File:** `/Users/ivanforcytebio/Projects/Monet/src/hooksInstaller.ts`  
**Line:** 244  
**Severity:** LOW

```typescript
if (!(await needsUpdate())) {
  return;
}
```

If `needsUpdate()` rejects, the promise rejection is unhandled (no `.catch()`). The surrounding try/catch (line 242) catches errors from file writes, but not from the promise chain itself.

**Better approach:**
```typescript
if (!(await needsUpdate().catch(() => true))) {
  return;
}
```

**Impact:** Minimal (extension still works, just logs errors), but not ideal.

---

## ASYNC/AWAIT ISSUES

### 12. Potential Fire-and-Forget Command Executions
**File:** `/Users/ivanforcytebio/Projects/Monet/src/extension.ts`  
**Lines:** 40, 43, 46, 49, 59, 66, 91, 130, 132  
**Severity:** LOW

Many command executions are not awaited:

```typescript
// Line 40
vscode.commands.executeCommand('monet.newSession');

// Line 59
vscode.commands.executeCommand('workbench.action.terminal.focus');
```

These are intentional (no need to wait for UI commands to complete), but some could benefit from await:

```typescript
// Line 130 - should wait for reveal
vscode.commands.executeCommand('revealInExplorer', uri);
```

**Impact:** Minor. The API returns a Promise that's ignored, which TypeScript allows.

---

## STRUCTURAL/DESIGN ISSUES

### 13. StatusWatcher Has No Interface Contract
**File:** `/Users/ivanforcytebio/Projects/Monet/src/statusWatcher.ts`  
**Severity:** LOW

The `SessionManager` depends on `StatusWatcher` having a `setSessionManager()` method, but there's no interface. This is not type-safe:

```typescript
// extension.ts line 21
statusWatcher.setSessionManager(sessionManager);
```

Should be:
```typescript
interface IStatusWatcher {
  start(): void;
  stop(): void;
  setSessionManager(sm: SessionManager): void;
  getStatus(slot: number): Promise<SessionStatusFile | null>;
}
```

**Impact:** Low in practice (both classes are internal), but reduces code robustness.

---

### 14. Tree View Provider Has No Error Handling
**File:** `/Users/ivanforcytebio/Projects/Monet/src/extension.ts`  
**Lines:** 161-174  
**Severity:** LOW

The `MonetTreeProvider` doesn't implement `onDidChangeTreeData` or handle state changes:

```typescript
class MonetTreeProvider implements vscode.TreeDataProvider<MonetActionItem> {
  getTreeItem(element: MonetActionItem): vscode.TreeItem {
    return element;
  }

  getChildren(): MonetActionItem[] {
    return [
      // static list...
    ];
  }
  // ❌ No onDidChangeTreeData event emitter
}
```

This is fine for a static tree, but if the tree ever needs to update, you'll need:

```typescript
private _onDidChangeTreeData: vscode.EventEmitter<MonetActionItem | undefined | null | void> = new vscode.EventEmitter<MonetActionItem | undefined | null | void>();
readonly onDidChangeTreeData: vscode.Event<MonetActionItem | undefined | null | void> = this._onDidChangeTreeData.event;
```

**Impact:** None currently (tree is static), but it's incomplete.

---

## CONFIGURATION ISSUES

### 15. Package.json Missing Cursor-Specific Notes
**File:** `/Users/ivanforcytebio/Projects/Monet/package.json`  
**Severity:** LOW

The extension targets Cursor first (per MONET_V0_FINAL.md), but `package.json` doesn't mention this:

```json
{
  "engines": {
    "vscode": "^1.85.0"
  },
  // ❌ No publisher name or repository
  "publisher": "monet",
  // ❌ No icon, repository, bugs, homepage
}
```

Should add:
```json
{
  "publisher": "your-org",
  "repository": "https://github.com/...",
  "bugs": "https://github.com/.../issues",
  "icon": "icons/monet.png"
}
```

**Impact:** None functionally. Only affects extension marketplace appearance.

---

## COMPREHENSIVE ISSUE SUMMARY TABLE

| # | Issue | File | Line | Severity | Type | Status |
|---|-------|------|------|----------|------|--------|
| 1 | Missing `await` on saveColors() | projectManager.ts | 43 | CRITICAL | Async/Await | Fire-and-forget |
| 2 | Sync file ops in hook scripts | hooksInstaller.ts | 68,93,105,106,191,199,208,210,211,214 | HIGH | Perf | Intentional but risky |
| 3 | Unused ROMAN_NUMERALS code | types.ts | 10-21 | HIGH | Dead Code | Should remove |
| 4 | Unsafe type assertion | sessionManager.ts | 163 | HIGH | Type Safety | Never called |
| 5 | Empty array edge case | projectManager.ts | 19 | MODERATE | Edge Case | Works but fragile |
| 6 | Brittle hook filtering | hooksManager.ts | 57,143 | MODERATE | Logic | String matching |
| 7 | Status emoji mismatch with spec | types.ts | 3-7 | MODERATE | Spec Mismatch | Inconsistent design |
| 8 | Silent emoji fallback | statusWatcher.ts | 77 | MODERATE | Error Handling | Hides bugs |
| 9 | Incomplete New Branch | extension.ts | 64-67 | LOW | Feature Gap | Documented |
| 10 | Promise rejection not caught | hooksInstaller.ts | 244 | LOW | Async/Await | Minimal impact |
| 11 | Fire-and-forget commands | extension.ts | 40,43,46,49,59,66,91,130,132 | LOW | Async/Await | Expected behavior |
| 12 | No interface contract | statusWatcher.ts | - | LOW | Design | Internal only |
| 13 | Incomplete tree provider | extension.ts | 161-174 | LOW | Design | Static tree ok |
| 14 | Missing package metadata | package.json | - | LOW | Config | Cosmetic |

---

## RECOMMENDATIONS (Priority Order)

### Must Fix (Blocking)
1. **Issue #1** - Add `await` to `saveColors()` in projectManager.ts line 43
2. **Issue #3** - Remove dead `ROMAN_NUMERALS`, `toRoman()`, and `ROMAN_REGEX` code
3. **Issue #4** - Either remove `writeStatusFile()` or validate status parameter
4. **Issue #6** - Replace brittle `JSON.stringify().includes()` logic with explicit field checks

### Should Fix (High Impact)
5. **Issue #7** - Clarify status emoji support (add error/complete or remove from types)
6. **Issue #8** - Add console.warn for unknown statuses instead of silent fallback

### Nice to Have
7. Fix promise rejection handling in `installHookScripts()`
8. Add interface contract for `StatusWatcher`
9. Add package.json metadata
10. Add comment explaining Math.max edge case

---

## Compilation & Build Status

- **TypeScript Config:** ✓ Valid (tsconfig.json)
- **Compiled Output:** ✓ Exists (dist/extension.js, 30KB)
- **Source Maps:** ✓ Generated (sourceMap: true in tsconfig)
- **Declarations:** ✓ Enabled (declaration: true)
- **Strict Mode:** ✓ Enabled (strict: true)

---

## Testing Recommendations

1. Test color persistence across extension restarts
2. Test hook filtering with user hooks containing "monet" substring
3. Stress test hook script on slow filesystems (sync ops may timeout)
4. Test with empty projects directory (edge case in ProjectManager)
5. Test terminal renaming under high load (rename queue)

