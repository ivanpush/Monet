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
// Usage: monet-status <position> <status> [__monet__]
// Updates ONLY the status field and timestamp. NEVER touches the title.
// ============================================================================
const MONET_STATUS_SCRIPT = `#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

try {
  const args = process.argv.slice(2).filter(a => a !== '__monet__');
  const position = parseInt(args[0], 10);
  const status = args[1] || 'idle';

  if (isNaN(position)) {
    process.exit(0);
  }

  const statusDir = path.join(os.homedir(), '.monet', 'status');
  const statusFile = path.join(statusDir, 'pos-' + position + '.json');

  // Read existing status file to preserve all fields except status
  let statusData = {
    position: position,
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
// Usage: monet-title <position> <title>
// Updates ONLY the title field and timestamp. Called by /title slash command.
// ============================================================================
const MONET_TITLE_SCRIPT = `#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

try {
  const args = process.argv.slice(2).filter(a => a !== '__monet__');
  const position = parseInt(args[0], 10);
  const newTitle = args.slice(1).join(' ').trim();

  if (isNaN(position)) {
    console.error('Usage: monet-title <position> <title>');
    process.exit(1);
  }

  if (!newTitle) {
    console.error('Usage: monet-title <position> <title>');
    process.exit(1);
  }

  const statusDir = path.join(os.homedir(), '.monet', 'status');
  const statusFile = path.join(statusDir, 'pos-' + position + '.json');

  // Read existing status file to preserve all fields except title
  let statusData = {
    position: position,
    project: path.basename(process.cwd()),
    status: 'idle',
    title: newTitle,
    updated: Date.now()
  };

  try {
    const existing = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    // Preserve existing data, only update title and timestamp
    statusData = {
      ...existing,
      title: newTitle,
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
// Usage: monet-title-check <position> [__monet__]
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
  const position = parseInt(args[0], 10);

  if (isNaN(position)) {
    process.exit(0);
  }

  const statusDir = path.join(os.homedir(), '.monet', 'status');
  const statusFile = path.join(statusDir, 'pos-' + position + '.json');

  // Read existing status
  let statusData = null;
  try {
    statusData = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  } catch {
    process.exit(0);
  }

  // If title already set, we're done
  if (statusData.title && statusData.title.length > 0) {
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

// Compute hash of scripts to detect when they need updating
function computeScriptsHash(): string {
  const combined = MONET_STATUS_SCRIPT + MONET_TITLE_SCRIPT + MONET_TITLE_CHECK_SCRIPT;
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

    // Write version hash
    const currentHash = computeScriptsHash();
    await fs.writeFile(VERSION_FILE, currentHash);

    console.log('Monet: Hook scripts installed/updated');
  } catch (err) {
    console.error('Monet: Failed to install hook scripts:', err);
  }
}
