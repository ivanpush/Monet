import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { PROJECT_COLORS, PROJECT_ICONS } from './types';

// GlobalState key for persisting project→color mappings
const COLORS_STATE_KEY = 'monet.projectColors';
// GlobalState key for persisting user color overrides
const USER_COLORS_KEY = 'monet.userOverrideColors';

// Manages project discovery and color assignment
// Colors persist to globalState but are freed when all sessions for a project close
export class ProjectManager {
  // projectPath → colorIndex (direct index into PROJECT_COLORS)
  private projectColors: Map<string, number> = new Map();
  // projectPath → number of terminals using this project
  private projectTerminalCount: Map<string, number> = new Map();
  // Paths where user explicitly chose a color (survives terminal close)
  private userOverrideColors: Set<string> = new Set();

  // Track project switch in progress to prevent race conditions
  // Set synchronously BEFORE async globalState update so getCurrentProject() sees new value immediately
  private switchingToProject: string | null = null;
  private switchLock: Promise<void> | null = null;

  constructor(private context: vscode.ExtensionContext) {
    // Load persisted color mappings from globalState
    this.loadPersistedColors();
  }

  // Load persisted project→color mappings from globalState
  private loadPersistedColors(): void {
    const persisted = this.context.globalState.get<Record<string, number>>(COLORS_STATE_KEY);
    if (persisted) {
      for (const [projectPath, colorIndex] of Object.entries(persisted)) {
        this.projectColors.set(projectPath, colorIndex);
      }
    }
    const overrides = this.context.globalState.get<string[]>(USER_COLORS_KEY);
    if (overrides) {
      for (const p of overrides) {
        this.userOverrideColors.add(p);
      }
    }
  }

  // Persist current color mappings to globalState
  private async persistColors(): Promise<void> {
    const toSave: Record<string, number> = {};
    for (const [projectPath, colorIndex] of this.projectColors) {
      toSave[projectPath] = colorIndex;
    }
    await this.context.globalState.update(COLORS_STATE_KEY, toSave);
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

  // Find a random unused color index
  // Returns a random color index from available slots
  private findRandomAvailableSlot(): number {
    const usedColors = new Set(this.projectColors.values());
    const availableColors: number[] = [];

    for (let i = 0; i < PROJECT_COLORS.length; i++) {
      if (!usedColors.has(i)) {
        availableColors.push(i);
      }
    }

    if (availableColors.length === 0) {
      // All colors used, return random color (will overlap)
      return Math.floor(Math.random() * PROJECT_COLORS.length);
    }

    // Return random pick from available colors
    return availableColors[Math.floor(Math.random() * availableColors.length)];
  }

  // Clear all color assignments (called on full reset)
  clearColors() {
    this.projectColors.clear();
    this.projectTerminalCount.clear();
    this.userOverrideColors.clear();
    // Also clear persisted colors and overrides
    this.context.globalState.update(COLORS_STATE_KEY, undefined);
    this.context.globalState.update(USER_COLORS_KEY, undefined);
  }

  // Assign a color to a project and increment terminal count
  // Returns the color index into PROJECT_COLORS
  assignColor(projectPath: string): number {
    const normalized = path.normalize(projectPath);

    // Increment terminal count
    const currentCount = this.projectTerminalCount.get(normalized) || 0;
    this.projectTerminalCount.set(normalized, currentCount + 1);

    // If already has a color (from persistence or earlier assignment), return it
    if (this.projectColors.has(normalized)) {
      return this.projectColors.get(normalized)!;
    }

    // Assign random available color
    const colorIndex = this.findRandomAvailableSlot();
    this.projectColors.set(normalized, colorIndex);

    // Persist to globalState (fire and forget)
    this.persistColors();

    return colorIndex;
  }

  // Release a color when a terminal closes
  // Frees the color when terminal count reaches 0 and removes from persistence
  // User-overridden colors are preserved (user explicitly chose this color)
  releaseColor(projectPath: string): void {
    const normalized = path.normalize(projectPath);

    const currentCount = this.projectTerminalCount.get(normalized) || 0;
    if (currentCount <= 1) {
      // Last terminal for this project - free the color (unless user override)
      this.projectTerminalCount.delete(normalized);
      if (!this.userOverrideColors.has(normalized)) {
        this.projectColors.delete(normalized);
      }

      // Persist removal (fire and forget)
      this.persistColors();
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
      return this.projectColors.get(normalized)!;
    }

    // Assign random available color (but don't increment count - this is for queries)
    const colorIndex = this.findRandomAvailableSlot();
    this.projectColors.set(normalized, colorIndex);

    // Persist to globalState (fire and forget)
    this.persistColors();

    return colorIndex;
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

  // Get color index for a project (read-only, no auto-assign)
  // Returns null if project has no color assigned
  getColorIndexForProject(projectPath: string): number | null {
    const normalized = path.normalize(projectPath);
    return this.projectColors.has(normalized) ? this.projectColors.get(normalized)! : null;
  }

  // Get a copy of all current color assignments (projectPath → colorIndex)
  getAllColorAssignments(): Map<string, number> {
    return new Map(this.projectColors);
  }

  // Set a specific color for a project and mark as user override
  // Persists both the color mapping and the override flag
  setColor(projectPath: string, colorIndex: number): void {
    const normalized = path.normalize(projectPath);
    this.projectColors.set(normalized, colorIndex);
    this.userOverrideColors.add(normalized);
    // Persist both (fire and forget)
    this.persistColors();
    this.context.globalState.update(USER_COLORS_KEY, Array.from(this.userOverrideColors));
  }

  // Get the projects root directory from settings (default ~/Projects)
  getProjectsRoot(): string {
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

          // Check for .git directory
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
