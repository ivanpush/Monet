import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SessionMeta } from './types';

const execFileAsync = promisify(execFile);

const MONET_DIR = path.join(os.homedir(), '.monet');
const WORKTREES_DIR = path.join(MONET_DIR, 'worktrees');

// Monet-owned branch status bar item
// Shows the git branch for the currently focused Monet terminal session
// Replaces VS Code's built-in branch indicator which bleeds across worktrees
export class MonetBranchIndicator {
  private statusBarItem: vscode.StatusBarItem;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      10
    );
  }

  // Update the branch indicator for the given session
  // If session is null (no Monet terminal focused), hides the indicator
  async update(session: SessionMeta | null): Promise<void> {
    if (!session) {
      this.statusBarItem.hide();
      return;
    }

    // Compute effective path: worktree path or project path
    let effectivePath: string;
    if (session.worktreeName) {
      effectivePath = path.join(WORKTREES_DIR, session.projectName, session.worktreeName);
    } else {
      effectivePath = session.projectPath;
    }

    try {
      const { stdout } = await execFileAsync('git', ['-C', effectivePath, 'branch', '--show-current']);
      const branch = stdout.trim();
      if (branch) {
        this.statusBarItem.text = `$(git-branch) ${branch}`;
        this.statusBarItem.tooltip = `Monet: ${session.projectName} — ${branch}`;
        this.statusBarItem.show();
      } else {
        // Detached HEAD or error
        this.statusBarItem.hide();
      }
    } catch {
      // git command failed (not a git repo, path doesn't exist, etc.)
      this.statusBarItem.hide();
    }
  }

  dispose(): void {
    this.statusBarItem.dispose();
  }
}
