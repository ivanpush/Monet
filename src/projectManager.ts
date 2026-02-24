import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { PROJECT_COLORS, PROJECT_ICONS } from './types';

// Manages project discovery and color assignment
// Colors are ephemeral - reset each reload for fresh Monet palette
export class ProjectManager {
  private projectColors: Map<string, number> = new Map();

  constructor(private context: vscode.ExtensionContext) {
    // No persistence - colors start fresh each session
  }

  // Find lowest unused color index (fills gaps when projects are removed)
  private findNextAvailableColorIndex(): number {
    const usedIndices = new Set(this.projectColors.values());
    for (let i = 0; i < PROJECT_COLORS.length; i++) {
      if (!usedIndices.has(i)) return i;
    }
    return 0; // All used, wrap around
  }

  // Clear all color assignments (called on full reset)
  clearColors() {
    this.projectColors.clear();
  }

  // Get or assign a color index for a project
  getColorIndex(projectPath: string): number {
    const normalized = path.normalize(projectPath);

    if (this.projectColors.has(normalized)) {
      return this.projectColors.get(normalized)!;
    }

    // Assign lowest available color index
    const colorIndex = this.findNextAvailableColorIndex();
    this.projectColors.set(normalized, colorIndex);

    return colorIndex;
  }

  // Get the ThemeColor for a project
  getThemeColor(projectPath: string): vscode.ThemeColor {
    const colorIndex = this.getColorIndex(projectPath);
    return new vscode.ThemeColor(PROJECT_COLORS[colorIndex]);
  }

  // Get the icon URI for a project
  getIconPath(projectPath: string): vscode.Uri {
    const colorIndex = this.getColorIndex(projectPath);
    const iconFile = PROJECT_ICONS[colorIndex % PROJECT_ICONS.length];
    return vscode.Uri.file(this.context.asAbsolutePath(`resources/${iconFile}`));
  }

  // Scan parent directory for available projects
  async getAvailableProjects(): Promise<Array<{ name: string; path: string }>> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return [];
    }

    const firstFolder = workspaceFolders[0].uri.fsPath;
    const parentDir = path.dirname(firstFolder);

    try {
      const entries = await fs.readdir(parentDir, { withFileTypes: true });
      const projects: Array<{ name: string; path: string }> = [];

      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          projects.push({
            name: entry.name,
            path: path.join(parentDir, entry.name)
          });
        }
      }

      return projects.sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      console.error('Error reading projects directory:', err);
      return [];
    }
  }

  // Get current project (first workspace folder)
  getCurrentProject(): { name: string; path: string } | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return null;
    }
    const folder = workspaceFolders[0];
    return {
      name: folder.name,
      path: folder.uri.fsPath
    };
  }
}
