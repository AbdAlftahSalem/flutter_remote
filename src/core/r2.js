import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { FlutterRemoteError, usageError } from './errors.js';

const CONFIG_PATH = join(homedir(), '.config', 'flutter-remote', 'r2.json');
export const R2_FIELDS = { 'account-id': 'accountId', 'access-key-id': 'accessKeyId', 'secret-access-key': 'secretAccessKey', bucket: 'bucket' };

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export function saveConfig(cfg) {
  const missing = Object.entries(R2_FIELDS).filter(([, key]) => !cfg[key]).map(([flag]) => `--${flag}`);
  if (missing.length) {
    throw usageError(`missing ${missing.join(', ')}`, 'flutter-remote r2 --account-id <id> --access-key-id <key> --secret-access-key <secret> --bucket <name>');
  }
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/**
 * Uploading builds to R2 was never implemented (earlier versions printed
 * "Uploaded" without uploading). Say so instead of pretending.
 */
export const r2NotSupported = () => new FlutterRemoteError('Uploading to Cloudflare R2 is not supported yet', {
  hint: 'drop --r2: the app is uploaded to a GitHub release on your repository instead',
});
