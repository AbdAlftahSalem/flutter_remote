/**
 * Flutter Remote WebRTC V2 Typed Error Hierarchy
 */

export class FlutterRemoteError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code || 'UNKNOWN_ERROR';
    this.status = options.status || 500;
    this.details = options.details || null;
    this.fatal = options.fatal !== undefined ? options.fatal : false;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      status: this.status,
      details: this.details,
      fatal: this.fatal,
    };
  }
}

export class SessionError extends FlutterRemoteError {
  constructor(message, options = {}) {
    super(message, { code: 'SESSION_ERROR', status: 400, ...options });
  }
}

export class SignalingError extends FlutterRemoteError {
  constructor(message, options = {}) {
    super(message, { code: 'SIGNALING_ERROR', status: 400, ...options });
  }
}

export class WebRTCError extends FlutterRemoteError {
  constructor(message, options = {}) {
    super(message, { code: 'WEBRTC_ERROR', status: 500, ...options });
  }
}

export class SimulatorError extends FlutterRemoteError {
  constructor(message, options = {}) {
    super(message, { code: 'SIMULATOR_ERROR', status: 502, ...options });
  }
}

export class CaptureError extends FlutterRemoteError {
  constructor(message, options = {}) {
    super(message, { code: 'CAPTURE_ERROR', status: 502, ...options });
  }
}

export class TransportError extends FlutterRemoteError {
  constructor(message, options = {}) {
    super(message, { code: 'TRANSPORT_ERROR', status: 502, ...options });
  }
}

export class AuthenticationError extends FlutterRemoteError {
  constructor(message, options = {}) {
    super(message, { code: 'AUTHENTICATION_ERROR', status: 403, ...options });
  }
}

export class TunnelError extends FlutterRemoteError {
  constructor(message, options = {}) {
    super(message, { code: 'TUNNEL_ERROR', status: 502, ...options });
  }
}
