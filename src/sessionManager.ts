import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { SessionMeta, SessionStatusFile, STATUS_EMOJI } from './types';
import { ProjectManager } from './projectManager';
import { installHooks, removeHooks } from './hooksManager';

const MONET_DIR = path.join(os.homedir(), '.monet');
const STATUS_DIR = path.join(MONET_DIR, 'status');

export interface CreateSessionOptions {
  claudeArgs?: string;     // Flags appended to `claude` command
  cwd?: string;            // Override terminal working directory
  projectPath?: string;    // Override project for color matching
  projectName?: string;    // Override project display name
}

export class SessionManager {
  private sessions: Map<string, SessionMeta> = new Map();
  // Map terminal to its sessionId
  private terminalToSession: Map<vscode.Terminal, string> = new Map();
  // Guard flag: true while createSession/continueSession async work is in progress
  private _isCreatingSession = false;
  get isCreatingSession(): boolean { return this._isCreatingSession; }
  // Sessions whose project color changed — terminals show ⟲ indicator
  private staleSessionIds: Set<string> = new Set();
  private static readonly STALE_SESSIONS_KEY = 'monet.staleSessions';

  constructor(
    private context: vscode.ExtensionContext,
    private projectManager: ProjectManager,
    private outputChannel: vscode.OutputChannel
  ) {
    this.loadSessions();
    this.loadStaleSessions();
    this.ensureDirectories();

    // Try to reconnect sessions via PID matching (handles Extension Host restarts)
    // Second pass at 750ms catches terminals that weren't ready yet
    // After second pass, clean up any status files that weren't matched to a session
    this.reconnectSessions().catch(err => this.outputChannel.appendLine(`Monet: reconnectSessions error: ${err}`));
    setTimeout(async () => {
      try {
        await this.reconnectSessions();
        await this.cleanupUnmatchedStatusFiles();
      } catch (err) {
        this.outputChannel.appendLine(`Monet: reconnectSessions/cleanup error: ${err}`);
      }
    }, 750);

    // Listen for terminal close events - clean up session
    vscode.window.onDidCloseTerminal(async terminal => {
      const sessionId = this.terminalToSession.get(terminal);
      if (sessionId) {
        this.terminalToSession.delete(terminal);
        await this.deleteSession(sessionId);
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

  // Idempotent, non-destructive reconnection of sessions
  // Primary: match terminal PID against disk status files (survives Extension Host restarts)
  // Fallback: match MONET_SESSION_ID env var (precise but lost on restart)
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

    // Build PID→SessionStatusFile map for primary matching
    const pidToDiskSession: Map<number, SessionStatusFile> = new Map();
    for (const diskSession of diskSessions.values()) {
      if (diskSession.processId) {
        pidToDiskSession.set(diskSession.processId, diskSession);
      }
    }

    // First pass: PID-based matching (primary — survives Extension Host restarts)
    for (const terminal of activeTerminals) {
      if (this.terminalToSession.has(terminal)) continue;

      const pid = await this.getPidWithRetry(terminal);
      if (!pid) continue;

      const matchedSession = pidToDiskSession.get(pid);
      if (!matchedSession) continue;

      const alreadyMapped = Array.from(this.terminalToSession.values())
        .some(id => id === matchedSession.sessionId);
      if (alreadyMapped) continue;

      const session: SessionMeta = {
        sessionId: matchedSession.sessionId,
        projectPath: matchedSession.projectPath || '',
        projectName: matchedSession.project,
        terminalName: terminal.name,
        createdAt: matchedSession.updated,
        isContinue: false,
        processId: pid
      };

      this.sessions.set(matchedSession.sessionId, session);
      this.terminalToSession.set(terminal, matchedSession.sessionId);
      await this.saveSessions();

      this.outputChannel.appendLine(`Monet: Reconnected session ${matchedSession.sessionId} via PID ${pid}`);
    }
  }

  private loadSessions() {
    const stored = this.context.globalState.get<Record<string, SessionMeta>>('monet.sessions', {});
    this.sessions = new Map(Object.entries(stored));
  }

  private async saveSessions() {
    await this.context.globalState.update('monet.sessions', Object.fromEntries(this.sessions));
  }

  private loadStaleSessions(): void {
    const stored = this.context.globalState.get<string[]>(SessionManager.STALE_SESSIONS_KEY);
    if (stored) {
      for (const id of stored) {
        this.staleSessionIds.add(id);
      }
    }
  }

  private async saveStaleSessions(): Promise<void> {
    await this.context.globalState.update(
      SessionManager.STALE_SESSIONS_KEY,
      Array.from(this.staleSessionIds)
    );
  }

  // Mark all active sessions for a project as stale (color changed, terminal can't recolor)
  markSessionsStale(projectPath: string): void {
    for (const session of this.sessions.values()) {
      if (session.projectPath === projectPath) {
        this.staleSessionIds.add(session.sessionId);
      }
    }
    // Persist (fire and forget)
    this.saveStaleSessions();
  }

  // Check if a session is stale (its project color was changed after terminal creation)
  isSessionStale(sessionId: string): boolean {
    return this.staleSessionIds.has(sessionId);
  }

  // Create a new session
  async createSession(options: CreateSessionOptions = {}): Promise<vscode.Terminal | null> {
    this._isCreatingSession = true;
    try {
      // Use override project or current project
      let projectPath = options.projectPath;
      let projectName = options.projectName;

      if (!projectPath) {
        const project = this.projectManager.getCurrentProject();
        if (!project) {
          vscode.window.showErrorMessage('No project folder open');
          return null;
        }
        projectPath = project.path;
        projectName = project.name;
      }

      if (!projectName) {
        projectName = path.basename(projectPath);
      }

      // Generate unique 8-char hex session ID
      const sessionId = crypto.randomUUID().replace(/-/g, '').slice(0, 8);

      // Assign color to this project (increments terminal count for gap-filling)
      const colorIndex = this.projectManager.assignColor(projectPath);
      const color = this.projectManager.getThemeColorByIndex(colorIndex);
      const iconPath = this.projectManager.getIconPathByIndex(colorIndex);
      const initialName = '⚪ — Claude | new session';

      const terminalCwd = options.cwd || projectPath;

      // Create terminal with project color and Claude icon
      // MONET_SESSION_ID env var lets slash commands know which session to update
      const terminal = vscode.window.createTerminal({
        name: initialName,
        cwd: terminalCwd,
        color: color,
        iconPath: iconPath,
        env: { MONET_SESSION_ID: sessionId }
      });

      // Store session metadata
      const isContinue = options.claudeArgs?.includes('-c') || false;
      const session: SessionMeta = {
        sessionId,
        projectPath,
        projectName,
        terminalName: initialName,
        createdAt: Date.now(),
        isContinue
      };

      this.sessions.set(sessionId, session);
      this.terminalToSession.set(terminal, sessionId);
      await this.saveSessions();

      // Save PID for reconnection after Extension Host restart (both globalState and disk)
      const pid = await this.getPidWithRetry(terminal);
      if (pid) {
        session.processId = pid;
        const storedSessions = this.context.globalState.get<Record<string, SessionMeta>>('monet.sessions', {});
        if (storedSessions[sessionId]) {
          storedSessions[sessionId].processId = pid;
          await this.context.globalState.update('monet.sessions', storedSessions);
        }
      }

      // Write status file with PID for reconnection (persists to disk, survives Extension Host restart)
      await this.writeStatusFile(sessionId, projectName, projectPath, pid);

      // Install Claude Code hooks
      await installHooks(projectPath, sessionId);

      // Show terminal and run claude with optional flags
      terminal.show();
      const claudeCmd = options.claudeArgs ? `claude ${options.claudeArgs}`.trim() : 'claude';
      terminal.sendText(claudeCmd);

      return terminal;
    } finally {
      this._isCreatingSession = false;
    }
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
    for (const [terminal, id] of this.terminalToSession.entries()) {
      if (id === sessionId) {
        return terminal;
      }
    }
    return undefined;
  }

  // Get sessionId for a terminal
  getSessionIdForTerminal(terminal: vscode.Terminal): string | null {
    return this.terminalToSession.get(terminal) ?? null;
  }

  // Get session metadata for a terminal
  getSessionByTerminal(terminal: vscode.Terminal): SessionMeta | null {
    const sessionId = this.terminalToSession.get(terminal);
    if (!sessionId) return null;
    return this.sessions.get(sessionId) ?? null;
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
  async deleteSession(sessionId: string) {
    // Get project path before deleting session (for hook and color cleanup)
    const session = this.sessions.get(sessionId);
    const projectPath = session?.projectPath;

    this.sessions.delete(sessionId);
    // Clean up stale marker if present
    if (this.staleSessionIds.delete(sessionId)) {
      this.saveStaleSessions();
    }
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

  // Check if any active terminals are Monet sessions
  // Primary: check MONET_SESSION_ID env var
  // Fallback: match terminal PIDs against disk status files
  // Returns true if this is an Extension Host restart (Monet terminals exist)
  // Returns false if this is a fresh Cursor load (no Monet terminals)
  async hasMonetTerminals(): Promise<boolean> {
    const terminals = vscode.window.terminals;

    // Fast path: check env vars first
    for (const terminal of terminals) {
      const env = (terminal.creationOptions as vscode.TerminalOptions)?.env;
      if (env?.MONET_SESSION_ID) {
        return true;
      }
    }

    // Slow path: check PIDs against disk status files
    // (env vars are lost after Extension Host restart)
    try {
      const files = await fs.readdir(STATUS_DIR);
      const diskPids = new Set<number>();
      for (const file of files) {
        if (!file.match(/^[a-f0-9]{8}\.json$/)) continue;
        try {
          const content = await fs.readFile(path.join(STATUS_DIR, file), 'utf-8');
          const parsed = JSON.parse(content) as SessionStatusFile;
          if (parsed.processId) {
            diskPids.add(parsed.processId);
          }
        } catch {
          // Ignore parse errors
        }
      }

      if (diskPids.size === 0) return false;

      for (const terminal of terminals) {
        const pid = await terminal.processId;
        if (pid && diskPids.has(pid)) {
          return true;
        }
      }
    } catch {
      // STATUS_DIR might not exist
    }

    return false;
  }

  // Dispose stale Monet terminals left over from a previous Cursor session.
  // Identifies ours by name pattern, keeps any whose PID matches a disk status file
  // (those are live terminals from an Extension Host restart).
  // Safe: only reads disk, doesn't modify status files or globalState.
  async disposeStaleTerminals(): Promise<void> {
    const emojiPrefixes = Object.values(STATUS_EMOJI).map(e => `${e} — `);
    const terminals = vscode.window.terminals;

    // Build set of known PIDs from disk status files
    const diskPids = new Set<number>();
    try {
      const files = await fs.readdir(STATUS_DIR);
      for (const file of files) {
        if (!file.match(/^[a-f0-9]{8}\.json$/)) continue;
        try {
          const content = await fs.readFile(path.join(STATUS_DIR, file), 'utf-8');
          const parsed = JSON.parse(content) as SessionStatusFile;
          if (parsed.processId) {
            diskPids.add(parsed.processId);
          }
        } catch {
          // Ignore parse errors
        }
      }
    } catch {
      // STATUS_DIR might not exist yet
    }

    for (const terminal of terminals) {
      const isMonetName = emojiPrefixes.some(p => terminal.name.startsWith(p))
        || terminal.name === 'zsh [ex-claude]';
      if (!isMonetName) continue;

      // Check if PID matches a known session (live terminal, don't touch)
      const pid = await terminal.processId;
      if (pid && diskPids.has(pid)) {
        this.outputChannel.appendLine(`Monet: Keeping live terminal "${terminal.name}" (PID ${pid} matches disk)`);
        continue;
      }

      // Stale terminal — dispose it
      this.outputChannel.appendLine(`Monet: Disposing stale terminal "${terminal.name}" (PID ${pid} not in disk status)`);
      terminal.dispose();
    }
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

  // Cleanup stale status files on fresh Cursor loads (no Monet terminals alive)
  // Deletes any file that is clearly dead:
  //   1. Has a processId but the process is dead
  //   2. Has no processId at all (no live terminal can claim it)
  //   3. Has a non-standard filename (not 8-char hex, e.g. "active.json", "test1234.json")
  // Only call this on fresh Cursor loads, NOT on Extension Host restarts
  async cleanupStaleStatusFiles(): Promise<void> {
    try {
      const files = await fs.readdir(STATUS_DIR);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const filePath = path.join(STATUS_DIR, file);
        try {
          // Non-standard filenames (not 8-char hex) are always stale
          const isStandardName = /^[a-f0-9]{8}\.json$/.test(file);
          if (!isStandardName) {
            await fs.unlink(filePath);
            this.outputChannel.appendLine(`Monet: Deleted non-standard status file ${file}`);
            continue;
          }

          const content = await fs.readFile(filePath, 'utf-8');
          const parsed = JSON.parse(content) as SessionStatusFile;

          // Has a PID: delete only if the process is dead
          if (parsed.processId) {
            if (!this.isProcessAlive(parsed.processId)) {
              await fs.unlink(filePath);
              this.outputChannel.appendLine(`Monet: Deleted stale status file ${file} (PID ${parsed.processId} dead)`);
            }
            // PID alive means another Cursor window owns it — leave it alone
            continue;
          }

          // No PID at all — no live terminal can claim this file, delete it
          await fs.unlink(filePath);
          this.outputChannel.appendLine(`Monet: Deleted orphan status file ${file} (no PID)`);
        } catch (err) {
          // Ignore parse errors, but log them
          this.outputChannel.appendLine(`Monet: Failed to parse/cleanup ${file}: ${err}`);
        }
      }
    } catch {
      // STATUS_DIR might not exist yet
    }
  }

  // Post-reconnect cleanup: delete any status files not matched to a tracked session
  // Runs after the second reconnectSessions() pass so all live sessions are accounted for
  // Multi-window safe: files with alive PIDs not in this.sessions belong to another window
  private async cleanupUnmatchedStatusFiles(): Promise<void> {
    try {
      const trackedSessionIds = new Set(this.sessions.keys());
      const files = await fs.readdir(STATUS_DIR);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const match = file.match(/^([a-f0-9]{8})\.json$/);
        if (!match) {
          // Non-standard filename — always delete
          await fs.unlink(path.join(STATUS_DIR, file)).catch(() => {});
          this.outputChannel.appendLine(`Monet: Deleted non-standard status file ${file}`);
          continue;
        }

        const sessionId = match[1];
        if (trackedSessionIds.has(sessionId)) continue; // Active session — keep

        // Not tracked. Check PID before deleting (might belong to another Cursor window)
        const filePath = path.join(STATUS_DIR, file);
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const parsed = JSON.parse(content) as SessionStatusFile;
          if (parsed.processId && this.isProcessAlive(parsed.processId)) {
            continue; // Another window owns this — leave it
          }
          await fs.unlink(filePath);
          this.outputChannel.appendLine(`Monet: Deleted unmatched status file ${file}`);
        } catch {
          // Parse error or file gone — ignore
        }
      }
    } catch {
      // STATUS_DIR might not exist
    }
  }

  // Clear globalState sessions
  async clearGlobalStateSessions(): Promise<void> {
    this.sessions.clear();
    this.staleSessionIds.clear();
    await this.context.globalState.update('monet.sessions', {});
    await this.context.globalState.update(SessionManager.STALE_SESSIONS_KEY, undefined);
    this.outputChannel.appendLine('Monet: Cleared globalState sessions (fresh load, no Monet terminals)');
  }

  // Reset all sessions (clear globalState)
  async resetAllSessions() {
    this.sessions.clear();
    this.terminalToSession.clear();
    this.staleSessionIds.clear();
    await this.context.globalState.update('monet.sessions', {});
    await this.context.globalState.update(SessionManager.STALE_SESSIONS_KEY, undefined);
    this.projectManager.clearColors(); // Reset color assignments too (including user overrides)

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
