import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { SessionMeta, SessionStatusFile } from './types';
import { ProjectManager } from './projectManager';
import { installHooks, removeHooks } from './hooksManager';

const MAX_SLOTS = 20;
const MONET_DIR = path.join(os.homedir(), '.monet');
const STATUS_DIR = path.join(MONET_DIR, 'status');

export class SessionManager {
  private sessions: Map<number, SessionMeta> = new Map();
  private terminalToSlot: Map<vscode.Terminal, number> = new Map();

  constructor(
    private context: vscode.ExtensionContext,
    private projectManager: ProjectManager
  ) {
    this.loadSessions();
    this.ensureDirectories();

    // On activation, all loaded sessions are orphaned (no live terminals yet)
    // Clear them so slot counter resets to 1
    this.clearOrphanedSessions();

    // Listen for terminal close events - free up slot for backfill
    vscode.window.onDidCloseTerminal(async terminal => {
      const slot = this.terminalToSlot.get(terminal);
      if (slot !== undefined) {
        this.terminalToSlot.delete(terminal);
        await this.deleteSession(slot);
      }
    });
  }

  // Clear all sessions that have no live terminal (called on activation)
  private clearOrphanedSessions() {
    // On fresh activation, terminalToSlot is empty, so ALL sessions are orphaned
    this.sessions.clear();
    this.context.globalState.update('monet.sessions', {});
    console.log('Monet: Cleared orphaned sessions on activation');
  }

  private async ensureDirectories() {
    try {
      await fs.mkdir(MONET_DIR, { recursive: true });
      await fs.mkdir(STATUS_DIR, { recursive: true });
    } catch (err) {
      console.error('Failed to create monet directories:', err);
    }
  }

  private loadSessions() {
    const stored = this.context.globalState.get<Record<string, SessionMeta>>('monet.sessions', {});
    this.sessions = new Map(Object.entries(stored).map(([k, v]) => [parseInt(k), v]));
  }

  private async saveSessions() {
    const obj: Record<string, SessionMeta> = {};
    this.sessions.forEach((v, k) => obj[k.toString()] = v);
    await this.context.globalState.update('monet.sessions', obj);
  }

  // Find next available slot (1-20)
  private findNextSlot(): number | null {
    for (let i = 1; i <= MAX_SLOTS; i++) {
      if (!this.sessions.has(i)) {
        return i;
      }
    }
    return null;
  }

  // Create a new session
  async createSession(isContinue: boolean = false): Promise<vscode.Terminal | null> {
    const project = this.projectManager.getCurrentProject();
    if (!project) {
      vscode.window.showErrorMessage('No project folder open');
      return null;
    }

    const slot = this.findNextSlot();
    if (slot === null) {
      vscode.window.showErrorMessage('All 20 session slots are in use');
      return null;
    }

    const color = this.projectManager.getThemeColor(project.path);
    const iconPath = this.projectManager.getIconPath(project.path);
    const initialName = '⚪ — Claude | new session'; // Until Claude writes a title

    // Create terminal with project color and Claude icon
    // MONET_POSITION env var lets slash commands know which slot to update
    const terminal = vscode.window.createTerminal({
      name: initialName,
      cwd: project.path,
      color: color,
      iconPath: iconPath,
      env: { MONET_POSITION: slot.toString() }
    });

    // Store session metadata
    const session: SessionMeta = {
      position: slot,
      projectPath: project.path,
      projectName: project.name,
      terminalName: initialName,
      createdAt: Date.now(),
      isContinue
    };

    this.sessions.set(slot, session);
    this.terminalToSlot.set(terminal, slot);
    await this.saveSessions();

    // Clean slate: delete any old status files for this slot before installing hooks
    await this.deleteStatusFiles(slot);

    // Install Claude Code hooks into project's .claude/settings.local.json
    // Position is baked directly into the hook commands
    await installHooks(project.path, slot);

    // Show terminal and run claude
    terminal.show();
    const claudeCmd = isContinue ? 'claude -c' : 'claude';
    terminal.sendText(claudeCmd);

    return terminal;
  }

  // Get sessions that have no active terminal (for "Continue" menu)
  getDeadSessions(): SessionMeta[] {
    const activeSlots = new Set(this.terminalToSlot.values());
    return Array.from(this.sessions.values()).filter(s => !activeSlots.has(s.position));
  }

  // Continue a specific dead session
  async continueSession(slot: number): Promise<vscode.Terminal | null> {
    const session = this.sessions.get(slot);
    if (!session) {
      return null;
    }

    const color = this.projectManager.getThemeColor(session.projectPath);
    const iconPath = this.projectManager.getIconPath(session.projectPath);
    const terminalName = '⚪ — Claude | new session'; // Until Claude writes a title

    // Create terminal with MONET_POSITION env var for slash commands
    const terminal = vscode.window.createTerminal({
      name: terminalName,
      cwd: session.projectPath,
      color: color,
      iconPath: iconPath,
      env: { MONET_POSITION: slot.toString() }
    });

    this.terminalToSlot.set(terminal, slot);

    // Update session
    session.isContinue = true;
    session.terminalName = terminalName;
    await this.saveSessions();

    // Clean slate: delete any old status files for this slot before installing hooks
    await this.deleteStatusFiles(slot);

    // Install Claude Code hooks with position baked in
    await installHooks(session.projectPath, slot);

    terminal.show();
    terminal.sendText('claude -c');

    return terminal;
  }

  // Write status file
  private async writeStatusFile(slot: number, project: string, status: string, title: string, error?: string) {
    const statusFile = path.join(STATUS_DIR, `pos-${slot}.json`);
    const content: SessionStatusFile = {
      position: slot,
      project,
      status: status as SessionStatusFile['status'],
      title,
      updated: Date.now()
    };
    if (error) {
      content.error = error;
    }
    try {
      await fs.writeFile(statusFile, JSON.stringify(content, null, 2));
    } catch (err) {
      console.error('Failed to write status file:', err);
    }
  }

  // Get all active sessions
  getAllSessions(): SessionMeta[] {
    return Array.from(this.sessions.values());
  }

  // Get terminal for a slot (used by status watcher)
  getTerminalForSlot(slot: number): vscode.Terminal | undefined {
    console.log(`Monet getTerminalForSlot(${slot}): map size=${this.terminalToSlot.size}, slots=[${Array.from(this.terminalToSlot.values()).join(',')}]`);
    for (const [terminal, s] of this.terminalToSlot.entries()) {
      if (s === slot) return terminal;
    }
    return undefined;
  }

  // Get slot for a terminal (used for Ctrl+C detection)
  getSlotForTerminal(terminal: vscode.Terminal): number | null {
    return this.terminalToSlot.get(terminal) ?? null;
  }

  // Get all active slot numbers
  getActiveSlots(): number[] {
    return Array.from(this.terminalToSlot.values());
  }

  // Delete all status files for a slot (json, needs-title, waiting-title)
  private async deleteStatusFiles(slot: number) {
    const patterns = [
      `pos-${slot}.json`,
      `pos-${slot}.needs-title`,
      `pos-${slot}.waiting-title`
    ];
    for (const file of patterns) {
      try {
        await fs.unlink(path.join(STATUS_DIR, file));
      } catch {
        // Ignore if doesn't exist
      }
    }
  }

  // Delete a session
  async deleteSession(slot: number) {
    // Get project path before deleting session (for hook cleanup)
    const session = this.sessions.get(slot);
    const projectPath = session?.projectPath;

    this.sessions.delete(slot);
    await this.saveSessions();

    // Clean up all status files for this slot
    await this.deleteStatusFiles(slot);

    // Check if this was the last session for the project, and remove hooks if so
    if (projectPath) {
      const remainingInProject = Array.from(this.sessions.values())
        .some(s => s.projectPath === projectPath);

      if (!remainingInProject) {
        await removeHooks(projectPath);
      }
    }
  }

  // Reset all sessions (clear globalState)
  async resetAllSessions() {
    this.sessions.clear();
    this.terminalToSlot.clear();
    await this.context.globalState.update('monet.sessions', {});
    this.projectManager.clearColors(); // Reset color assignments too

    // Clear ALL status files (json, needs-title, waiting-title, etc)
    try {
      const files = await fs.readdir(STATUS_DIR);
      for (const file of files) {
        if (file.startsWith('pos-')) {
          await fs.unlink(path.join(STATUS_DIR, file));
        }
      }
    } catch {
      // Ignore errors
    }
  }
}
