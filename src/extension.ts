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

// Debounce timer for terminal focus switching
let terminalFocusDebounceTimer: NodeJS.Timeout | undefined;

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
  // 2. Null out stale processIds in status files (but keep files for history)
  // Skip this during Extension Host restarts where Monet terminals are still alive
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

    if (projects.length === 0) {
      vscode.window.showErrorMessage('No projects found. Set monet.projectsRoot in settings.');
      return;
    }

    const picked = await vscode.window.showQuickPick(
      projects.map(p => ({ label: p.name, description: p.path, path: p.path })),
      { placeHolder: 'Select a project' }
    );

    if (picked) {
      // Save active project to globalState
      await projectManager.setActiveProject(picked.path);

      // Swap workspace: replace all folders with the new project
      vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length ?? 0, { uri: vscode.Uri.file(picked.path) });
    }
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
    sessionManager.markSessionsStale(project.path);
    vscode.window.showInformationMessage(
      `Monet: Color changed to ${COLOR_DISPLAY_NAMES[PROJECT_COLORS[picked.colorIndex]] || PROJECT_COLORS[picked.colorIndex]}. New sessions will use the new color. Existing terminals show ⟲.`
    );
  });

  // Terminal focus listener - auto-switch explorer when focusing Monet terminals
  // Debounced 500ms to prevent thrashing on rapid clicks
  const terminalFocusListener = vscode.window.onDidChangeActiveTerminal(async (terminal) => {
    // Clear any pending debounce
    if (terminalFocusDebounceTimer) {
      clearTimeout(terminalFocusDebounceTimer);
      terminalFocusDebounceTimer = undefined;
    }

    if (!terminal) {
      return;
    }

    // Don't switch workspaces while a session is being created
    // (the async gap between createTerminal and terminal.show can exceed the 500ms debounce)
    if (sessionManager.isCreatingSession) {
      return;
    }

    // Look up if this is a Monet terminal
    const sessionId = sessionManager.getSessionIdForTerminal(terminal);
    if (sessionId === null) {
      // Not a Monet terminal, do nothing
      return;
    }

    // Get the session metadata
    const sessions = sessionManager.getAllSessions();
    const session = sessions.find(s => s.sessionId === sessionId);
    if (!session) {
      return;
    }

    const sessionProjectPath = session.projectPath;

    // Check if workspace already shows this project
    const currentProjectFolder = vscode.workspace.workspaceFolders?.[0];
    if (currentProjectFolder && currentProjectFolder.uri.fsPath === sessionProjectPath) {
      // Already showing the right project, no need to switch
      return;
    }

    // Debounce the workspace swap
    terminalFocusDebounceTimer = setTimeout(async () => {
      try {
        // Update globalState
        await projectManager.setActiveProject(sessionProjectPath);

        // Swap workspace to this project
        vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length ?? 0, { uri: vscode.Uri.file(sessionProjectPath) });
      } catch (err) {
        outputChannel.appendLine(`Monet: Failed to switch project on terminal focus: ${err}`);
      }
    }, 500);
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

export function deactivate() {
  // Clear debounce timer
  if (terminalFocusDebounceTimer) {
    clearTimeout(terminalFocusDebounceTimer);
  }

  if (statusWatcher) {
    statusWatcher.stop();
  }
}
