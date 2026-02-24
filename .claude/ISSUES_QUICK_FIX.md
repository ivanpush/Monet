# Monet Extension - Issues Quick Fix Guide

## CRITICAL (Must Fix Immediately)

### Issue #1: Missing `await` on saveColors()
**File:** `src/projectManager.ts`  
**Line:** 43

```typescript
// BEFORE (WRONG):
this.saveColors();

// AFTER (CORRECT):
await this.saveColors();
```

**Why:** Colors won't persist to globalState if extension crashes before promise resolves.

---

### Issue #2: Remove Dead Code
**File:** `src/types.ts`  
**Lines:** 10-21

DELETE these lines completely:
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

**Why:** These are from old design (position numbers). Current design uses emoji+title.

---

### Issue #3: Dead Method in sessionManager
**File:** `src/sessionManager.ts`  
**Lines:** 157-175

Either DELETE the entire `writeStatusFile()` method OR add validation:

```typescript
// OPTION A: DELETE (if it's never called)
// (remove lines 157-175 entirely)

// OPTION B: ADD VALIDATION (if you want to keep it)
private async writeStatusFile(slot: number, project: string, status: string, title: string, error?: string) {
  // Add validation
  const validStatuses = ['active', 'idle', 'waiting'];
  if (!validStatuses.includes(status)) {
    console.error(`Invalid status: ${status}`);
    return;
  }
  
  // ... rest of method
  status: status as SessionStatusFile['status'],
  // ...
}
```

**Why:** Type assertion without validation allows invalid statuses.

---

### Issue #4: Brittle Hook Filtering
**File:** `src/hooksManager.ts`  
**Lines:** 56-59 and 141-144

```typescript
// BEFORE (BRITTLE):
settings.hooks[event] = settings.hooks[event]!.filter(
  (group: HookGroup) => !JSON.stringify(group).includes(MONET_TAG)
);

// AFTER (EXPLICIT):
settings.hooks[event] = settings.hooks[event]!.filter(
  (group: HookGroup) => !group.hooks?.some(h => h.command?.includes(MONET_TAG))
);
```

Apply this change to BOTH locations (lines 56-59 and 141-144).

**Why:** String matching can accidentally delete user hooks if they contain "__monet__" substring.

---

## HIGH PRIORITY (Should Fix Soon)

### Issue #5: Status Emoji Missing Error/Complete
**File:** `src/types.ts`  
**Lines:** 3-7

Choose ONE option:

**OPTION A: Add error and complete statuses**
```typescript
export const STATUS_EMOJI: Record<string, string> = {
  active: '🟢',
  idle: '⚪',
  waiting: '🟡',
  error: '🔴',
  complete: '✅'
};
```

**OPTION B: Remove error field from interface**
```typescript
// In SessionStatusFile interface, change:
error?: string;          // ← DELETE THIS LINE
```

**Why:** Current design only has 3 statuses but interface suggests 5.

---

### Issue #6: Add Warning for Unknown Statuses
**File:** `src/statusWatcher.ts`  
**Line:** 77

```typescript
// BEFORE (SILENT FALLBACK):
const emoji = STATUS_EMOJI[status.status] || '⚪';

// AFTER (WITH WARNING):
if (!STATUS_EMOJI[status.status]) {
  console.warn(`Monet: Unknown status "${status.status}", using idle emoji`);
}
const emoji = STATUS_EMOJI[status.status] || '⚪';
```

**Why:** Helps catch bugs when invalid statuses are written to status files.

---

## MODERATE ISSUES (Nice to Have)

### Issue #7: Add Comment for Math.max Edge Case
**File:** `src/projectManager.ts`  
**Line:** 19

```typescript
// BEFORE:
this.nextColorIndex = Math.max(0, ...Array.from(this.projectColors.values())) + 1;

// AFTER:
// Math.max(0, ...[]) returns 0 (not -Infinity) due to explicit 0 argument
this.nextColorIndex = Math.max(0, ...Array.from(this.projectColors.values())) + 1;
```

**Why:** Explains why the explicit `0` argument is necessary for safety.

---

### Issue #8: Fix Promise Rejection Handling
**File:** `src/hooksInstaller.ts`  
**Line:** 244

```typescript
// BEFORE:
if (!(await needsUpdate())) {
  return;
}

// AFTER:
if (!(await needsUpdate().catch(() => true))) {
  return;
}
```

**Why:** Prevents unhandled promise rejections.

---

## OPTIONAL IMPROVEMENTS

### Add Interface Contract for StatusWatcher
**File:** `src/statusWatcher.ts`  

Add at top of file:
```typescript
export interface IStatusWatcher {
  start(): void;
  stop(): void;
  setSessionManager(sm: SessionManager): void;
  getStatus(slot: number): Promise<SessionStatusFile | null>;
}
```

Then change class declaration:
```typescript
export class StatusWatcher implements IStatusWatcher {
  // ... rest stays same
}
```

---

### Complete Tree View Provider
**File:** `src/extension.ts`  
**Lines:** 161-174

Add to `MonetTreeProvider` class:
```typescript
private _onDidChangeTreeData: vscode.EventEmitter<MonetActionItem | undefined | null | void> = 
  new vscode.EventEmitter<MonetActionItem | undefined | null | void>();

readonly onDidChangeTreeData: vscode.Event<MonetActionItem | undefined | null | void> = 
  this._onDidChangeTreeData.event;
```

---

## TESTING AFTER FIXES

```bash
# 1. Recompile
npm run compile

# 2. Test in Cursor
# Press F5 to launch extension dev host

# 3. Manual tests:
□ Create new session, close extension, restart → color should persist
□ Create hooks with "monet" in command → should NOT be deleted
□ Check console for warnings about unknown statuses
□ Verify all commands execute without errors
```

---

## SUMMARY

| Priority | Count | Action |
|----------|-------|--------|
| CRITICAL | 4 | Must fix before production |
| HIGH | 2 | Should fix this week |
| MODERATE | 2 | Nice to fix soon |
| OPTIONAL | 2 | Can do later |

**Estimated fix time:** 30-45 minutes for all critical + high issues.
