import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { PROJECT_COLORS, PROJECT_ICONS } from './types';

// Manages project discovery and color assignment
// Colors are ephemeral - reset each reload for fresh Monet palette
export class ProjectManager {
  // projectPath → colorIndex (slot in colorOrder)
  private projectColors: Map<string, number> = new Map();
  // projectPath → number of terminals using this project
  private projectTerminalCount: Map<string, number> = new Map();
  // Color order: indices into PROJECT_COLORS array (may be shuffled)
  private colorOrder: number[];

  // Track project switch in progress to prevent race conditions
  // Set synchronously BEFORE async globalState update so getCurrentProject() sees new value immediately
  private switchingToProject: string | null = null;
  private switchLock: Promise<void> | null = null;

  constructor(private context: vscode.ExtensionContext) {
    // Initialize color order based on setting
    const colorSetting = vscode.workspace.getConfiguration('monet').get<string>('colorOrder', 'fixed');

    if (colorSetting === 'shuffle') {
      // Fisher-Yates shuffle
      this.colorOrder = Array.from({ length: PROJECT_COLORS.length }, (_, i) => i);
      for (let i = this.colorOrder.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.colorOrder[i], this.colorOrder[j]] = [this.colorOrder[j], this.colorOrder[i]];
      }
    } else {
      // Fixed order: 0, 1, 2, ...
      this.colorOrder = Array.from({ length: PROJECT_COLORS.length }, (_, i) => i);
    }
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

  // Find lowest unused slot (fills gaps when projects are removed)
  // Returns the slot index (0 to N-1), not the actual color index
  private findNextAvailableSlot(): number {
    const usedSlots = new Set(this.projectColors.values());
    for (let i = 0; i < PROJECT_COLORS.length; i++) {
      if (!usedSlots.has(i)) return i;
    }
    return 0; // All used, wrap around
  }

  // Clear all color assignments (called on full reset)
  clearColors() {
    this.projectColors.clear();
    this.projectTerminalCount.clear();
  }

  // Assign a color to a project and increment terminal count
  // Returns the actual color index into PROJECT_COLORS
  assignColor(projectPath: string): number {
    const normalized = path.normalize(projectPath);

    // Increment terminal count
    const currentCount = this.projectTerminalCount.get(normalized) || 0;
    this.projectTerminalCount.set(normalized, currentCount + 1);

    // If already has a color slot, return the mapped color
    if (this.projectColors.has(normalized)) {
      const slot = this.projectColors.get(normalized)!;
      return this.colorOrder[slot];
    }

    // Assign next available slot
    const slot = this.findNextAvailableSlot();
    this.projectColors.set(normalized, slot);
    return this.colorOrder[slot];
  }

  // Release a color when a terminal closes
  // Frees the color slot when terminal count reaches 0
  releaseColor(projectPath: string): void {
    const normalized = path.normalize(projectPath);

    const currentCount = this.projectTerminalCount.get(normalized) || 0;
    if (currentCount <= 1) {
      // Last terminal for this project - free the color
      this.projectTerminalCount.delete(normalized);
      this.projectColors.delete(normalized);
    } else {
      // Decrement count
      this.projectTerminalCount.set(normalized, currentCount - 1);
    }
  }

  // Get the color index for a project (used internally)
  // Does NOT increment terminal count - use assignColor for new terminals
  private getColorIndex(projectPath: string): number {
    const normalized = path.normalize(projectPath);

    if (this.projectColors.has(normalized)) {
      const slot = this.projectColors.get(normalized)!;
      return this.colorOrder[slot];
    }

    // Assign lowest available slot (but don't increment count - this is for queries)
    const slot = this.findNextAvailableSlot();
    this.projectColors.set(normalized, slot);
    return this.colorOrder[slot];
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
  // Priority: 1. in-progress switch target, 2. globalState activeProject, 3. first workspace folder
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

    // Try globalState
    const activeProject = this.context.globalState.get<string>('monet.activeProject');
    if (activeProject) {
      // Verify it still exists
      try {
        // Use sync check here since this is a quick validation
        // and we're in a sync method
        const exists = require('fs').existsSync(activeProject);
        if (exists) {
          return {
            name: path.basename(activeProject),
            path: activeProject
          };
        }
      } catch {
        // Fall through to workspace fallback
      }
    }

    // Fallback to first workspace folder
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      const folder = workspaceFolders[0];
      return {
        name: folder.name,
        path: folder.uri.fsPath
      };
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
