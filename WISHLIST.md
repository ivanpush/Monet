# Monet Wishlist

*Created: 2026-03-01*

---

## 1. Color Change — Per-Session Status + Smart Apply

**Status:** Nice-to-have
**Priority:** Low
**Added:** 2026-03-02

### Ideas

- **Per-session status display with emoji** — Show each session's status inline in the QuickPick (e.g., `🟢 Fix auth`, `🟡 Refactor API`) so the user can see exactly which sessions are busy
- **"Apply idle only" third option** — Skip active sessions, only refresh idle ones. Note: has a gap — can't re-run color change to same color later to fix the skipped sessions
- **Deferred refresh** — `withProgress` polling that waits for all sessions to go idle before applying, with cancel button and timeout
- **Re-apply to skipped sessions** — Allow re-running color migration for sessions that were skipped earlier

---

## 2. `/refresh` Slash Command — Migrate Session to New Color

**Status:** Nice-to-have
**Priority:** Low
**Added:** 2026-03-01

### Problem

After changing a project color via `monet.changeColor`, existing terminals keep the old color (VS Code can't change terminal color after creation). They show a `⟲` stale indicator but the user has no way to apply the new color without manually creating a new session and losing context.

### Proposed Solution

One-shot `/refresh` slash command: new terminal opens with updated color continuing the same conversation, old terminal is killed — no manual `/exit` needed.

```
Boot: monet-title-draft captures Claude's session_id from hook stdin → writes to status file
  ↓
User types /refresh in Claude
  → Claude runs ~/.monet/bin/monet-refresh $MONET_SESSION_ID
  → Script reads claudeSessionId from status file
  → Writes launch request to ~/.monet/launch/ with:
      args: "--resume <claudeSessionId>"
      type: "refresh"
      closeSessionId, title, titleSource (carried over)
  → Extension picks up launch request
  → Creates new session with `claude --resume <id>` (new color)
  → Copies title from old session to new status file
  → Disposes old terminal
  → Done. User is in new terminal, same conversation, same title.
```

**Why `--resume <id>`:** Targets a specific conversation by UUID. Works even while old session runs — no need to wait for clean shutdown. Race-free (unlike `-c` which picks "most recent").

**Why capture in monet-title-draft:** It already reads stdin JSON on UserPromptSubmit. monet-status runs first in the `;` chain but does NOT read stdin, so stdin passes through intact. monet-title-draft only runs meaningfully on the first prompt (exits early after), so zero ongoing overhead. `...existing` spread in monet-status preserves `claudeSessionId` on all subsequent writes.

### Implementation Steps

#### Step 1: Add fields to SessionStatusFile

**File:** `src/types.ts` — line ~62

```typescript
claudeSessionId?: string;    // Claude CLI's internal session UUID (from hook stdin)
refreshRequested?: boolean;   // Set by /refresh, triggers session migration
```

No existing code reads these fields. Safe addition.

#### Step 2: Capture Claude's session_id in monet-title-draft

**File:** `src/hooksInstaller.ts` — `MONET_TITLE_DRAFT_SCRIPT`

After parsing `hookData` from stdin (line ~377), before the first-prompt guard:

```javascript
// Capture claudeSessionId even if title already set (needed for /refresh)
if (hookData.session_id && !statusData.claudeSessionId) {
  statusData.claudeSessionId = hookData.session_id;
  statusData.updated = Date.now();
  const tmpFile = statusFile + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(statusData, null, 2));
  fs.renameSync(tmpFile, statusFile);
}

// First-prompt only guard for TITLE — exit if title already set
if (statusData.title && statusData.title.length > 0) {
  process.exit(0);
}
```

This ensures `claudeSessionId` is captured on the very first prompt regardless of title state. Zero overhead on subsequent prompts (short-circuit on `!statusData.claudeSessionId`).

#### Step 3: Add monet-refresh script

**File:** `src/hooksInstaller.ts` — New `MONET_REFRESH_SCRIPT` constant

Node.js script (~45 lines):
1. Validate `$MONET_SESSION_ID` (non-empty, ≥6 chars)
2. Read status file `~/.monet/status/{sessionId}.json`
3. Check `claudeSessionId` exists (error if not: "Send at least one message first")
4. Read `projectPath` and `title`/`titleSource` from status file
5. Compute `gitRoot` from `projectPath`
6. Write launch request to `~/.monet/launch/{requestId}.json`:
   ```json
   {
     "requestId": "<random-hex>",
     "cwd": "<projectPath>",
     "gitRoot": "<gitRoot>",
     "args": "--resume <claudeSessionId>",
     "type": "refresh",
     "closeSessionId": "<monetSessionId>",
     "oldTitle": "<title>",
     "oldTitleSource": "<titleSource>",
     "timestamp": "<now>"
   }
   ```
7. Output: "Session refresh in progress. A new terminal will open shortly."

Also: add to `installHookScripts()` file writes, add to `computeScriptsHash()`.

#### Step 4: Handle refresh in processLaunchRequest

**File:** `src/statusWatcher.ts` — `processLaunchRequest()` method

After the existing `createSession()` call, add refresh handling:

```typescript
// Handle refresh: copy title from old session, dispose old terminal
if (request.type === 'refresh' && request.closeSessionId && newTerminal) {
  // Copy title from old session to new status file
  if (request.oldTitle) {
    const newSession = this.sessionManager.getSessionByTerminal(newTerminal);
    if (newSession) {
      const newStatusPath = path.join(STATUS_DIR, `${newSession.sessionId}.json`);
      try {
        const content = await fs.readFile(newStatusPath, 'utf-8');
        const statusData = JSON.parse(content);
        statusData.title = request.oldTitle;
        if (request.oldTitleSource) statusData.titleSource = request.oldTitleSource;
        const tmpPath = newStatusPath + '.tmp';
        await fs.writeFile(tmpPath, JSON.stringify(statusData, null, 2));
        await fs.rename(tmpPath, newStatusPath);
      } catch { /* status file may not exist yet, title-draft will handle */ }
    }
  }

  // Dispose old terminal (triggers deleteSession cleanup)
  const oldTerminal = this.sessionManager.getTerminalForSession(request.closeSessionId);
  if (oldTerminal) {
    oldTerminal.dispose();
  }
}
```

Need to also add `type`, `closeSessionId`, `oldTitle`, `oldTitleSource` to the launch request interface/parsing.

**Safety:** `createSession` completes first (awaited) → new session is in `this.sessions` → `deleteSession` on old terminal won't remove hooks (it sees new session exists for same project). Dispose is only called if `newTerminal` exists (guard against createSession failure).

#### Step 5: Install `/refresh` slash command

**File:** `src/extension.ts` — `installSlashCommandsCmd` handler (after title.md write)

```typescript
const refreshCommand = `Refresh this Monet session into a new terminal with the updated project color.

Run this command:
\`\`\`bash
~/.monet/bin/monet-refresh $MONET_SESSION_ID
\`\`\`

Run the bash command. No additional explanation needed.
`;
await fs.writeFile(path.join(claudeCommandsDir, 'refresh.md'), refreshCommand);
```

### Files Modified

| File | Change |
|------|--------|
| `src/types.ts` | Add `claudeSessionId?: string` and `refreshRequested?: boolean` to SessionStatusFile |
| `src/hooksInstaller.ts` | 1) monet-title-draft captures `session_id` from stdin, 2) new monet-refresh script, 3) install + hash |
| `src/statusWatcher.ts` | Handle `type: "refresh"` in processLaunchRequest — copy title, dispose old terminal |
| `src/extension.ts` | Write `refresh.md` in installSlashCommands |

**NOT modified:** sessionManager.ts, projectManager.ts, hooksManager.ts, package.json

### Attack Plan Results

| Issue | Severity | Fix |
|-------|----------|-----|
| **Title loss** — old title deleted with old status file | HIGH | monet-refresh passes `oldTitle`/`oldTitleSource` in launch request → extension copies to new status file |
| **Two Claude processes overlap** — brief window where both access conversation | MEDIUM | Accept: `--resume` loads a snapshot, old process killed immediately after. Window is <1 second. |
| **stdin consumed by wrong script** — monet-status could eat stdin | N/A | Design uses monet-title-draft (which reads stdin). monet-status does NOT read stdin. |
| **claudeSessionId not in TypeScript type** — future refactoring could drop it | MEDIUM | Added to `SessionStatusFile` interface |
| **createSession fails but old terminal disposed** — data loss | HIGH | Guard: only dispose if `newTerminal` is truthy |
| **Hook removal race** — deleteSession removes hooks before new session uses them | OK | `createSession` completes (awaited) before dispose → new session in `sessions` map → `remainingInProject` finds it |
| **No claudeSessionId yet** — /refresh before first prompt | LOW | monet-refresh checks and prints clear error |

### Verification

1. `npm run compile` — clean build
2. `npm run package` — produce VSIX
3. Install VSIX, run `Monet: Install Slash Commands`
4. Open a session, send a message → check `~/.monet/status/<id>.json` has `claudeSessionId`
5. Change project color via `Monet: Change Project Color`
6. Type `/refresh` in Claude
7. Verify: new terminal with updated color, old terminal gone, conversation resumes, title preserved
8. Test edge: `/refresh` before sending any message → should see clear error
9. Test edge: `/refresh` on non-stale session → should work (same color, harmless)
