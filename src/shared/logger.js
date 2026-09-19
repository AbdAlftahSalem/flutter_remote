/**
 * Flutter Remote WebRTC V2 Structured Logger
 */

const LOG_LEVELS = {
  TRACE: 0,
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4,
};

const SENSITIVE_KEYS = new Set([
  'token',
  'gatetoken',
  'gate_token',
  'password',
  'credential',
  'turn_credential',
  'secret',
  'cookie',
  'authorization',
  'clipboard',
  'text',
]);

function redact(obj, depth = 0) {
  if (depth > 5 || obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redact(item, depth + 1));
  }

  const clean = {};
  for (const [key, value] of Object.entries(obj)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lower) || lower.includes('token') || lower.includes('secret') || lower.includes('password')) {
      clean[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      clean[key] = redact(value, depth + 1);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

export class Logger {
  constructor(options = {}) {
    this.name = options.name || 'flutter-remote';
    this.sessionId = options.sessionId || null;
    this.generation = options.generation || null;
    this.level = LOG_LEVELS[(process.env.LOG_LEVEL || options.level || 'INFO').toUpperCase()] ?? LOG_LEVELS.INFO;
    this.isJson = options.json !== undefined ? options.json : (process.env.NODE_ENV === 'production' || process.env.LOG_FORMAT === 'json');
  }

  child(context = {}) {
    const childLogger = new Logger({
      name: context.name || this.name,
      sessionId: context.sessionId || this.sessionId,
      generation: context.generation !== undefined ? context.generation : this.generation,
      level: Object.keys(LOG_LEVELS).find((k) => LOG_LEVELS[k] === this.level),
      json: this.isJson,
    });
    return childLogger;
  }

  _log(levelName, event, meta = {}) {
    if (LOG_LEVELS[levelName] < this.level) return;

    const entry = {
      ts: Date.now(),
      level: levelName.toLowerCase(),
      name: this.name,
      event,
      sessionId: this.sessionId || meta.sessionId || undefined,
      generation: this.generation !== null ? this.generation : meta.generation,
      ...redact(meta),
    };

    if (this.isJson) {
      const line = JSON.stringify(entry);
      if (levelName === 'ERROR') {
        process.stderr.write(line + '\n');
      } else {
        process.stdout.write(line + '\n');
      }
    } else {
      const prefix = `[${new Date(entry.ts).toISOString()}] [${entry.level.toUpperCase()}] [${entry.name}]`;
      const genStr = entry.generation !== undefined ? ` (gen:${entry.generation})` : '';
      const metaStr = Object.keys(meta).length > 0 ? ' ' + JSON.stringify(redact(meta)) : '';
      const formatted = `${prefix} ${event}${genStr}${metaStr}`;
      if (levelName === 'ERROR') {
        console.error(formatted);
      } else if (levelName === 'WARN') {
        console.warn(formatted);
      } else {
        console.log(formatted);
      }
    }
  }

  trace(event, meta) { this._log('TRACE', event, meta); }
  debug(event, meta) { this._log('DEBUG', event, meta); }
  info(event, meta) { this._log('INFO', event, meta); }
  warn(event, meta) { this._log('WARN', event, meta); }
  error(event, meta) { this._log('ERROR', event, meta); }
}

export const logger = new Logger();
