import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { ProjectManager } from './projectManager';
import { SessionManager } from './sessionManager';
import { StatusWatcher } from './statusWatcher';
import { installHookScripts } from './hooksInstaller';

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

  // On fresh Cursor loads (no Monet terminals present):
  // 1. Clear globalState sessions (resets slot counter)
  // 2. Null out stale processIds in status files (but keep files for history)
  // Skip this during Extension Host restarts where Monet terminals are still alive
  if (!sessionManager.hasMonetTerminals()) {
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
      { label: '$(git-branch) New Branch', description: 'Create worktree + start Claude', action: 'newBranch' },
      { label: '$(debug-continue) Continue', description: 'Resume a previous session', action: 'continue' },
      { label: '$(window) Switch Project', description: 'Change active project', action: 'switchProject' }
    ];

    const picked = await vscode.window.showQuickPick(options, {
      placeHolder: 'Monet'
    });

    if (picked) {
      switch (picked.action) {
        case 'newSession':
          vscode.commands.executeCommand('monet.newSession');
          break;
        case 'newBranch':
          vscode.commands.executeCommand('monet.newBranch');
          break;
        case 'continue':
          vscode.commands.executeCommand('monet.continueSession');
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

      project = { name: picked.label, path: picked.path };
    }

    const terminal = await sessionManager.createSession(false);
    if (terminal) {
      vscode.commands.executeCommand('workbench.action.terminal.focus');
    }
  });

  const newBranchCmd = vscode.commands.registerCommand('monet.newBranch', async () => {
    vscode.window.showInformationMessage('Monet: New Branch (coming in Step 5 - worktrees)');
    vscode.commands.executeCommand('workbench.action.terminal.focus');
  });

  const continueSessionCmd = vscode.commands.registerCommand('monet.continueSession', async () => {
    // FUTURE: /continue will let user pick from named conversations, not just resume last
    // FUTURE: Continue feature will list past conversations by title from stored history
    const deadSessions = sessionManager.getDeadSessions();

    if (deadSessions.length === 0) {
      vscode.window.showInformationMessage('No previous sessions to continue');
      return;
    }

    const options = deadSessions.map(s => ({
      label: s.projectName,
      description: `Last: ${s.terminalName}`,
      slot: s.position
    }));

    const picked = await vscode.window.showQuickPick(options, {
      placeHolder: 'Select a session to continue'
    });

    if (picked) {
      const terminal = await sessionManager.continueSession(picked.slot);
      if (terminal) {
        vscode.commands.executeCommand('workbench.action.terminal.focus');
      }
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

  // Terminal focus listener - auto-switch explorer when focusing Monet terminals
  // Debounced 500ms to prevent thrashing on rapid clicks
  // FUTURE: Session slots will become UUIDs instead of numbers 1-20 (to support multiple Cursor windows)
  const terminalFocusListener = vscode.window.onDidChangeActiveTerminal(async (terminal) => {
    // Clear any pending debounce
    if (terminalFocusDebounceTimer) {
      clearTimeout(terminalFocusDebounceTimer);
      terminalFocusDebounceTimer = undefined;
    }

    if (!terminal) {
      return;
    }

    // Look up if this is a Monet terminal
    const slot = sessionManager.getSlotForTerminal(terminal);
    if (slot === null) {
      // Not a Monet terminal, do nothing
      return;
    }

    // Get the session metadata for this slot
    const sessions = sessionManager.getAllSessions();
    const session = sessions.find(s => s.position === slot);
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
    newBranchCmd,
    continueSessionCmd,
    resetCmd,
    switchProjectCmd,
    installSlashCommandsCmd,
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
      new MonetActionItem('New Branch', 'monet.newBranch', 'git-branch'),
      new MonetActionItem('Continue', 'monet.continueSession', 'debug-continue'),
      new MonetActionItem('Switch Project', 'monet.switchProject', 'window')
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
