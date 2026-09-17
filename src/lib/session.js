import { writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Stored inside .git so it is never committed and cleans up with the workspace */
const sessionFile = (cwd) => join(cwd, '.git', 'flutter-remote-session.json');

export function saveSession(cwd, data) {
  if (!existsSync(join(cwd, '.git'))) return;
  writeFileSync(sessionFile(cwd), JSON.stringify({ ...data, startedAt: Date.now() }, null, 2));
}

export function loadSession(cwd) {
  const path = sessionFile(cwd);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function clearSession(cwd) {
  rmSync(sessionFile(cwd), { force: true });
}
