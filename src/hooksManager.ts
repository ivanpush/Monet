import * as path from 'path';
import * as fs from 'fs/promises';

const MONET_TAG = '__monet__';

interface HookConfig {
  type: 'command';
  command: string;
  async?: boolean;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookConfig[];
}

interface ClaudeSettings {
  hooks?: {
    UserPromptSubmit?: HookGroup[];
    PreToolUse?: HookGroup[];
    Notification?: HookGroup[];
    Stop?: HookGroup[];
    [key: string]: HookGroup[] | undefined;
  };
  [key: string]: unknown;
}

// Install Monet hooks into project's .claude/settings.local.json
// Merges with existing settings, never overwrites user hooks
// Position is hardcoded directly into hook commands
//
// Hooks (5 total):
// 1. UserPromptSubmit → status "thinking"
// 2. PostToolUse (no matcher) → status "active"
// 3. Notification → status "waiting"
// 4. Stop → status "idle"
// 5. Stop (second hook) → monet-title-check
export async function installHooks(projectPath: string, position: number): Promise<void> {
  const claudeDir = path.join(projectPath, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.local.json');

  try {
    // Ensure .claude directory exists
    await fs.mkdir(claudeDir, { recursive: true });

    // Read existing settings or start fresh
    let settings: ClaudeSettings = {};
    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      settings = JSON.parse(content);
    } catch {
      // File doesn't exist or invalid JSON, start fresh
    }

    // Ensure hooks structure exists
    if (!settings.hooks) {
      settings.hooks = {};
    }

    // Remove any existing Monet hooks first (to update them)
    // Include PostToolUse for backwards compat (old code used PostToolUse, now we use PreToolUse)
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop']) {
      if (settings.hooks[event]) {
        settings.hooks[event] = settings.hooks[event]!.filter(
          (group: HookGroup) => !JSON.stringify(group).includes(MONET_TAG)
        );
      }
    }

    // Add fresh Monet hooks
    // Position is baked directly into each command

    // 1. UserPromptSubmit → status "thinking" (user sent prompt, Claude processing)
    if (!settings.hooks.UserPromptSubmit) {
      settings.hooks.UserPromptSubmit = [];
    }
    settings.hooks.UserPromptSubmit.push({
      hooks: [{
        type: 'command',
        command: `~/.monet/bin/monet-status ${position} thinking ${MONET_TAG}`,
        async: true,
        timeout: 5
      }]
    });

    // 2. PreToolUse → status "active" (Claude is about to use tools)
    // No matcher - matches all tools
    if (!settings.hooks.PreToolUse) {
      settings.hooks.PreToolUse = [];
    }
    settings.hooks.PreToolUse.push({
      hooks: [{
        type: 'command',
        command: `~/.monet/bin/monet-status ${position} active ${MONET_TAG}`,
        async: true,
        timeout: 5
      }]
    });

    // 3. Notification → status "waiting" (Claude needs user input/permission)
    if (!settings.hooks.Notification) {
      settings.hooks.Notification = [];
    }
    settings.hooks.Notification.push({
      hooks: [{
        type: 'command',
        command: `~/.monet/bin/monet-status ${position} waiting ${MONET_TAG}`,
        async: true,
        timeout: 5
      }]
    });

    // 4. Stop → status "idle" (Claude finished responding)
    if (!settings.hooks.Stop) {
      settings.hooks.Stop = [];
    }
    settings.hooks.Stop.push({
      hooks: [{
        type: 'command',
        command: `~/.monet/bin/monet-status ${position} idle ${MONET_TAG}`,
        async: true,
        timeout: 5
      }]
    });

    // 5. Stop (second hook) → monet-title-check (generates title via claude -p)
    settings.hooks.Stop.push({
      hooks: [{
        type: 'command',
        command: `~/.monet/bin/monet-title-check ${position} ${MONET_TAG}`,
        async: true,
        timeout: 20
      }]
    });

    // Write atomically
    const tmpPath = settingsPath + '.tmp';
    await fs.writeFile(tmpPath, JSON.stringify(settings, null, 2));
    await fs.rename(tmpPath, settingsPath);

  } catch (err) {
    console.error('Monet: Failed to install hooks:', err);
  }
}

// Remove Monet hooks from project's .claude/settings.local.json
// Only removes Monet-tagged hooks, preserves user hooks
export async function removeHooks(projectPath: string): Promise<void> {
  const settingsPath = path.join(projectPath, '.claude', 'settings.local.json');

  try {
    const content = await fs.readFile(settingsPath, 'utf-8');
    const settings: ClaudeSettings = JSON.parse(content);

    if (!settings.hooks) {
      return;
    }

    // Remove Monet hooks from each event type
    for (const event of Object.keys(settings.hooks)) {
      if (settings.hooks[event]) {
        settings.hooks[event] = settings.hooks[event]!.filter(
          (group: HookGroup) => !JSON.stringify(group).includes(MONET_TAG)
        );
        // Clean up empty arrays
        if (settings.hooks[event]!.length === 0) {
          delete settings.hooks[event];
        }
      }
    }

    // Clean up empty hooks object
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    // Write atomically
    const tmpPath = settingsPath + '.tmp';
    await fs.writeFile(tmpPath, JSON.stringify(settings, null, 2));
    await fs.rename(tmpPath, settingsPath);

  } catch {
    // File doesn't exist or invalid, nothing to clean
  }
}
