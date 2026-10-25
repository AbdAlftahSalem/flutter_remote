/**
 * A user-facing error: what went wrong, and the one thing to do about it.
 * `bin/flutter-remote.js` prints `message`, then `hint` as a "Fix:" line.
 */
export class FlutterRemoteError extends Error {
  /**
   * @param {string} message  What went wrong, in one sentence.
   * @param {{ hint?: string, code?: string, exitCode?: number }} [options]
   */
  constructor(message, { hint, code = 'E_FLUTTER_REMOTE', exitCode = 1 } = {}) {
    super(message);
    this.name = 'FlutterRemoteError';
    this.hint = hint;
    this.code = code;
    this.exitCode = exitCode;
  }
}

/** Exit codes, so scripts can tell failure kinds apart. */
export const EXIT = Object.freeze({
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  PREREQUISITE: 3,
});

export const usageError = (message, hint) =>
  new FlutterRemoteError(message, { hint, code: 'E_USAGE', exitCode: EXIT.USAGE });

export const prerequisiteError = (message, hint) =>
  new FlutterRemoteError(message, { hint, code: 'E_PREREQUISITE', exitCode: EXIT.PREREQUISITE });
