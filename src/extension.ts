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

export async function activate(context: vscode.ExtensionContext) {
  console.log('Monet extension is now active');

  // Initialize managers FIRST (these are sync and won't throw)
  projectManager = new ProjectManager(context);
  sessionManager = new SessionManager(context, projectManager);
  statusWatcher = new StatusWatcher();
  statusWatcher.setSessionManager(sessionManager);

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
      vscode.window.showWarningMessage('No projects found');
      return;
    }

    const picked = await vscode.window.showQuickPick(
      projects.map(p => ({ label: p.name, description: p.path, path: p.path })),
      { placeHolder: 'Select a project' }
    );

    if (picked) {
      const uri = vscode.Uri.file(picked.path);
      const existing = vscode.workspace.workspaceFolders?.find(f => f.uri.fsPath === picked.path);

      if (!existing) {
        vscode.workspace.updateWorkspaceFolders(
          vscode.workspace.workspaceFolders?.length || 0,
          0,
          { uri }
        );
      }

      vscode.commands.executeCommand('revealInExplorer', uri);
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

Run this command to update the terminal title:

\`\`\`bash
~/.monet/bin/monet-title $MONET_POSITION $ARGUMENTS
\`\`\`

The MONET_POSITION environment variable is set automatically by Monet when creating sessions.
Only the title text will be updated - status emoji remains unchanged.
`;

      const titlePath = path.join(claudeCommandsDir, 'title.md');
      await fs.writeFile(titlePath, titleCommand);

      vscode.window.showInformationMessage('Monet: Slash commands installed to ~/.claude/commands/');
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to install slash commands: ${err}`);
    }
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
    installSlashCommandsCmd
  );

  // NOW do async initialization (wrapped in try/catch so it can't crash)
  try {
    await installHookScripts();
  } catch (err) {
    console.error('Monet: Failed to install hook scripts:', err);
  }

  try {
    await statusWatcher.start();
  } catch (err) {
    console.error('Monet: Failed to start status watcher:', err);
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
  if (statusWatcher) {
    statusWatcher.stop();
  }
  console.log('Monet extension deactivated');
}
