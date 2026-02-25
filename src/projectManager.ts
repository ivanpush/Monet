import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { PROJECT_COLORS, PROJECT_ICONS } from './types';

// Manages project discovery and color assignment
// Colors are assigned sequentially (gap-filling) - no collisions until 11+ projects
export class ProjectManager {
  // Track which color indices are currently in use
  private usedColorIndices: Set<number> = new Set();
  // projectPath → assigned color index
  private projectColorAssignment: Map<string, number> = new Map();
  // projectPath → number of terminals using this project
  private projectTerminalCount: Map<string, number> = new Map();

  // Track project switch in progress to prevent race conditions
  // Set synchronously BEFORE async globalState update so getCurrentProject() sees new value immediately
  private switchingToProject: string | null = null;
  private switchLock: Promise<void> | null = null;

  constructor(private context: vscode.ExtensionContext) {
    // Load persisted color assignments from globalState
    this.loadColorAssignments();
  }

  // Load color assignments from globalState (survives Extension Host restart)
  private loadColorAssignments(): void {
    const persisted = this.context.globalState.get<Record<string, number>>('monet.colorAssignments');
    if (persisted) {
      for (const [projectPath, colorIndex] of Object.entries(persisted)) {
        this.projectColorAssignment.set(projectPath, colorIndex);
        this.usedColorIndices.add(colorIndex);
      }
    }
  }

  // Persist color assignments to globalState
  private persistColorAssignments(): void {
    const obj: Record<string, number> = {};
    for (const [projectPath, colorIndex] of this.projectColorAssignment.entries()) {
      obj[projectPath] = colorIndex;
    }
    // Fire and forget - don't block on persistence
    this.context.globalState.update('monet.colorAssignments', obj);
  }

  // Check if a project switch is in progress
  isSwitching(): boolean {
    return this.switchingToProject !== null;
  }

  // Wait for any in-progress project switch to complete
  async waitForSwitch(): Promise<void> {
    if (this.switchLock) {
      await this.switchLock;
    }
  }

  // Clear all color assignments (called on full reset)
  clearColors() {
    this.usedColorIndices.clear();
    this.projectColorAssignment.clear();
    this.projectTerminalCount.clear();
    this.context.globalState.update('monet.colorAssignments', undefined);
  }

  // Assign a color to a project and increment terminal count
  // Returns the color index into PROJECT_COLORS (gap-filling: lowest available index)
  assignColor(projectPath: string): number {
    const normalized = path.normalize(projectPath);

    // Check if project already has a color assigned
    let colorIndex = this.projectColorAssignment.get(normalized);

    if (colorIndex === undefined) {
      // Find lowest available color index
      colorIndex = 0;
      while (this.usedColorIndices.has(colorIndex)) {
        colorIndex++;
      }

      // Assign it
      this.usedColorIndices.add(colorIndex);
      this.projectColorAssignment.set(normalized, colorIndex);
      this.persistColorAssignments();
    }

    // Increment terminal count
    const currentCount = this.projectTerminalCount.get(normalized) || 0;
    this.projectTerminalCount.set(normalized, currentCount + 1);

    return colorIndex;
  }

  // Release a terminal from a project
  // Decrements terminal count but keeps color assignment permanent (for stability across restarts)
  releaseColor(projectPath: string): void {
    const normalized = path.normalize(projectPath);

    const currentCount = this.projectTerminalCount.get(normalized) || 0;
    if (currentCount <= 1) {
      this.projectTerminalCount.delete(normalized);
      // Keep color assignment - don't free it. This ensures the project
      // always gets the same color even after all terminals close.
    } else {
      this.projectTerminalCount.set(normalized, currentCount - 1);
    }
  }

  // Get the color index for a project (looks up assigned color, or 0 if not assigned)
  private getColorIndex(projectPath: string): number {
    const normalized = path.normalize(projectPath);
    return this.projectColorAssignment.get(normalized) ?? 0;
  }

  // Get the ThemeColor for a given color index
  getThemeColorByIndex(colorIndex: number): vscode.ThemeColor {
    return new vscode.ThemeColor(PROJECT_COLORS[colorIndex]);
  }

  // Get the icon URI for a given color index
  getIconPathByIndex(colorIndex: number): vscode.Uri {
    const iconFile = PROJECT_ICONS[colorIndex % PROJECT_ICONS.length];
    return vscode.Uri.file(this.context.asAbsolutePath(`resources/${iconFile}`));
  }

  // Get the ThemeColor for a project (convenience, does NOT increment count)
  getThemeColor(projectPath: string): vscode.ThemeColor {
    const colorIndex = this.getColorIndex(projectPath);
    return new vscode.ThemeColor(PROJECT_COLORS[colorIndex]);
  }

  // Get the icon URI for a project (convenience, does NOT increment count)
  getIconPath(projectPath: string): vscode.Uri {
    const colorIndex = this.getColorIndex(projectPath);
    const iconFile = PROJECT_ICONS[colorIndex % PROJECT_ICONS.length];
    return vscode.Uri.file(this.context.asAbsolutePath(`resources/${iconFile}`));
  }

  // Get the projects root directory from settings (default ~/Projects)
  private getProjectsRoot(): string {
    const config = vscode.workspace.getConfiguration('monet');
    const configuredRoot = config.get<string>('projectsRoot');

    if (configuredRoot) {
      // Expand ~ to home directory
      if (configuredRoot.startsWith('~')) {
        return path.join(os.homedir(), configuredRoot.slice(1));
      }
      return configuredRoot;
    }

    // Default to ~/Projects
    return path.join(os.homedir(), 'Projects');
  }

  // Scan monet.projectsRoot for available projects (all directories)
  // hasGit indicates whether project has git initialized (for future worktree features)
  // Does NOT depend on workspace folders
  async getAvailableProjects(): Promise<Array<{ name: string; path: string; hasGit: boolean }>> {
    const projectsRoot = this.getProjectsRoot();

    try {
      // Check if directory exists
      await fs.access(projectsRoot);
    } catch {
      // Directory doesn't exist
      return [];
    }

    try {
      const entries = await fs.readdir(projectsRoot, { withFileTypes: true });
      const projects: Array<{ name: string; path: string; hasGit: boolean }> = [];

      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          const projectPath = path.join(projectsRoot, entry.name);

          // Check for .git directory (for future worktree features)
          const hasGit = await fs.access(path.join(projectPath, '.git'))
            .then(() => true)
            .catch(() => false);

          projects.push({
            name: entry.name,
            path: projectPath,
            hasGit
          });
        }
      }

      return projects.sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      console.error('Error reading projects directory:', err);
      return [];
    }
  }

  // Get current project
  // Priority: 1. in-progress switch target, 2. workspace folder, 3. globalState (fallback)
  // Returns null if all are empty/missing
  getCurrentProject(): { name: string; path: string } | null {
    // If a switch is in progress, return the target project immediately
    // This prevents race conditions during async globalState updates
    if (this.switchingToProject) {
      return {
        name: path.basename(this.switchingToProject),
        path: this.switchingToProject
      };
    }

    // Use workspace folder as primary source (matches what user has open)
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      const folder = workspaceFolders[0];
      return {
        name: folder.name,
        path: folder.uri.fsPath
      };
    }

    // Fallback to globalState (for when no workspace is open)
    const activeProject = this.context.globalState.get<string>('monet.activeProject');
    if (activeProject) {
      // Verify it still exists
      try {
        const exists = require('fs').existsSync(activeProject);
        if (exists) {
          return {
            name: path.basename(activeProject),
            path: activeProject
          };
        }
      } catch {
        // Fall through
      }
    }

    return null;
  }

  // Set active project and persist to globalState
  // Sets switchingToProject SYNCHRONOUSLY before async operation so getCurrentProject() sees new value immediately
  async setActiveProject(projectPath: string): Promise<void> {
    // Set target synchronously - getCurrentProject() will return this immediately
    this.switchingToProject = projectPath;

    // Create a lock that other operations can await
    let resolveLock: () => void;
    this.switchLock = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });

    try {
      await this.context.globalState.update('monet.activeProject', projectPath);
    } finally {
      // Clear the switch-in-progress state
      this.switchingToProject = null;
      this.switchLock = null;
      resolveLock!();
    }
  }
}
