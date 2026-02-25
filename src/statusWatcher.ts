import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { SessionStatusFile, STATUS_EMOJI } from './types';
import { SessionManager } from './sessionManager';

const STATUS_DIR = path.join(os.homedir(), '.monet', 'status');

// Debounce interval for fs.watch events
const DEBOUNCE_MS = 100;
// Fallback poll interval
const FALLBACK_POLL_INTERVAL = 1000;

export class StatusWatcher {
  private watcher: fsSync.FSWatcher | null = null;
  private fallbackTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private renameQueue: Array<{ terminal: vscode.Terminal; newName: string }> = [];
  private isRenaming = false;
  private sessionManager: SessionManager | null = null;

  setSessionManager(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
  }

  async start() {
    try {
      // Ensure status directory exists
      await fs.mkdir(STATUS_DIR, { recursive: true });

      // Start fs.watch
      this.startWatcher();

      // Start fallback poll
      this.startFallbackPoll();

      // Do initial poll (don't await - let it run async)
      this.poll().catch(() => {});

      console.log('Monet: Status watcher started (fs.watch + fallback poll)');
    } catch (err) {
      console.error('Monet: Failed to start status watcher:', err);
      // Still start fallback poll even if something fails
      this.startFallbackPoll();
    }
  }

  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    console.log('Monet: Status watcher stopped');
  }

  private startWatcher() {
    try {
      this.watcher = fsSync.watch(STATUS_DIR, () => {
        // Debounce rapid events
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
          this.poll().catch(() => {});
        }, DEBOUNCE_MS);
      });

      this.watcher.on('error', (err) => {
        console.error('Monet: fs.watch error:', err);
        // Watcher died, will rely on fallback poll
      });
    } catch (err) {
      console.error('Monet: Failed to start fs.watch:', err);
      // Will rely on fallback poll
    }
  }

  private startFallbackPoll() {
    this.fallbackTimer = setInterval(() => {
      this.poll().catch(() => {});
    }, FALLBACK_POLL_INTERVAL);
  }

  // Poll all status files and update terminal names
  private async poll() {
    if (!this.sessionManager) return;

    try {
      const files = await fs.readdir(STATUS_DIR).catch(() => []);

      for (const file of files) {
        // Only handle status JSON files (8-char hex sessionId)
        const match = file.match(/^([a-f0-9]{8})\.json$/);
        if (!match) continue;

        const sessionId = match[1];

        // Use sessionManager to get terminal for this session
        const terminal = this.sessionManager.getTerminalForSession(sessionId);
        console.log(`Monet poll: sessionId=${sessionId}, terminal=${terminal ? 'found' : 'NOT FOUND'}`);
        if (!terminal) continue;

        const statusPath = path.join(STATUS_DIR, file);
        try {
          const content = await fs.readFile(statusPath, 'utf-8');
          const status: SessionStatusFile = JSON.parse(content);

          const emoji = STATUS_EMOJI[status.status] || '⚪';
          // Terminal name: emoji — title
          const newName = status.title ? `${emoji} — ${status.title}` : `${emoji} — Claude | new session`;

          // Only rename if different
          if (terminal.name !== newName) {
            this.queueRename(terminal, newName);
          }
        } catch {
          // Ignore parse errors - file might be mid-write
        }
      }
    } catch (err) {
      console.error('Monet: Poll error:', err);
    }
  }

  // Queue a rename operation
  private queueRename(terminal: vscode.Terminal, newName: string) {
    // Check if already queued for this terminal
    const existing = this.renameQueue.find(r => r.terminal === terminal);
    if (existing) {
      existing.newName = newName; // Update to latest name
    } else {
      this.renameQueue.push({ terminal, newName });
    }
    this.processRenameQueue();
  }

  // Process rename queue one at a time to avoid focus conflicts
  private async processRenameQueue() {
    if (this.isRenaming || this.renameQueue.length === 0) return;

    this.isRenaming = true;

    try {
      const item = this.renameQueue.shift();
      if (!item) return;

      const { terminal, newName } = item;

      // Save current active terminal
      const originalActive = vscode.window.activeTerminal;

      // Focus target terminal (without revealing - keeps it quiet)
      terminal.show(false);
      await new Promise(r => setTimeout(r, 50));

      // Rename using the API
      await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: newName });

      // Restore focus to original terminal
      if (originalActive && originalActive !== terminal) {
        originalActive.show(false);
      }
    } catch (err) {
      console.error('Monet: Rename error:', err);
    } finally {
      this.isRenaming = false;
      // Process next item if any
      if (this.renameQueue.length > 0) {
        setTimeout(() => this.processRenameQueue(), 100);
      }
    }
  }

  // Get the current status for a session
  async getStatus(sessionId: string): Promise<SessionStatusFile | null> {
    const statusPath = path.join(STATUS_DIR, `${sessionId}.json`);
    try {
      const content = await fs.readFile(statusPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  // Write idle status directly (used for Ctrl+C detection)
  // Preserves processId, terminalName, projectPath for reconnection
  async writeIdleStatus(sessionId: string) {
    const statusPath = path.join(STATUS_DIR, `${sessionId}.json`);
    try {
      let statusData: SessionStatusFile = {
        sessionId: sessionId,
        project: 'unknown',
        status: 'idle',
        title: '',
        updated: Date.now()
      };

      // Try to preserve existing data (including processId, terminalName, projectPath)
      try {
        const existing = await fs.readFile(statusPath, 'utf-8');
        const parsed = JSON.parse(existing) as SessionStatusFile;
        statusData = {
          ...parsed,
          status: 'idle',
          updated: Date.now()
        };
      } catch {}

      // Write atomically
      const tmpPath = statusPath + '.tmp';
      await fs.writeFile(tmpPath, JSON.stringify(statusData, null, 2));
      await fs.rename(tmpPath, statusPath);
    } catch (err) {
      console.error(`Monet: Failed to write idle status for session ${sessionId}:`, err);
    }
  }
}
