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
// SessionId is hardcoded directly into hook commands (unique per session, never collides across projects)
//
// Hooks (4 active):
// 1. UserPromptSubmit → status "active" (🟢 green - Claude working)
// 2. PreToolUse → DISABLED (was causing jitter with rapid status changes)
// 3. Notification → status "waiting" (🟡 yellow - needs input)
// 4. Stop → status "idle" (⚪ white - done)
// 5. Stop (second hook) → monet-title-check
export async function installHooks(projectPath: string, sessionId: string): Promise<void> {
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
    // SessionId is baked directly into each command (unique per session)

    // 1. UserPromptSubmit → status "active" (user sent prompt, Claude working)
    // Goes straight to green to avoid jitter from rapid thinking→active transitions
    if (!settings.hooks.UserPromptSubmit) {
      settings.hooks.UserPromptSubmit = [];
    }
    settings.hooks.UserPromptSubmit.push({
      hooks: [{
        type: 'command',
        command: `~/.monet/bin/monet-status ${sessionId} active ${MONET_TAG}`,
        async: true,
        timeout: 5
      }]
    });

    // 2. PreToolUse - DISABLED to reduce jitter
    // TODO: Future - re-enable with "thinking" status when jitter is resolved
    // The idea: UserPromptSubmit→thinking (🔵), PreToolUse→active (🟢)
    // For now: UserPromptSubmit→active (🟢), stays green until waiting/idle
    //
    // if (!settings.hooks.PreToolUse) {
    //   settings.hooks.PreToolUse = [];
    // }
    // settings.hooks.PreToolUse.push({
    //   hooks: [{
    //     type: 'command',
    //     command: `~/.monet/bin/monet-status ${sessionId} active ${MONET_TAG}`,
    //     async: true,
    //     timeout: 5
    //   }]
    // });

    // 3. Notification → status "waiting" (Claude needs user input/permission)
    if (!settings.hooks.Notification) {
      settings.hooks.Notification = [];
    }
    settings.hooks.Notification.push({
      hooks: [{
        type: 'command',
        command: `~/.monet/bin/monet-status ${sessionId} waiting ${MONET_TAG}`,
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
        command: `~/.monet/bin/monet-status ${sessionId} idle ${MONET_TAG}`,
        async: true,
        timeout: 5
      }]
    });

    // 5. Stop (second hook) → monet-title-check (generates title via claude -p)
    settings.hooks.Stop.push({
      hooks: [{
        type: 'command',
        command: `~/.monet/bin/monet-title-check ${sessionId} ${MONET_TAG}`,
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
