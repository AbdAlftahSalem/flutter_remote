/**
 * Flutter Remote WebRTC V2 Session Lifecycle & Idempotent Cleanup
 */

import { logger } from '../shared/logger.js';

export class SessionLifecycle {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this._cleanupHooks = [];
    this._trackedProcesses = new Map();
    this._cleanedUp = false;
    this._cleanupPromise = null;
  }

  addCleanupHook(name, fn) {
    if (this._cleanedUp) return;
    this._cleanupHooks.push({ name, fn });
  }

  trackProcess(pid, name, port = null) {
    if (!pid) return;
    this._trackedProcesses.set(pid, { pid, name, port, startedAt: Date.now() });
  }

  untrackProcess(pid) {
    this._trackedProcesses.delete(pid);
  }

  get trackedProcesses() {
    return Array.from(this._trackedProcesses.values());
  }

  async cleanup(reason = 'shutdown') {
    if (this._cleanedUp) {
      return this._cleanupPromise || Promise.resolve();
    }

    this._cleanedUp = true;

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

      // Terminate tracked processes
      for (const [pid, proc] of this._trackedProcesses.entries()) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {}
      }
      this._trackedProcesses.clear();

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
