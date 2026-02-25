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

  // Idempotent, non-destructive reconnection of sessions via MONET_SESSION_ID env var
  // Reads session data from disk files (survives Extension Host restarts)
  private async reconnectSessions() {
    const activeTerminals = vscode.window.terminals;

    // Read all session files from disk (indexed by sessionId for fast lookup)
    const diskSessions: Map<string, SessionStatusFile> = new Map();
    try {
      const files = await fs.readdir(STATUS_DIR);
      for (const file of files) {
        const match = file.match(/^([a-f0-9]{8})\.json$/);
        if (!match) continue;

        try {
          const content = await fs.readFile(path.join(STATUS_DIR, file), 'utf-8');
          const parsed = JSON.parse(content) as SessionStatusFile;
          diskSessions.set(parsed.sessionId, parsed);
        } catch {
          // Ignore parse errors
        }
      }
    } catch {
      // STATUS_DIR might not exist yet
      return;
    }

    if (diskSessions.size === 0) return;

    for (const terminal of activeTerminals) {
      if (this.terminalToSession.has(terminal)) continue;

      // Only reconnect terminals that have MONET_SESSION_ID set
      // This prevents false matches on plain zsh terminals with recycled PIDs
      const env = (terminal.creationOptions as vscode.TerminalOptions)?.env;
      const sessionIdFromEnv = env?.MONET_SESSION_ID;

      if (!sessionIdFromEnv) continue; // Not a Monet terminal, skip

      // Look up session by sessionId (exact match, no PID guessing)
      const matchedSession = diskSessions.get(sessionIdFromEnv);

      if (!matchedSession) {
        this.outputChannel.appendLine(`Monet: Terminal has MONET_SESSION_ID=${sessionIdFromEnv} but no status file found`);
        continue;
      }

      // Check if this session is already mapped to another terminal
      const alreadyMapped = Array.from(this.terminalToSession.values())
        .some(info => info.sessionId === matchedSession!.sessionId);
      if (alreadyMapped) continue;

      // Get PID for status file update (not for matching)
      const pid = await this.getPidWithRetry(terminal);

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
          pid
        );
      }

      this.outputChannel.appendLine(`Monet: Reconnected session ${matchedSession.sessionId} via MONET_SESSION_ID`);
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

    // Assign color to this project (increments terminal count for gap-filling)
    const colorIndex = this.projectManager.assignColor(project.path);
    const color = this.projectManager.getThemeColorByIndex(colorIndex);
    const iconPath = this.projectManager.getIconPathByIndex(colorIndex);
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
    await this.writeStatusFile(sessionId, project.name, project.path, pid);

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

    // Assign color to this project (increments terminal count for gap-filling)
    const colorIndex = this.projectManager.assignColor(session.projectPath);
    const color = this.projectManager.getThemeColorByIndex(colorIndex);
    const iconPath = this.projectManager.getIconPathByIndex(colorIndex);
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
    await this.writeStatusFile(sessionId, session.projectName, session.projectPath, pid);

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
      projectPath
    };

    try {
      const existing = await fs.readFile(statusFile, 'utf-8');
      const parsed = JSON.parse(existing) as SessionStatusFile;
      // Merge: preserve existing status/title but update processId/projectPath
      content = {
        ...parsed,
        processId,
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
    // Get project path before deleting session (for hook and color cleanup)
    const session = this.sessions.get(slot);
    const projectPath = session?.projectPath;

    this.sessions.delete(slot);
    await this.saveSessions();

    // Clean up status file for this session
    await this.deleteStatusFiles(sessionId);

    // Release color (frees the slot if this was the last terminal for this project)
    if (projectPath) {
      this.projectManager.releaseColor(projectPath);

      // Check if this was the last session for the project, and remove hooks if so
      const remainingInProject = Array.from(this.sessions.values())
        .some(s => s.projectPath === projectPath);

      if (!remainingInProject) {
        await removeHooks(projectPath);
      }
    }
  }

  // Check if any active terminals have MONET_SESSION_ID set
  // Returns true if this is an Extension Host restart (Monet terminals exist)
  // Returns false if this is a fresh Cursor load (no Monet terminals)
  hasMonetTerminals(): boolean {
    for (const terminal of vscode.window.terminals) {
      const env = (terminal.creationOptions as vscode.TerminalOptions)?.env;
      if (env?.MONET_SESSION_ID) {
        return true;
      }
    }
    return false;
  }

  // Check if a process is alive
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // Cleanup stale status files where processId exists but process is dead
  // Sets processId to null instead of deleting (preserves title/status for history)
  // Only call this on fresh Cursor loads, NOT on Extension Host restarts
  async cleanupStaleStatusFiles(): Promise<void> {
    try {
      const files = await fs.readdir(STATUS_DIR);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const filePath = path.join(STATUS_DIR, file);
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const parsed = JSON.parse(content) as SessionStatusFile;

          // If processId exists and process is dead, null it out but keep the file
          if (parsed.processId && !this.isProcessAlive(parsed.processId)) {
            parsed.processId = undefined;
            parsed.updated = Date.now();
            const tmpPath = filePath + '.tmp';
            await fs.writeFile(tmpPath, JSON.stringify(parsed, null, 2));
            await fs.rename(tmpPath, filePath);
            this.outputChannel.appendLine(`Monet: Nulled stale processId in ${file}`);
          }
        } catch (err) {
          // Ignore parse errors, but log them
          this.outputChannel.appendLine(`Monet: Failed to parse/cleanup ${file}: ${err}`);
        }
      }
    } catch {
      // STATUS_DIR might not exist yet
    }
  }

  // Clear globalState sessions (resets slot counter)
  async clearGlobalStateSessions(): Promise<void> {
    this.sessions.clear();
    await this.context.globalState.update('monet.sessions', {});
    this.outputChannel.appendLine('Monet: Cleared globalState sessions (fresh load, no Monet terminals)');
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
