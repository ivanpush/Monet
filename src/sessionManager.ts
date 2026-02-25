import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { SessionMeta, SessionStatusFile } from './types';
import { ProjectManager } from './projectManager';
import { installHooks, removeHooks } from './hooksManager';

const MAX_SLOTS = 20;
const MONET_DIR = path.join(os.homedir(), '.monet');
const STATUS_DIR = path.join(MONET_DIR, 'status');

export class SessionManager {
  private sessions: Map<number, SessionMeta> = new Map();
  // Map terminal to both slot (for deleteSession) and sessionId (for status lookup)
  private terminalToSession: Map<vscode.Terminal, { slot: number; sessionId: string }> = new Map();

  constructor(
    private context: vscode.ExtensionContext,
    private projectManager: ProjectManager,
    private outputChannel: vscode.OutputChannel
  ) {
    this.loadSessions();
    this.ensureDirectories();

    // Try to reconnect sessions via PID matching (handles Extension Host restarts)
    this.reconnectSessions().catch(err => this.outputChannel.appendLine(`Monet: reconnectSessions error: ${err}`));
    setTimeout(() => this.reconnectSessions().catch(err => this.outputChannel.appendLine(`Monet: reconnectSessions error: ${err}`)), 750);

    // Listen for terminal close events - free up slot for backfill
    vscode.window.onDidCloseTerminal(async terminal => {
      const sessionInfo = this.terminalToSession.get(terminal);
      if (sessionInfo) {
        this.terminalToSession.delete(terminal);
        await this.deleteSession(sessionInfo.slot, sessionInfo.sessionId);
      }
    });
  }

  private async ensureDirectories() {
    try {
      await fs.mkdir(MONET_DIR, { recursive: true });
      await fs.mkdir(STATUS_DIR, { recursive: true });
    } catch (err) {
      this.outputChannel.appendLine(`Monet: Failed to create monet directories: ${err}`);
    }
  }

  // Get terminal PID with retry (VS Code API can be slow to populate)
  private async getPidWithRetry(terminal: vscode.Terminal, retries = 3): Promise<number | undefined> {
    for (let i = 0; i < retries; i++) {
      const pid = await terminal.processId;
      if (pid) return pid;
      await new Promise(r => setTimeout(r, 200));
    }
    return undefined;
  }

  // Idempotent, non-destructive reconnection of sessions via PID matching
  // Reads session data from disk files (survives Extension Host restarts)
  private async reconnectSessions() {
    const activeTerminals = vscode.window.terminals;

    // Read all session files from disk
    const diskSessions: SessionStatusFile[] = [];
    try {
      const files = await fs.readdir(STATUS_DIR);
      for (const file of files) {
        const match = file.match(/^([a-f0-9]{8})\.json$/);
        if (!match) continue;

        try {
          const content = await fs.readFile(path.join(STATUS_DIR, file), 'utf-8');
          const parsed = JSON.parse(content) as SessionStatusFile;
          diskSessions.push(parsed);
        } catch {
          // Ignore parse errors
        }
      }
    } catch {
      // STATUS_DIR might not exist yet
      return;
    }

    if (diskSessions.length === 0) return;

    for (const terminal of activeTerminals) {
      if (this.terminalToSession.has(terminal)) continue;

      const pid = await this.getPidWithRetry(terminal);

      // Try PID match first (most reliable)
      let matchedSession = diskSessions.find(s => pid && s.processId === pid);

      // Fallback: terminal name match
      if (!matchedSession) {
        matchedSession = diskSessions.find(s =>
          s.terminalName && terminal.name === s.terminalName
        );
        if (matchedSession) {
          this.outputChannel.appendLine(`Monet: PID miss, matched session ${matchedSession.sessionId} via name fallback`);
        }
      }

      if (!matchedSession) continue;

      // Check if this session is already mapped to another terminal
      const alreadyMapped = Array.from(this.terminalToSession.values())
        .some(info => info.sessionId === matchedSession!.sessionId);
      if (alreadyMapped) continue;

      // Find or assign a slot
      let slot: number | null = null;

      // First check if we have this session in memory already
      for (const [existingSlot, meta] of this.sessions.entries()) {
        if (meta.sessionId === matchedSession.sessionId) {
          slot = existingSlot;
          break;
        }
      }

      // If not found, assign new slot
      if (slot === null) {
        slot = this.findNextSlot();
        if (slot === null) {
          this.outputChannel.appendLine(`Monet: No slots available for reconnecting ${matchedSession.sessionId}`);
          continue;
        }
      }

      // Reconstruct SessionMeta from disk data
      const session: SessionMeta = {
        sessionId: matchedSession.sessionId,
        position: slot,
        projectPath: matchedSession.projectPath || '',
        projectName: matchedSession.project,
        terminalName: terminal.name,
        createdAt: matchedSession.updated,
        isContinue: false,
        processId: pid
      };

      this.sessions.set(slot, session);
      this.terminalToSession.set(terminal, { slot, sessionId: matchedSession.sessionId });
      await this.saveSessions();

      // Update disk file with current PID if it changed
      if (pid && pid !== matchedSession.processId) {
        await this.writeStatusFile(
          matchedSession.sessionId,
          matchedSession.project,
          matchedSession.projectPath || '',
          terminal.name,
          pid
        );
      }

      this.outputChannel.appendLine(`Monet: Reconnected session ${matchedSession.sessionId} via PID ${pid}`);
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

    // Generate unique 8-char hex session ID
    const sessionId = crypto.randomUUID().replace(/-/g, '').slice(0, 8);

    const color = this.projectManager.getThemeColor(project.path);
    const iconPath = this.projectManager.getIconPath(project.path);
    const initialName = '⚪ — Claude | new session'; // Until Claude writes a title

    // Create terminal with project color and Claude icon
    // MONET_SESSION_ID env var lets slash commands know which session to update
    const terminal = vscode.window.createTerminal({
      name: initialName,
      cwd: project.path,
      color: color,
      iconPath: iconPath,
      env: { MONET_SESSION_ID: sessionId }
    });

    // Store session metadata
    const session: SessionMeta = {
      sessionId,
      position: slot,
      projectPath: project.path,
      projectName: project.name,
      terminalName: initialName,
      createdAt: Date.now(),
      isContinue
    };

    this.sessions.set(slot, session);
    this.terminalToSession.set(terminal, { slot, sessionId });
    await this.saveSessions();

    // Save PID for reconnection after Extension Host restart (both globalState and disk)
    const pid = await this.getPidWithRetry(terminal);
    if (pid) {
      session.processId = pid;
      const storedSessions = this.context.globalState.get<Record<string, SessionMeta>>('monet.sessions', {});
      if (storedSessions[slot.toString()]) {
        storedSessions[slot.toString()].processId = pid;
        await this.context.globalState.update('monet.sessions', storedSessions);
      }
    }

    // Write status file with PID for reconnection (persists to disk, survives Extension Host restart)
    await this.writeStatusFile(sessionId, project.name, project.path, initialName, pid);

    // Install Claude Code hooks into project's .claude/settings.local.json
    // SessionId is baked directly into the hook commands
    await installHooks(project.path, sessionId);

    // Show terminal and run claude
    terminal.show();
    const claudeCmd = isContinue ? 'claude -c' : 'claude';
    terminal.sendText(claudeCmd);

    return terminal;
  }

  // Get sessions that have no active terminal (for "Continue" menu)
  getDeadSessions(): SessionMeta[] {
    const activeSlots = new Set(Array.from(this.terminalToSession.values()).map(s => s.slot));
    return Array.from(this.sessions.values()).filter(s => !activeSlots.has(s.position));
  }

  // Continue a specific dead session
  async continueSession(slot: number): Promise<vscode.Terminal | null> {
    const session = this.sessions.get(slot);
    if (!session) {
      return null;
    }

    // Use existing sessionId or generate new one if missing (migration from old data)
    const sessionId = session.sessionId || crypto.randomUUID().replace(/-/g, '').slice(0, 8);

    const color = this.projectManager.getThemeColor(session.projectPath);
    const iconPath = this.projectManager.getIconPath(session.projectPath);
    const terminalName = '⚪ — Claude | new session'; // Until Claude writes a title

    // Create terminal with MONET_SESSION_ID env var for slash commands
    const terminal = vscode.window.createTerminal({
      name: terminalName,
      cwd: session.projectPath,
      color: color,
      iconPath: iconPath,
      env: { MONET_SESSION_ID: sessionId }
    });

    this.terminalToSession.set(terminal, { slot, sessionId });

    // Update session
    session.sessionId = sessionId;
    session.isContinue = true;
    session.terminalName = terminalName;
    await this.saveSessions();

    // Save PID for reconnection after Extension Host restart (both globalState and disk)
    const pid = await this.getPidWithRetry(terminal);
    if (pid) {
      session.processId = pid;
      const storedSessions = this.context.globalState.get<Record<string, SessionMeta>>('monet.sessions', {});
      if (storedSessions[slot.toString()]) {
        storedSessions[slot.toString()].processId = pid;
        await this.context.globalState.update('monet.sessions', storedSessions);
      }
    }

    // Write status file with PID for reconnection (persists to disk, survives Extension Host restart)
    await this.writeStatusFile(sessionId, session.projectName, session.projectPath, terminalName, pid);

    // Install Claude Code hooks with sessionId baked in
    await installHooks(session.projectPath, sessionId);

    terminal.show();
    terminal.sendText('claude -c');

    return terminal;
  }

  // Write status file with processId for reconnection after Extension Host restart
  // This is called after session creation to persist PID to disk
  private async writeStatusFile(
    sessionId: string,
    project: string,
    projectPath: string,
    terminalName: string,
    processId?: number
  ) {
    const statusFile = path.join(STATUS_DIR, `${sessionId}.json`);

    // Read existing status file if it exists (preserve title/status from hooks)
    let content: SessionStatusFile = {
      sessionId,
      project,
      status: 'idle',
      title: '',
      updated: Date.now(),
      processId,
      terminalName,
      projectPath
    };

    try {
      const existing = await fs.readFile(statusFile, 'utf-8');
      const parsed = JSON.parse(existing) as SessionStatusFile;
      // Merge: preserve existing status/title but update processId/terminalName/projectPath
      content = {
        ...parsed,
        processId,
        terminalName,
        projectPath,
        updated: Date.now()
      };
    } catch {
      // File doesn't exist, use defaults
    }

    try {
      const tmpPath = statusFile + '.tmp';
      await fs.writeFile(tmpPath, JSON.stringify(content, null, 2));
      await fs.rename(tmpPath, statusFile);
    } catch (err) {
      this.outputChannel.appendLine(`Monet: Failed to write status file: ${err}`);
    }
  }

  // Get all active sessions
  getAllSessions(): SessionMeta[] {
    return Array.from(this.sessions.values());
  }

  // Get terminal for a sessionId (used by status watcher)
  getTerminalForSession(sessionId: string): vscode.Terminal | undefined {
    for (const [terminal, info] of this.terminalToSession.entries()) {
      if (info.sessionId === sessionId) {
        return terminal;
      }
    }
    return undefined;
  }

  // Get slot for a terminal (used for terminal focus handler)
  getSlotForTerminal(terminal: vscode.Terminal): number | null {
    const info = this.terminalToSession.get(terminal);
    if (!info) return null;
    return info.slot;
  }

  // Get sessionId for a terminal
  getSessionIdForTerminal(terminal: vscode.Terminal): string | null {
    const info = this.terminalToSession.get(terminal);
    if (!info) return null;
    return info.sessionId;
  }

  // Get all active slot numbers
  getActiveSlots(): number[] {
    return Array.from(this.terminalToSession.values()).map(info => info.slot);
  }

  // Delete status file for a session
  private async deleteStatusFiles(sessionId: string) {
    try {
      await fs.unlink(path.join(STATUS_DIR, `${sessionId}.json`));
    } catch {
      // Ignore if doesn't exist
    }
  }

  // Delete a session
  async deleteSession(slot: number, sessionId: string) {
    // Get project path before deleting session (for hook cleanup)
    const session = this.sessions.get(slot);
    const projectPath = session?.projectPath;

    this.sessions.delete(slot);
    await this.saveSessions();

    // Clean up status file for this session
    await this.deleteStatusFiles(sessionId);

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
    this.terminalToSession.clear();
    await this.context.globalState.update('monet.sessions', {});
    this.projectManager.clearColors(); // Reset color assignments too

    // Clear ALL status files (any .json in status dir)
    try {
      const files = await fs.readdir(STATUS_DIR);
      for (const file of files) {
        if (file.endsWith('.json')) {
          await fs.unlink(path.join(STATUS_DIR, file));
        }
      }
    } catch {
      // Ignore errors
    }
  }
}
