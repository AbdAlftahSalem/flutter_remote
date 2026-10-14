/**
 * Flutter Remote WebRTC V2 Session Lifecycle & Idempotent Cleanup
 */

import { logger } from '../shared/logger.js';
import { ProcessSupervisor } from './ProcessSupervisor.js';
import { SessionError } from '../shared/errors.js';

export class SessionLifecycle {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this._cleanupHooks = [];
    this._cleanedUp = false;
    this._cleanupPromise = null;
    this.supervisor = new ProcessSupervisor(this.sessionId);
    this.abortController = new AbortController();
  }

  get signal() {
    return this.abortController.signal;
  }

  addCleanupHook(name, fn) {
    if (this._cleanedUp) return;
    this._cleanupHooks.push({ name, fn });
  }

  trackProcess(pid, name, port = null, childProc = null) {
    return this.supervisor.trackProcess(pid, name, port, childProc);
  }

  untrackProcess(pid) {
    this.supervisor.untrackProcess(pid);
  }

  get trackedProcesses() {
    return this.supervisor.trackedProcesses;
  }

  /**
   * Runs an async operation with an enforceable timeout and abort check.
   */
  async withTimeout(promise, timeoutMs, opName = 'operation') {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new SessionError(`Operation '${opName}' timed out after ${timeoutMs}ms`, { code: 'OPERATION_TIMEOUT' }));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async cleanup(reason = 'shutdown') {
    if (this._cleanedUp) {
      return this._cleanupPromise || Promise.resolve();
    }

    this._cleanedUp = true;

    // Trigger AbortController signal
    try {
      this.abortController.abort(reason);
    } catch {}

    this._cleanupPromise = (async () => {
      logger.info('session.cleanup_started', { sessionId: this.sessionId, reason });

      // Run cleanup hooks in reverse order (LIFO)
      const hooks = [...this._cleanupHooks].reverse();
      for (const { name, fn } of hooks) {
        try {
          await fn();
        } catch (err) {
          logger.warn('session.cleanup_hook_failed', {
            sessionId: this.sessionId,
            hook: name,
            error: err.message,
          });
        }
      }

      // Terminate tracked processes with SIGTERM -> SIGKILL escalation
      await this.supervisor.terminateAll({ timeoutMs: 2000 });

      logger.info('session.cleanup_completed', { sessionId: this.sessionId });
    })();

    return this._cleanupPromise;
  }

  installSignalHandlers() {
    const handler = (signal) => {
      logger.info('session.signal_received', { sessionId: this.sessionId, signal });
      this.cleanup(`signal_${signal}`).finally(() => {
        process.exit(signal === 'SIGINT' ? 130 : 143);
      });
    };

    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const sig of signals) {
      process.once(sig, handler);
      this.addCleanupHook(`signal_listener_${sig}`, () => {
        process.removeListener(sig, handler);
      });
    }
  }
}
