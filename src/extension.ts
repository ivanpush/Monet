import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { ProjectManager } from './projectManager';
import { SessionManager } from './sessionManager';
import { StatusWatcher } from './statusWatcher';
import { installHookScripts } from './hooksInstaller';
import { PROJECT_COLORS, COLOR_DISPLAY_NAMES } from './types';
let projectManager: ProjectManager;
let sessionManager: SessionManager;
let statusWatcher: StatusWatcher;


export async function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Monet');
  outputChannel.appendLine(`Monet: activate() called at ${new Date().toISOString()}`);
  outputChannel.appendLine('Monet extension is now active');

  // Initialize managers FIRST (these are sync and won't throw)
  projectManager = new ProjectManager(context);
  sessionManager = new SessionManager(context, projectManager, outputChannel);
  statusWatcher = new StatusWatcher();
  statusWatcher.setSessionManager(sessionManager);
  statusWatcher.setProjectManager(projectManager);

  // Dispose stale Monet terminals from a previous Cursor session
  // (identified by name pattern, safe-guarded by PID matching against disk status files)
  try {
    await sessionManager.disposeStaleTerminals();
  } catch (err) {
    outputChannel.appendLine(`Monet: disposeStaleTerminals error: ${err}`);
  }

  // On fresh Cursor loads (no Monet terminals present):
  // 1. Clear globalState sessions
  // 2. Delete all stale status files (dead PIDs, no PIDs, junk filenames)
  // Skip this during Extension Host restarts where Monet terminals are still alive
  // (EH restart cleanup happens via cleanupUnmatchedStatusFiles after reconnection)
  if (!(await sessionManager.hasMonetTerminals())) {
    outputChannel.appendLine('Monet: Fresh load detected, running cleanup pass');
    sessionManager.clearGlobalStateSessions().catch(err => {
      outputChannel.appendLine(`Monet: Clear globalState error: ${err}`);
    });
    sessionManager.cleanupStaleStatusFiles().catch(err => {
      outputChannel.appendLine(`Monet: Cleanup error: ${err}`);
    });
  } else {
    outputChannel.appendLine('Monet: Extension Host restart detected, skipping cleanup');
  }

  // Register TreeView IMMEDIATELY (must happen before any async that could fail)
  const treeProvider = new MonetTreeProvider();
  const treeView = vscode.window.createTreeView('monet.sessions', {
    treeDataProvider: treeProvider
  });

  // Register all commands IMMEDIATELY
  const menuCmd = vscode.commands.registerCommand('monet.menu', async () => {
    const options = [
      { label: '$(add) New Session', description: 'Start a new Claude session', action: 'newSession' },
      { label: '$(terminal) New with Flags', description: 'Start with flags (e.g. --resume, --worktree)', action: 'newSessionWithFlag' },
      { label: '$(window) Change Project', description: 'Change active project', action: 'switchProject' }
    ];

    const picked = await vscode.window.showQuickPick(options, {
      placeHolder: 'Monet'
    });

    if (picked) {
      switch (picked.action) {
        case 'newSession':
          vscode.commands.executeCommand('monet.newSession');
          break;
        case 'newSessionWithFlag':
          vscode.commands.executeCommand('monet.newSessionWithFlag');
          break;
        case 'switchProject':
          vscode.commands.executeCommand('monet.switchProject');
          break;
      }
    }
  });

  const newSessionCmd = vscode.commands.registerCommand('monet.newSession', async () => {
    // If no current project, prompt user to select one first
    let project = projectManager.getCurrentProject();

    if (!project) {
      const projects = await projectManager.getAvailableProjects();

      if (projects.length === 0) {
        vscode.window.showErrorMessage('No projects found. Set monet.projectsRoot in settings.');
        return;
      }

      const picked = await vscode.window.showQuickPick(
        projects.map(p => ({ label: p.name, description: p.path, path: p.path })),
        { placeHolder: 'Select a project to start a session' }
      );

      if (!picked) {
        return; // User cancelled
      }

      // Set as active project and swap workspace
      await projectManager.setActiveProject(picked.path);
      vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length ?? 0, { uri: vscode.Uri.file(picked.path) });

      // Wait for VS Code to process workspace folder change before creating terminal
      await new Promise<void>(resolve => {
        const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => {
          listener.dispose();
          clearTimeout(timer);
          resolve();
        });
        const timer = setTimeout(() => { listener.dispose(); resolve(); }, 1000);
      });

      project = { name: picked.label, path: picked.path };
    }

    const terminal = await sessionManager.createSession();
    if (terminal) {
      vscode.commands.executeCommand('workbench.action.terminal.focus');
    }
  });

  const newSessionWithFlagCmd = vscode.commands.registerCommand('monet.newSessionWithFlag', async () => {
    const flags = await vscode.window.showInputBox({
      placeHolder: '--resume, --worktree feature/x, etc.',
      prompt: 'Claude flags'
    });

    if (flags === undefined) {
      return; // User cancelled
    }

    const terminal = await sessionManager.createSession({ claudeArgs: flags });
    if (terminal) {
      vscode.commands.executeCommand('workbench.action.terminal.focus');
    }
  });

  const resetCmd = vscode.commands.registerCommand('monet.reset', async () => {
    await sessionManager.resetAllSessions();
    vscode.window.showInformationMessage('Monet: All sessions reset');
  });

  const switchProjectCmd = vscode.commands.registerCommand('monet.switchProject', async () => {
    const projects = await projectManager.getAvailableProjects();

    const items: Array<{ label: string; description: string; path: string; kind?: vscode.QuickPickItemKind }> =
      projects.map(p => ({ label: p.name, description: p.path, path: p.path }));

    // "New Project" at the bottom
    items.push({ label: '$(add) New Project\u2026', description: 'Create a new project folder', path: '__new__' });

    let picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a project'
    });

    if (!picked) {
      return;
    }

    if (picked.path === '__new__') {
      const name = await vscode.window.showInputBox({
        prompt: 'Project name',
        placeHolder: 'my-new-project',
        validateInput: (value) => {
          if (!value || !value.trim()) return 'Name required';
          if (/[\/\\]/.test(value)) return 'Name cannot contain path separators';
          return null;
        }
      });
      if (!name) return;

      const projectsRoot = projectManager.getProjectsRoot();
      const newPath = path.join(projectsRoot, name.trim());
      try {
        await fs.mkdir(newPath, { recursive: true });
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to create project: ${err}`);
        return;
      }
      picked = { label: name.trim(), description: newPath, path: newPath };
    }

    // Save active project to globalState
    await projectManager.setActiveProject(picked.path);

    // Swap workspace: replace all folders with the new project
    vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length ?? 0, { uri: vscode.Uri.file(picked.path) });
    vscode.commands.executeCommand('workbench.action.terminal.focus');
  });

  // Install Claude Code slash commands to ~/.claude/commands/
  const installSlashCommandsCmd = vscode.commands.registerCommand('monet.installSlashCommands', async () => {
    try {
      const claudeCommandsDir = path.join(os.homedir(), '.claude', 'commands');
      await fs.mkdir(claudeCommandsDir, { recursive: true });

      // /title slash command - updates only the title, not status
      const titleCommand = `Change the title of this Monet session.

If a title is provided in $ARGUMENTS, use it directly:
\`\`\`bash
~/.monet/bin/monet-title $MONET_SESSION_ID $ARGUMENTS
\`\`\`

If $ARGUMENTS is empty, generate a concise 3-5 word title summarizing what this conversation accomplished, then run:
\`\`\`bash
~/.monet/bin/monet-title $MONET_SESSION_ID "<your generated title>"
\`\`\`

Run the bash command. No explanation needed.
`;

      const titlePath = path.join(claudeCommandsDir, 'title.md');
      await fs.writeFile(titlePath, titleCommand);

      vscode.window.showInformationMessage('Monet: Slash commands installed to ~/.claude/commands/');
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to install slash commands: ${err}`);
    }
  });

  const changeColorCmd = vscode.commands.registerCommand('monet.changeColor', async () => {
    const project = projectManager.getCurrentProject();
    if (!project) {
      vscode.window.showErrorMessage('Monet: No active project');
      return;
    }

    const currentIndex = projectManager.getColorIndexForProject(project.path);

    // Build set of colors in use by OTHER projects with active sessions
    const activeProjectPaths = new Set(
      sessionManager.getAllSessions()
        .map(s => path.normalize(s.projectPath))
        .filter(p => p !== path.normalize(project.path))
    );
    const colorsInUse = new Set<number>();
    for (const activePath of activeProjectPaths) {
      const idx = projectManager.getColorIndexForProject(activePath);
      if (idx !== null) {
        colorsInUse.add(idx);
      }
    }

    // Build QuickPick items: available colors + current color (marked)
    const items: Array<{ label: string; description: string; colorIndex: number }> = [];
    for (let i = 0; i < PROJECT_COLORS.length; i++) {
      const colorKey = PROJECT_COLORS[i];
      const displayName = COLOR_DISPLAY_NAMES[colorKey] || colorKey;

      if (i === currentIndex) {
        items.push({ label: `$(check) ${displayName}`, description: 'current', colorIndex: i });
      } else if (colorsInUse.has(i)) {
        // Color in use by another project — exclude from list
        continue;
      } else {
        items.push({ label: displayName, description: '', colorIndex: i });
      }
    }

    if (items.length <= 1) {
      vscode.window.showInformationMessage('Monet: All colors are in use by other projects');
      return;
    }

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `Change color for ${project.name}`
    });

    if (!picked || picked.colorIndex === currentIndex) {
      return;
    }

    projectManager.setColor(project.path, picked.colorIndex);

    // Find existing sessions for this project
    const allSessions = sessionManager.getAllSessions();
    outputChannel.appendLine(`Monet changeColor: project.path="${project.path}" allSessions=${allSessions.length} paths=[${allSessions.map(s => s.projectPath).join(', ')}]`);
    const staleSessions = allSessions
      .filter(s => s.projectPath === project.path);

    if (staleSessions.length === 0) {
      vscode.window.showInformationMessage(
        `Monet: Color changed to ${COLOR_DISPLAY_NAMES[PROJECT_COLORS[picked.colorIndex]] || PROJECT_COLORS[picked.colorIndex]}.`
      );
      return;
    }

    // Ask whether to apply to existing sessions
    const colorName = COLOR_DISPLAY_NAMES[PROJECT_COLORS[picked.colorIndex]] || PROJECT_COLORS[picked.colorIndex];

    // Read statuses: filter out stopped sessions (Ctrl+C'd terminals) and count busy ones
    const liveSessions: typeof staleSessions = [];
    let busyCount = 0;
    for (const session of staleSessions) {
      try {
        const sf = await statusWatcher.getStatus(session.sessionId);
        outputChannel.appendLine(`Monet changeColor: session=${session.sessionId} sf.status=${sf?.status ?? 'NULL'}`);
        if (sf?.status === 'stopped') continue; // Dead session — skip
        liveSessions.push(session);
        if (sf && sf.status !== 'idle') {
          busyCount++;
        }
      } catch {
        // No status file — include it (treat as idle)
        liveSessions.push(session);
      }
    }

    if (liveSessions.length === 0) {
      vscode.window.showInformationMessage(
        `Monet: Color changed to ${colorName}. No active sessions to migrate.`
      );
      return;
    }

    const applyDescription = busyCount > 0
      ? `Note: will interrupt ${busyCount} active task${busyCount > 1 ? 's' : ''}`
      : 'Migrates conversations to new terminals with updated color';

    const apply = await vscode.window.showQuickPick([
      { label: `$(sync) Apply to ${liveSessions.length} existing session${liveSessions.length > 1 ? 's' : ''}`, description: applyDescription, action: 'apply' },
      { label: '$(close) New sessions only', description: 'Existing terminals keep old color', action: 'skip' }
    ], {
      placeHolder: `Color changed to ${colorName}. Apply to existing sessions?`
    });

    if (apply?.action === 'apply') {
      let refreshed = 0;
      for (const session of liveSessions) {
        try {
          const ok = await sessionManager.refreshSession(session.sessionId);
          if (ok) refreshed++;
        } catch (err) {
          console.error(`Monet: Failed to refresh session ${session.sessionId}:`, err);
        }
      }
      vscode.window.showInformationMessage(
        `Monet: Color changed. ${refreshed}/${liveSessions.length} session${liveSessions.length > 1 ? 's' : ''} migrated.`
      );
    } else {
      // Mark as stale so they show ⟲
      sessionManager.markSessionsStale(project.path);
      vscode.window.showInformationMessage(
        `Monet: Color changed to ${colorName}. Existing terminals show ⟲.`
      );
    }
  });

  // Terminal focus listener - auto-switch workspace when focusing Monet terminals
  const terminalFocusListener = vscode.window.onDidChangeActiveTerminal(async (terminal) => {
    if (!terminal) return;
    if (sessionManager.isCreatingSession) return;
    if (statusWatcher.isRenamingTerminal) return;

    const sid = sessionManager.getSessionIdForTerminal(terminal);
    if (sid === null) return;

    const session = sessionManager.getAllSessions().find(s => s.sessionId === sid);
    if (!session) return;

    const sessionProjectPath = session.projectPath;
    const currentProjectFolder = vscode.workspace.workspaceFolders?.[0];
    if (currentProjectFolder && currentProjectFolder.uri.fsPath === sessionProjectPath) {
      return;
    }

    try {
      await projectManager.setActiveProject(sessionProjectPath);
      vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length ?? 0, { uri: vscode.Uri.file(sessionProjectPath) });
    } catch {
      // Workspace switch failed — non-critical, ignore
    }
  });

  // Add all subscriptions
  context.subscriptions.push(
    treeView,
    menuCmd,
    newSessionCmd,
    newSessionWithFlagCmd,
    resetCmd,
    switchProjectCmd,
    installSlashCommandsCmd,
    changeColorCmd,
    terminalFocusListener
  );

  // NOW do async initialization (wrapped in try/catch so it can't crash)
  try {
    await installHookScripts();
  } catch (err) {
    outputChannel.appendLine(`Monet: Failed to install hook scripts: ${err}`);
  }

  try {
    await statusWatcher.start();
  } catch (err) {
    outputChannel.appendLine(`Monet: Failed to start status watcher: ${err}`);
  }
}

export function deactivate() {
  if (statusWatcher) {
    statusWatcher.stop();
  }
}

// Tree item that acts as a clickable button
class MonetActionItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly commandId: string,
    public readonly icon: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.command = {
      command: commandId,
      title: label
    };
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

// Tree data provider - instant render
class MonetTreeProvider implements vscode.TreeDataProvider<MonetActionItem> {
  getTreeItem(element: MonetActionItem): vscode.TreeItem {
    return element;
  }

  getChildren(): MonetActionItem[] {
    return [
      new MonetActionItem('New Session', 'monet.newSession', 'add'),
      new MonetActionItem('New with Flags', 'monet.newSessionWithFlag', 'terminal'),
      new MonetActionItem('Change Project', 'monet.switchProject', 'window')
    ];
  }
}
