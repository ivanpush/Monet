import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';

const MONET_DIR = path.join(os.homedir(), '.monet');
const BIN_DIR = path.join(MONET_DIR, 'bin');
const STATUS_DIR = path.join(MONET_DIR, 'status');

// Version hash file to track when scripts need updating
const VERSION_FILE = path.join(BIN_DIR, '.version');

// ============================================================================
// monet-status script (Node.js)
// Usage: monet-status <sessionId> <status> [__monet__]
// Updates ONLY the status field and timestamp. NEVER touches the title.
// ============================================================================
const MONET_STATUS_SCRIPT = `#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

try {
  const args = process.argv.slice(2).filter(a => a !== '__monet__');
  const sessionId = args[0];
  const status = args[1] || 'idle';

  if (!sessionId || sessionId.length < 6) {
    process.exit(0);
  }

  const statusDir = path.join(os.homedir(), '.monet', 'status');
  const statusFile = path.join(statusDir, sessionId + '.json');

  // Read existing status file to preserve all fields except status
  let statusData = {
    sessionId: sessionId,
    project: path.basename(process.cwd()),
    status: status,
    title: '',
    updated: Date.now()
  };

  try {
    const existing = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    // Preserve existing data, only update status and timestamp
    statusData = {
      ...existing,
      status: status,
      updated: Date.now()
    };
  } catch {
    // No existing file, use defaults
  }

  // Write atomically
  fs.mkdirSync(statusDir, { recursive: true });
  const tmpFile = statusFile + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(statusData, null, 2));
  fs.renameSync(tmpFile, statusFile);

  process.exit(0);
} catch {
  process.exit(0);
}
`;

// ============================================================================
// monet-title script (Node.js)
// Usage: monet-title <sessionId> <title>
// Updates ONLY the title field and timestamp. Called by /title slash command.
// ============================================================================
const MONET_TITLE_SCRIPT = `#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

try {
  const args = process.argv.slice(2).filter(a => a !== '__monet__');
  const sessionId = args[0];
  const newTitle = args.slice(1).join(' ').trim();

  if (!sessionId || sessionId.length < 6) {
    console.error('Usage: monet-title <sessionId> <title>');
    process.exit(1);
  }

  if (!newTitle) {
    console.error('Usage: monet-title <sessionId> <title>');
    process.exit(1);
  }

  const statusDir = path.join(os.homedir(), '.monet', 'status');
  const statusFile = path.join(statusDir, sessionId + '.json');

  // Read existing status file to preserve all fields except title
  let statusData = {
    sessionId: sessionId,
    project: path.basename(process.cwd()),
    status: 'idle',
    title: newTitle,
    titleSource: 'manual',
    updated: Date.now()
  };

  try {
    const existing = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    // Preserve existing data, only update title and timestamp
    statusData = {
      ...existing,
      title: newTitle,
      titleSource: 'manual',
      updated: Date.now()
    };
  } catch {
    // No existing file, use defaults
  }

  // Write atomically
  fs.mkdirSync(statusDir, { recursive: true });
  const tmpFile = statusFile + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(statusData, null, 2));
  fs.renameSync(tmpFile, statusFile);

  console.log('Title updated: ' + newTitle);
  process.exit(0);
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
`;

// ============================================================================
// monet-title-check script (Node.js)
// Usage: monet-title-check <sessionId> [__monet__]
// Called on Stop hook. Generates title using claude -p with context from transcript.
//
// Logic:
// 1. If title already set → exit (title is set once, never overwritten)
// 2. Read stdin for hook JSON (contains transcript_path)
// 3. Read JSONL transcript, extract first user message and first assistant response
// 4. Call claude -p with haiku to generate a 3-5 word title
// 5. Validate output and write to status file
// ============================================================================
const MONET_TITLE_CHECK_SCRIPT = `#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Prevent recursive calls
if (process.env.MONET_TITLE_CHECK_RUNNING === '1') {
  process.exit(0);
}

try {
  const args = process.argv.slice(2).filter(a => a !== '__monet__');
  const sessionId = args[0];

  if (!sessionId || sessionId.length < 6) {
    process.exit(0);
  }

  const statusDir = path.join(os.homedir(), '.monet', 'status');
  const statusFile = path.join(statusDir, sessionId + '.json');

  // Read existing status
  let statusData = null;
  try {
    statusData = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  } catch {
    process.exit(0);
  }

  // Only overwrite "draft" titles. Never touch "final" or "manual".
  if (statusData.titleSource === 'final' || statusData.titleSource === 'manual') {
    process.exit(0);
  }

  // Read stdin for hook JSON
  let input = '';
  try {
    input = fs.readFileSync(0, 'utf8');
  } catch {}

  let hookData = {};
  try {
    if (input.trim()) {
      hookData = JSON.parse(input.trim());
    }
  } catch {}

  const transcriptPath = hookData.transcript_path;
  if (!transcriptPath) {
    process.exit(0);
  }

  // Expand ~ to home directory
  const fullPath = transcriptPath.replace(/^~/, os.homedir());

  // Read JSONL transcript
  let content = '';
  try {
    content = fs.readFileSync(fullPath, 'utf8');
  } catch {
    process.exit(0);
  }

  const lines = content.trim().split('\\n').filter(l => l.trim());

  // Find first user message and first assistant response
  let firstUserMsg = '';
  let firstAssistantMsg = '';

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      // Look for user/human message
      if (!firstUserMsg && (entry.type === 'human' || entry.type === 'user')) {
        const msgContent = entry.message?.content || entry.content;
        if (typeof msgContent === 'string') {
          firstUserMsg = msgContent;
        } else if (Array.isArray(msgContent)) {
          for (const block of msgContent) {
            if (block.type === 'text' && block.text) {
              firstUserMsg = block.text;
              break;
            }
          }
        }
      }

      // Look for assistant message
      if (!firstAssistantMsg && entry.type === 'assistant') {
        const msgContent = entry.message?.content || entry.content;
        if (typeof msgContent === 'string') {
          firstAssistantMsg = msgContent;
        } else if (Array.isArray(msgContent)) {
          for (const block of msgContent) {
            if (block.type === 'text' && block.text) {
              firstAssistantMsg = block.text;
              break;
            }
          }
        }
      }

      // Stop once we have both
      if (firstUserMsg && firstAssistantMsg) break;
    } catch {}
  }

  if (!firstUserMsg) {
    process.exit(0); // No user message to summarize
  }

  // Truncate for context
  const truncatedUser = firstUserMsg.slice(0, 200);
  const truncatedAssistant = firstAssistantMsg.slice(0, 500);

  // Find claude binary
  let claudeBin = null;
  const candidates = [
    path.join(os.homedir(), '.claude', 'local', 'claude'),
    'claude'
  ];

  for (const candidate of candidates) {
    try {
      execSync(candidate + ' --version', { timeout: 5000, stdio: 'pipe' });
      claudeBin = candidate;
      break;
    } catch {}
  }

  if (!claudeBin) {
    process.exit(0); // No claude binary found
  }

  // Build prompt
  let prompt = 'Name this coding task in 3-5 words. Output ONLY the title, nothing else. No quotes, no punctuation.\\n\\nUser asked: ' + truncatedUser;
  if (truncatedAssistant) {
    prompt += '\\n\\nClaude responded: ' + truncatedAssistant;
  }

  // Call claude -p with haiku - set env var to prevent recursion
  let titleOutput = '';
  try {
    titleOutput = execSync(
      claudeBin + ' -p --model haiku --max-turns 1 ' + JSON.stringify(prompt),
      {
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, { MONET_TITLE_CHECK_RUNNING: '1' })
      }
    ).toString().trim();
  } catch {
    process.exit(0);
  }

  // Validate output
  if (!titleOutput || titleOutput.length >= 60) {
    process.exit(0);
  }

  // If >8 words, truncate to first 5
  let words = titleOutput.split(/\\s+/);
  if (words.length > 8) {
    titleOutput = words.slice(0, 5).join(' ');
  }

  // Strip quotes and trailing punctuation
  titleOutput = titleOutput.replace(/^["']|["']$/g, '').replace(/[.!?,;:]+$/, '').trim();

  if (!titleOutput) {
    process.exit(0);
  }

  // Write title to status file atomically
  statusData.title = titleOutput;
  statusData.titleSource = 'final';
  statusData.updated = Date.now();

  fs.mkdirSync(statusDir, { recursive: true });
  const tmpFile = statusFile + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(statusData, null, 2));
  fs.renameSync(tmpFile, statusFile);

  process.exit(0);
} catch {
  process.exit(0);
}
`;

// ============================================================================
// monet-title-draft script (Node.js)
// Usage: echo '{"prompt":"..."}' | monet-title-draft <sessionId> [__monet__]
// Called on UserPromptSubmit. Sets a draft title from the user's first prompt.
//
// Logic:
// 1. Read stdin JSON, extract prompt text
// 2. If status file already has a title → exit (first prompt only)
// 3. Smart-truncate prompt to ~40 chars at word boundary, append "..."
// 4. Write to status file with titleSource: "draft"
// ============================================================================
const MONET_TITLE_DRAFT_SCRIPT = `#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

try {
  const args = process.argv.slice(2).filter(a => a !== '__monet__');
  const sessionId = args[0];

  if (!sessionId || sessionId.length < 6) {
    process.exit(0);
  }

  // Read stdin for hook JSON
  let input = '';
  try {
    input = fs.readFileSync(0, 'utf8');
  } catch {}

  let hookData = {};
  try {
    if (input.trim()) {
      hookData = JSON.parse(input.trim());
    }
  } catch {}

  // Extract prompt text defensively
  const prompt = (hookData.prompt || hookData.message || '').trim();
  if (!prompt) {
    process.exit(0);
  }

  const statusDir = path.join(os.homedir(), '.monet', 'status');
  const statusFile = path.join(statusDir, sessionId + '.json');

  // Read existing status file
  let statusData = null;
  try {
    statusData = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  } catch {
    // No status file yet, create fresh
    statusData = {
      sessionId: sessionId,
      project: path.basename(process.cwd()),
      status: 'active',
      title: '',
      updated: Date.now()
    };
  }

  // First-prompt only guard: if title already has any value, exit
  if (statusData.title && statusData.title.length > 0) {
    process.exit(0);
  }

  // Smart-truncate to ~40 chars at word boundary
  let title = prompt;
  if (title.length > 40) {
    title = title.slice(0, 40);
    const lastSpace = title.lastIndexOf(' ');
    if (lastSpace > 20) {
      title = title.slice(0, lastSpace);
    }
    title = title + '...';
  }

  // Write to status file with titleSource: "draft"
  statusData.title = title;
  statusData.titleSource = 'draft';
  statusData.updated = Date.now();

  fs.mkdirSync(statusDir, { recursive: true });
  const tmpFile = statusFile + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(statusData, null, 2));
  fs.renameSync(tmpFile, statusFile);

  process.exit(0);
} catch {
  process.exit(0);
}
`;

// ============================================================================
// monet CLI launcher script (Bash)
// Usage: monet [flags...]
// Context capture + launch request for Monet extension.
// Writes a JSON launch request to ~/.monet/launch/ for the extension to pick up.
// Restricted to Cursor/VS Code integrated terminals.
// ============================================================================
const MONET_LAUNCH_SCRIPT = `#!/usr/bin/env bash
# Monet CLI — context capture + launch request for Monet extension
# Restricted to Cursor/VS Code integrated terminals

# Guard: only run inside Cursor/VS Code
if [ "$TERM_PROGRAM" != "vscode" ]; then
  echo "monet: must be run from a Cursor/VS Code integrated terminal"
  exit 1
fi

LAUNCH_DIR="$HOME/.monet/launch"
mkdir -p "$LAUNCH_DIR"

# Capture context from invoking terminal
CWD="$(pwd)"
GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo '')"
GIT_BRANCH="$(git branch --show-current 2>/dev/null || echo '')"
TIMESTAMP="$(date +%s000)"
REQUEST_ID="$(openssl rand -hex 4)"

# All args forwarded to claude
ARGS="$*"

# Atomic write: tmp then rename
TMPFILE="$LAUNCH_DIR/.$REQUEST_ID.tmp"
TARGETFILE="$LAUNCH_DIR/$REQUEST_ID.json"

cat > "$TMPFILE" <<ENDJSON
{
  "requestId": "$REQUEST_ID",
  "cwd": "$CWD",
  "gitRoot": "$GIT_ROOT",
  "branch": "$GIT_BRANCH",
  "args": "$ARGS",
  "timestamp": $TIMESTAMP
}
ENDJSON

mv "$TMPFILE" "$TARGETFILE"
echo "Monet: session requested (cwd: $CWD)"
`;

// Compute hash of scripts to detect when they need updating
function computeScriptsHash(): string {
  const combined = MONET_STATUS_SCRIPT + MONET_TITLE_SCRIPT + MONET_TITLE_CHECK_SCRIPT + MONET_TITLE_DRAFT_SCRIPT + MONET_LAUNCH_SCRIPT;
  return crypto.createHash('sha256').update(combined).digest('hex').slice(0, 16);
}

// Check if scripts need to be installed/updated
async function needsUpdate(): Promise<boolean> {
  try {
    const currentHash = computeScriptsHash();
    const storedHash = await fs.readFile(VERSION_FILE, 'utf8');
    return storedHash.trim() !== currentHash;
  } catch {
    // Version file doesn't exist, needs install
    return true;
  }
}

// Install or update the hook scripts
export async function installHookScripts(): Promise<void> {
  try {
    // Check if update is needed
    if (!(await needsUpdate())) {
      return; // Scripts are up to date
    }

    // Ensure directories exist
    await fs.mkdir(BIN_DIR, { recursive: true });
    await fs.mkdir(STATUS_DIR, { recursive: true });

    // Write monet-status script
    const statusScript = path.join(BIN_DIR, 'monet-status');
    const statusTmp = statusScript + '.tmp';
    await fs.writeFile(statusTmp, MONET_STATUS_SCRIPT, { mode: 0o755 });
    await fs.rename(statusTmp, statusScript);

    // Write monet-title script (for /title slash command)
    const titleScript = path.join(BIN_DIR, 'monet-title');
    const titleTmp = titleScript + '.tmp';
    await fs.writeFile(titleTmp, MONET_TITLE_SCRIPT, { mode: 0o755 });
    await fs.rename(titleTmp, titleScript);

    // Write monet-title-check script
    const titleCheckScript = path.join(BIN_DIR, 'monet-title-check');
    const titleCheckTmp = titleCheckScript + '.tmp';
    await fs.writeFile(titleCheckTmp, MONET_TITLE_CHECK_SCRIPT, { mode: 0o755 });
    await fs.rename(titleCheckTmp, titleCheckScript);

    // Write monet-title-draft script
    const titleDraftScript = path.join(BIN_DIR, 'monet-title-draft');
    const titleDraftTmp = titleDraftScript + '.tmp';
    await fs.writeFile(titleDraftTmp, MONET_TITLE_DRAFT_SCRIPT, { mode: 0o755 });
    await fs.rename(titleDraftTmp, titleDraftScript);

    // Write monet CLI launcher script
    const launchScript = path.join(BIN_DIR, 'monet');
    const launchTmp = launchScript + '.tmp';
    await fs.writeFile(launchTmp, MONET_LAUNCH_SCRIPT, { mode: 0o755 });
    await fs.rename(launchTmp, launchScript);

    // Ensure launch directory exists
    const launchDir = path.join(MONET_DIR, 'launch');
    await fs.mkdir(launchDir, { recursive: true });

    // Write version hash
    const currentHash = computeScriptsHash();
    await fs.writeFile(VERSION_FILE, currentHash);

    console.log('Monet: Hook scripts installed/updated');
  } catch (err) {
    console.error('Monet: Failed to install hook scripts:', err);
  }
}
