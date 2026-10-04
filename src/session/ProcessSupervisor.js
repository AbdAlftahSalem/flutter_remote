/**
 * Flutter Remote Process Supervisor
 *
 * Tracks every child process spawned across simulator, gateway, ffmpeg, peer, and tunnels.
 * Enforces clean shutdown: SIGTERM -> wait grace period -> SIGKILL if necessary.
 * Prevents orphan processes on remote macOS runners.
 */

import { spawn as cpSpawn } from 'node:child_process';
import { logger } from '../shared/logger.js';

export const PROCESS_STATES = {
  RUNNING: 'running',
  TERMINATING: 'terminating',
  DEAD: 'dead',
};

export class ProcessSupervisor {
  constructor(sessionId = 'default') {
    this.sessionId = sessionId;
    this.processes = new Map(); // pid -> ProcessInfo
  }

  trackProcess(pid, name, port = null, childProc = null) {
    if (!pid) return null;
    const info = {
      pid,
      name,
      port,
      startedAt: Date.now(),
      state: PROCESS_STATES.RUNNING,
      exitCode: null,
      signal: null,
      childProc,
    };
    this.processes.set(pid, info);

    if (childProc) {
      childProc.once('close', (code, signal) => {
        info.state = PROCESS_STATES.DEAD;
        info.exitCode = code;
        info.signal = signal;
        logger.info('process.closed', { sessionId: this.sessionId, pid, name, code, signal });
      });
      childProc.once('error', (err) => {
        logger.warn('process.error', { sessionId: this.sessionId, pid, name, error: err.message });
      });
    }

    return info;
  }

  untrackProcess(pid) {
    this.processes.delete(pid);
  }

  getProcess(pid) {
    return this.processes.get(pid);
  }

  get trackedProcesses() {
    return Array.from(this.processes.values());
  }

  get runningProcesses() {
    return Array.from(this.processes.values()).filter((p) => p.state === PROCESS_STATES.RUNNING);
  }

  /**
   * Spawns a child process and automatically tracks it in the supervisor.
   */
  spawnTracked(name, command, args = [], options = {}, port = null) {
    const child = cpSpawn(command, args, options);
    if (child.pid) {
      this.trackProcess(child.pid, name, port, child);
    }
    return child;
  }

  /**
   * Terminates a single process: SIGTERM -> wait timeout -> SIGKILL escalation.
   */
  async terminateProcess(pid, { timeoutMs = 2000 } = {}) {
    const info = this.processes.get(pid);
    if (!info) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
      return;
    }

    if (info.state === PROCESS_STATES.DEAD) {
      return;
    }

    info.state = PROCESS_STATES.TERMINATING;
    logger.info('process.terminating', { sessionId: this.sessionId, pid, name: info.name });

    // Send SIGTERM
    try {
      if (info.childProc) {
        info.childProc.kill('SIGTERM');
      } else {
        process.kill(pid, 'SIGTERM');
      }
    } catch (err) {
      // Process might already be dead
      info.state = PROCESS_STATES.DEAD;
      return;
    }

    // Wait for exit
    const died = await new Promise((resolve) => {
      if (info.state === PROCESS_STATES.DEAD) {
        resolve(true);
        return;
      }

      let timer = null;
      let checkInterval = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (checkInterval) clearInterval(checkInterval);
      };

      if (info.childProc) {
        info.childProc.once('close', () => {
          cleanup();
          resolve(true);
        });
      } else {
        // Poll process existence
        checkInterval = setInterval(() => {
          try {
            process.kill(pid, 0); // test existence
          } catch {
            cleanup();
            info.state = PROCESS_STATES.DEAD;
            resolve(true);
          }
        }, 100);
      }

      timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
    });

    if (!died && info.state !== PROCESS_STATES.DEAD) {
      logger.warn('process.escalating_sigkill', { sessionId: this.sessionId, pid, name: info.name });
      try {
        if (info.childProc) {
          info.childProc.kill('SIGKILL');
        } else {
          process.kill(pid, 'SIGKILL');
        }
      } catch {}
      info.state = PROCESS_STATES.DEAD;
    }
  }

  /**
   * Terminates all tracked processes in reverse order of addition.
   */
  async terminateAll({ timeoutMs = 2000 } = {}) {
    const list = Array.from(this.processes.values()).reverse();
    for (const info of list) {
      await this.terminateProcess(info.pid, { timeoutMs });
    }
    this.processes.clear();
  }
}
